// File-backed state: subscriptions, poll cursor, recent events, delivery failures.
// Pass no path for an in-memory store (tests).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_EVENTS = 1000;

function createStore(file) {
  let state = { subscriptions: [], cursor: null, events: [], failures: [] };
  if (file && fs.existsSync(file)) {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  }

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    addSubscription(sub) {
      state.subscriptions.push(sub);
      save();
      return sub;
    },
    /// Returns "ok", "missing" or "forbidden".
    removeSubscription(id, secret) {
      const sub = state.subscriptions.find((s) => s.id === id);
      if (!sub) return "missing";
      const a = Buffer.from(sub.secret);
      const b = Buffer.from(String(secret || ""));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "forbidden";
      state.subscriptions = state.subscriptions.filter((s) => s.id !== id);
      save();
      return "ok";
    },
    subscriptionsFor(vaultId) {
      return state.subscriptions.filter((s) => s.vaultId === vaultId);
    },
    cursor() {
      return state.cursor;
    },
    setCursor(block) {
      state.cursor = block;
      save();
    },
    hasEvent(id) {
      return state.events.some((e) => e.id === id);
    },
    recordEvent(ev) {
      state.events.push(ev);
      if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
      save();
    },
    recentEvents(vaultId, limit = 50) {
      return state.events.filter((e) => !vaultId || e.vaultId === vaultId).slice(-limit).reverse();
    },
    recordFailure(f) {
      state.failures.push(f);
      if (state.failures.length > MAX_EVENTS) state.failures.splice(0, state.failures.length - MAX_EVENTS);
      save();
    },
    failures() {
      return [...state.failures];
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

module.exports = { createStore };
