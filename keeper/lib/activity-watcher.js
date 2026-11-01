// Consent-bound activity watcher. Only successful outgoing transactions from a
// wallet that signed the exact authorization below can refresh its named owner.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ABI = ["function watcherCheckIn(address owner)"];
const ACTIVITY_SCOPE = "successful outgoing EVM transactions only";

function authorizationMessage({ chainId, lastKey, owner, wallet, expiresAt }) {
  return [
    "LastKey wallet activity heartbeat authorization",
    `Chain ID: ${BigInt(chainId)}`,
    `LastKey contract: ${ethers.getAddress(lastKey)}`,
    `Vault owner to check in: ${ethers.getAddress(owner)}`,
    `Wallet whose activity is tracked: ${ethers.getAddress(wallet)}`,
    `Activity definition: ${ACTIVITY_SCOPE}`,
    `Expires at (unix seconds): ${BigInt(expiresAt)}`,
    "This authorizes LastKey's configured watcher to call watcherCheckIn for this owner when this wallet sends a successful transaction. It does not authorize custody, signing, or transfer of funds.",
  ].join("\n");
}

async function validateAuthorization(record, { chainId, lastKey, now = Math.floor(Date.now() / 1000) }) {
  if (!record || !record.owner || !record.wallet || !record.signature || record.expiresAt == null) throw new Error("incomplete wallet authorization");
  if (BigInt(record.chainId) !== BigInt(chainId)) throw new Error("authorization chain mismatch");
  if (ethers.getAddress(record.lastKey) !== ethers.getAddress(lastKey)) throw new Error("authorization LastKey mismatch");
  if (BigInt(record.expiresAt) <= BigInt(now)) throw new Error("wallet authorization expired");
  const message = authorizationMessage({ ...record, chainId, lastKey });
  const recovered = ethers.verifyMessage(message, record.signature);
  if (recovered !== ethers.getAddress(record.wallet)) throw new Error("wallet authorization signature mismatch");
  return { owner: ethers.getAddress(record.owner), wallet: ethers.getAddress(record.wallet), expiresAt: Number(record.expiresAt) };
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return { lastBlock: null, processed: [] }; throw e; }
}
function writeState(file, state) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function createActivityWatcher({ provider, signer, lastKey, chainId, authorizations, stateFile, confirmations = 1, log = () => {} }) {
  const contract = new ethers.Contract(lastKey, ABI, signer);
  const walletOwners = new Map();
  let state = readState(stateFile);
  let busy = false;

  async function initialize(now) {
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== BigInt(chainId)) throw new Error("provider chain id does not match configured chain id");
    for (const record of authorizations) {
      const auth = await validateAuthorization(record, { chainId, lastKey, now });
      if (walletOwners.has(auth.wallet.toLowerCase())) throw new Error("wallet authorization duplicated");
      walletOwners.set(auth.wallet.toLowerCase(), auth.owner);
    }
    if (walletOwners.size === 0) throw new Error("no user-authorized wallets configured");
    return { authorizedWallets: walletOwners.size };
  }

  async function tick() {
    if (busy) return { skipped: true, checkIns: 0 };
    busy = true;
    let checkIns = 0;
    try {
      const head = Number(await provider.getBlockNumber()) - Math.max(0, Number(confirmations) - 1);
      let from = state.lastBlock == null ? head : Number(state.lastBlock) + 1;
      if (from > head) return { head, scanned: 0, checkIns };
      const first = from;
      for (; from <= head; from++) {
        const block = await provider.getBlock(from, true);
        if (!block) {
          state.lastBlock = from;
          writeState(stateFile, state);
          continue;
        }
        const transactions = block.prefetchedTransactions || block.transactions || [];
        for (const item of transactions) {
          const tx = typeof item === "string" ? await provider.getTransaction(item) : item;
          if (!tx || !tx.from) continue;
          const owner = walletOwners.get(ethers.getAddress(tx.from).toLowerCase());
          if (!owner || state.processed.includes(tx.hash)) continue;
          const receipt = await provider.getTransactionReceipt(tx.hash);
          if (!receipt || Number(receipt.status) !== 1) continue;
          const result = await contract.watcherCheckIn(owner);
          await result.wait();
          state.processed.push(tx.hash);
          if (state.processed.length > 10000) state.processed.splice(0, state.processed.length - 10000);
          checkIns++;
          log(`authorized activity check-in owner=${owner} tx=${tx.hash}`);
        }
        state.lastBlock = from;
        writeState(stateFile, state);
      }
      return { head, scanned: from - first, checkIns };
    } finally {
      busy = false;
    }
  }

  return { initialize, tick };
}

module.exports = { ACTIVITY_SCOPE, authorizationMessage, validateAuthorization, createActivityWatcher };
