// Keeper logic. Pure functions over an ethers provider or signer, so the CLI and the tests share them.
const { Contract, ethers } = require("ethers");

const LK_ABI = [
  "function attestationData(address owner) view returns (bool active, bool triggered, uint64 epoch, uint64 lastCheckIn, uint256 claimOpensAt, bytes32 secretHash, address[] beneficiaries, uint16[] sharesBps)",
  "function timing(address owner) view returns (uint256 deadline, uint256 claimOpensAt)",
  "function isClaimable(address owner, address beneficiary) view returns (bool)",
  "function hasClaimed(address owner, address beneficiary) view returns (bool)",
  "function payoutOf(address owner, address beneficiary) view returns (uint256)",
  "function escrowTokensOf(address owner) view returns (address[])",
  "function tokenPayoutOf(address owner, address token, address beneficiary) view returns (uint256)",
  "function pulse(address owner)",
  "function claim(address owner, string secret)",
];

const WARN_BPS = 8000; // matches TimerWarning at 80% of the check-in interval

/// One row per owner. status is one of: inactive, active, warning, claimable, triggered.
async function readStatus(runner, lkAddress, owner, now = Math.floor(Date.now() / 1000)) {
  const lk = new Contract(lkAddress, LK_ABI, runner);
  const d = await lk.attestationData(owner);
  const [deadline, claimOpensAt] = await lk.timing(owner);
  const lastCheckIn = Number(d.lastCheckIn);
  const deadlineN = Number(deadline);
  const intervalSec = deadlineN - lastCheckIn - (Number(claimOpensAt) - deadlineN);
  const interval = Math.max(1, deadlineN - lastCheckIn);
  const elapsed = Math.max(0, now - lastCheckIn);
  const elapsedBps = Math.min(10000, Math.floor((elapsed * 10000) / interval));
  let status;
  if (!d.active) status = "inactive";
  else if (d.triggered) status = "triggered";
  else if (now > Number(claimOpensAt)) status = "claimable";
  else if (elapsedBps >= WARN_BPS) status = "warning";
  else status = "active";
  return {
    owner,
    status,
    epoch: Number(d.epoch),
    lastCheckIn,
    deadline: deadlineN,
    claimOpensAt: Number(claimOpensAt),
    elapsedBps,
    beneficiaries: d.beneficiaries,
    intervalSec,
  };
}

function formatTable(rows) {
  const head = ["owner", "status", "epoch", "elapsed", "claim opens (UTC)"];
  const body = rows.map((r) => [
    r.owner,
    r.status,
    String(r.epoch),
    (r.elapsedBps / 100).toFixed(1) + "%",
    new Date(r.claimOpensAt * 1000).toISOString().replace(".000Z", "Z"),
  ]);
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ")).join("\n");
}

/// Claim for one beneficiary if the window is open and they have not claimed yet.
/// Returns {action: "claimed"|"skip", reason, txHash?}. Never sends a tx when skipping.
async function autoClaim({ signer, lkAddress, owner, secret, now = Math.floor(Date.now() / 1000) }) {
  const beneficiary = await signer.getAddress();
  const lk = new Contract(lkAddress, LK_ABI, signer);
  const [claimable, done] = await Promise.all([
    lk.isClaimable(owner, beneficiary),
    lk.hasClaimed(owner, beneficiary),
  ]);
  if (done) return { action: "skip", reason: "already claimed" };
  if (!claimable) return { action: "skip", reason: "not claimable yet" };
  const payout = await lk.payoutOf(owner, beneficiary);
  if (payout === 0n) {
    // Token-only vaults have no native payout. Skip only when every escrowed token also pays this beneficiary 0.
    const tokens = await lk.escrowTokensOf(owner);
    let tokenPaid = 0n;
    for (const t of tokens) tokenPaid += await lk.tokenPayoutOf(owner, t, beneficiary);
    if (tokenPaid === 0n) return { action: "skip", reason: "no payout for this beneficiary" };
  }
  const tx = await lk.claim(owner, secret);
  const rec = await tx.wait();
  return { action: "claimed", txHash: rec.hash ?? tx.hash, payout: payout.toString(), block: rec.blockNumber, now };
}

module.exports = { LK_ABI, WARN_BPS, readStatus, formatTable, autoClaim };
