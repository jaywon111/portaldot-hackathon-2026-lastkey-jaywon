const { expect } = require("chai");
const crypto = require("crypto");
const { sign, verify } = require("../notify/lib/sign");
const { deliverWebhook } = require("../notify/lib/deliver");
const { createStore } = require("../notify/lib/store");
const { createWatcher } = require("../notify/lib/watcher");
const { decodeLog, TOPICS } = require("../notify/lib/events");
const { createApi } = require("../notify/lib/api");
const { ethers } = require("hardhat");

const VAULT = "0x" + "ab".repeat(32);

describe("LastKey-Notify service", function () {
  describe("signing", function () {
    it("verifies a fresh signature and rejects tampering or stale timestamps", function () {
      const ts = String(Math.floor(Date.now() / 1000));
      const body = '{"type":"CheckInReceived"}';
      const sig = sign("s3cret", ts, body);
      expect(verify("s3cret", ts, body, sig)).to.equal(true);
      expect(verify("s3cret", ts, body + " ", sig)).to.equal(false);
      expect(verify("other", ts, body, sig)).to.equal(false);
      const old = String(Math.floor(Date.now() / 1000) - 3600);
      expect(verify("s3cret", old, body, sign("s3cret", old, body))).to.equal(false);
      expect(verify("s3cret", "not-a-number", body, sig)).to.equal(false);
    });
  });

  describe("delivery", function () {
    it("retries with backoff until a 2xx and reports attempts", async function () {
      const seen = [];
      const fetchImpl = async (url, init) => {
        seen.push({ url, init });
        return { status: seen.length < 3 ? 500 : 200 };
      };
      const r = await deliverWebhook({
        url: "https://hook.test/a",
        secret: "k",
        payload: { id: "e1", type: "TimerWarning" },
        attempts: 5,
        backoffMs: 1,
        fetchImpl,
      });
      expect(r).to.deep.include({ ok: true, attempts: 3, status: 200 });
      expect(seen[0].init.headers["x-lastkey-event-id"]).to.equal("e1");
      expect(seen[0].init.headers["x-lastkey-signature"]).to.match(/^sha256=[0-9a-f]{64}$/);
    });

    it("gives up after the attempt budget and reports the last error", async function () {
      const r = await deliverWebhook({
        url: "https://hook.test/b",
        secret: "k",
        payload: { id: "e2" },
        attempts: 2,
        backoffMs: 1,
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      });
      expect(r).to.deep.equal({ ok: false, attempts: 2, error: "ECONNREFUSED" });
    });
  });

  describe("event decoding", function () {
    it("decodes a real LastKey log and ignores unrelated topics", async function () {
      const [, owner, alice] = await ethers.getSigners();
      const lk = await (await ethers.getContractFactory("LastKey")).deploy();
      const tx = await lk
        .connect(owner)
        .register(30, 7, [alice.address], [10000], ethers.keccak256(ethers.toUtf8Bytes("p")), ethers.toUtf8Bytes("p"), {
          value: ethers.parseEther("1"),
        });
      const rec = await tx.wait();
      const lkAddr = (await lk.getAddress()).toLowerCase();
      const lg = rec.logs.find((l) => l.address.toLowerCase() === lkAddr && TOPICS.includes(l.topics[0]));
      expect(lg, "a notify event is emitted by register").to.not.be.undefined;
      const ev = decodeLog(lg);
      expect(ev.type).to.equal("VaultFunded");
      expect(ev.owner).to.equal(owner.address.toLowerCase());
      expect(ev.vaultId).to.equal((await lk.vaultIdOf(owner.address, 1)).toLowerCase());
      expect(decodeLog({ topics: [ethers.id("Transfer(address,address,uint256)")], data: "0x" })).to.equal(null);
    });
  });

  describe("watcher", function () {
    function fakeProvider(logs, head) {
      return {
        getBlockNumber: async () => head,
        getLogs: async ({ fromBlock, toBlock }) => logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
      };
    }

    function fakeLog(block, idx, type, owner) {
      const iface = new ethers.Interface([
        "event TimerWarning(bytes32 indexed vaultId, address indexed owner, uint64 epoch, uint256 deadline, uint256 claimOpensAt, uint16 elapsedBps, uint256 timestamp)",
      ]);
      const data = iface.encodeEventLog(iface.getEvent("TimerWarning"), [VAULT, owner, 1, 100, 200, 8000, 150]);
      return { address: "0xlk", blockNumber: block, transactionHash: "0x" + block.toString(16).padStart(64, "0"), index: idx, topics: data.topics, data: data.data };
    }

    it("delivers only to subscribers of the matching vault, once per event, and advances the cursor", async function () {
      const store = createStore();
      store.addSubscription({ id: "s1", url: "https://a.test", vaultId: VAULT, secret: "sa" });
      store.addSubscription({ id: "s2", url: "https://b.test", vaultId: "0x" + "cd".repeat(32), secret: "sb" });
      const owner = "0x" + "11".repeat(20);
      const logs = [fakeLog(5, 0, "TimerWarning", owner)];
      const delivered = [];
      const deliver = async ({ url, payload }) => {
        delivered.push({ url, type: payload.type });
        return { ok: true, attempts: 1, status: 200 };
      };
      const w = createWatcher({ provider: fakeProvider(logs, 10), address: "0xlk", store, deliver, startBlock: 0 });
      const r1 = await w.tick();
      expect(r1.scanned).to.equal(1);
      expect(delivered).to.deep.equal([{ url: "https://a.test", type: "TimerWarning" }]);
      expect(store.cursor()).to.equal(10);
      // second tick: nothing new, nothing re-delivered
      const r2 = await w.tick();
      expect(r2.scanned).to.equal(0);
      expect(delivered.length).to.equal(1);
    });

    it("records a failed delivery instead of dropping it silently", async function () {
      const store = createStore();
      store.addSubscription({ id: "s1", url: "https://down.test", vaultId: VAULT, secret: "sa" });
      const logs = [fakeLog(3, 0, "TimerWarning", "0x" + "11".repeat(20))];
      const w = createWatcher({
        provider: fakeProvider(logs, 4),
        address: "0xlk",
        store,
        deliver: async () => ({ ok: false, attempts: 5, error: "http 503" }),
      });
      await w.tick();
      expect(store.failures()).to.have.length(1);
      expect(store.failures()[0]).to.include({ url: "https://down.test", error: "http 503" });
    });
  });

  describe("http api", function () {
    let server, base, store;

    before(async function () {
      store = createStore();
      server = createApi({ store }).listen(0);
      await new Promise((r) => server.once("listening", r));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((r) => server.close(r)));

    async function post(path, body, headers = {}) {
      const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    }

    it("registers a subscription and returns a secret once", async function () {
      const r = await post("/v1/subscriptions", { url: "https://hook.test/x", vaultId: VAULT });
      expect(r.status).to.equal(201);
      expect(r.body.secret).to.match(/^[0-9a-f]{64}$/);
      expect(r.body.vaultId).to.equal(VAULT);
    });

    it("rejects bad urls, bad vault ids and bad json", async function () {
      expect((await post("/v1/subscriptions", { url: "ftp://x", vaultId: VAULT })).status).to.equal(400);
      expect((await post("/v1/subscriptions", { url: "https://x", vaultId: "0x12" })).status).to.equal(400);
      const r = await fetch(base + "/v1/subscriptions", { method: "POST", body: "{nope" });
      expect(r.status).to.equal(400);
    });

    it("deletes only with the subscription secret", async function () {
      const made = await post("/v1/subscriptions", { url: "https://hook.test/y", vaultId: VAULT });
      const url = `${base}/v1/subscriptions/${made.body.id}`;
      const bad = await fetch(url, { method: "DELETE", headers: { "x-subscription-secret": "nope" } });
      expect(bad.status).to.equal(403);
      const ok = await fetch(url, { method: "DELETE", headers: { "x-subscription-secret": made.body.secret } });
      expect(ok.status).to.equal(200);
      const gone = await fetch(url, { method: "DELETE", headers: { "x-subscription-secret": made.body.secret } });
      expect(gone.status).to.equal(404);
    });

    it("serves health and recent events", async function () {
      const h = await (await fetch(base + "/health")).json();
      expect(h.ok).to.equal(true);
      const e = await (await fetch(`${base}/v1/events?vaultId=${VAULT}&limit=5`)).json();
      expect(e.events).to.be.an("array");
      expect((await fetch(base + "/v1/events?vaultId=0x1")).status).to.equal(400);
    });
  });
});
