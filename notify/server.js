#!/usr/bin/env node
// Run: RPC_URL=... LASTKEY_ADDRESS=0x... node notify/server.js
// Env: RPC_URL (required), LASTKEY_ADDRESS (required), CHAIN_ID, PORT (8787), STATE_FILE (./notify-state.json),
//      POLL_MS (5000), START_BLOCK (0, set to the LastKey deploy block).
const path = require("path");
const { rpcProvider } = require("../shared/rpc");
const { createNotify } = require("./index");

const RPC_URL = process.env.RPC_URL;
const ADDRESS = process.env.LASTKEY_ADDRESS;
if (!RPC_URL || !ADDRESS) {
  console.error("set RPC_URL and LASTKEY_ADDRESS");
  process.exit(1);
}

const provider = rpcProvider(RPC_URL, process.env.CHAIN_ID);
const { watcher, api } = createNotify({
  provider,
  address: ADDRESS,
  stateFile: process.env.STATE_FILE || path.resolve("notify-state.json"),
  startBlock: Number(process.env.START_BLOCK || 0),
  log: (m) => console.error(new Date().toISOString(), m),
});

const POLL_MS = Number(process.env.POLL_MS || 5000);
let busy = false;
async function loop() {
  if (busy) return;
  busy = true;
  try {
    const r = await watcher.tick();
    if (r.scanned || r.deliveries) console.error(`scanned ${r.scanned} logs, ${r.deliveries} deliveries, head ${r.head}`);
  } catch (e) {
    console.error("poll failed:", e.message);
  } finally {
    busy = false;
  }
}
setInterval(loop, POLL_MS);
loop();

const port = Number(process.env.PORT || 8787);
api.listen(port, () => console.error(`LastKey-Notify listening on :${port}`));
