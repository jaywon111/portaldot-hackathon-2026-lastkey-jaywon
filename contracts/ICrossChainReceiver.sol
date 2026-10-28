// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICrossChainReceiver
/// @notice Adapter interface for a destination-chain escrow that pays out a LastKey vault's
///         claim after a quorum of watchers attests the source-chain state. The interface is the
///         product: any transport (a LayerZero/Wormhole/Hyperlane receiver, a light client, or the
///         watcher-quorum bridge in {LastKeyBridgeReceiver}) can implement it and keep the same
///         owner-facing and beneficiary-facing calls.
/// @dev Trust model is defined by the implementation. The watcher-quorum implementation trusts
///      `threshold` of its signers to attest the source vault's roster, claim window and secret
///      hash. It does not verify the source chain on-chain.
interface ICrossChainReceiver {
    event MirrorFunded(bytes32 indexed vaultId, address indexed funder, uint256 amount, uint256 balance);
    event CrossChainClaimed(
        bytes32 indexed vaultId,
        address indexed beneficiary,
        uint256 payout,
        bytes32 attestationId
    );

    /// @notice Deterministic id for a mirrored vault cycle on this destination chain.
    function mirrorIdOf(uint256 srcChainId, address srcVault, address owner, uint64 epoch)
        external
        pure
        returns (bytes32);

    /// @notice Fund the mirrored escrow for one source vault cycle. Open until the first claim.
    function fundMirror(uint256 srcChainId, address srcVault, address owner, uint64 epoch) external payable;

    /// @notice Claim a beneficiary's share on this chain using a quorum-signed attestation and the secret word.
    /// @param attestation abi.encode(Attestation) as produced by the watchers.
    /// @param signatures 65-byte ECDSA signatures over the attestation digest, sorted by signer address ascending.
    /// @param secret The secret word the owner chose on the source chain.
    function claimCrossChain(bytes calldata attestation, bytes[] calldata signatures, string calldata secret) external;
}
