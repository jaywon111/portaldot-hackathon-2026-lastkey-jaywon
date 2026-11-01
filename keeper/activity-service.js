#!/usr/bin/env node
// Automatic consent-bound wallet-activity heartbeat. Never accepts private keys in argv.
// Required: RPC_URL, CHAIN_ID, LASTKEY_ADDRESS, WATCHER_PRIVATE_KEY, WATCH_AUTHORIZATIONS
// Optional: WATCH_STATE_FILE (./watch-state.json), POLL_MS (10000), CONFIRMATIONS (2)
const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");
const { rpcProvider } = require("../shared/rpc");
const { createActivityWatcher } = require("./lib/activity-watcher");

const { RPC_URL, CHAIN_ID, LASTKEY_ADDRESS, WATCHER_PRIVATE_KEY, WATCH_AUTHORIZATIONS } = process.env;
if (!RPC_URL || !CHAIN_ID || !LASTKEY_ADDRESS || !WATCHER_PRIVATE_KEY || !WATCH_AUTHORIZATIONS) {
  console.error("set RPC_URL, CHAIN_ID, LASTKEY_ADDRESS, WATCHER_PRIVATE_KEY, and WATCH_AUTHORIZATIONS");
  process.exit(1);
}
const authPath = path.resolve(WATCH_AUTHORIZATIONS);
const authorizations = JSON.parse(fs.readFileSync(authPath, "utf8"));
if (!Array.isArray(authorizations)) throw new Error("WATCH_AUTHORIZATIONS must be a JSON array of signed authorizations");
const provider = rpcProvider(RPC_URL, CHAIN_ID);
const signer = new Wallet(WATCHER_PRIVATE_KEY, provider);
const watcher = createActivityWatcher({
  provider, signer, lastKey: LASTKEY_ADDRESS, chainId: CHAIN_ID, authorizations,
  stateFile: path.resolve(process.env.WATCH_STATE_FILE || "watch-state.json"),
  confirmations: Number(process.env.CONFIRMATIONS || 2),
  log: (message) => console.error(new Date().toISOString(), message),
});
const pollMs = Math.max(1000, Number(process.env.POLL_MS || 10000));
let busy = false;
async function loop() {
  if (busy) return;
  busy = true;
  try {
    const result = await watcher.tick();
    if (result.scanned || result.checkIns) console.error(`scanned ${result.scanned} blocks, sent ${result.checkIns} check-ins`);
  } catch (error) { console.error("activity watcher poll failed:", error.message); }
  finally { busy = false; }
}
watcher.initialize().then(() => {
  console.error(`LastKey activity watcher active for ${authorizations.length} authorized wallet(s)`);
  loop();
  setInterval(loop, pollMs);
}).catch((error) => { console.error("refusing to start:", error.message); process.exit(1); });
