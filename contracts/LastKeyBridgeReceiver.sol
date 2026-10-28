// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICrossChainReceiver} from "./ICrossChainReceiver.sol";

/// @title LastKeyBridgeReceiver
/// @notice Watcher-quorum implementation of {ICrossChainReceiver}. It lets a beneficiary claim a
///         mirrored escrow on a second EVM chain. A quorum of watcher keys signs an attestation
///         of one source-chain LastKey vault cycle (roster, shares, claim window, secret hash)
///         and the destination pays out after the secret word matches.
/// @dev Trust model (be explicit with judges and users):
///      - The destination chain does NOT read the source chain. It trusts `threshold` of the
///        `signers` to attest the source state. Use independent operators in production.
///      - Each attestation is bound to this chain (chainid + contract address), to a source
///        chain id and vault, and to a single-use nonce. Each (mirror, beneficiary) pair can
///        claim once. Attestations expire at `expiresAt`.
///      - The first claim on a mirror snapshots its balance. Later funding is refused.
///      - On portaldot testnet the watcher quorum runs locally in keeper/ (see README). The
///        ICrossChainReceiver interface is the portable part; the signer set is swappable.
///      - Freshness limit: a source-chain check-in made after an attestation was issued does
///        not revoke it. Watchers should only sign when the source claim window is open, and
///        attestations carry a short expiry.
contract LastKeyBridgeReceiver is ICrossChainReceiver {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Attestation {
        uint256 srcChainId;   // chain where the LastKey vault lives
        address srcVault;     // LastKey contract on the source chain
        address owner;        // vault owner on the source chain
        uint64 epoch;         // epoch of the vault cycle being attested
        uint64 lastCheckIn;   // source lastCheckIn at attestation time
        uint256 claimOpensAt; // source claim window opening time
        bytes32 secretHash;   // keccak256(bytes(secret)) for this epoch
        address beneficiary;  // the beneficiary this attestation pays
        uint16 shareBps;      // that beneficiary's share on the source roster
        bytes32 nonce;        // single-use nonce chosen by the watcher quorum
        uint256 expiresAt;    // attestation is invalid after this time
    }

    struct Mirror {
        uint256 balance;       // escrow funded so far (before the first claim)
        uint256 pool;          // snapshot taken at the first claim
        bool triggered;        // first claim happened, funding closed
        bool exists;           // funded at least once
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public admin;
    uint256 public threshold;
    address[] private _signerList;
    mapping(address => bool) public isSigner;

    mapping(bytes32 => Mirror) private _mirrors;
    mapping(bytes32 => mapping(address => bool)) public claimedBy;     // mirror => beneficiary => claimed
    mapping(bytes32 => mapping(address => uint16)) public shareOf;     // mirror => beneficiary => attested share
    mapping(bytes32 => uint256) public claimedBps;                     // mirror => sum of claimed shares
    mapping(bytes32 => bool) public nonceUsed;                         // nonce => used

    uint256 private _locked;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event QuorumUpdated(uint256 threshold, uint256 signerCount);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAdmin();
    error ZeroAddress();
    error InvalidQuorum();
    error DuplicateSigner();
    error MirrorTriggered();
    error ZeroFunding();
    error AttestationExpired();
    error AttestationNotForSender();
    error WrongMirror();
    error NonceReused();
    error WrongSecret();
    error NotYetClaimable();
    error AlreadyClaimed();
    error ShareOverflow();
    error InsufficientSignatures();
    error SignerOrder();
    error UnknownSigner();
    error BadSignature();
    error PayoutFailed();
    error ReentrantCall();

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
    // Constructor and admin
    // ---------------------------------------------------------------------

    constructor(address[] memory watchers, uint256 quorum) {
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
        _setQuorum(watchers, quorum);
    }

    /// @notice Replace the watcher set and threshold.
    function setQuorum(address[] calldata watchers, uint256 quorum) external onlyAdmin {
        _setQuorum(watchers, quorum);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function signerSet() external view returns (address[] memory) {
        return _signerList;
    }

    function _setQuorum(address[] memory list, uint256 quorum) internal {
        if (list.length == 0 || quorum == 0 || quorum > list.length) revert InvalidQuorum();
        for (uint256 i = 0; i < _signerList.length; ++i) {
            isSigner[_signerList[i]] = false;
        }
        delete _signerList;
        for (uint256 i = 0; i < list.length; ++i) {
            address s = list[i];
            if (s == address(0)) revert ZeroAddress();
            if (isSigner[s]) revert DuplicateSigner();
            isSigner[s] = true;
            _signerList.push(s);
        }
        threshold = quorum;
        emit QuorumUpdated(quorum, list.length);
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    function mirrorIdOf(uint256 srcChainId, address srcVault, address owner, uint64 epoch)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(srcChainId, srcVault, owner, epoch));
    }

    /// @notice Fund the mirrored escrow for one source vault cycle until its first claim.
    function fundMirror(uint256 srcChainId, address srcVault, address owner, uint64 epoch)
        external
        payable
        nonReentrant
    {
        if (msg.value == 0) revert ZeroFunding();
        bytes32 id = mirrorIdOf(srcChainId, srcVault, owner, epoch);
        Mirror storage m = _mirrors[id];
        if (m.triggered) revert MirrorTriggered();
        m.balance += msg.value;
        m.exists = true;
        emit MirrorFunded(id, msg.sender, msg.value, m.balance);
    }

    function mirrorOf(bytes32 id)
        external
        view
        returns (uint256 balance, uint256 pool, bool triggered, bool exists)
    {
        Mirror storage m = _mirrors[id];
        return (m.balance, m.pool, m.triggered, m.exists);
    }

    // ---------------------------------------------------------------------
    // Attestation
    // ---------------------------------------------------------------------

    /// @notice Digest the watchers sign (EIP-191 over this 32-byte value). Bound to this chain and contract.
    function attestationDigest(Attestation memory a) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), a));
    }

    // ---------------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------------

    /// @notice Claim this beneficiary's share on the destination chain.
    /// @param attestation abi.encode(Attestation).
    /// @param signatures Watcher signatures over the EIP-191 digest, signers strictly ascending.
    /// @param secret The source-chain secret word.
    function claimCrossChain(bytes calldata attestation, bytes[] calldata signatures, string calldata secret)
        external
        nonReentrant
    {
        Attestation memory a = abi.decode(attestation, (Attestation));

        if (a.beneficiary != msg.sender) revert AttestationNotForSender();
        if (block.timestamp > a.expiresAt) revert AttestationExpired();
        if (keccak256(bytes(secret)) != a.secretHash) revert WrongSecret();
        if (block.timestamp <= a.claimOpensAt) revert NotYetClaimable();

        bytes32 id = mirrorIdOf(a.srcChainId, a.srcVault, a.owner, a.epoch);
        Mirror storage m = _mirrors[id];
        if (!m.exists) revert WrongMirror();

        bytes32 digest = attestationDigest(a);
        _verifyQuorum(digest, signatures);
        if (nonceUsed[a.nonce]) revert NonceReused();
        nonceUsed[a.nonce] = true;

        if (claimedBy[id][msg.sender]) revert AlreadyClaimed();
        shareOf[id][msg.sender] = a.shareBps;

        if (!m.triggered) {
            m.triggered = true;
            m.pool = m.balance;
        }

        claimedBy[id][msg.sender] = true;
        claimedBps[id] += a.shareBps;
        if (claimedBps[id] > 10000) revert ShareOverflow();

        uint256 payout = (m.pool * a.shareBps) / 10000;
        if (payout > 0) {
            m.balance -= payout;
            (bool ok, ) = payable(msg.sender).call{value: payout}("");
            if (!ok) revert PayoutFailed();
        }

        emit CrossChainClaimed(id, msg.sender, payout, digest);
    }

    /// @dev Checks `threshold` distinct watcher signatures over the EIP-191 wrapped digest.
    ///      Signers must be strictly ascending (no duplicates), in the set, and each signature
    ///      must be low-s, so a signature cannot be replayed under another encoding.
    function _verifyQuorum(bytes32 digest, bytes[] calldata sigs) internal view {
        if (sigs.length < threshold) revert InsufficientSignatures();
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address last = address(0);
        for (uint256 i = 0; i < threshold; ++i) {
            address signer = _recover(signed, sigs[i]);
            if (signer <= last) revert SignerOrder();
            if (!isSigner[signer]) revert UnknownSigner();
            last = signer;
        }
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // secp256k1n / 2
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address rec = ecrecover(hash, v, r, s);
        if (rec == address(0)) revert BadSignature();
        return rec;
    }
}
