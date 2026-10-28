// Watcher-quorum attestation helpers. Used by the keeper CLI and by the bridge tests.
// An attestation describes one beneficiary's claim right on a SOURCE chain LastKey vault.
// Watchers read the source vault, build the attestation, and sign its digest. The destination
// LastKeyBridgeReceiver checks the signatures and pays out.
const { ethers } = require("ethers");

const ATTESTATION_TUPLE =
  "tuple(uint256 srcChainId,address srcVault,address owner,uint64 epoch,uint64 lastCheckIn," +
  "uint256 claimOpensAt,bytes32 secretHash,address beneficiary,uint16 shareBps,bytes32 nonce,uint256 expiresAt)";

const coder = ethers.AbiCoder.defaultAbiCoder();

function encodeAttestation(att) {
  return coder.encode([ATTESTATION_TUPLE], [toTuple(att)]);
}

function decodeAttestation(bytes) {
  const [t] = coder.decode([ATTESTATION_TUPLE], bytes);
  return t;
}

function toTuple(a) {
  return [
    BigInt(a.srcChainId),
    a.srcVault,
    a.owner,
    BigInt(a.epoch),
    BigInt(a.lastCheckIn),
    BigInt(a.claimOpensAt),
    a.secretHash,
    a.beneficiary,
    Number(a.shareBps),
    a.nonce,
    BigInt(a.expiresAt),
  ];
}

/// Digest the contract checks: keccak256(abi.encode(chainid, receiver, attestation)).
function attestationDigest({ chainId, receiver, att }) {
  return ethers.keccak256(coder.encode(["uint256", "address", ATTESTATION_TUPLE], [BigInt(chainId), receiver, toTuple(att)]));
}

/// Sign the digest as the contract expects (EIP-191 over the 32-byte digest).
async function signDigest(wallet, digest) {
  return wallet.signMessage(ethers.getBytes(digest));
}

/// Quorum signatures ordered by signer address ascending, the order the receiver requires.
async function quorumSignatures(wallets, digest, threshold) {
  const sorted = [...wallets].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
  const chosen = sorted.slice(0, threshold);
  const sigs = [];
  for (const w of chosen) sigs.push(await signDigest(w, digest));
  return sigs;
}

/// Read the source vault and build one attestation per beneficiary of the current epoch.
/// Only active, untriggered vaults can be attested.
async function buildAttestations({ sourceProvider, srcChainId, srcVault, owner, expiresAt, nonceSeed }) {
  const lk = new ethers.Contract(
    srcVault,
    [
      "function attestationData(address owner) view returns (bool active, bool triggered, uint64 epoch, uint64 lastCheckIn, uint256 claimOpensAt, bytes32 secretHash, address[] beneficiaries, uint16[] sharesBps)",
    ],
    sourceProvider
  );
  const d = await lk.attestationData(owner);
  if (!d.active) throw new Error("source vault is not active");
  if (d.triggered) throw new Error("source vault already triggered");
  const out = [];
  for (let i = 0; i < d.beneficiaries.length; i++) {
    out.push({
      srcChainId: BigInt(srcChainId),
      srcVault,
      owner,
      epoch: d.epoch,
      lastCheckIn: d.lastCheckIn,
      claimOpensAt: d.claimOpensAt,
      secretHash: d.secretHash,
      beneficiary: d.beneficiaries[i],
      shareBps: d.sharesBps[i],
      nonce: ethers.keccak256(ethers.toUtf8Bytes(`${nonceSeed}:${d.epoch}:${d.beneficiaries[i]}`)),
      expiresAt: BigInt(expiresAt),
    });
  }
  return out;
}

const RECEIVER_FUNCS = [
  "function mirrorIdOf(uint256 srcChainId, address srcVault, address owner, uint64 epoch) pure returns (bytes32)",
  "function fundMirror(uint256 srcChainId, address srcVault, address owner, uint64 epoch) payable",
  "function claimCrossChain(bytes attestation, bytes[] signatures, string secret)",
];

/// ICrossChainReceiver interface id: XOR of the function selectors. Lets an integrator check
/// an adapter exposes the same surface without reading the source.
function receiverInterfaceId() {
  const iface = new ethers.Interface(RECEIVER_FUNCS);
  let id = 0n;
  for (const f of iface.fragments) {
    if (f.type !== "function") continue;
    id ^= BigInt(f.selector);
  }
  return "0x" + id.toString(16).padStart(8, "0");
}

module.exports = {
  ATTESTATION_TUPLE,
  encodeAttestation,
  decodeAttestation,
  attestationDigest,
  signDigest,
  quorumSignatures,
  buildAttestations,
  receiverInterfaceId,
  RECEIVER_FUNCS,
};
