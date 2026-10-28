// Shared JSON-RPC provider. The Portaldot testnet RPC rejects requests without a browser
// User-Agent, so every client sets one.
const { JsonRpcProvider, FetchRequest } = require("ethers");

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) LastKey/1.0";

function rpcProvider(url, chainId) {
  const req = new FetchRequest(url);
  req.setHeader("User-Agent", USER_AGENT);
  if (chainId) return new JsonRpcProvider(req, Number(chainId), { staticNetwork: true });
  return new JsonRpcProvider(req);
}

module.exports = { rpcProvider, USER_AGENT };
