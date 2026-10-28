#!/usr/bin/env node
// LastKey keeper CLI. Plain node, deps: ethers only.
//
//   node keeper/cli.js watch --rpc URL --lastkey 0x.. --owners 0xA,0xB [--interval 30]
//   node keeper/cli.js auto-claim --rpc URL --lastkey 0x.. --owner 0xOwner --secret-env LK_SECRET   (PRIVATE_KEY in env)
//   node keeper/cli.js notify-integrate --notify URL --vault-id 0x.. --webhook https://..
//   node keeper/cli.js sweep-all <vaultId> <beneficiaryKey-env> --rpc URL --lastkey 0x.. --owner 0xOwner --secret-env LK_SECRET
//        [--tokens 0xA,0xB] [--batch 5] [--lookback 50000] [--chunk 2000]
//
// Keys come from env (PRIVATE_KEY for auto-claim, never a flag). Output never prints keys.
const { JsonRpcProvider, Wallet, ethers } = require("ethers");
const { rpcProvider } = require("../shared/rpc");
const { readStatus, formatTable, autoClaim } = require("./lib/keeper");
const { sweepAllAndClaim, DEFAULT_BATCH } = require("./lib/sweep");

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith("--")) continue;
    opts[k.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  }
  return { cmd, opts };
}

/// Positional args (everything that is not a --flag or a flag's value), in order.
function positionals(argv) {
  const [, ...rest] = argv;
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k.startsWith("--")) {
      if (rest[i + 1] && !rest[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(k);
  }
  return out;
}

function need(opts, key) {
  if (!opts[key] || opts[key] === true) throw new Error(`missing --${key}`);
  return opts[key];
}

async function cmdWatch(opts) {
  const provider = rpcProvider(need(opts, "rpc"), opts["chain-id"]);
  const lk = need(opts, "lastkey");
  const owners = need(opts, "owners").split(",").map((s) => s.trim()).filter(Boolean);
  const interval = Number(opts.interval || 0);
  const once = async () => {
    const rows = [];
    for (const o of owners) rows.push(await readStatus(provider, lk, o));
    console.log(new Date().toISOString());
    console.log(formatTable(rows));
  };
  await once();
  if (interval > 0) setInterval(() => once().catch((e) => console.error("watch:", e.message)), interval * 1000);
}

async function cmdAutoClaim(opts) {
  const provider = rpcProvider(need(opts, "rpc"), opts["chain-id"]);
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("set PRIVATE_KEY (the beneficiary's funded key) in the environment");
  const secret = process.env[need(opts, "secret-env")];
  if (!secret) throw new Error(`env ${opts["secret-env"]} is empty`);
  const signer = new Wallet(pk, provider);
  const res = await autoClaim({ signer, lkAddress: need(opts, "lastkey"), owner: need(opts, "owner"), secret });
  console.log(JSON.stringify(res));
}

async function cmdSweepAll(argv, opts) {
  const [vaultId, keyEnv] = positionals(argv);
  if (!vaultId || !keyEnv) throw new Error("usage: keeper sweep-all <vaultId> <beneficiaryKey-env> [flags]");
  const key = process.env[keyEnv];
  if (!key) throw new Error(`env ${keyEnv} is empty (put the beneficiary key in it; it is never printed)`);
  const secret = process.env[need(opts, "secret-env")];
  if (!secret) throw new Error(`env ${opts["secret-env"]} is empty`);
  const provider = rpcProvider(need(opts, "rpc"), opts["chain-id"]);
  const signer = new Wallet(key, provider);
  const knownTokens =
    typeof opts.tokens === "string" ? opts.tokens.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const report = await sweepAllAndClaim({
    signer,
    provider,
    lkAddress: need(opts, "lastkey"),
    owner: need(opts, "owner"),
    vaultId,
    secret,
    knownTokens,
    batchSize: Number(opts.batch || DEFAULT_BATCH),
    lookback: Number(opts.lookback || 50000),
    chunk: Number(opts.chunk || 2000),
  });
  console.log(JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function cmdNotifyIntegrate(opts) {
  const base = need(opts, "notify").replace(/\/$/, "");
  const res = await fetch(base + "/v1/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: need(opts, "webhook"), vaultId: need(opts, "vault-id") }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`notify said ${res.status}: ${body.error}`);
  console.log(`subscribed ${body.id} to ${body.vaultId}`);
  console.log(`signing secret (shown once, store it): ${body.secret}`);
  console.log(`verify header x-lastkey-signature with HMAC-SHA256 over "<x-lastkey-timestamp>.<raw body>"`);
}

const USAGE = "usage: keeper watch|auto-claim|notify-integrate|sweep-all [args] [--flags]";

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (cmd === "watch") return cmdWatch(opts);
  if (cmd === "auto-claim") return cmdAutoClaim(opts);
  if (cmd === "notify-integrate") return cmdNotifyIntegrate(opts);
  if (cmd === "sweep-all") return cmdSweepAll(process.argv.slice(2), opts);
  console.error(USAGE);
  process.exit(2);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("error:", e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, positionals };
