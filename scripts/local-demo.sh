#!/usr/bin/env bash
# Local demo: hardhat node + LastKey + MockERC20 + keeper claim service + static frontend.
# Local only (chainId 31338). Does not touch portaldot config, deployments/portaldotTestnet.json, or tests.
# Usage: npm run demo   (or bash scripts/local-demo.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_PORT=8545
KEEPER_PORT=8787
WEB_PORT=8080
RPC="http://127.0.0.1:${NODE_PORT}"

cleanup() {
  for p in "${NODE_PID:-}" "${KEEPER_PID:-}" "${WEB_PID:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

if ! curl -s -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1; then
  echo "starting hardhat node on $RPC ..."
  npx hardhat node --port "$NODE_PORT" >scripts/.hardhat-node.log 2>&1 &
  NODE_PID=$!
  for _ in $(seq 1 60); do
    curl -s -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

echo "deploying LastKey + MockERC20 to local chain ..."
npx hardhat run scripts/local-deploy.js --network localhost

# Advance chain time past the claim window so the claim can run.
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"evm_increaseTime","params":[90000000]}' "$RPC" >/dev/null
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"evm_mine","params":[]}' "$RPC" >/dev/null

echo ""
echo "addresses:"
node -e 'const o=require("./scripts/local-demo.out.json");console.log(JSON.stringify({lastKey:o.lastKey,tokens:o.tokens,owner:o.owner,beneficiaries:o.beneficiaries,vaultId:o.vaultId},null,2))'

echo ""
echo "starting keeper claim service on http://127.0.0.1:${KEEPER_PORT} ..."
# Hardhat account #2 (a beneficiary of the demo vault). Public local test key, no value. Never use on a real chain.
export KEEPER_PRIVATE_KEY="${KEEPER_PRIVATE_KEY:-0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a}"
export LASTKEY_ADDRESS="$(node -e 'console.log(require("./scripts/local-demo.out.json").lastKey)')"
export RPC_URL="$RPC"
export CHAIN_ID=31337
export PORT="$KEEPER_PORT"
export ALLOW_LOCAL_ORIGINS=1
export ALLOW_NO_ORIGIN=1
node keeper/server.js >scripts/.keeper.log 2>&1 &
KEEPER_PID=$!

echo "serving frontend on http://127.0.0.1:${WEB_PORT} ..."
python3 -m http.server "$WEB_PORT" --directory frontend >scripts/.web.log 2>&1 &
WEB_PID=$!

echo ""
echo "demo running:"
echo "  dapp:   http://127.0.0.1:${WEB_PORT}"
echo "  claim:  POST http://127.0.0.1:${KEEPER_PORT}/claim"
echo "  chain:  ${RPC} (chainId 31338)"
echo "Ctrl-C to stop everything."
wait
