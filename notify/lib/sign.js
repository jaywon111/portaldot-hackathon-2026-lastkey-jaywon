// Webhook signing. Header X-LastKey-Signature = "sha256=" + HMAC-SHA256(secret, timestamp + "." + body).
const crypto = require("crypto");

function sign(secret, timestamp, body) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/// Receiver-side check. Rejects stale timestamps (default 5 minutes) and compares in constant time.
function verify(secret, timestamp, body, header, { toleranceSec = 300, nowSec = Date.now() / 1000 } = {}) {
  if (!secret || !timestamp || !header) return false;
  if (!/^\d+$/.test(String(timestamp))) return false;
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const got = Buffer.from(String(header));
  return got.length === expected.length && crypto.timingSafeEqual(expected, got);
}

module.exports = { sign, verify };
