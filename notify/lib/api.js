// Minimal HTTP API (node:http, no framework).
//   POST   /v1/subscriptions            {url, vaultId}      -> 201 {id, secret, vaultId, url}
//   DELETE /v1/subscriptions/:id        header x-subscription-secret
//   GET    /v1/events?vaultId=0x..&limit=50
//   GET    /health
const http = require("http");
const crypto = require("crypto");

const VAULT_ID = /^0x[0-9a-fA-F]{64}$/;
const MAX_BODY = 16 * 1024;

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function validUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function createApi({ store, health = () => ({ ok: true }) }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") return send(res, 200, health());

      if (req.method === "POST" && path === "/v1/subscriptions") {
        let body;
        try {
          body = JSON.parse(await readBody(req) || "{}");
        } catch {
          return send(res, 400, { error: "invalid json" });
        }
        if (typeof body.url !== "string" || !validUrl(body.url)) return send(res, 400, { error: "url must be http(s)" });
        if (typeof body.vaultId !== "string" || !VAULT_ID.test(body.vaultId)) {
          return send(res, 400, { error: "vaultId must be a 32-byte hex id" });
        }
        const sub = store.addSubscription({
          id: crypto.randomUUID(),
          url: body.url,
          vaultId: body.vaultId.toLowerCase(),
          secret: crypto.randomBytes(32).toString("hex"),
          createdAt: new Date().toISOString(),
        });
        return send(res, 201, { id: sub.id, secret: sub.secret, vaultId: sub.vaultId, url: sub.url });
      }

      const del = path.match(/^\/v1\/subscriptions\/([0-9a-f-]{36})$/);
      if (req.method === "DELETE" && del) {
        const r = store.removeSubscription(del[1], req.headers["x-subscription-secret"]);
        if (r === "missing") return send(res, 404, { error: "not found" });
        if (r === "forbidden") return send(res, 403, { error: "bad secret" });
        return send(res, 200, { ok: true });
      }

      if (req.method === "GET" && path === "/v1/events") {
        const vaultId = url.searchParams.get("vaultId");
        if (vaultId && !VAULT_ID.test(vaultId)) return send(res, 400, { error: "bad vaultId" });
        const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
        return send(res, 200, { events: store.recentEvents(vaultId ? vaultId.toLowerCase() : null, limit) });
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, e.status || 500, { error: e.status ? e.message : "internal error" });
    }
  });
}

module.exports = { createApi };
