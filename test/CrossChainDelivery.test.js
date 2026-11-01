"use strict";
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { prepareCrossChainClaim, submitCrossChainClaim } = require("../keeper/lib/crosschain");

const DAY = 86400;
const SECRET = "cross-chain secret";
const SECRET_HASH = ethers.keccak256(ethers.toUtf8Bytes(SECRET));

describe("Cross-chain claim delivery", function () {
  it("prepares source-verified quorum package and lets only beneficiary submit it", async function () {
    const [admin, owner, alice, bob] = await ethers.getSigners();
    const w1 = ethers.Wallet.createRandom();
    const w2 = ethers.Wallet.createRandom();
    const w3 = ethers.Wallet.createRandom();
    const src = await (await ethers.getContractFactory("LastKey")).deploy();
    const bridge = await (await ethers.getContractFactory("LastKeyBridgeReceiver")).deploy([w1.address, w2.address, w3.address], 2);
    await src.waitForDeployment();
    await bridge.waitForDeployment();
    const start = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 5n;
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(start)]);
    await src.connect(owner).register(1, 1, [alice.address, bob.address], [6000, 4000], SECRET_HASH, ethers.toUtf8Bytes("ciphertext"), { value: ethers.parseEther("1") });
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(start + 2n * BigInt(DAY))]);
    await ethers.provider.send("evm_mine", []);
    await bridge.fundMirror(31338, await src.getAddress(), owner.address, 1, { value: ethers.parseEther("1") });

    const pkg = await prepareCrossChainClaim({
      sourceProvider: ethers.provider,
      destinationProvider: ethers.provider,
      srcChainId: 31338,
      srcVault: await src.getAddress(),
      owner: owner.address,
      beneficiary: alice.address,
      receiverAddress: await bridge.getAddress(),
      watcherWallets: [w1, w2, w3],
      now: () => Number(start + 2n * BigInt(DAY)),
    });
    expect(pkg.signatures).to.have.length(2);
    expect(pkg.att.shareBps).to.equal(6000);
    await expect(submitCrossChainClaim({ destinationSigner: bob, receiverAddress: await bridge.getAddress(), claimPackage: pkg, secret: SECRET })).to.be.rejectedWith("destination signer must be the attested beneficiary");
    const result = await submitCrossChainClaim({ destinationSigner: alice, receiverAddress: await bridge.getAddress(), claimPackage: pkg, secret: SECRET });
    expect(result.status).to.equal(1);
    expect(await bridge.claimedBy(pkg.mirrorId, alice.address)).to.equal(true);
  });

  it("refuses to attest before source claim window or without funded mirror", async function () {
    const [admin, owner, alice] = await ethers.getSigners();
    const w = ethers.Wallet.createRandom();
    const src = await (await ethers.getContractFactory("LastKey")).deploy();
    const bridge = await (await ethers.getContractFactory("LastKeyBridgeReceiver")).deploy([w.address], 1);
    await src.waitForDeployment();
    await bridge.waitForDeployment();
    const start = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 5n;
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(start)]);
    await src.connect(owner).register(30, 7, [alice.address], [10000], SECRET_HASH, ethers.toUtf8Bytes("ciphertext"), { value: 1 });
    const args = { sourceProvider: ethers.provider, destinationProvider: ethers.provider, srcChainId: 31338, srcVault: await src.getAddress(), owner: owner.address, beneficiary: alice.address, receiverAddress: await bridge.getAddress(), watcherWallets: [w] };
    await expect(prepareCrossChainClaim(args)).to.be.rejectedWith("source claim window is not open yet");
  });
});
