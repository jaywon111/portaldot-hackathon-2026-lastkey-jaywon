const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  
  if (net.chainId !== 420420777n) throw new Error("wrong chainId: " + net.chainId);

  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("chainId:", net.chainId.toString());
  console.log("deployer:", deployer.address);
  console.log("balance(wei):", bal.toString());

  const F = await hre.ethers.getContractFactory("LastKey");
  const deployTx = await F.getDeployTransaction();

  const feeData = await hre.ethers.provider.getFeeData();
  const currentGasPrice = feeData.gasPrice || 29715n;
  const maxFeePerGas = (currentGasPrice * 1125n) / 1000n;
  const maxPriorityFeePerGas = 0n;

  console.log("Estimating gas...");
  let estimatedGas;
  try {
    estimatedGas = await hre.ethers.provider.estimateGas({
      from: deployer.address,
      data: deployTx.data,
    });
  } catch (e) {
    console.warn("Gas estimation failed, falling back to 4,000,000. Error:", e.message);
    estimatedGas = 4000000n;
  }
  
  const gasLimit = (estimatedGas * 110n) / 100n;

  const maxGasCost = gasLimit * maxFeePerGas;
  console.log("Signing Gas Limit:", gasLimit.toString());
  console.log("Max Gas Cost (wei):", maxGasCost.toString());

  if (maxGasCost > bal) {
    console.error("❌ ABORT: Max gas cost exceeds your entire balance!");
    process.exit(1);
  }

  console.log("Sending deployment transaction...");
  const tx = await deployer.sendTransaction({
    data: deployTx.data,
    type: 2,
    maxFeePerGas: maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas,
    gasLimit: gasLimit,
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
