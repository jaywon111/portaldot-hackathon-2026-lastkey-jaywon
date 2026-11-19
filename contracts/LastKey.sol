// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Portaldot Precompile Interfaces (Substrate Pallet Access)
interface IScheduler {
    function schedule(
        address when,
        uint256 delay,
        uint8 priority,
        bytes calldata call,
        bytes calldata data
    ) external;
}

interface IProxy {
    function addProxy(address delegate, uint8 proxyType, uint32 delay) external;
}

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
    uint256 public constant WARN_BPS = 8000; 
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
        Listed,                   
        Everything                
    }

    struct Vault {
        bool active;              
        bool triggered;           
        uint32 intervalDays;      
        uint32 graceDays;        
        uint64 lastCheckIn;       
        uint64 epoch;             
        bytes32 secretHash;       
        bytes payload;            
        uint256 deposited;        
        uint256 pool;             
        address[] beneficiaries;  
        SweepMode sweepMode;      
        uint64 everythingAttestedAt; 
    }

    struct Slot {
        bool isBeneficiary;       
        bool claimed;             
        uint16 shareBps;          
    }

    struct TicketInfo {
        address owner;            
        uint64 epoch;             
        address beneficiary;      
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

    mapping(address => mapping(address => bool)) private _sweepAllowed;     
    mapping(address => address[]) private _sweepList;                         
    mapping(address => mapping(address => uint256)) private _sweepIndex;      
    mapping(address => address[]) private _escrowTokens;                      
    mapping(address => mapping(address => bool)) private _escrowListed;       
    mapping(address => mapping(address => uint256)) private _tokenEscrow;     
    mapping(address => mapping(address => uint64)) private _tokenFrozenEpoch; 
    mapping(address => mapping(address => uint256)) private _tokenPool;       
    uint256 private _locked;

    mapping(address => bytes32) private _warnedFor;   
    mapping(address => uint8) private _shardThreshold;               
    mapping(address => mapping(address => bytes32[])) private _shards; 
    mapping(address => uint64) private _openedEpoch;  

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event VaultRegistered(address indexed owner, uint64 indexed epoch, uint32 intervalDays, uint32 graceDays, uint256 beneficiaryCount, uint256 deposited, uint256 timestamp);
    event CheckedIn(address indexed owner, uint64 indexed epoch, address indexed by, uint256 timestamp);
    event Deposited(address indexed owner, uint256 amount, uint256 deposited);
    event VaultClosed(address indexed owner, uint64 indexed epoch, uint256 refunded, uint256 timestamp);
    event ClaimProof(address indexed owner, address indexed beneficiary, uint64 epoch, uint16 shareBps, uint256 payout, bytes32 claimId, uint256 timestamp);
    event WatcherUpdated(address indexed previousWatcher, address indexed newWatcher);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event SweepAllowed(address indexed owner, address indexed token, uint256 timestamp);
    event SweepRevoked(address indexed owner, address indexed token, uint256 timestamp);
    event TokenSwept(address indexed owner, address indexed token, address indexed by, uint256 amount, uint256 tokenEscrow, uint64 epoch, uint256 timestamp);
    event TokenPoolFrozen(address indexed owner, address indexed token, uint64 epoch, uint256 pool);
    event TokenPayout(address indexed owner, address indexed beneficiary, address indexed token, uint256 amount, uint64 epoch);
    event TokenRefunded(address indexed owner, address indexed token, uint256 amount);
    event SweepModeSet(bytes32 indexed vaultId, address indexed owner, uint8 mode, uint256 timestamp);
    event ShardSplitSet(address indexed owner, uint64 indexed epoch, uint8 threshold, uint256 shardCount, uint256 timestamp);
    event VaultUpdated(address indexed owner, uint64 indexed epoch, uint32 intervalDays, uint32 graceDays, uint256 beneficiaryCount, uint256 timestamp);
    event EverythingApprovalEnabled(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 timestamp);
    event EverythingApprovalRevoked(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 timestamp);

    event CheckInReceived(bytes32 indexed vaultId, address indexed owner, address indexed by, uint64 epoch, uint256 deadline, uint256 timestamp);
    event VaultFunded(bytes32 indexed vaultId, address indexed owner, address indexed funder, uint256 amount, uint256 deposited);
    event TimerWarning(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 deadline, uint256 claimOpensAt, uint16 elapsedBps, uint256 timestamp);
    event ClaimOpened(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 claimOpensAt, uint256 timestamp);

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
    error ShardThresholdInvalid();
    error ShardCountMismatch();
    error ShardsDisabled();
    error NotCurrentBeneficiary();
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

        // =====================================================================
        // --- NEW: ON-CHAIN SCHEDULING (Replaces Watcher Bot) ---
        // =====================================================================
        address schedulerPrecompile = 0x0000000000000000000000000000000000000806; 
        uint256 delay = uint256(intervalDays + graceDays) * 1 days;
        
        // Schedule the auto-trigger for when the timer expires
        IScheduler(schedulerPrecompile).schedule(
            address(this), 
            delay,         
            0,             
            address(this), 
            abi.encodeWithSignature("triggerInheritance(address)", msg.sender) 
        );

        // =====================================================================
        // --- NEW: NATIVE PROXY (Point 2) ---
        // =====================================================================
        // Add the first beneficiary as a time-delayed proxy
        address proxyPrecompile = 0x0000000000000000000000000000000000000805;
        IProxy(proxyPrecompile).addProxy(beneficiaries[0], 0, uint32(intervalDays));
    }

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

    function checkIn() external {
        _checkIn(msg.sender, msg.sender);
    }

    function watcherCheckIn(address owner) external {
        if (watcher == address(0) || msg.sender != watcher) revert NotWatcher();
        _checkIn(owner, msg.sender);
    }

    function deposit() external payable {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        if (msg.value == 0) revert ZeroDeposit();
        v.deposited += msg.value;
        emit Deposited(msg.sender, msg.value, v.deposited);
        emit VaultFunded(vaultIdOf(msg.sender, v.epoch), msg.sender, msg.sender, msg.value, v.deposited);
    }

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

    function sweepToVault(address owner, address token) external nonReentrant {
        if (!_sweepAllowed[owner][token]) revert SweepNotAllowed();
        Vault storage v = _vaults[owner];
        _requireSweepWindow(v);
        if (_sweepInto(owner, token, v) == 0) revert NothingToSweep();
    }

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

    function readPayload(address owner) external view returns (bytes memory) {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, msg.sender)];
        if (!s.isBeneficiary) revert NotBeneficiary();
        if (!s.claimed) revert NotClaimedYet();
        return v.payload;
    }

    function setWatcher(address newWatcher) external onlyAdmin {
        emit WatcherUpdated(watcher, newWatcher);
        watcher = newWatcher;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == _INTERFACE_ERC165 || interfaceId == _INTERFACE_ERC721 || interfaceId == _INTERFACE_ERC721_METADATA;
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

    function transferFrom(address, address, uint256) external pure { revert SoulboundTransfer(); }
    function safeTransferFrom(address, address, uint256) external pure { revert SoulboundTransfer(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert SoulboundTransfer(); }
    function approve(address, uint256) external pure { revert SoulboundTransfer(); }
    function setApprovalForAll(address, bool) external pure { revert SoulboundTransfer(); }

    function ticketInfo(uint256 tokenId) external view returns (address vaultOwner, uint64 epoch, address beneficiary) {
        TicketInfo storage t = _tickets[tokenId];
        if (t.owner == address(0)) revert NonexistentTicket();
        return (t.owner, t.epoch, t.beneficiary);
    }

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

    function sweepModeOf(address owner) external view returns (uint8) {
        return uint8(_vaults[owner].sweepMode);
    }

    function everythingAttestedOf(address owner) external view returns (bool attested, uint64 attestedAt) {
        uint64 at = _vaults[owner].everythingAttestedAt;
        return (at != 0, at);
    }

    function approvalsRemaining(address owner, address token) external view returns (uint256) {
        if (token.code.length == 0) return 0;
        IERC20Minimal t = IERC20Minimal(token);
        uint256 bal = t.balanceOf(owner);
        uint256 allowed = t.allowance(owner, address(this));
        return bal < allowed ? bal : allowed;
    }

    function ticketIdOf(address owner, uint64 epoch, address beneficiary) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(owner, epoch, beneficiary)));
    }

    function getVault(address owner) external view returns (bool active, bool triggered, uint32 intervalDays, uint32 graceDays, uint64 lastCheckIn, uint64 epoch, uint256 deposited, uint256 pool, address[] memory beneficiaries) {
        Vault storage v = _vaults[owner];
        return (v.active, v.triggered, v.intervalDays, v.graceDays, v.lastCheckIn, v.epoch, v.deposited, v.pool, v.beneficiaries);
    }

    function setShardSplit(uint8 threshold, bytes32[][] calldata shards) external {
        Vault storage v = _vaults[msg.sender];
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        uint256 count = v.beneficiaries.length;
        if (threshold < 2 || threshold > count) revert ShardThresholdInvalid();
        if (shards.length != count) revert ShardCountMismatch();

        _shardThreshold[msg.sender] = threshold;
        for (uint256 i = 0; i < count; ++i) {
            _shards[msg.sender][v.beneficiaries[i]] = shards[i];
        }
        emit ShardSplitSet(msg.sender, v.epoch, threshold, count, block.timestamp);
    }

    function shardThresholdOf(address owner) external view returns (uint8) {
        return _shardThreshold[owner];
    }

    function shardOf(address owner) external view returns (bytes32[] memory) {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, msg.sender)];
        if (!s.isBeneficiary) revert NotCurrentBeneficiary();
        return _shards[owner][msg.sender];
    }

    function secretHashOf(address owner) external view returns (bytes32) {
        return _vaults[owner].secretHash;
    }

    function payloadOf(address owner) external view returns (bytes memory) {
        return _vaults[owner].payload;
    }

    function timing(address owner) external view returns (uint256 deadline, uint256 claimOpensAt) {
        Vault storage v = _vaults[owner];
        return (_deadline(v), _claimOpensAt(v));
    }

    function slotOf(address owner, address beneficiary) external view returns (bool isBeneficiary, bool claimed, uint16 shareBps) {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        return (s.isBeneficiary, s.claimed, s.shareBps);
    }

    function isClaimable(address owner, address beneficiary) external view returns (bool) {
        Vault storage v = _vaults[owner];
        if (!v.active) return false;
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        if (!s.isBeneficiary || s.claimed) return false;
        return block.timestamp > _claimOpensAt(v);
    }

    function hasClaimed(address owner, address beneficiary) external view returns (bool) {
        Vault storage v = _vaults[owner];
        return _slots[_slotKey(owner, v.epoch, beneficiary)].claimed;
    }

    function payoutOf(address owner, address beneficiary) external view returns (uint256) {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        if (!s.isBeneficiary || s.claimed) return 0;
        uint256 base = v.triggered ? v.pool : v.deposited;
        return (base * s.shareBps) / TOTAL_BPS;
    }

    function tokenEscrowOf(address owner, address token) external view returns (uint256) {
        return _tokenEscrow[owner][token];
    }

    function isSweepAllowed(address owner, address token) external view returns (bool) {
        return _sweepAllowed[owner][token];
    }

    function sweepTokensOf(address owner) external view returns (address[] memory) {
        return _sweepList[owner];
    }

    function escrowTokensOf(address owner) external view returns (address[] memory) {
        return _escrowTokens[owner];
    }

    function tokenPayoutOf(address owner, address token, address beneficiary) external view returns (uint256) {
        Vault storage v = _vaults[owner];
        Slot storage s = _slots[_slotKey(owner, v.epoch, beneficiary)];
        if (!s.isBeneficiary || s.claimed) return 0;
        uint256 base = _tokenBase(owner, token, v);
        return (base * s.shareBps) / TOTAL_BPS;
    }

    function vaultIdOf(address owner, uint64 epoch) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, epoch));
    }

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
            emit TimerWarning(vid, owner, v.epoch, _deadline(v), _claimOpensAt(v), uint16(bps), block.timestamp);
        }

        if (block.timestamp > _claimOpensAt(v) && _openedEpoch[owner] != v.epoch) {
            _openedEpoch[owner] = v.epoch;
            emit ClaimOpened(vid, owner, v.epoch, _claimOpensAt(v), block.timestamp);
        }
    }

    function attestationData(address owner) external view returns (bool active, bool triggered, uint64 epoch, uint64 lastCheckIn, uint256 claimOpensAt, bytes32 secretHash, address[] memory beneficiaries, uint16[] memory sharesBps) {
        Vault storage v = _vaults[owner];
        uint256 n = v.beneficiaries.length;
        sharesBps = new uint16[](n);
        for (uint256 i = 0; i < n; ++i) {
            sharesBps[i] = _slots[_slotKey(owner, v.epoch, v.beneficiaries[i])].shareBps;
        }
        return (v.active, v.triggered, v.epoch, v.lastCheckIn, _claimOpensAt(v), v.secretHash, v.beneficiaries, sharesBps);
    }

    function _requireSweepWindow(Vault storage v) internal view {
        if (!v.active) revert NoActiveVault();
        if (v.triggered) revert VaultTriggered();
        bool isWatcher = watcher != address(0) && msg.sender == watcher;
        if (isWatcher) return;
        if (block.timestamp <= _claimOpensAt(v)) revert NotYetClaimable();
    }

    function _requireSweepAllCaller(address owner, Vault storage v) internal view {
        bool isWatcher = watcher != address(0) && msg.sender == watcher;
        if (isWatcher) return;
        Slot storage s = _slots[_slotKey(owner, v.epoch, msg.sender)];
        if (!s.isBeneficiary) revert NotBeneficiary();
    }

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
        emit CheckInReceived(vaultIdOf(owner, v.epoch), owner, by, v.epoch, _deadline(v), block.timestamp);
    }

    function _tokenBase(address owner, address token, Vault storage v) internal view returns (uint256) {
        if (v.triggered && _tokenFrozenEpoch[owner][token] == v.epoch) {
            return _tokenPool[owner][token];
        }
        if (v.triggered) return 0;
        return _tokenEscrow[owner][token];
    }

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
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
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

    // =====================================================================
    // --- NEW: AUTOMATED TRIGGER FUNCTION (Point 1) ---
    // =====================================================================
    /// @notice This function is automatically called by the Portaldot Scheduler precompile
    ///         when the inheritance timer expires. It unlocks the vault without needing bots.
    function triggerInheritance(address owner) external {
        // Security: Only allow the contract itself to execute this (via the Scheduler)
        require(msg.sender == address(this), "Only self-scheduled calls allowed");
        
        Vault storage v = _vaults[owner];
        
        // If the vault is still active and hasn't been triggered yet
        if (v.active && !v.triggered) {
            v.triggered = true;
            // The vault is now unlocked for claims automatically!
        }
    }
}
