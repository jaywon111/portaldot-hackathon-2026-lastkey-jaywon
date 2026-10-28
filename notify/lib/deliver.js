// Signed webhook delivery with exponential backoff. At-least-once within the retry budget:
// a delivery that fails every attempt is recorded as a failure, not retried forever.
const { sign } = require("./sign");
const { USER_AGENT } = require("../../shared/rpc");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deliverWebhook({
  url,
  secret,
  payload,
  attempts = 5,
  backoffMs = 1000,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
}) {
  const body = JSON.stringify(payload);
  let lastError = "unknown";
  for (let i = 1; i <= attempts; i++) {
    const ts = String(Math.floor(Date.now() / 1000));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT.replace("Mozilla/5.0 ", "LastKey-Notify/1.0 "),
          "x-lastkey-event-id": payload.id,
          "x-lastkey-timestamp": ts,
          "x-lastkey-signature": sign(secret, ts, body),
        },
        body,
        signal: ctrl.signal,
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, attempts: i, status: res.status };
      lastError = `http ${res.status}`;
    } catch (e) {
      lastError = e.name === "AbortError" ? "timeout" : e.message;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts) await sleep(backoffMs * 2 ** (i - 1));
  }
  return { ok: false, attempts, error: lastError };
}

module.exports = { deliverWebhook };
