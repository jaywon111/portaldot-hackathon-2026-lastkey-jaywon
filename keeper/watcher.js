const { ethers } = require("ethers");

const RPC_URL = "https://test-evm-rpc-v3.portaldot.dev";
const CONTRACT_ADDRESS = "0x6BBE683abe51f6edF2D02b007ca722c7DF925FaC";
const WATCHER_PRIVATE_KEY = process.env.PRIVATE_KEY; 
const OWNER_ADDRESS = process.env.OWNER_ADDRESS;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(WATCHER_PRIVATE_KEY, provider);

const abi = [
  "function watcherCheckIn(address owner) external",
  "function watcher() view returns (address)",
  "function setWatcher(address newWatcher) external"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

async function main() {
  console.log(`Starting watcher for owner: ${OWNER_ADDRESS}`);
  
  // 1. Ensure the deployer wallet is set as the watcher on the contract
  const currentWatcher = await contract.watcher();
  if (currentWatcher.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`Setting watcher to: ${wallet.address}`);
    const tx = await contract.setWatcher(wallet.address);
    await tx.wait();
  }

  console.log("Listening for wallet activity (Polling every 10s)...");
  let lastBlock = await provider.getBlockNumber();

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock > lastBlock) {
        for (let i = lastBlock + 1; i <= currentBlock; i++) {
          const block = await provider.getBlock(i, true);
          if (block && block.transactions) {
            const hasOwnerTx = block.transactions.some(tx => 
              tx.from && tx.from.toLowerCase() === OWNER_ADDRESS.toLowerCase()
            );
            
            if (hasOwnerTx) {
              console.log(`🚨 Detected activity from owner in block ${i}! Triggering heartbeat...`);
              const checkTx = await contract.watcherCheckIn(OWNER_ADDRESS);
              await checkTx.wait();
              console.log(`✅ Heartbeat triggered! Tx: ${checkTx.hash}`);
            }
          }
        }
        lastBlock = currentBlock;
      }
    } catch (e) {
      console.error("Error polling:", e.message);
    }
  }, 10000);
}

main();
