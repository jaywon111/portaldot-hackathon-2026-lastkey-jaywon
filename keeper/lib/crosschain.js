// End-to-end cross-chain claim preparation/submission. Source state is read again at
// preparation time; beneficiary secret remains solely in the beneficiary-side caller.
const { ethers } = require("ethers");
const crypto = require("crypto");
const { buildAttestations, attestationDigest, encodeAttestation, quorumSignatures } = require("./attest");

const RECEIVER_ABI = [
  "function threshold() view returns (uint256)",
  "function mirrorOf(bytes32 id) view returns (uint256 balance,uint256 pool,bool triggered,bool exists)",
  "function mirrorIdOf(uint256 srcChainId,address srcVault,address owner,uint64 epoch) pure returns (bytes32)",
  "function claimCrossChain(bytes attestation,bytes[] signatures,string secret)",
];

async function prepareCrossChainClaim({ sourceProvider, destinationProvider, srcChainId, srcVault, owner, beneficiary, receiverAddress, watcherWallets, expiresInSeconds = 900, now = () => Math.floor(Date.now() / 1000) }) {
  const sourceNetwork = await sourceProvider.getNetwork();
  if (BigInt(sourceNetwork.chainId) !== BigInt(srcChainId)) throw new Error("source RPC chain id mismatch");
  const destinationNetwork = await destinationProvider.getNetwork();
  const receiverCode = await destinationProvider.getCode(receiverAddress);
  if (!receiverCode || receiverCode === "0x") throw new Error("destination receiver has no contract code");

  const lk = new ethers.Contract(srcVault, [
    "function attestationData(address owner) view returns (bool active,bool triggered,uint64 epoch,uint64 lastCheckIn,uint256 claimOpensAt,bytes32 secretHash,address[] beneficiaries,uint16[] sharesBps)",
  ], sourceProvider);
  const state = await lk.attestationData(owner);
  if (!state.active) throw new Error("source vault is not active");
  if (state.triggered) throw new Error("source vault already triggered; cross-chain attestations are closed");
  const block = await sourceProvider.getBlock("latest");
  if (!block || BigInt(block.timestamp) <= BigInt(state.claimOpensAt)) throw new Error("source claim window is not open yet");

  const expiry = BigInt(now()) + BigInt(expiresInSeconds);
  if (expiresInSeconds <= 0 || expiresInSeconds > 3600) throw new Error("attestation expiry must be between 1 and 3600 seconds");
  const atts = await buildAttestations({
    sourceProvider, srcChainId, srcVault, owner, expiresAt: expiry,
    nonceSeed: crypto.randomBytes(32).toString("hex"),
  });
  const att = atts.find((entry) => ethers.getAddress(entry.beneficiary) === ethers.getAddress(beneficiary));
  if (!att) throw new Error("beneficiary is not in the current source roster");
  if (!Array.isArray(watcherWallets) || watcherWallets.length === 0) throw new Error("no watcher signer wallets provided");
  const signerAddresses = watcherWallets.map((w) => ethers.getAddress(w.address));
  if (new Set(signerAddresses).size !== signerAddresses.length) throw new Error("watcher signer wallets must be distinct");

  const receiver = new ethers.Contract(receiverAddress, RECEIVER_ABI, destinationProvider);
  const mirrorId = await receiver.mirrorIdOf(srcChainId, srcVault, owner, att.epoch);
  const mirror = await receiver.mirrorOf(mirrorId);
  if (!mirror.exists || mirror.triggered || BigInt(mirror.balance) === 0n) throw new Error("destination mirror is not funded and available");
  const threshold = Number(await receiver.threshold());
  if (watcherWallets.length < threshold) throw new Error(`need ${threshold} watcher signatures; received ${watcherWallets.length}`);
  const digest = attestationDigest({ chainId: destinationNetwork.chainId, receiver: receiverAddress, att });
  const signatures = await quorumSignatures(watcherWallets, digest, threshold);
  return { attestation: encodeAttestation(att), signatures, digest, mirrorId, att, expiresAt: expiry };
}

async function submitCrossChainClaim({ destinationSigner, receiverAddress, claimPackage, secret }) {
  const receiver = new ethers.Contract(receiverAddress, RECEIVER_ABI, destinationSigner);
  const address = await destinationSigner.getAddress();
  if (ethers.getAddress(claimPackage.att.beneficiary) !== ethers.getAddress(address)) throw new Error("destination signer must be the attested beneficiary");
  const tx = await receiver.claimCrossChain(claimPackage.attestation, claimPackage.signatures, secret);
  const receipt = await tx.wait();
  return { txHash: receipt.hash || tx.hash, blockNumber: receipt.blockNumber, status: Number(receipt.status) };
}

module.exports = { prepareCrossChainClaim, submitCrossChainClaim };
