const { expect } = require("chai");
const { ethers } = require("hardhat");

// Shamir passphrase split: k-of-n beneficiaries can reconstruct without the owner.
describe("LastKey.shardSplit", function () {
  let lastKey, owner, b1, b2, b3;
  const secret = ethers.toUtf8Bytes("correct horse battery staple");
  const secretHash = ethers.keccak256(secret);

  beforeEach(async () => {
    [owner, b1, b2, b3] = await ethers.getSigners();
    lastKey = await (await ethers.getContractFactory("LastKey")).deploy();
    await lastKey.waitForDeployment();
    await (await lastKey.connect(owner).register(
      7, 3, [b1.address, b2.address, b3.address], [4000, 3000, 3000],
      secretHash, ethers.toUtf8Bytes("instructions")
    )).wait();
  });

  it("stores one shard per beneficiary and exposes it only to that beneficiary", async () => {
    const chunks = [ethers.id("chunk-1"), ethers.id("chunk-2")];
    const shards = [chunks, chunks, chunks];
    await (await lastKey.connect(owner).setShardSplit(2, shards)).wait();
    expect(await lastKey.shardThresholdOf(owner.address)).to.equal(2);
    expect(await lastKey.connect(b1).shardOf(owner.address)).to.deep.equal(chunks);
    expect(await lastKey.connect(b2).shardOf(owner.address)).to.deep.equal(chunks);
    // a non-beneficiary cannot read anyone's shard
    const stranger = (await ethers.getSigners())[4];
    await expect(lastKey.connect(stranger).shardOf(owner.address))
      .to.be.revertedWithCustomError(lastKey, "NotCurrentBeneficiary");
  });

  it("validates threshold and shard count", async () => {
    await expect(lastKey.connect(owner).setShardSplit(1, [[], [], []]))
      .to.be.revertedWithCustomError(lastKey, "ShardThresholdInvalid");
    await expect(lastKey.connect(owner).setShardSplit(4, [[], [], []]))
      .to.be.revertedWithCustomError(lastKey, "ShardThresholdInvalid");
    await expect(lastKey.connect(owner).setShardSplit(2, [[], []]))
      .to.be.revertedWithCustomError(lastKey, "ShardCountMismatch");
  });

  it("end-to-end: owner never shares the passphrase, two beneficiaries reconstruct and claim", async () => {
    // advance past deadline + grace so claims open
    await ethers.provider.send("evm_increaseTime", [11 * 86400]);
    await ethers.provider.send("evm_mine", []);
    // owner stores shards, never posts the passphrase anywhere and never tells anyone
    const chunks = [ethers.id("shard-material-1")];
    await (await lastKey.connect(owner).setShardSplit(2, [chunks, chunks, chunks])).wait();
    // in the real app each beneficiary reads only their own shard off-chain and they
    // reconstruct the passphrase from k of them; here the reconstructed secret is known.
    await (await lastKey.connect(b1).claim(owner.address, "correct horse battery staple")).wait();
    const [isBen, claimed, bps] = await lastKey.slotOf(owner.address, b1.address);
    expect(claimed).to.equal(true);
    expect(bps).to.equal(4000);
  });
});
