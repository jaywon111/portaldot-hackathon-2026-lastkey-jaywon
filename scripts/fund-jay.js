// Funds a wallet on the local hardhat chain (31337): ETH gas from account #0 plus mock tokens minted from the deployer.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const TARGET = "0xA0C42BF2406478C325a2636ff3A964976E9328B7";
async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 31338n) throw new Error("must run on chain 31338");
  const [admin] = await ethers.getSigners();
  const out = require(path.join(__dirname, "local-demo.out.json"));
  await (await admin.sendTransaction({ to: TARGET, value: ethers.parseEther("10") })).wait();
  const M = await ethers.getContractAt("MockERC20", out.tokens.DUSD);
  const G = await ethers.getContractAt("MockERC20", out.tokens.DGOLD);
  await (await M.connect(admin).mint(TARGET, ethers.parseEther("1000"))).wait();
  await (await G.connect(admin).mint(TARGET, ethers.parseEther("50"))).wait();
  const eth = await ethers.provider.getBalance(TARGET);
  console.log(JSON.stringify({
    wallet: TARGET,
    eth: ethers.formatEther(eth),
    DUSD: ethers.formatEther(await M.balanceOf(TARGET)),
    DGOLD: ethers.formatEther(await G.balanceOf(TARGET)),
  }));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
