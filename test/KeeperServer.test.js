const { expect } = require("chai");
const http = require("http");
const { ethers } = require("hardhat");
const {
  createServer,
  loadConfig,
  checkOrigin,
  makeRateLimiter,
  parseClaimBody,
  classifyError,
} = require("../keeper/server");

const KEY = "0x" + "11".repeat(32);
const LK = "0x" + "ab".repeat(20);
const VAULT = "0x" + "cd".repeat(32);
const OWNER = "0x" + "12".repeat(20);
const ENV = {
  KEEPER_PRIVATE_KEY: KEY,
  LASTKEY_ADDRESS: LK,
  RPC_URL: "http://127.0.0.1:1",
};

function baseCfg(over = {}) {
  return loadConfig({ ...ENV, ...over.env });
}

// Raw http request so we can set the Origin header and read CORS headers exactly.
function req(port, { method = "GET", path = "/", origin, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (origin) h.origin = origin;
    if (body !== undefined) {
      h["content-type"] = "application/json";
      h["content-length"] = Buffer.byteLength(body);
    }
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe("KeeperServer config (deny by default)", function () {
  it("refuses to start without KEEPER_PRIVATE_KEY", function () {
    expect(() => loadConfig({ LASTKEY_ADDRESS: LK, RPC_URL: "http://x" })).to.throw(/KEEPER_PRIVATE_KEY/);
  });

  it("refuses a malformed key", function () {
    expect(() => loadConfig({ ...ENV, KEEPER_PRIVATE_KEY: "0x1234" })).to.throw(/32-byte hex/);
  });

  it("refuses a bad LASTKEY_ADDRESS and a bad known token", function () {
    expect(() => loadConfig({ ...ENV, LASTKEY_ADDRESS: "nope" })).to.throw(/LASTKEY_ADDRESS/);
    expect(() => loadConfig({ ...ENV, KNOWN_TOKENS: "0x12" })).to.throw(/KNOWN_TOKENS/);
  });

  it("defaults to the lastkey-dapp origin only and a rate limit of 5 per minute", function () {
    const cfg = baseCfg();
    expect(cfg.allowedOrigins).to.deep.equal(["https://lastkey-dapp.vercel.app"]);
    expect(cfg.rateLimitPerMin).to.equal(5);
    expect(cfg.allowNoOrigin).to.equal(false);
  });
});

describe("KeeperServer origin check", function () {
  const cfg = baseCfg();

  it("allows the known frontend origin", function () {
    expect(checkOrigin("https://lastkey-dapp.vercel.app", cfg).ok).to.equal(true);
  });

  it("allows localhost and 127.0.0.1 on any port", function () {
    expect(checkOrigin("http://localhost:5173", cfg).ok).to.equal(true);
    expect(checkOrigin("http://127.0.0.1:8080", cfg).ok).to.equal(true);
    expect(checkOrigin("http://localhost", cfg).ok).to.equal(true);
  });

  it("refuses other origins, lookalike hosts and https localhost", function () {
    expect(checkOrigin("https://evil.example", cfg).ok).to.equal(false);
    expect(checkOrigin("https://lastkey-dapp.vercel.app.evil.com", cfg).ok).to.equal(false);
    expect(checkOrigin("http://localhost.evil.com", cfg).ok).to.equal(false);
    expect(checkOrigin("null", cfg).ok).to.equal(false);
  });

  it("refuses requests with no Origin unless ALLOW_NO_ORIGIN=1", function () {
    expect(checkOrigin(undefined, cfg).ok).to.equal(false);
    expect(checkOrigin(undefined, baseCfg({ env: { ALLOW_NO_ORIGIN: "1" } })).ok).to.equal(true);
  });

  it("honours a custom ALLOWED_ORIGINS list and can turn off localhost", function () {
    const c = baseCfg({ env: { ALLOWED_ORIGINS: "https://a.example, https://b.example", ALLOW_LOCAL_ORIGINS: "0" } });
    expect(checkOrigin("https://b.example", c).ok).to.equal(true);
    expect(checkOrigin("http://localhost:3000", c).ok).to.equal(false);
  });
});

describe("KeeperServer rate limiter", function () {
  it("allows up to the limit per IP per window, then blocks, then resets", function () {
    let t = 0;
    const rl = makeRateLimiter(2, 60_000, () => t);
    expect(rl.allow("1.1.1.1")).to.equal(true);
    expect(rl.allow("1.1.1.1")).to.equal(true);
    expect(rl.allow("1.1.1.1")).to.equal(false);
    expect(rl.allow("2.2.2.2")).to.equal(true);
    expect(rl.retryAfterSec("1.1.1.1")).to.be.greaterThan(0);
    t = 60_001;
    expect(rl.allow("1.1.1.1")).to.equal(true);
  });
});

describe("KeeperServer body validation", function () {
  it("accepts a good body and normalises the vault id and owner", function () {
    const out = parseClaimBody(JSON.stringify({ vaultId: VAULT.toUpperCase().replace("0X", "0x"), owner: OWNER.toLowerCase(), secret: "s" }));
    expect(out.vaultId).to.equal(VAULT);
    expect(out.owner).to.equal(ethers.getAddress(OWNER));
    expect(out.secret).to.equal("s");
  });

  it("rejects non-JSON, a short vault id, a bad owner, and an empty or huge secret", function () {
    const bad = [
      "not json",
      JSON.stringify({ vaultId: "0x1234", owner: OWNER, secret: "s" }),
      JSON.stringify({ vaultId: VAULT, owner: "0xnope", secret: "s" }),
      JSON.stringify({ vaultId: VAULT, owner: OWNER, secret: "" }),
      JSON.stringify({ vaultId: VAULT, owner: OWNER, secret: "x".repeat(300) }),
    ];
    for (const b of bad) {
      let err;
      try {
        parseClaimBody(b);
      } catch (e) {
        err = e;
      }
      expect(err, b).to.exist;
      expect(err.status).to.equal(400);
    }
  });
});

describe("KeeperServer error mapping", function () {
  it("maps known contract and precondition failures to client statuses", function () {
    expect(classifyError(new Error("vault id does not match the owner's current cycle")).status).to.equal(409);
    expect(classifyError(new Error("owner has not enabled everything approval for this cycle")).status).to.equal(409);
    expect(classifyError(new Error("claim window not open yet")).status).to.equal(409);
    expect(classifyError(new Error("execution reverted: WrongSecret")).status).to.equal(403);
    expect(classifyError(new Error("execution reverted: NotBeneficiary")).status).to.equal(403);
  });

  it("maps anything unknown to 500 without leaking the raw message", function () {
    const m = classifyError(new Error("socket hang up at 10.0.0.5 key=0xdead"));
    expect(m.status).to.equal(500);
    expect(m.message).to.not.include("10.0.0.5");
  });
});

describe("KeeperServer HTTP surface", function () {
  let server;
  let port;
  let limited;

  before(async function () {
    const cfg = baseCfg({ env: { RATE_LIMIT_PER_MIN: "2", ALLOWED_ORIGINS: "https://lastkey-dapp.vercel.app" } });
    const keeperAddr = new ethers.Wallet(KEY).address;
    const made = createServer(cfg, {
      provider: { getBlock: async () => ({ timestamp: 0 }) },
      signer: { getAddress: async () => keeperAddr },
    });
    server = made.server;
    limited = made.limiter;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });

  after(function (done) {
    server.close(done);
  });

  it("GET /health works for an allowed origin and returns CORS headers", async function () {
    const r = await req(port, { path: "/health", origin: "https://lastkey-dapp.vercel.app" });
    expect(r.status).to.equal(200);
    expect(r.headers["access-control-allow-origin"]).to.equal("https://lastkey-dapp.vercel.app");
    expect(JSON.parse(r.body).ok).to.equal(true);
  });

  it("refuses a disallowed origin with 403 and no CORS header", async function () {
    const r = await req(port, { path: "/health", origin: "https://evil.example" });
    expect(r.status).to.equal(403);
    expect(r.headers["access-control-allow-origin"]).to.equal(undefined);
  });

  it("answers the CORS preflight for the allowed origin", async function () {
    const r = await req(port, { method: "OPTIONS", path: "/claim", origin: "http://localhost:5173" });
    expect(r.status).to.equal(204);
    expect(r.headers["access-control-allow-methods"]).to.include("POST");
  });

  it("returns 404 for unknown routes and 405 for GET /claim", async function () {
    const nf = await req(port, { path: "/admin", origin: "http://localhost:5173" });
    expect(nf.status).to.equal(404);
    const nm = await req(port, { method: "GET", path: "/claim", origin: "http://localhost:5173" });
    expect(nm.status).to.equal(405);
  });

  it("returns 400 for a bad body before touching the chain", async function () {
    const r = await req(port, { method: "POST", path: "/claim", origin: "http://localhost:5173", body: "{\"vaultId\":\"0x1\"}" });
    expect(r.status).to.equal(400);
    expect(r.body).to.include("vaultId");
  });

  async function startWith(env) {
    const cfg = baseCfg({ env });
    const keeperAddr = new ethers.Wallet(KEY).address;
    const made = createServer(cfg, {
      provider: { getBlock: async () => ({ timestamp: 0 }) },
      signer: { getAddress: async () => keeperAddr },
    });
    await new Promise((r) => made.server.listen(0, "127.0.0.1", r));
    return { server: made.server, port: made.server.address().port };
  }

  it("rate limits /claim per IP after the configured count (dedicated server, limit 2)", async function () {
    const s = await startWith({ RATE_LIMIT_PER_MIN: "2" });
    try {
      const body = JSON.stringify({ vaultId: VAULT, owner: OWNER, secret: "s" });
      const go = () => req(s.port, { method: "POST", path: "/claim", origin: "http://localhost:5173", body });
      const first = await go();
      const second = await go();
      const third = await go();
      expect(first.status).to.not.equal(429);
      expect(second.status).to.not.equal(429);
      expect(third.status).to.equal(429);
      expect(third.headers["retry-after"]).to.exist;
    } finally {
      await new Promise((r) => s.server.close(r));
    }
  });

  it("rejects an oversized body with 413 before any chain call (dedicated server, high limit)", async function () {
    const s = await startWith({ RATE_LIMIT_PER_MIN: "100" });
    try {
      const big = JSON.stringify({ vaultId: VAULT, owner: OWNER, secret: "x".repeat(10000) });
      const r = await req(s.port, { method: "POST", path: "/claim", origin: "http://localhost:5173", body: big });
      expect(r.status).to.equal(413);
    } finally {
      await new Promise((r) => s.server.close(r));
    }
  });

  it("the shared server still has a live limiter", function () {
    expect(limited.allow("9.9.9.9")).to.equal(true);
  });
});
