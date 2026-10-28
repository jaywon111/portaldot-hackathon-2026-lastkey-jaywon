// Deploy LastKey to the Portaldot testnet EVM with a legacy type-0 transaction.
// Usage: PRIVATE_KEY=0x... npx hardhat run scripts/deploy-lastkey.js --network portaldotTestnet
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const GAS_PRICE = 29715n;
const GAS_LIMIT = 10_000_000n;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  if (net.chainId !== 420420777n) throw new Error("wrong chainId: " + net.chainId);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("chainId:", net.chainId.toString(), "deployer:", deployer.address, "balance(wei):", bal.toString());

  const F = await hre.ethers.getContractFactory("LastKey");
  const deployTx = await F.getDeployTransaction();
  const tx = await deployer.sendTransaction({
    data: deployTx.data,
    type: 0,
    gasPrice: GAS_PRICE,
    gasLimit: GAS_LIMIT,
    chainId: 420420777,
  });
  console.log("creation tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("receipt status:", receipt.status, "block:", receipt.blockNumber, "gasUsed:", receipt.gasUsed.toString());
  if (receipt.status !== 1) throw new Error("creation reverted, tx " + tx.hash);

  const c = F.attach(receipt.contractAddress);
  const admin = await c.admin();
  const ticketName = await c.name();
  console.log("contract:", receipt.contractAddress, "admin:", admin, "name:", ticketName);

  const out = {
    network: "portaldotTestnet",
    chainId: 420420777,
    address: receipt.contractAddress,
    txHash: tx.hash,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "portaldotTestnet.json"), JSON.stringify(out, null, 2));
  console.log("saved deployments/portaldotTestnet.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
