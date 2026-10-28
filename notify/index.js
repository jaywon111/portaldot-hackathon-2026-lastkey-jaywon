// LastKey-Notify: embeddable service. server.js wires this to env config.
const { createStore } = require("./lib/store");
const { createWatcher } = require("./lib/watcher");
const { createApi } = require("./lib/api");
const { deliverWebhook } = require("./lib/deliver");
const { verify } = require("./lib/sign");
const { decodeLog, TOPICS } = require("./lib/events");

function createNotify({ provider, address, stateFile, startBlock = 0, deliverOpts = {}, log = () => {} }) {
  const store = createStore(stateFile);
  const watcher = createWatcher({
    provider,
    address,
    store,
    startBlock,
    log,
    deliver: (args) => deliverWebhook({ ...deliverOpts, ...args }),
  });
  const api = createApi({
    store,
    health: () => ({ ok: true, cursor: store.cursor() }),
  });
  return { store, watcher, api };
}

module.exports = { createNotify, verify, decodeLog, TOPICS, deliverWebhook, createStore, createWatcher, createApi };
