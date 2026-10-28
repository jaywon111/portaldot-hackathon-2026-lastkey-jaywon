// Polls eth_getLogs for LastKey events, records them once, and fans them out to subscribers.
const { decodeLog } = require("./events");

function createWatcher({ provider, address, store, deliver, startBlock = 0, chunk = 2000, log = () => {} }) {
  const lcAddress = address.toLowerCase();

  async function dispatch(ev, lg) {
    const id = `${lg.transactionHash}:${lg.index ?? lg.logIndex}`;
    if (store.hasEvent(id)) return 0;
    const payload = {
      id,
      type: ev.type,
      vaultId: ev.vaultId,
      owner: ev.owner,
      blockNumber: lg.blockNumber,
      txHash: lg.transactionHash,
      data: ev.args,
    };
    store.recordEvent({ ...payload });
    const subs = store.subscriptionsFor(ev.vaultId);
    await Promise.all(
      subs.map(async (sub) => {
        const r = await deliver({ url: sub.url, secret: sub.secret, payload });
        if (!r.ok) {
          store.recordFailure({ eventId: id, subscriptionId: sub.id, url: sub.url, error: r.error, attempts: r.attempts });
          log(`delivery failed for ${id} to ${sub.url}: ${r.error}`);
        }
      })
    );
    return subs.length;
  }

  return {
    /// One poll cycle. Returns how many logs were scanned and how many deliveries were attempted.
    async tick() {
      const head = await provider.getBlockNumber();
      let from = store.cursor() == null ? startBlock : store.cursor() + 1;
      let scanned = 0;
      let deliveries = 0;
      while (from <= head) {
        const to = Math.min(head, from + chunk - 1);
        const logs = await provider.getLogs({ address: lcAddress, fromBlock: from, toBlock: to });
        for (const lg of logs) {
          scanned++;
          const ev = decodeLog(lg);
          if (!ev) continue;
          deliveries += await dispatch(ev, lg);
        }
        store.setCursor(to);
        from = to + 1;
      }
      return { head, scanned, deliveries };
    },
  };
}

module.exports = { createWatcher };
