#!/usr/bin/env node
// LastKey claim service. One endpoint behind the dapp's "Claim everything" button.
//
//   POST /claim   body: {"vaultId":"0x<32 bytes>", "owner":"0x<address>", "secret":"<passphrase>"}
//   GET  /health
//
// It runs the same sweep-all logic as keeper/cli.js sweep-all: attestation check, holdings scan
// (listed tokens + known list + Transfer-log scan), allowance check, batched sweepAll pulls, then claim.
//
// Who the key belongs to: the contract only lets a BENEFICIARY (or the watcher) call sweepAll and claim,
// and native payouts go to the caller. So KEEPER_PRIVATE_KEY must be the key of a beneficiary of the
// vault, and that beneficiary receives the swept tokens and the native share. Never put the owner's key here.
//
// Passphrase: claim needs the owner's secret word, so the caller sends it. The service uses it for this
// one request, never stores it, and never logs it.
//
// Deny by default: unknown routes 404, unknown origins are refused, requests without an Origin header are
// refused unless ALLOW_NO_ORIGIN=1 (local curl testing only), and the server refuses to start without its
// required env. Per-IP rate limit on /claim. One claim at a time (single keeper nonce).
//
// Deps: node built-ins + ethers (already in the project). No other packages.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Wallet, ethers } = require("ethers");
const { rpcProvider } = require("../shared/rpc");
const { sweepAllAndClaim, DEFAULT_BATCH, SWEEP_ABI } = require("./lib/sweep");

const MAX_BODY_BYTES = 4096;
const SECRET_MAX = 256;
const DEFAULT_ORIGINS = ["https://lastkey-dapp.vercel.app"];
// Any localhost / 127.0.0.1 origin on any port (the dev and local-demo frontends).
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

function log(event, fields = {}) {
  // One JSON line per event. Callers must never pass secrets or keys in fields.
  const line = { t: new Date().toISOString(), ev: event, ...fields };
  console.log(JSON.stringify(line));
}

/// Tiny .env loader (KEY=VALUE lines). Does not override variables already set in the environment.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) {
      process.env[key] = val;
      n++;
    }
  }
  return n;
}

/// Reads and validates config from env. Throws (refuses to start) when anything required is missing.
function loadConfig(env = process.env) {
  const need = (k) => {
    const v = (env[k] || "").trim();
    if (!v) throw new Error(`missing required env ${k} (see keeper/.env.example)`);
    return v;
  };
  const pk = need("KEEPER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("KEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const lkAddress = need("LASTKEY_ADDRESS");
  if (!ethers.isAddress(lkAddress)) throw new Error("LASTKEY_ADDRESS is not a valid address");
  const rpcUrl = need("RPC_URL");

  const originsRaw = (env.ALLOWED_ORIGINS || "").trim();
  const allowedOrigins = originsRaw
    ? originsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS.slice();

  const knownTokens = (env.KNOWN_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const t of knownTokens) if (!ethers.isAddress(t)) throw new Error(`KNOWN_TOKENS has an invalid address: ${t}`);

  const num = (k, d) => {
    const v = env[k] === undefined || env[k] === "" ? d : Number(env[k]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
    return v;
  };

  return {
    keeperKey: pk,
    lkAddress: ethers.getAddress(lkAddress),
    rpcUrl,
    chainId: env.CHAIN_ID ? Number(env.CHAIN_ID) : undefined,
    host: (env.HOST || "127.0.0.1").trim(),
    port: num("PORT", 8787),
    allowedOrigins,
    allowLocalOrigins: env.ALLOW_LOCAL_ORIGINS !== "0",
    allowNoOrigin: env.ALLOW_NO_ORIGIN === "1",
    trustProxy: env.TRUST_PROXY === "1",
    rateLimitPerMin: num("RATE_LIMIT_PER_MIN", 5),
    knownTokens: knownTokens.map((t) => ethers.getAddress(t)),
    batchSize: num("BATCH_SIZE", DEFAULT_BATCH),
    lookback: num("LOOKBACK_BLOCKS", 50000),
    chunk: num("LOG_CHUNK_BLOCKS", 2000),
  };
}

/// Origin check. Returns {ok, origin}. Deny by default.
function checkOrigin(origin, cfg) {
  if (!origin) return { ok: cfg.allowNoOrigin, origin: null };
  if (cfg.allowedOrigins.includes(origin)) return { ok: true, origin };
  if (cfg.allowLocalOrigins && LOCAL_ORIGIN_RE.test(origin)) return { ok: true, origin };
  return { ok: false, origin };
}

/// Fixed-window per-IP limiter. Returns true when the request is allowed.
function makeRateLimiter(limitPerMin, windowMs = 60_000, now = () => Date.now()) {
  const hits = new Map();
  return {
    allow(ip) {
      const t = now();
      if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      let e = hits.get(ip);
      if (!e || e.resetAt <= t) {
        e = { count: 0, resetAt: t + windowMs };
        hits.set(ip, e);
      }
      e.count++;
      return e.count <= limitPerMin;
    },
    retryAfterSec(ip) {
      const e = hits.get(ip);
      return e ? Math.max(1, Math.ceil((e.resetAt - now()) / 1000)) : 60;
    },
  };
}

function clientIp(req, cfg) {
  if (cfg.trustProxy) {
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders });
  res.end(payload);
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on("data", (c) => {
      if (tooBig) return; // keep draining so the client can read the 413 response
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!tooBig) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}


/// Validates the /claim body. Returns {vaultId, owner, secret} or throws {status, message}.
function parseClaimBody(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    throw Object.assign(new Error("body must be JSON"), { status: 400 });
  }
  if (!body || typeof body !== "object") throw Object.assign(new Error("body must be a JSON object"), { status: 400 });
  const { vaultId, owner, secret } = body;
  if (typeof vaultId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(vaultId)) {
    throw Object.assign(new Error("vaultId must be a 0x-prefixed 32-byte hex string"), { status: 400 });
  }
  if (typeof owner !== "string" || !ethers.isAddress(owner)) {
    throw Object.assign(new Error("owner must be a valid address"), { status: 400 });
  }
  if (typeof secret !== "string" || secret.length === 0 || secret.length > SECRET_MAX) {
    throw Object.assign(new Error(`secret must be 1 to ${SECRET_MAX} characters`), { status: 400 });
  }
  return { vaultId: vaultId.toLowerCase(), owner: ethers.getAddress(owner), secret };
}

/// Maps a precondition failure from sweepAllAndClaim to a client status. Anything else is a 500.
const PRECONDITION_MSG = [
  "owner has no active vault",
  "vault already triggered",
  "vault id does not match",
  "owner has not enabled everything",
  "claim window not open yet",
];
function classifyError(e) {
  const msg = String((e && e.message) || "");
  if (PRECONDITION_MSG.some((p) => msg.includes(p))) return { status: 409, message: msg };
  if (msg.includes("not a beneficiary") || msg.includes("NotBeneficiary")) return { status: 403, message: "keeper key is not a beneficiary of this vault" };
  if (msg.includes("NotYetClaimable")) return { status: 409, message: "claim window not open yet" };
  if (msg.includes("WrongSecret")) return { status: 403, message: "wrong passphrase for this vault" };
  if (msg.includes("AlreadyClaimed")) return { status: 409, message: "this beneficiary already claimed" };
  if (msg.includes("WrongSweepMode")) return { status: 409, message: "owner is not in everything mode" };
  return { status: 500, message: "claim failed on-chain or in the keeper; see service logs" };
}

/// Builds the service. `deps` lets tests inject an in-process provider and signer.
function createServer(cfg, deps = {}) {
  const provider = deps.provider || rpcProvider(cfg.rpcUrl, cfg.chainId);
  const signer = deps.signer || new Wallet(cfg.keeperKey, provider);
  const limiter = makeRateLimiter(cfg.rateLimitPerMin);
  const inFlight = new Set(); // vaultIds with a claim running
  let queue = Promise.resolve(); // one chain write at a time (single keeper nonce)

  async function runClaim({ vaultId, owner, secret }) {
    const lkFull = new ethers.Contract(cfg.lkAddress, [...SWEEP_ABI, "function sweepTokensOf(address owner) view returns (address[])", "function sweepModeOf(address owner) view returns (uint8)", "function sweepToVault(address owner, address token)"], signer);
    const mode = Number(await lkFull.sweepModeOf(owner));
    if (mode === 0) return runListedClaim({ vaultId, owner, secret, lkFull });
    // Listed tokens on-chain are scanned too, so tokens the owner listed are always candidates.
    const listed = (await lkFull.sweepTokensOf(owner)).map((a) => ethers.getAddress(a));
    const knownTokens = [...new Set([...cfg.knownTokens, ...listed])];
    return sweepAllAndClaim({
      signer,
      provider,
      lkAddress: cfg.lkAddress,
      owner,
      vaultId,
      secret,
      knownTokens,
      batchSize: cfg.batchSize,
      lookback: cfg.lookback,
      chunk: cfg.chunk,
    });
  }

  /// Listed mode: sweep only the tokens the owner put on-chain with allowSweep, one sweepToVault per token,
  /// then claim. Checks the same preconditions as the everything path so a bad vault id still fails early.
  async function runListedClaim({ vaultId, owner, secret, lkFull }) {
    const beneficiary = await signer.getAddress();
    const data = await lkFull.attestationData(owner);
    if (!data.active) throw new Error("owner has no active vault");
    if (data.triggered) throw new Error("vault already triggered by a claim; sweeps are closed");
    const expectedId = await lkFull.vaultIdOf(owner, data.epoch);
    if (String(vaultId).toLowerCase() !== String(expectedId).toLowerCase()) throw new Error("vault id does not match the owner's current cycle");
    const chainNow = Number((await provider.getBlock("latest")).timestamp);
    if (chainNow <= Number(data.claimOpensAt)) throw new Error("claim window not open yet");

    const listed = (await lkFull.sweepTokensOf(owner)).map((a) => ethers.getAddress(a));
    const batches = [];
    for (const token of listed) {
      try {
        const tx = await lkFull.sweepToVault(owner, token);
        const rec = await tx.wait();
        batches.push({ tokens: [token], status: "swept", txHash: rec.hash ?? tx.hash });
      } catch (e) {
        batches.push({ tokens: [token], status: "failed", error: String((e.shortMessage || e.message || "").split("\n")[0]).slice(0, 200) });
      }
    }
    const claim = await require("./lib/keeper").autoClaim({ signer, lkAddress: cfg.lkAddress, owner, secret });
    return { mode: "listed", beneficiary, owner, vaultId: expectedId, scanned: listed.length, pullable: listed.map((t) => ({ token: t })), skipped: [], overflow: [], batches, claim };
  }


  function enqueue(job) {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const ip = clientIp(req, cfg);
    const origin = req.headers.origin;
    const originCheck = checkOrigin(origin, cfg);
    const cors = originCheck.ok ? corsHeaders(origin) : {};
    const url = (req.url || "/").split("?")[0];

    if (!originCheck.ok) {
      log("deny_origin", { ip, origin: origin || null, path: url });
      return sendJson(res, 403, { error: "origin not allowed" });
    }

    if (req.method === "OPTIONS") {
      res.writeHead(originCheck.origin ? 204 : 403, cors);
      return res.end();
    }

    if (req.method === "GET" && url === "/health") {
      return sendJson(res, 200, { ok: true, keeper: await signer.getAddress() }, cors);
    }

    if (url !== "/claim") {
      log("deny_route", { ip, method: req.method, path: url });
      return sendJson(res, 404, { error: "not found" }, cors);
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "use POST" }, { ...cors, allow: "POST" });
    }

    if (!limiter.allow(ip)) {
      log("rate_limited", { ip, path: url });
      return sendJson(res, 429, { error: "too many claim requests, slow down" }, { ...cors, "retry-after": String(limiter.retryAfterSec(ip)) });
    }

    let input;
    try {
      input = parseClaimBody(await readBody(req, MAX_BODY_BYTES));
    } catch (e) {
      log("bad_request", { ip, status: e.status || 400, reason: e.message });
      return sendJson(res, e.status || 400, { error: e.message }, cors);
    }

    if (inFlight.has(input.vaultId)) {
      log("busy", { ip, vaultId: input.vaultId });
      return sendJson(res, 409, { error: "a claim for this vault is already running" }, cors);
    }

    inFlight.add(input.vaultId);
    log("claim_start", { ip, vaultId: input.vaultId, owner: input.owner });
    try {
      const report = await enqueue(() => runClaim(input));
      const swept = report.batches.filter((b) => b.status === "swept").length;
      const failed = report.batches.filter((b) => b.status === "failed").length;
      log("claim_done", {
        ip,
        vaultId: input.vaultId,
        owner: input.owner,
        pullable: report.pullable.length,
        batchesSwept: swept,
        batchesFailed: failed,
        claim: report.claim.action,
        claimTx: report.claim.txHash || null,
        ms: Date.now() - started,
      });
      return sendJson(res, 200, { ok: true, ...report }, cors);
    } catch (e) {
      const mapped = classifyError(e);
      log("claim_fail", { ip, vaultId: input.vaultId, status: mapped.status, reason: String(e.message || "").split("\n")[0].slice(0, 200), ms: Date.now() - started });
      return sendJson(res, mapped.status, { ok: false, error: mapped.message }, cors);
    } finally {
      inFlight.delete(input.vaultId);
    }
  });

  return { server, cfg, provider, signer, limiter };
}

async function main() {
  const loaded = loadDotEnv(path.join(__dirname, ".env"));
  if (loaded) log("env_loaded", { keys: loaded });
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error("refusing to start: " + e.message);
    process.exit(1);
  }
  const { server, signer } = createServer(cfg);
  const addr = await signer.getAddress();
  server.listen(cfg.port, cfg.host, () => {
    log("listening", {
      host: cfg.host,
      port: cfg.port,
      lastkey: cfg.lkAddress,
      keeper: addr,
      origins: cfg.allowedOrigins,
      localOrigins: cfg.allowLocalOrigins,
      rateLimitPerMin: cfg.rateLimitPerMin,
    });
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error("fatal:", e.message);
    process.exit(1);
  });
}

module.exports = { createServer, loadConfig, loadDotEnv, checkOrigin, makeRateLimiter, parseClaimBody, classifyError };
