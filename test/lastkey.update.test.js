const { expect } = require("chai");
const { ethers } = require("hardhat");

// updateVault: in-place edits keep the epoch and the clock.
describe("LastKey.updateVault", function () {
  let lastKey, owner, b1, b2, b3;
  const I = 7, G = 3;

  beforeEach(async () => {
    [owner, b1, b2, b3] = await ethers.getSigners();
    lastKey = await (await ethers.getContractFactory("LastKey")).deploy();
    await lastKey.waitForDeployment();
    await (await lastKey.connect(owner).register(
      I, G, [b1.address, b2.address], [5000, 5000],
      ethers.keccak256(ethers.toUtf8Bytes("old-secret")),
      ethers.toUtf8Bytes("instructions v1")
    )).wait();
  });

  it("edits interval/grace without resetting lastCheckIn or epoch", async () => {
    const before = await lastKey.getVault(owner.address);
    await ethers.provider.send("evm_increaseTime", [3 * 86400]);
    await ethers.provider.send("evm_mine", []);
    await (await lastKey.connect(owner).updateVault(
      30, 7, [b1.address, b2.address], [5000, 5000],
      ethers.keccak256(ethers.toUtf8Bytes("old-secret")),
      ethers.toUtf8Bytes("instructions v1")
    )).wait();
    const after = await lastKey.getVault(owner.address);
    expect(after.epoch).to.equal(before.epoch);          // same epoch
    expect(after.lastCheckIn).to.equal(before.lastCheckIn); // clock untouched
    expect(after.intervalDays).to.equal(30);
    expect(after.graceDays).to.equal(7);
    const [, claimOpensAt] = await lastKey.timing(owner.address);
    const deadline = before.lastCheckIn + BigInt(30 * 86400);
    expect(claimOpensAt).to.equal(deadline + BigInt(7 * 86400));
  });

  it("swaps beneficiaries and shares in the same epoch", async () => {
    await (await lastKey.connect(owner).updateVault(
      7, 3, [b2.address, b3.address], [7000, 3000],
      ethers.keccak256(ethers.toUtf8Bytes("new-secret")),
      ethers.toUtf8Bytes("instructions v2")
    )).wait();
    const v = await lastKey.getVault(owner.address);
    expect(v.beneficiaries).to.deep.equal([b2.address, b3.address]);
    const s1 = await lastKey.slotOf(owner.address, b1.address);
    expect(s1.isBeneficiary).to.equal(false);
    const s3 = await lastKey.slotOf(owner.address, b3.address);
    expect(s3.isBeneficiary).to.equal(true);
    expect(s3.shareBps).to.equal(3000);
  });

  it("rejects edits on a closed or triggered vault", async () => {
    await (await lastKey.connect(owner).close()).wait();
    await expect(lastKey.connect(owner).updateVault(
      30, 7, [b1.address], [10000],
      ethers.keccak256(ethers.toUtf8Bytes("s")), ethers.toUtf8Bytes("x")
    )).to.be.revertedWithCustomError(lastKey, "NoActiveVault");
  });
});
