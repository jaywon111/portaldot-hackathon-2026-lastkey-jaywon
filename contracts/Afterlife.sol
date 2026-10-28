// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Afterlife
/// @author Afterlife contributors
/// @notice A deadman switch for digital inheritance. An owner registers a vault
///         with a check-in interval (in days) and a list of beneficiaries. Each
///         beneficiary is bound to a keccak256 hash of an encrypted payload
///         (the payload itself lives off-chain; only its fingerprint is stored).
///         The owner proves they are alive by calling {checkIn}. If the owner
///         stops checking in for longer than the interval, any beneficiary may
///         call {claim} once, which emits a {ClaimProof} event that the
///         beneficiary can use to retrieve and decrypt their payload.
/// @dev Design notes:
///      - One active vault per owner address. Closing a vault (or never having
///        one) allows a new registration, which starts a new "epoch". Slot data
///        is keyed by (owner, epoch, beneficiary), so data from an earlier epoch
///        never leaks into a later one and no clean-up loops are needed.
///      - Claim rule: `block.timestamp > lastCheckIn + intervalDays * 1 days`
///        (strictly greater; a claim at the exact deadline reverts).
///      - Once the first beneficiary claims, the vault is "triggered": the owner
///        can no longer check in or close it, so beneficiaries can claim one by one
///        without the deadline moving. The owner can still re-register after a
///        trigger, which starts a fresh epoch and drops the old beneficiaries' rights.
///      - Registration fee is OFF by default (`feeEnabled == false`, fee == 0).
///        When the admin enables it, each registration must send exactly
///        `registrationFee` wei; the fee accumulates in this contract and the
///        admin can sweep it to `feeSink`.
///      - Nothing here is encrypted on-chain. The client encrypts payloads and
///        only publishes keccak256 hashes. Key management is out of scope for v1.
contract Afterlife {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Smallest allowed check-in interval, in days.
    uint32 public constant MIN_INTERVAL_DAYS = 1;

    /// @notice Largest allowed check-in interval, in days (10 years).
    uint32 public constant MAX_INTERVAL_DAYS = 3650;

    /// @notice Maximum number of beneficiaries per vault.
    uint256 public constant MAX_BENEFICIARIES = 20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Per-owner vault state for the current epoch.
    /// @dev `beneficiaries` lists the addresses registered in the current epoch.
    struct Vault {
        bool active;              // false once closed or before first registration
        bool triggered;           // true once any beneficiary has claimed
        uint32 intervalDays;      // check-in interval in days
        uint64 lastCheckIn;       // unix time of the last check-in (or registration)
        uint64 epoch;             // increments on every successful registration
        address[] beneficiaries;  // beneficiaries of the current epoch
    }

    /// @notice Per (owner, epoch, beneficiary) slot.
    struct Slot {
        bool isBeneficiary;       // true if the beneficiary was registered in this epoch
        bool claimed;             // true once this beneficiary has claimed
        bytes32 payloadHash;      // keccak256 of the beneficiary's encrypted payload
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(address => Vault) private _vaults;
    mapping(bytes32 => Slot) private _slots;

    /// @notice Admin who can change the registration fee and sweep fees.
    address public admin;

    /// @notice Whether the registration fee is charged. Disabled by default.
    bool public feeEnabled;

    /// @notice Registration fee in wei. Only charged when `feeEnabled` is true.
    uint256 public registrationFee;

    /// @notice Address that receives swept registration fees.
    address public feeSink;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when a vault is registered (new epoch starts).
    /// @param owner The vault owner.
    /// @param epoch The new epoch number for this owner.
    /// @param intervalDays Check-in interval in days.
    /// @param beneficiaryCount Number of beneficiaries registered.
    /// @param timestamp Block timestamp of registration.
    event VaultRegistered(
        address indexed owner,
        uint64 indexed epoch,
        uint32 intervalDays,
        uint256 beneficiaryCount,
        uint256 timestamp
    );

    /// @notice Emitted on every successful check-in.
    /// @param owner The vault owner who checked in.
    /// @param epoch Current epoch of the vault.
    /// @param timestamp New `lastCheckIn` value.
    event CheckedIn(address indexed owner, uint64 indexed epoch, uint256 timestamp);

    /// @notice Emitted when an owner closes (cancels) an untriggered vault.
    /// @param owner The vault owner.
    /// @param epoch Epoch that was closed.
    /// @param timestamp Block timestamp of the close.
    event VaultClosed(address indexed owner, uint64 indexed epoch, uint256 timestamp);

    /// @notice Proof that a beneficiary claimed their payload access right.
    /// @param owner The vault owner whose lapse was claimed.
    /// @param beneficiary The beneficiary who claimed (always msg.sender).
    /// @param epoch Epoch of the vault at claim time.
    /// @param payloadHash Hash of the beneficiary's encrypted payload.
    /// @param claimId keccak256 of (owner, epoch, beneficiary, timestamp, payloadHash).
    /// @param timestamp Block timestamp of the claim.
    event ClaimProof(
        address indexed owner,
        address indexed beneficiary,
        uint64 epoch,
        bytes32 payloadHash,
        bytes32 claimId,
        uint256 timestamp
    );

    /// @notice Emitted when the admin changes the registration fee settings.
    event FeeSettingsUpdated(bool enabled, uint256 fee);

    /// @notice Emitted when the fee sink address changes.
    event FeeSinkUpdated(address indexed sink);

    /// @notice Emitted when accumulated fees are swept to the fee sink.
    event FeesWithdrawn(address indexed sink, uint256 amount);

    /// @notice Emitted when the admin role is handed to a new address.
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAdmin();
    error ZeroAddress();
    error VaultAlreadyActive();
    error NoActiveVault();
    error VaultTriggered();
    error InvalidInterval();
    error InvalidBeneficiaryCount();
    error LengthMismatch();
    error SelfBeneficiary();
    error DuplicateBeneficiary();
    error EmptyPayloadHash();
    error IncorrectFee();
    error NotBeneficiary();
    error NotYetClaimable();
    error AlreadyClaimed();
    error NothingToWithdraw();
    error TransferFailed();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    /// @dev Restricts a function to the admin.
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @notice Deploys the contract. The deployer becomes admin and fee sink.
    /// @dev Fees are disabled by default: `feeEnabled == false` and `registrationFee == 0`.
    constructor() {
        admin = msg.sender;
        feeSink = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
        emit FeeSinkUpdated(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    /// @notice Register a new vault for `msg.sender`.
    /// @dev Reverts if the sender already has an active vault. Starts a new epoch,
    ///      sets `lastCheckIn` to now, and records each beneficiary with its payload hash.
    ///      If `feeEnabled` is true, `msg.value` must equal `registrationFee`; otherwise
    ///      `msg.value` must be zero.
    /// @param intervalDays Check-in interval in days, between MIN_INTERVAL_DAYS and MAX_INTERVAL_DAYS.
    /// @param beneficiaries Beneficiary addresses (1 to MAX_BENEFICIARIES). Must be unique,
    ///        non-zero, and different from the owner.
    /// @param payloadHashes Non-zero keccak256 payload hashes, one per beneficiary, same order.
    function register(
        uint32 intervalDays,
        address[] calldata beneficiaries,
        bytes32[] calldata payloadHashes
    ) external payable {
        Vault storage v = _vaults[msg.sender];
        // A vault can be re-registered if it was closed, or if it was triggered
        // (a beneficiary claimed) and the owner is back. Re-registering starts a
        // fresh epoch, so prior claims do not carry over.
        if (v.active && !v.triggered) revert VaultAlreadyActive();

        if (intervalDays < MIN_INTERVAL_DAYS || intervalDays > MAX_INTERVAL_DAYS) revert InvalidInterval();

        uint256 count = beneficiaries.length;
        if (count == 0 || count > MAX_BENEFICIARIES) revert InvalidBeneficiaryCount();
        if (payloadHashes.length != count) revert LengthMismatch();

        if (feeEnabled) {
            if (msg.value != registrationFee) revert IncorrectFee();
        } else {
            if (msg.value != 0) revert IncorrectFee();
        }

        uint64 newEpoch = v.epoch + 1;
        v.epoch = newEpoch;
        v.active = true;
        v.triggered = false;
        v.intervalDays = intervalDays;
        v.lastCheckIn = uint64(block.timestamp);
        delete v.beneficiaries;

        for (uint256 i = 0; i < count; ++i) {
            address b = beneficiaries[i];
            if (b == address(0)) revert ZeroAddress();
            if (b == msg.sender) revert SelfBeneficiary();
            if (payloadHashes[i] == bytes32(0)) revert EmptyPayloadHash();

            Slot storage s = _slots[_slotKey(msg.sender, newEpoch, b)];
            if (s.isBeneficiary) revert DuplicateBeneficiary();

            s.isBeneficiary = true;
            s.payloadHash = payloadHashes[i];
            v.beneficiaries.push(b);
        }

        emit VaultRegistered(msg.sender, newEpoch, intervalDays, count, block.timestamp);
    }

    /// @notice Prove liveness. Resets `lastCheckIn` to now, pushing the claim deadline forward.
    /// @dev Reverts if there is no active vault or if the vault has been triggered by a claim.
    function checkIn() external {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();

        v.lastCheckIn = uint64(block.timestamp);
        emit CheckedIn(msg.sender, v.epoch, block.timestamp);
    }

    /// @notice Cancel (close) the caller's active vault before any claim.
    /// @dev The vault data stays readable until the owner registers again. Closing
    ///      does not refund a registration fee.
    function close() external {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();

        v.active = false;
        emit VaultClosed(msg.sender, v.epoch, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Beneficiary actions
    // ---------------------------------------------------------------------

    /// @notice Claim the caller's payload access right for `owner`'s vault.
    /// @dev Allowed only when: the vault is active, msg.sender is a beneficiary of the
    ///      current epoch, has not claimed yet, and `block.timestamp > lastCheckIn + interval`.
    ///      Marks the vault as triggered and emits {ClaimProof}.
    /// @param owner The vault owner whose deadman switch has lapsed.
    function claim(address owner) external {
        Vault storage v = _vaults[owner];
        if (!v.active) revert NoActiveVault();

        Slot storage s = _slots[_slotKey(owner, v.epoch, msg.sender)];
        if (!s.isBeneficiary) revert NotBeneficiary();
        if (s.claimed) revert AlreadyClaimed();

        if (block.timestamp <= _deadline(v)) revert NotYetClaimable();

        s.claimed = true;
        v.triggered = true;

        bytes32 claimId = keccak256(
            abi.encode(owner, v.epoch, msg.sender, block.timestamp, s.payloadHash)
        );
        emit ClaimProof(owner, msg.sender, v.epoch, s.payloadHash, claimId, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Admin actions (fee sink)
    // ---------------------------------------------------------------------

    /// @notice Turn the registration fee on or off and set its amount.
    /// @dev Fee is disabled by default. Setting `enabled = false` ignores `fee` for new registrations.
    /// @param enabled Whether registrations must pay `fee`.
    /// @param fee Fee in wei charged per registration when enabled.
    function setFee(bool enabled, uint256 fee) external onlyAdmin {
        feeEnabled = enabled;
        registrationFee = fee;
        emit FeeSettingsUpdated(enabled, fee);
    }

    /// @notice Set the address that receives swept fees.
    /// @param sink New fee sink address (must be non-zero).
    function setFeeSink(address sink) external onlyAdmin {
        if (sink == address(0)) revert ZeroAddress();
        feeSink = sink;
        emit FeeSinkUpdated(sink);
    }

    /// @notice Send all accumulated registration fees to `feeSink`.
    function withdrawFees() external onlyAdmin {
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToWithdraw();

        (bool ok, ) = payable(feeSink).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesWithdrawn(feeSink, amount);
    }

    /// @notice Hand the admin role to a new address.
    /// @param newAdmin The new admin (must be non-zero).
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Full vault state for an owner.
    /// @param owner The vault owner.
    /// @return active Whether the vault is active.
    /// @return triggered Whether any beneficiary has claimed.
    /// @return intervalDays Check-in interval in days.
    /// @return lastCheckIn Unix time of the last check-in.
    /// @return epoch Current epoch (0 if never registered).
    /// @return deadline Unix time after which claims open (lastCheckIn + interval).
    /// @return beneficiaries Beneficiary addresses of the current epoch.
    function getVault(address owner)
        external
        view
        returns (
            bool active,
            bool triggered,
            uint32 intervalDays,
            uint64 lastCheckIn,
            uint64 epoch,
            uint256 deadline,
            address[] memory beneficiaries
        )
    {
        Vault storage v = _vaults[owner];
        return (
            v.active,
            v.triggered,
            v.intervalDays,
            v.lastCheckIn,
            v.epoch,
            _deadline(v),
            v.beneficiaries
        );
    }

    /// @notice Unix time after which beneficiaries may claim for `owner`.
    /// @param owner The vault owner.
    /// @return The deadline (lastCheckIn + interval). Zero if never registered.
    function deadlineOf(address owner) external view returns (uint256) {
        return _deadline(_vaults[owner]);
    }

    /// @notice Whether `beneficiary` can claim from `owner`'s vault right now.
    /// @param owner The vault owner.
    /// @param beneficiary The address to check.
    /// @return True if active, beneficiary in current epoch, not yet claimed, and past the deadline.
    function isClaimable(address owner, address beneficiary) external view returns (bool) {
        Vault storage v = _vaults[owner];
        if (!v.active) return false;
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        if (!s.isBeneficiary || s.claimed) return false;
        return block.timestamp > _deadline(v);
    }

    /// @notice Payload hash bound to `beneficiary` in `owner`'s current epoch.
    /// @param owner The vault owner.
    /// @param beneficiary The beneficiary address.
    /// @return The payload hash, or zero if not a beneficiary of the current epoch.
    function payloadHashOf(address owner, address beneficiary) external view returns (bytes32) {
        Vault storage v = _vaults[owner];
        return _slots[_slotKey(owner, v.epoch, beneficiary)].payloadHash;
    }

    /// @notice Whether `beneficiary` has already claimed in `owner`'s current epoch.
    /// @param owner The vault owner.
    /// @param beneficiary The beneficiary address.
    /// @return True if the beneficiary has claimed.
    function hasClaimed(address owner, address beneficiary) external view returns (bool) {
        Vault storage v = _vaults[owner];
        return _slots[_slotKey(owner, v.epoch, beneficiary)].claimed;
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    /// @dev Storage key for an (owner, epoch, beneficiary) slot.
    function _slotKey(address owner, uint64 epoch, address beneficiary) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, epoch, beneficiary));
    }

    /// @dev Claim deadline for a vault: lastCheckIn plus the interval in seconds.
    function _deadline(Vault storage v) internal view returns (uint256) {
        return uint256(v.lastCheckIn) + uint256(v.intervalDays) * 1 days;
    }
}
