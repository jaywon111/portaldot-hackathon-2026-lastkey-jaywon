// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ERC20 surface used by the token sweep feature.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title LastKey
/// @author LastKey contributors
/// @notice v3 of the Afterlife deadman switch. An owner opens a vault with a
///         check-in interval, a grace window, a secret word, an encrypted
///         instructions blob and a list of beneficiaries with percentage shares.
///         The owner (or a trusted watcher, e.g. a backend that sees the owner's
///         outgoing wallet activity) checks in to reset the clock. If the clock
///         runs out and the grace window passes, a beneficiary can claim by
///         submitting the secret word. The first claim freezes the vault, snapshots
///         the escrow and pays each beneficiary their share. Every beneficiary also
///         holds a soulbound claim ticket (non-transferable ERC-721) minted at setup.
///         v3 adds a token sweep: the owner can allow specific ERC20 tokens to be
///         pulled into escrow, split by the same shares.
/// @dev Design notes:
///      - Claim rule: `block.timestamp > lastCheckIn + (intervalDays + graceDays) * 1 days`.
///      - Secret word: only keccak256(bytes(secret)) is stored. The secret is public once
///        submitted in a claim transaction, so the encrypted blob is only as private as
///        the secret word is until the first claim. See README "limits".
///      - Escrow: native value sent to {register} or {deposit} is held by this contract. On the
///        first claim `pool` snapshots `deposited`; each beneficiary receives
///        `pool * shareBps / 10000`. Rounding dust stays in the contract.
///      - Token sweep: an owner calls {allowSweep} for each ERC20, then also calls
///        `token.approve(lastKey, amount)` on the token itself (the contract cannot grant
///        an allowance). {sweepToVault} pulls min(balance, allowance) into token escrow.
///        Token escrow is paid out with the same shares at the first claim. Sweeps stop
///        once the vault has been triggered by a claim.
///      - Sweep modes (v3.1): each vault picks a mode with {setSweepMode}. `Listed` (default):
///        only tokens the owner listed with {allowSweep} can be swept. `Everything`: the owner
///        also approves ERC20s directly on the token (`token.approve(lastKey, amount)`), and a
///        beneficiary may call {sweepAll} with any token addresses. Only tokens with a live
///        allowance to this contract are pulled (min of owner balance and allowance). Nothing
///        is enumerated on-chain and no keys are held. Mode is locked once the vault is
///        triggered and resets to `Listed` on each new registration. Native escrow is paid in
///        both modes.
///      - Epochs: slot and ticket keys include the epoch, so a re-registration starts
///        clean and old beneficiaries lose their claim rights for the new vault.
///      - Plain ETH transfers are rejected (no receive/fallback), funds only enter via
///        register/deposit/sweepToVault.
contract LastKey {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint32 public constant MIN_INTERVAL_DAYS = 1;
    uint32 public constant MAX_INTERVAL_DAYS = 3650;
    uint32 public constant MAX_GRACE_DAYS = 365;
    uint256 public constant MAX_BENEFICIARIES = 20;
    uint256 public constant MAX_PAYLOAD_BYTES = 8192;
    uint256 public constant TOTAL_BPS = 10000;
    uint256 public constant WARN_BPS = 8000; // TimerWarning fires at 80% of the check-in interval
    uint256 public constant MAX_SWEEP_TOKENS = 10;
    uint256 public constant MAX_ESCROW_TOKENS = 20;

    string public constant name = "LastKey Claim Ticket";
    string public constant symbol = "LKT";

    bytes4 private constant _INTERFACE_ERC165 = 0x01ffc9a7;
    bytes4 private constant _INTERFACE_ERC721 = 0x80ac58cd;
    bytes4 private constant _INTERFACE_ERC721_METADATA = 0x5b5e139f;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum SweepMode {
        Listed,                   // only owner-listed ERC20s (allowSweep) can be swept
        Everything                // also any ERC20 the owner approved to this contract (sweepAll)
    }

    struct Vault {
        bool active;              // false once closed or before first registration
        bool triggered;           // true once the first beneficiary has claimed
        uint32 intervalDays;      // check-in interval in days
        uint32 graceDays;        // extra days after the deadline before claims open
        uint64 lastCheckIn;       // unix time of the last check-in (or registration)
        uint64 epoch;             // increments on every registration
        bytes32 secretHash;       // keccak256 of the secret word for the current epoch
        bytes payload;            // encrypted instructions blob (ciphertext only)
        uint256 deposited;        // native escrow held for this owner
        uint256 pool;             // native escrow snapshot taken at the first claim
        address[] beneficiaries;  // beneficiaries of the current epoch
        SweepMode sweepMode;      // token sweep mode for the current epoch
        uint64 everythingAttestedAt; // 0 = no blanket-approval attestation this cycle; else when the owner attested
    }

    struct Slot {
        bool isBeneficiary;       // registered in this epoch
        bool claimed;             // has claimed in this epoch
        uint16 shareBps;          // share of the pool, in basis points (sums to 10000)
    }

    struct TicketInfo {
        address owner;            // vault owner that issued the ticket
        uint64 epoch;             // epoch the ticket was minted in
        address beneficiary;      // holder of the ticket
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(address => Vault) private _vaults;
    mapping(bytes32 => Slot) private _slots;

    mapping(uint256 => address) private _ticketOwner;
    mapping(address => uint256) private _ticketBalance;
    mapping(uint256 => TicketInfo) private _tickets;

    address public admin;
    address public watcher;

    // Token sweep (v3). Only tokens an owner explicitly approved can ever be swept.
    mapping(address => mapping(address => bool)) private _sweepAllowed;     // owner => token => approved
    mapping(address => address[]) private _sweepList;                         // owner => approved tokens
    mapping(address => mapping(address => uint256)) private _sweepIndex;      // owner => token => index + 1
    mapping(address => address[]) private _escrowTokens;                      // owner => tokens ever held in escrow
    mapping(address => mapping(address => bool)) private _escrowListed;       // owner => token => in _escrowTokens
    mapping(address => mapping(address => uint256)) private _tokenEscrow;     // owner => token => escrow held
    mapping(address => mapping(address => uint64)) private _tokenFrozenEpoch; // owner => token => epoch whose pool is frozen
    mapping(address => mapping(address => uint256)) private _tokenPool;       // owner => token => pool frozen at the first claim
    uint256 private _locked;

    // Notify (v4). Per-owner flags so pulse() emits each lifecycle event once per cycle.
    mapping(address => bytes32) private _warnedFor;   // owner => keccak(epoch, lastCheckIn) already warned
    mapping(address => uint64) private _openedEpoch;  // owner => epoch whose ClaimOpened was emitted

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event VaultRegistered(
        address indexed owner,
        uint64 indexed epoch,
        uint32 intervalDays,
        uint32 graceDays,
        uint256 beneficiaryCount,
        uint256 deposited,
        uint256 timestamp
    );
    event CheckedIn(address indexed owner, uint64 indexed epoch, address indexed by, uint256 timestamp);
    event Deposited(address indexed owner, uint256 amount, uint256 deposited);
    event VaultClosed(address indexed owner, uint64 indexed epoch, uint256 refunded, uint256 timestamp);
    event ClaimProof(
        address indexed owner,
        address indexed beneficiary,
        uint64 epoch,
        uint16 shareBps,
        uint256 payout,
        bytes32 claimId,
        uint256 timestamp
    );
    event WatcherUpdated(address indexed previousWatcher, address indexed newWatcher);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event SweepAllowed(address indexed owner, address indexed token, uint256 timestamp);
    event SweepRevoked(address indexed owner, address indexed token, uint256 timestamp);
    event TokenSwept(
        address indexed owner,
        address indexed token,
        address indexed by,
        uint256 amount,
        uint256 tokenEscrow,
        uint64 epoch,
        uint256 timestamp
    );
    event TokenPoolFrozen(address indexed owner, address indexed token, uint64 epoch, uint256 pool);
    event TokenPayout(
        address indexed owner,
        address indexed beneficiary,
        address indexed token,
        uint256 amount,
        uint64 epoch
    );
    event TokenRefunded(address indexed owner, address indexed token, uint256 amount);
    event SweepModeSet(bytes32 indexed vaultId, address indexed owner, uint8 mode, uint256 timestamp);
    event VaultUpdated(
        address indexed owner,
        uint64 indexed epoch,
        uint32 intervalDays,
        uint32 graceDays,
        uint256 beneficiaryCount,
        uint256 timestamp
    );
    /// @dev Blanket-approval attestation: the owner says "everything I approve to this vault may be swept".
    ///      The keeper checks this flag before it runs sweep-all. Token pulls still need each ERC20 allowance.
    event EverythingApprovalEnabled(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 timestamp);
    event EverythingApprovalRevoked(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 timestamp);

    // Notify (v4) structured events. vaultId = keccak256(abi.encode(owner, epoch)).
    event CheckInReceived(
        bytes32 indexed vaultId,
        address indexed owner,
        address indexed by,
        uint64 epoch,
        uint256 deadline,
        uint256 timestamp
    );
    event VaultFunded(
        bytes32 indexed vaultId,
        address indexed owner,
        address indexed funder,
        uint256 amount,
        uint256 deposited
    );
    event TimerWarning(
        bytes32 indexed vaultId,
        address indexed owner,
        uint64 epoch,
        uint256 deadline,
        uint256 claimOpensAt,
        uint16 elapsedBps,
        uint256 timestamp
    );
    event ClaimOpened(
        bytes32 indexed vaultId,
        address indexed owner,
        uint64 epoch,
        uint256 claimOpensAt,
        uint256 timestamp
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAdmin();
    error NotWatcher();
    error ZeroAddress();
    error VaultAlreadyActive();
    error NoActiveVault();
    error VaultTriggered();
    error InvalidInterval();
    error InvalidGrace();
    error EmptySecretHash();
    error InvalidPayloadSize();
    error InvalidBeneficiaryCount();
    error LengthMismatch();
    error ZeroShare();
    error InvalidShares();
    error SelfBeneficiary();
    error DuplicateBeneficiary();
    error ZeroDeposit();
    error NotBeneficiary();
    error AlreadyClaimed();
    error WrongSecret();
    error NotYetClaimable();
    error NotClaimedYet();
    error TransferFailed();
    error SoulboundTransfer();
    error NonexistentTicket();
    error SweepAlreadyAllowed();
    error SweepNotAllowed();
    error TooManySweepTokens();
    error TooManyEscrowTokens();
    error NothingToSweep();
    error TokenTransferFailed();
    error InvalidToken();
    error ReentrantCall();
    error InvalidSweepMode();
    error WrongSweepMode();
    error VaultIdMismatch();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier nonReentrant() {
        if (_locked == 1) revert ReentrantCall();
        _locked = 1;
        _;
        _locked = 0;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor() {
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    /// @notice Open a vault for `msg.sender` and mint one soulbound ticket per beneficiary.
    /// @param intervalDays Check-in interval in days (1 to 3650).
    /// @param graceDays Extra days after the deadline before claims open (0 to 365).
    /// @param beneficiaries 1 to 20 unique non-zero addresses, not the owner.
    /// @param sharesBps Basis points per beneficiary, same order, each > 0, summing to 10000.
    /// @param secretHash keccak256(bytes(secret word)). Non-zero.
    /// @param payload Encrypted instructions blob (1 to 8192 bytes). Ciphertext only.
    function register(
        uint32 intervalDays,
        uint32 graceDays,
        address[] calldata beneficiaries,
        uint16[] calldata sharesBps,
        bytes32 secretHash,
        bytes calldata payload
    ) external payable {
        Vault storage v = _vaults[msg.sender];
        if (v.active && !v.triggered) revert VaultAlreadyActive();
        if (intervalDays < MIN_INTERVAL_DAYS || intervalDays > MAX_INTERVAL_DAYS) revert InvalidInterval();
        if (graceDays > MAX_GRACE_DAYS) revert InvalidGrace();
        if (secretHash == bytes32(0)) revert EmptySecretHash();
        if (payload.length == 0 || payload.length > MAX_PAYLOAD_BYTES) revert InvalidPayloadSize();

        uint256 count = beneficiaries.length;
        if (count == 0 || count > MAX_BENEFICIARIES) revert InvalidBeneficiaryCount();
        if (sharesBps.length != count) revert LengthMismatch();

        uint256 total;
        for (uint256 i = 0; i < count; ++i) {
            if (sharesBps[i] == 0) revert ZeroShare();
            total += sharesBps[i];
        }
        if (total != TOTAL_BPS) revert InvalidShares();

        uint64 newEpoch = v.epoch + 1;
        v.epoch = newEpoch;
        v.active = true;
        v.triggered = false;
        v.pool = 0;
        v.intervalDays = intervalDays;
        v.graceDays = graceDays;
        v.sweepMode = SweepMode.Listed;
        v.everythingAttestedAt = 0;
        v.lastCheckIn = uint64(block.timestamp);
        v.secretHash = secretHash;
        v.payload = payload;
        v.deposited += msg.value;
        delete v.beneficiaries;

        for (uint256 i = 0; i < count; ++i) {
            address b = beneficiaries[i];
            if (b == address(0)) revert ZeroAddress();
            if (b == msg.sender) revert SelfBeneficiary();

            Slot storage s = _slots[_slotKey(msg.sender, newEpoch, b)];
            if (s.isBeneficiary) revert DuplicateBeneficiary();

            s.isBeneficiary = true;
            s.shareBps = sharesBps[i];
            v.beneficiaries.push(b);

            _mintTicket(msg.sender, newEpoch, b);
        }

        emit VaultRegistered(msg.sender, newEpoch, intervalDays, graceDays, count, v.deposited, block.timestamp);
        if (msg.value > 0) {
            emit VaultFunded(vaultIdOf(msg.sender, newEpoch), msg.sender, msg.sender, msg.value, v.deposited);
        }
    }

    /// @notice Edit a live vault in place, same epoch: new interval, grace, beneficiaries,
    ///        shares, passphrase hash and instructions. The clock does NOT reset: lastCheckIn
    ///        (and therefore the current deadline) carries over, so moving a 7-day check-in to
    ///        30 days keeps the time already elapsed. Old beneficiaries stop being beneficiaries
    ///        immediately; their soulbound tickets stay in their wallets but can never claim.
    function updateVault(
        uint32 intervalDays,
        uint32 graceDays,
        address[] calldata beneficiaries,
        uint16[] calldata sharesBps,
        bytes32 secretHash,
        bytes calldata payload
    ) external {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        if (intervalDays < MIN_INTERVAL_DAYS || intervalDays > MAX_INTERVAL_DAYS) revert InvalidInterval();
        if (graceDays > MAX_GRACE_DAYS) revert InvalidGrace();
        if (secretHash == bytes32(0)) revert EmptySecretHash();
        if (payload.length == 0 || payload.length > MAX_PAYLOAD_BYTES) revert InvalidPayloadSize();

        uint256 count = beneficiaries.length;
        if (count == 0 || count > MAX_BENEFICIARIES) revert InvalidBeneficiaryCount();
        if (sharesBps.length != count) revert LengthMismatch();

        uint256 total;
        for (uint256 i = 0; i < count; ++i) {
            if (sharesBps[i] == 0) revert ZeroShare();
            total += sharesBps[i];
        }
        if (total != TOTAL_BPS) revert InvalidShares();

        uint64 epoch = v.epoch;

        // Retire the old roster first so a removed beneficiary cannot claim mid-edit.
        for (uint256 i = 0; i < v.beneficiaries.length; ++i) {
            Slot storage old = _slots[_slotKey(msg.sender, epoch, v.beneficiaries[i])];
            old.isBeneficiary = false;
            old.shareBps = 0;
        }
        delete v.beneficiaries;

        for (uint256 i = 0; i < count; ++i) {
            address b = beneficiaries[i];
            if (b == address(0)) revert ZeroAddress();
            if (b == msg.sender) revert SelfBeneficiary();

            Slot storage s = _slots[_slotKey(msg.sender, epoch, b)];
            if (s.isBeneficiary) revert DuplicateBeneficiary();

            s.isBeneficiary = true;
            s.shareBps = sharesBps[i];
            // claimed stays as-is within the epoch, it was already impossible before the edit.
            v.beneficiaries.push(b);

            uint256 id = ticketIdOf(msg.sender, epoch, b);
            if (_ticketOwner[id] == address(0)) _mintTicket(msg.sender, epoch, b);
        }

        v.intervalDays = intervalDays;
        v.graceDays = graceDays;
        v.secretHash = secretHash;
        v.payload = payload;

        emit VaultUpdated(msg.sender, epoch, intervalDays, graceDays, count, block.timestamp);
    }

    /// @notice Prove liveness yourself. Resets the clock.
    function checkIn() external {
        _checkIn(msg.sender, msg.sender);
    }

    /// @notice Liveness from the trusted watcher (backend that sees the owner's outgoing
    ///         wallet activity). Only the watcher address set by the admin may call it.
    /// @param owner The vault owner to check in for.
    function watcherCheckIn(address owner) external {
        if (watcher == address(0) || msg.sender != watcher) revert NotWatcher();
        _checkIn(owner, msg.sender);
    }

    /// @notice Add native escrow to the caller's active, untriggered vault.
    function deposit() external payable {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        if (msg.value == 0) revert ZeroDeposit();
        v.deposited += msg.value;
        emit Deposited(msg.sender, msg.value, v.deposited);
        emit VaultFunded(vaultIdOf(msg.sender, v.epoch), msg.sender, msg.sender, msg.value, v.deposited);
    }

    /// @notice Close the caller's active, untriggered vault and refund native and token escrow.
    function close() external nonReentrant {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();

        uint256 refund = v.deposited;
        v.active = false;
        v.deposited = 0;
        emit VaultClosed(msg.sender, v.epoch, refund, block.timestamp);
        _refundTokens(msg.sender);
        if (refund > 0) _send(payable(msg.sender), refund);
    }

    // ---------------------------------------------------------------------
    // Token sweep (v3)
    // ---------------------------------------------------------------------

    /// @notice Owner grants this vault permission to sweep `token` (an ERC20 you hold).
    /// @dev The contract cannot grant the ERC20 allowance itself. The owner must also call
    ///      `token.approve(lastKeyAddress, amount)` on the token. Only tokens approved here
    ///      are ever swept. {revokeSweep} blocks future sweeps at once. Revoke the ERC20
    ///      allowance too, on the token itself.
    function allowSweep(address token) external {
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (_sweepAllowed[msg.sender][token]) revert SweepAlreadyAllowed();
        address[] storage list = _sweepList[msg.sender];
        if (list.length >= MAX_SWEEP_TOKENS) revert TooManySweepTokens();

        _sweepAllowed[msg.sender][token] = true;
        list.push(token);
        _sweepIndex[msg.sender][token] = list.length;
        emit SweepAllowed(msg.sender, token, block.timestamp);
    }

    /// @notice Owner withdraws permission for `token`. Future sweeps of it revert.
    function revokeSweep(address token) external {
        if (!_sweepAllowed[msg.sender][token]) revert SweepNotAllowed();
        _sweepAllowed[msg.sender][token] = false;

        address[] storage list = _sweepList[msg.sender];
        uint256 idx = _sweepIndex[msg.sender][token] - 1;
        address last = list[list.length - 1];
        list[idx] = last;
        _sweepIndex[msg.sender][last] = idx + 1;
        list.pop();
        delete _sweepIndex[msg.sender][token];

        emit SweepRevoked(msg.sender, token, block.timestamp);
    }

    /// @notice Choose how token sweeps work for your active, untriggered vault.
    /// @dev `vaultId` must equal `vaultIdOf(msg.sender, currentEpoch)`, so a stale id from a
    ///      previous cycle is rejected. Mode is locked once the vault is triggered.
    /// @param vaultId The vault cycle id (see {vaultIdOf}).
    /// @param mode 0 = Listed (owner-listed tokens only), 1 = Everything (also sweepAll).
    function setSweepMode(bytes32 vaultId, uint8 mode) external {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        if (vaultId != vaultIdOf(msg.sender, v.epoch)) revert VaultIdMismatch();
        if (mode > uint8(SweepMode.Everything)) revert InvalidSweepMode();
        v.sweepMode = SweepMode(mode);
        v.everythingAttestedAt = mode == uint8(SweepMode.Everything) ? uint64(block.timestamp) : 0;
        emit SweepModeSet(vaultId, msg.sender, mode, block.timestamp);
    }

    /// @notice One-click everything mode for the current cycle: records the owner's blanket-approval
    ///         attestation (on-chain flag + event the keeper checks) and switches the vault to Everything.
    /// @dev Attests intent only. The contract cannot grant ERC20 allowances. Each token still needs
    ///      `token.approve(lastKey, amount)` from the owner, and {sweepAll} pulls min(balance, allowance).
    ///      Attestations reset on every registration and are blocked after a claim.
    /// @param vaultId The vault cycle id (see {vaultIdOf}).
    function enableEverythingApproval(bytes32 vaultId) external {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        if (vaultId != vaultIdOf(msg.sender, v.epoch)) revert VaultIdMismatch();
        v.sweepMode = SweepMode.Everything;
        v.everythingAttestedAt = uint64(block.timestamp);
        emit SweepModeSet(vaultId, msg.sender, uint8(SweepMode.Everything), block.timestamp);
        emit EverythingApprovalEnabled(vaultId, msg.sender, v.epoch, block.timestamp);
    }

    /// @notice Withdraw the blanket-approval attestation and return the vault to Listed mode.
    /// @dev Existing ERC20 allowances are untouched. Revoke them on the token itself.
    function revokeEverythingApproval(bytes32 vaultId) external {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        if (vaultId != vaultIdOf(msg.sender, v.epoch)) revert VaultIdMismatch();
        v.sweepMode = SweepMode.Listed;
        v.everythingAttestedAt = 0;
        emit SweepModeSet(vaultId, msg.sender, uint8(SweepMode.Listed), block.timestamp);
        emit EverythingApprovalRevoked(vaultId, msg.sender, v.epoch, block.timestamp);
    }

    /// @notice Pull `owner`'s approved `token` into the vault's token escrow.
    /// @dev Callable by the trusted watcher at any time before the vault is triggered, or by
    ///      anyone once the claim window has opened. Pulls min(owner balance, owner allowance
    ///      to this contract). Blocked after the first claim (VaultTriggered).
    /// @param owner The vault owner whose approved token is swept.
    /// @param token An ERC20 the owner explicitly approved with {allowSweep}.
    function sweepToVault(address owner, address token) external nonReentrant {
        if (!_sweepAllowed[owner][token]) revert SweepNotAllowed();
        Vault storage v = _vaults[owner];
        _requireSweepWindow(v);

        if (_sweepInto(owner, token, v) == 0) revert NothingToSweep();
    }

    /// @notice Everything mode: sweep every token in `tokens` the owner approved to this contract.
    /// @dev Caller must be the watcher, or a beneficiary of the current epoch once the claim
    ///      window is open. Tokens the owner did not approve, or holds nothing of, are skipped
    ///      (no revert), so the batch is safe to pass speculatively. Reverts if nothing moved.
    ///      The contract never enumerates holdings: the caller supplies the candidate list and
    ///      the allowance decides what is pulled. Max MAX_ESCROW_TOKENS entries per call.
    /// @param owner The vault owner whose everything-mode vault is being swept.
    /// @param tokens Candidate ERC20 addresses (duplicates are harmless).
    function sweepAll(address owner, address[] calldata tokens) external nonReentrant {
        Vault storage v = _vaults[owner];
        if (v.sweepMode != SweepMode.Everything) revert WrongSweepMode();
        if (tokens.length > MAX_ESCROW_TOKENS) revert TooManyEscrowTokens();
        _requireSweepWindow(v);
        _requireSweepAllCaller(owner, v);

        uint256 moved;
        for (uint256 i = 0; i < tokens.length; ++i) {
            address token = tokens[i];
            if (token == address(0) || token.code.length == 0) continue;
            moved += _sweepInto(owner, token, v);
        }
        if (moved == 0) revert NothingToSweep();
    }

    // ---------------------------------------------------------------------
    // Beneficiary actions
    // ---------------------------------------------------------------------

    /// @notice Claim your share of `owner`'s vault by submitting the secret word.
    /// @dev Requires: active vault, caller is a beneficiary of the current epoch and has not
    ///      claimed, the secret matches, and `block.timestamp > claimOpensAt`. The first
    ///      claim freezes the vault, snapshots native and token escrow, and pays token shares.
    /// @param owner The vault owner whose switch has lapsed.
    /// @param secret The secret word the owner chose.
    function claim(address owner, string calldata secret) external nonReentrant {
        Vault storage v = _vaults[owner];
        if (!v.active) revert NoActiveVault();

        Slot storage s = _slots[_slotKey(owner, v.epoch, msg.sender)];
        if (!s.isBeneficiary) revert NotBeneficiary();
        if (s.claimed) revert AlreadyClaimed();
        if (keccak256(bytes(secret)) != v.secretHash) revert WrongSecret();
        if (block.timestamp <= _claimOpensAt(v)) revert NotYetClaimable();

        if (!v.triggered) {
            v.triggered = true;
            v.pool = v.deposited;
        }

        s.claimed = true;
        uint256 payout = (v.pool * s.shareBps) / TOTAL_BPS;
        v.deposited -= payout;

        bytes32 claimId = keccak256(abi.encode(owner, v.epoch, msg.sender, block.timestamp, s.shareBps));
        emit ClaimProof(owner, msg.sender, v.epoch, s.shareBps, payout, claimId, block.timestamp);

        _payTokens(owner, v.epoch, msg.sender, s.shareBps);
        if (payout > 0) _send(payable(msg.sender), payout);
    }

    /// @notice Read the encrypted instructions blob. Only a beneficiary who has claimed.
    /// @dev Returns ciphertext. Decrypt it client-side with the secret word.
    /// @param owner The vault owner.
    function readPayload(address owner) external view returns (bytes memory) {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, msg.sender)];
        if (!s.isBeneficiary) revert NotBeneficiary();
        if (!s.claimed) revert NotClaimedYet();
        return v.payload;
    }

    // ---------------------------------------------------------------------
    // Admin actions
    // ---------------------------------------------------------------------

    /// @notice Set the trusted watcher address. Zero disables watcher check-ins and sweeps.
    function setWatcher(address newWatcher) external onlyAdmin {
        emit WatcherUpdated(watcher, newWatcher);
        watcher = newWatcher;
    }

    /// @notice Hand the admin role to a new address.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ---------------------------------------------------------------------
    // Soulbound ticket (ERC-721 surface, transfers blocked)
    // ---------------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == _INTERFACE_ERC165 ||
            interfaceId == _INTERFACE_ERC721 ||
            interfaceId == _INTERFACE_ERC721_METADATA;
    }

    function balanceOf(address holder) external view returns (uint256) {
        if (holder == address(0)) revert ZeroAddress();
        return _ticketBalance[holder];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address holder = _ticketOwner[tokenId];
        if (holder == address(0)) revert NonexistentTicket();
        return holder;
    }

    /// @notice Inline JSON metadata for a ticket, including the vault's sweep mode.
    /// @dev Returned as an unencoded data URI. Attributes: sweep_mode ("listed" or
    ///      "everything") and current_cycle (whether the ticket's epoch is the vault's current one).
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ticketOwner[tokenId] == address(0)) revert NonexistentTicket();
        (uint8 mode, bool current) = _ticketSweepMode(tokenId);
        string memory modeName = mode == uint8(SweepMode.Everything) ? "everything" : "listed";
        string memory cycle = current ? "true" : "false";
        return string(
            abi.encodePacked(
                'data:application/json;utf8,{"name":"LastKey Claim Ticket","symbol":"LKT",',
                '"attributes":[{"trait_type":"sweep_mode","value":"',
                modeName,
                '"},{"trait_type":"current_cycle","value":',
                cycle,
                "}]}"
            )
        );
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_ticketOwner[tokenId] == address(0)) revert NonexistentTicket();
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure {
        revert SoulboundTransfer();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert SoulboundTransfer();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert SoulboundTransfer();
    }

    function approve(address, uint256) external pure {
        revert SoulboundTransfer();
    }

    function setApprovalForAll(address, bool) external pure {
        revert SoulboundTransfer();
    }

    /// @notice Ticket metadata: the vault owner, epoch and holder it was minted for.
    function ticketInfo(uint256 tokenId)
        external
        view
        returns (address vaultOwner, uint64 epoch, address beneficiary)
    {
        TicketInfo storage t = _tickets[tokenId];
        if (t.owner == address(0)) revert NonexistentTicket();
        return (t.owner, t.epoch, t.beneficiary);
    }

    /// @notice Sweep mode for a ticket's vault. `currentEpoch` is false when the ticket belongs
    ///         to an older cycle, in which case `mode` is Listed (the default) and not meaningful.
    /// @return mode 0 = Listed (owner-listed tokens only), 1 = Everything (sweepAll).
    /// @return currentEpoch Whether the ticket's epoch is the owner's current one.
    function ticketSweepMode(uint256 tokenId) external view returns (uint8 mode, bool currentEpoch) {
        if (_tickets[tokenId].owner == address(0)) revert NonexistentTicket();
        return _ticketSweepMode(tokenId);
    }

    function _ticketSweepMode(uint256 tokenId) internal view returns (uint8 mode, bool currentEpoch) {
        TicketInfo storage t = _tickets[tokenId];
        Vault storage v = _vaults[t.owner];
        if (v.epoch != t.epoch) return (uint8(SweepMode.Listed), false);
        return (uint8(v.sweepMode), true);
    }

    /// @notice Current sweep mode for an owner's vault (Listed or Everything).
    function sweepModeOf(address owner) external view returns (uint8) {
        return uint8(_vaults[owner].sweepMode);
    }

    /// @notice Blanket-approval attestation for the owner's current cycle.
    /// @return attested True when the owner enabled everything mode and has not revoked it.
    /// @return attestedAt Unix time of the attestation (0 when not attested).
    function everythingAttestedOf(address owner) external view returns (bool attested, uint64 attestedAt) {
        uint64 at = _vaults[owner].everythingAttestedAt;
        return (at != 0, at);
    }

    /// @notice How much of `token` a sweep could pull from `owner` right now: min(balance, allowance to this vault).
    /// @dev A live snapshot, not a reservation. It is 0 for a non-contract token, for no allowance or no balance.
    function approvalsRemaining(address owner, address token) external view returns (uint256) {
        if (token.code.length == 0) return 0;
        IERC20Minimal t = IERC20Minimal(token);
        uint256 bal = t.balanceOf(owner);
        uint256 allowed = t.allowance(owner, address(this));
        return bal < allowed ? bal : allowed;
    }

    /// @notice Deterministic ticket id for (owner, epoch, beneficiary).
    function ticketIdOf(address owner, uint64 epoch, address beneficiary) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(owner, epoch, beneficiary)));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Core vault state for an owner.
    function getVault(address owner)
        external
        view
        returns (
            bool active,
            bool triggered,
            uint32 intervalDays,
            uint32 graceDays,
            uint64 lastCheckIn,
            uint64 epoch,
            uint256 deposited,
            uint256 pool,
            address[] memory beneficiaries
        )
    {
        Vault storage v = _vaults[owner];
        return (
            v.active,
            v.triggered,
            v.intervalDays,
            v.graceDays,
            v.lastCheckIn,
            v.epoch,
            v.deposited,
            v.pool,
            v.beneficiaries
        );
    }

    /// @notice Deadline (lastCheckIn + interval) and the time claims open (deadline + grace).
    /// @notice The passphrase hash of the current epoch. Zero before first registration.
    function secretHashOf(address owner) external view returns (bytes32) {
        return _vaults[owner].secretHash;
    }

    /// @notice The encrypted instructions blob of the current epoch.
    function payloadOf(address owner) external view returns (bytes memory) {
        return _vaults[owner].payload;
    }

    function timing(address owner) external view returns (uint256 deadline, uint256 claimOpensAt) {
        Vault storage v = _vaults[owner];
        return (_deadline(v), _claimOpensAt(v));
    }

    /// @notice Slot data for a beneficiary in the owner's current epoch.
    function slotOf(address owner, address beneficiary)
        external
        view
        returns (bool isBeneficiary, bool claimed, uint16 shareBps)
    {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        return (s.isBeneficiary, s.claimed, s.shareBps);
    }

    /// @notice Whether `beneficiary` can claim right now (time window only, not the secret).
    function isClaimable(address owner, address beneficiary) external view returns (bool) {
        Vault storage v = _vaults[owner];
        if (!v.active) return false;
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        if (!s.isBeneficiary || s.claimed) return false;
        return block.timestamp > _claimOpensAt(v);
    }

    /// @notice Whether `beneficiary` has claimed in the owner's current epoch.
    function hasClaimed(address owner, address beneficiary) external view returns (bool) {
        Vault storage v = _vaults[owner];
        return _slots[_slotKey(owner, v.epoch, beneficiary)].claimed;
    }

    /// @notice Projected native payout for a beneficiary: share of the pool if triggered, else of the live escrow.
    function payoutOf(address owner, address beneficiary) external view returns (uint256) {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        if (!s.isBeneficiary || s.claimed) return 0;
        uint256 base = v.triggered ? v.pool : v.deposited;
        return (base * s.shareBps) / TOTAL_BPS;
    }

    /// @notice Escrowed balance of `token` held for `owner`'s vault.
    function tokenEscrowOf(address owner, address token) external view returns (uint256) {
        return _tokenEscrow[owner][token];
    }

    /// @notice Whether `owner` currently allows sweeping `token`.
    function isSweepAllowed(address owner, address token) external view returns (bool) {
        return _sweepAllowed[owner][token];
    }

    /// @notice Tokens `owner` currently allows to be swept.
    function sweepTokensOf(address owner) external view returns (address[] memory) {
        return _sweepList[owner];
    }

    /// @notice Every token that has ever been held in `owner`'s escrow.
    function escrowTokensOf(address owner) external view returns (address[] memory) {
        return _escrowTokens[owner];
    }

    /// @notice Projected token payout for a beneficiary in the owner's current epoch.
    function tokenPayoutOf(address owner, address token, address beneficiary) external view returns (uint256) {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        if (!s.isBeneficiary || s.claimed) return 0;
        uint256 base = _tokenBase(owner, token, v);
        return (base * s.shareBps) / TOTAL_BPS;
    }

    // ---------------------------------------------------------------------
    // Notify (v4)
    // ---------------------------------------------------------------------

    /// @notice Stable id for one vault cycle: keccak256(abi.encode(owner, epoch)).
    function vaultIdOf(address owner, uint64 epoch) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, epoch));
    }

    /// @notice Permissionless status pulse. Emits TimerWarning once when 80% of the check-in
    ///         interval has elapsed (once per check-in), and ClaimOpened once per epoch after
    ///         the claim window opens. Anyone (a keeper, a notify service, the owner) may call
    ///         it. It is a no-op when nothing is due, so it is safe to call often.
    /// @param owner The vault owner to pulse.
    function pulse(address owner) external {
        Vault storage v = _vaults[owner];
        if (!v.active || v.triggered) return;

        bytes32 vid = vaultIdOf(owner, v.epoch);
        uint256 window = uint256(v.intervalDays) * 1 days;
        uint256 elapsed = block.timestamp - uint256(v.lastCheckIn);
        bytes32 cycle = keccak256(abi.encode(v.epoch, v.lastCheckIn));

        if (elapsed * TOTAL_BPS >= window * WARN_BPS && _warnedFor[owner] != cycle) {
            _warnedFor[owner] = cycle;
            uint256 bps = (elapsed * TOTAL_BPS) / window;
            if (bps > TOTAL_BPS) bps = TOTAL_BPS;
            emit TimerWarning(
                vid,
                owner,
                v.epoch,
                _deadline(v),
                _claimOpensAt(v),
                uint16(bps),
                block.timestamp
            );
        }

        if (block.timestamp > _claimOpensAt(v) && _openedEpoch[owner] != v.epoch) {
            _openedEpoch[owner] = v.epoch;
            emit ClaimOpened(vid, owner, v.epoch, _claimOpensAt(v), block.timestamp);
        }
    }

    /// @notice Everything an off-chain watcher needs to attest this vault to another chain.
    /// @return active Whether the vault is open.
    /// @return triggered Whether a claim already happened.
    /// @return epoch Current epoch.
    /// @return lastCheckIn Unix time of the last check-in (freshness key for attestations).
    /// @return claimOpensAt Time the claim window opens.
    /// @return secretHash keccak256 of the secret word for the current epoch.
    /// @return beneficiaries Beneficiaries of the current epoch.
    /// @return sharesBps Basis-point shares, same order as beneficiaries.
    function attestationData(address owner)
        external
        view
        returns (
            bool active,
            bool triggered,
            uint64 epoch,
            uint64 lastCheckIn,
            uint256 claimOpensAt,
            bytes32 secretHash,
            address[] memory beneficiaries,
            uint16[] memory sharesBps
        )
    {
        Vault storage v = _vaults[owner];
        uint256 n = v.beneficiaries.length;
        sharesBps = new uint16[](n);
        for (uint256 i = 0; i < n; ++i) {
            sharesBps[i] = _slots[_slotKey(owner, v.epoch, v.beneficiaries[i])].shareBps;
        }
        return (
            v.active,
            v.triggered,
            v.epoch,
            v.lastCheckIn,
            _claimOpensAt(v),
            v.secretHash,
            v.beneficiaries,
            sharesBps
        );
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    /// @dev Sweeps are blocked after a claim. The watcher may sweep any time before that.
    ///      Anyone may run sweepToVault once the claim window is open.
    function _requireSweepWindow(Vault storage v) internal view {
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        bool isWatcher = watcher != address(0) && msg.sender == watcher;
        if (isWatcher) return;
        if (block.timestamp <= _claimOpensAt(v)) revert NotYetClaimable();
    }

    /// @dev sweepAll is restricted to the watcher or a beneficiary of the current epoch.
    function _requireSweepAllCaller(address owner, Vault storage v) internal view {
        bool isWatcher = watcher != address(0) && msg.sender == watcher;
        if (isWatcher) return;
        Slot storage s = _slots[_slotKey(owner, v.epoch, msg.sender)];
        if (!s.isBeneficiary) revert NotBeneficiary();
    }

    /// @dev Pulls min(owner balance, owner allowance) of `token` into escrow. Returns 0 when
    ///      nothing is approved or held, without reverting. Caller decides whether 0 is an error.
    function _sweepInto(address owner, address token, Vault storage v) internal returns (uint256) {
        IERC20Minimal t = IERC20Minimal(token);
        uint256 bal = t.balanceOf(owner);
        uint256 allowed = t.allowance(owner, address(this));
        uint256 amount = bal < allowed ? bal : allowed;
        if (amount == 0) return 0;

        if (!_escrowListed[owner][token]) {
            if (_escrowTokens[owner].length >= MAX_ESCROW_TOKENS) revert TooManyEscrowTokens();
            _escrowListed[owner][token] = true;
            _escrowTokens[owner].push(token);
        }

        uint256 before = t.balanceOf(address(this));
        _safeTransferFrom(token, owner, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before;
        if (received == 0) return 0;

        _tokenEscrow[owner][token] += received;
        emit TokenSwept(owner, token, msg.sender, received, _tokenEscrow[owner][token], v.epoch, block.timestamp);
        return received;
    }

    function _checkIn(address owner, address by) internal {
        Vault storage v = _vaults[owner];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        v.lastCheckIn = uint64(block.timestamp);
        emit CheckedIn(owner, v.epoch, by, block.timestamp);
        emit CheckInReceived(
            vaultIdOf(owner, v.epoch),
            owner,
            by,
            v.epoch,
            _deadline(v),
            block.timestamp
        );
    }

    /// @dev Token base for payouts: the pool frozen at the first claim of this epoch,
    ///      or the live escrow before any claim.
    function _tokenBase(address owner, address token, Vault storage v) internal view returns (uint256) {
        if (v.triggered && _tokenFrozenEpoch[owner][token] == v.epoch) {
            return _tokenPool[owner][token];
        }
        if (v.triggered) return 0;
        return _tokenEscrow[owner][token];
    }

    /// @dev Pays this beneficiary's share of every escrowed token. Freezes each token's pool
    ///      for the epoch at the first claim (the first call with this epoch).
    function _payTokens(address owner, uint64 epoch, address beneficiary, uint16 shareBps) internal {
        address[] storage tokens = _escrowTokens[owner];
        for (uint256 i = 0; i < tokens.length; ++i) {
            address token = tokens[i];
            if (_tokenFrozenEpoch[owner][token] != epoch) {
                _tokenFrozenEpoch[owner][token] = epoch;
                _tokenPool[owner][token] = _tokenEscrow[owner][token];
                emit TokenPoolFrozen(owner, token, epoch, _tokenPool[owner][token]);
            }
            uint256 payout = (_tokenPool[owner][token] * shareBps) / TOTAL_BPS;
            if (payout == 0) continue;
            _tokenEscrow[owner][token] -= payout;
            _safeTransfer(token, beneficiary, payout);
            emit TokenPayout(owner, beneficiary, token, payout, epoch);
        }
    }

    /// @dev Refunds all token escrow to the owner on close.
    function _refundTokens(address owner) internal {
        address[] storage tokens = _escrowTokens[owner];
        for (uint256 i = 0; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 amount = _tokenEscrow[owner][token];
            if (amount == 0) continue;
            _tokenEscrow[owner][token] = 0;
            _safeTransfer(token, owner, amount);
            emit TokenRefunded(owner, token, amount);
        }
    }

    function _mintTicket(address owner, uint64 epoch, address beneficiary) internal {
        uint256 id = ticketIdOf(owner, epoch, beneficiary);
        _ticketOwner[id] = beneficiary;
        _ticketBalance[beneficiary] += 1;
        _tickets[id] = TicketInfo(owner, epoch, beneficiary);
        emit Transfer(address(0), beneficiary, id);
    }

    function _send(address payable to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _slotKey(address owner, uint64 epoch, address beneficiary) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, epoch, beneficiary));
    }

    function _deadline(Vault storage v) internal view returns (uint256) {
        return uint256(v.lastCheckIn) + uint256(v.intervalDays) * 1 days;
    }

    function _claimOpensAt(Vault storage v) internal view returns (uint256) {
        return uint256(v.lastCheckIn) + (uint256(v.intervalDays) + uint256(v.graceDays)) * 1 days;
    }
}
