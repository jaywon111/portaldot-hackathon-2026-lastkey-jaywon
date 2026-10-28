// Keeper sweep-all: one-click "everything" claim, run by a beneficiary's key (or a keeper that holds it).
// Order matters: token pulls must land BEFORE the first claim, because the claim freezes token escrow.
//   1. read the owner's blanket-approval attestation (everythingAttestedOf). No attestation = refuse.
//   2. scan candidate tokens: a known list + every token that sent the owner a Transfer in recent blocks.
//   3. for each candidate, read balanceOf(owner) and allowance(owner, lastKey); keep min > 0.
//   4. pull in batches of `batchSize` via sweepAll (default 5 tokens per tx). A failing batch is retried
//      token by token so one bad token (paused, blacklisting, fee-on-transfer edge cases) cannot block the rest.
//   5. claim for the beneficiary, with the owner's secret word, exactly like auto-claim.
// The keeper never holds the owner's key. It only uses the owner's standing ERC20 allowances.
const { Contract, ethers } = require("ethers");
const { autoClaim, LK_ABI } = require("./keeper");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const SWEEP_ABI = [
  "function everythingAttestedOf(address owner) view returns (bool attested, uint64 attestedAt)",
  "function sweepAll(address owner, address[] tokens)",
  "function vaultIdOf(address owner, uint64 epoch) view returns (bytes32)",
  "function attestationData(address owner) view returns (bool active, bool triggered, uint64 epoch, uint64 lastCheckIn, uint256 claimOpensAt, bytes32 secretHash, address[] beneficiaries, uint16[] sharesBps)",
];
const MAX_TOKENS_PER_TX = 20; // contract MAX_ESCROW_TOKENS
const DEFAULT_BATCH = 5;

/// Token addresses that sent the owner a Transfer in the last `lookback` blocks, scanned in chunks.
/// Logs are the only discovery signal, so an old token with no recent transfer to the owner is missed.
async function transferSources(provider, owner, { lookback = 50000, chunk = 2000 } = {}) {
  const latest = await provider.getBlockNumber();
  const from = Math.max(0, latest - lookback);
  const topicOwner = ethers.zeroPadValue(owner, 32);
  const found = new Set();
  for (let start = from; start <= latest; start += chunk) {
    const end = Math.min(latest, start + chunk - 1);
    const logs = await provider.getLogs({
      fromBlock: start,
      toBlock: end,
      topics: [TRANSFER_TOPIC, null, topicOwner],
    });
    for (const l of logs) found.add(ethers.getAddress(l.address));
  }
  return [...found];
}

/// Candidate tokens = known list + Transfer-log sources, deduped. Each is then checked on-chain.
async function scanHoldings({ provider, owner, lkAddress, knownTokens = [], lookback, chunk }) {
  const fromLogs = await transferSources(provider, owner, { lookback, chunk });
  const candidates = [...new Set([...knownTokens, ...fromLogs].map((a) => ethers.getAddress(a)))];
  const rows = [];
  for (const token of candidates) {
    const code = await provider.getCode(token);
    if (code === "0x" || code.length <= 2) {
      rows.push({ token, source: "skip", reason: "no contract code", amount: 0n });
      continue;
    }
    const erc = new Contract(token, ERC20_ABI, provider);
    let bal = 0n;
    let allowed = 0n;
    try {
      bal = await erc.balanceOf(owner);
      allowed = await erc.allowance(owner, lkAddress);
    } catch (e) {
      rows.push({ token, source: "skip", reason: "balanceOf/allowance reverted", amount: 0n });
      continue;
    }
    const amount = bal < allowed ? bal : allowed;
    const source = knownTokens.some((k) => ethers.getAddress(k) === token) ? "known" : "transfer-log";
    rows.push({
      token,
      source,
      balance: bal,
      allowance: allowed,
      amount,
      reason: amount === 0n ? (bal === 0n ? "no balance" : "no allowance to vault") : "pullable",
    });
  }
  return rows;
}

function chunkList(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/// Full sweep-all run. Returns a report; throws only on preconditions (wrong vault id, no attestation,
/// window closed) so nothing irreversible happens before the checks pass.
async function sweepAllAndClaim({
  signer,
  provider,
  lkAddress,
  owner,
  vaultId,
  secret,
  knownTokens = [],
  lookback = 50000,
  chunk = 2000,
  batchSize = DEFAULT_BATCH,
  now,
}) {
  const beneficiary = await signer.getAddress();
  const lk = new Contract(lkAddress, [...LK_ABI, ...SWEEP_ABI], signer);

  const data = await lk.attestationData(owner);
  if (!data.active) throw new Error("owner has no active vault");
  if (data.triggered) throw new Error("vault already triggered by a claim; sweeps are closed");
  const expectedId = await lk.vaultIdOf(owner, data.epoch);
  if (String(vaultId).toLowerCase() !== String(expectedId).toLowerCase()) {
    throw new Error("vault id does not match the owner's current cycle");
  }

  const [attested, attestedAt] = await lk.everythingAttestedOf(owner);
  if (!attested) throw new Error("owner has not enabled everything approval for this cycle");

  // Use the chain's clock, not the local one, unless the caller pins `now` (tests).
  const chainNow = now ?? Number((await provider.getBlock("latest")).timestamp);
  const claimOpensAt = Number(data.claimOpensAt);
  if (chainNow <= claimOpensAt) throw new Error("claim window not open yet");

  const rows = await scanHoldings({ provider, owner, lkAddress, knownTokens, lookback, chunk });
  const pullable = rows.filter((r) => r.amount > 0n).slice(0, MAX_TOKENS_PER_TX);
  const overflow = rows.filter((r) => r.amount > 0n).slice(MAX_TOKENS_PER_TX).map((r) => r.token);

  const batches = [];
  for (const group of chunkList(pullable, Math.max(1, Math.min(batchSize, MAX_TOKENS_PER_TX)))) {
    const tokens = group.map((r) => r.token);
    try {
      const tx = await lk.sweepAll(owner, tokens);
      const rec = await tx.wait();
      batches.push({ tokens, status: "swept", txHash: rec.hash ?? tx.hash });
    } catch (e) {
      // Retry token by token so one bad token cannot block the rest of the batch.
      for (const token of tokens) {
        try {
          const tx = await lk.sweepAll(owner, [token]);
          const rec = await tx.wait();
          batches.push({ tokens: [token], status: "swept", txHash: rec.hash ?? tx.hash });
        } catch (e2) {
          batches.push({ tokens: [token], status: "failed", error: shortError(e2) });
        }
      }
    }
  }

  const claim = await autoClaim({ signer, lkAddress, owner, secret, now });

  return {
    beneficiary,
    owner,
    vaultId: expectedId,
    attestedAt: Number(attestedAt),
    scanned: rows.length,
    pullable: pullable.map((r) => ({ token: r.token, amount: r.amount.toString(), source: r.source })),
    skipped: rows.filter((r) => r.amount === 0n).map((r) => ({ token: r.token, reason: r.reason })),
    overflow,
    batches,
    claim,
  };
}

function shortError(e) {
  const msg = (e && (e.shortMessage || e.reason || e.message)) || "unknown error";
  return String(msg).split("\n")[0].slice(0, 200);
}

module.exports = {
  ERC20_ABI,
  SWEEP_ABI,
  TRANSFER_TOPIC,
  DEFAULT_BATCH,
  MAX_TOKENS_PER_TX,
  transferSources,
  scanHoldings,
  sweepAllAndClaim,
  chunkList,
};
