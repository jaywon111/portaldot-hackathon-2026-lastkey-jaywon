// Deploy Afterlife to the Portaldot EVM testnet.
// Usage: PRIVATE_KEY=0x... npm run deploy:testnet
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  console.log("network chainId:", net.chainId.toString());
  console.log("deployer:", deployer.address);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("balance (wei):", bal.toString());
  if (bal === 0n) throw new Error("deployer has no testnet balance. get PDOT from the faucet first.");

  const F = await hre.ethers.getContractFactory("Afterlife");
  const c = await F.deploy();
  await c.waitForDeployment();
  const address = await c.getAddress();
  console.log("Afterlife deployed at:", address);

  const out = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    address,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hre.network.name}.json`), JSON.stringify(out, null, 2));
  console.log("saved deployments/" + hre.network.name + ".json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
