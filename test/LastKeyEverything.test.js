const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const SECRET = "open-sesame";
const SECRET_HASH = ethers.keccak256(ethers.toUtf8Bytes(SECRET));
const PAYLOAD = ethers.toUtf8Bytes("ciphertext-everything");
const LISTED = 0;
const EVERYTHING = 1;

async function setNextTime(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
}
async function latest() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

describe("LastKey everything approval (blanket attestation)", function () {
  let lk, token, token2, owner, alice, bob, watcher, stranger;
  const AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [, owner, alice, bob, watcher, stranger] = await ethers.getSigners();
    lk = await (await ethers.getContractFactory("LastKey")).deploy();
    await lk.waitForDeployment();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Mock", "MCK");
    token2 = await Mock.deploy("Mock2", "MC2");
    await token.waitForDeployment();
    await token2.waitForDeployment();
    await (await lk.setWatcher(watcher.address)).wait();
    await token.mint(owner.address, AMOUNT * 10n);
    await token2.mint(owner.address, AMOUNT * 10n);
  });

  async function registerVault() {
    await lk.connect(owner).register(30, 7, [alice.address, bob.address], [6000, 4000], SECRET_HASH, PAYLOAD);
    return latest();
  }
  async function vaultId(epoch = 1n) {
    return lk.vaultIdOf(owner.address, epoch);
  }

  describe("enableEverythingApproval", function () {
    it("records the attestation, switches to Everything and emits both events", async function () {
      await registerVault();
      const id = await vaultId();
      const tx = await lk.connect(owner).enableEverythingApproval(id);
      const rc = await tx.wait();
      const ts = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;

      await expect(tx)
        .to.emit(lk, "EverythingApprovalEnabled")
        .withArgs(id, owner.address, 1n, ts);
      await expect(tx).to.emit(lk, "SweepModeSet").withArgs(id, owner.address, EVERYTHING, ts);

      const [attested, at] = await lk.everythingAttestedOf(owner.address);
      expect(attested).to.equal(true);
      expect(at).to.equal(ts);
      expect(await lk.sweepModeOf(owner.address)).to.equal(EVERYTHING);
    });

    it("rejects a stale vault id from an earlier cycle", async function () {
      await registerVault();
      const oldId = await vaultId(1n);
      await lk.connect(owner).close();
      await lk.connect(owner).register(30, 7, [alice.address], [10000], SECRET_HASH, PAYLOAD);
      await expect(lk.connect(owner).enableEverythingApproval(oldId)).to.be.revertedWithCustomError(
        lk,
        "VaultIdMismatch"
      );
    });

    it("reverts without an active vault", async function () {
      await expect(lk.connect(owner).enableEverythingApproval(await vaultId())).to.be.revertedWithCustomError(
        lk,
        "NoActiveVault"
      );
    });

    it("reverts after a claim has triggered the vault", async function () {
      const t0 = await registerVault();
      await setNextTime(t0 + 37 * DAY + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      await expect(lk.connect(owner).enableEverythingApproval(await vaultId())).to.be.revertedWithCustomError(
        lk,
        "VaultTriggered"
      );
    });

    it("is not callable by a stranger on someone else's vault", async function () {
      await registerVault();
      // the id is only meaningful for its owner, so a stranger's own vault is simply inactive
      await expect(lk.connect(stranger).enableEverythingApproval(await vaultId())).to.be.revertedWithCustomError(
        lk,
        "NoActiveVault"
      );
    });

    it("attests but does not grant any ERC20 allowance (approval stays with the owner)", async function () {
      await registerVault();
      await lk.connect(owner).enableEverythingApproval(await vaultId());
      expect(await token.allowance(owner.address, await lk.getAddress())).to.equal(0n);
      expect(await lk.approvalsRemaining(owner.address, await token.getAddress())).to.equal(0n);
    });
  });

  describe("revokeEverythingApproval", function () {
    it("clears the attestation, returns to Listed and emits the revoke event", async function () {
      await registerVault();
      const id = await vaultId();
      await lk.connect(owner).enableEverythingApproval(id);
      const tx = await lk.connect(owner).revokeEverythingApproval(id);
      await expect(tx).to.emit(lk, "EverythingApprovalRevoked");
      const [attested, at] = await lk.everythingAttestedOf(owner.address);
      expect(attested).to.equal(false);
      expect(at).to.equal(0n);
      expect(await lk.sweepModeOf(owner.address)).to.equal(LISTED);
    });

    it("blocks sweepAll again once revoked", async function () {
      const t0 = await registerVault();
      const id = await vaultId();
      await lk.connect(owner).enableEverythingApproval(id);
      await lk.connect(owner).revokeEverythingApproval(id);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await setNextTime(t0 + 37 * DAY + 1);
      await expect(lk.connect(alice).sweepAll(owner.address, [await token.getAddress()])).to.be.revertedWithCustomError(
        lk,
        "WrongSweepMode"
      );
    });
  });

  describe("attestation interacts with setSweepMode and registration", function () {
    it("setSweepMode(Everything) also records the attestation, and Listed clears it", async function () {
      await registerVault();
      const id = await vaultId();
      await lk.connect(owner).setSweepMode(id, EVERYTHING);
      expect((await lk.everythingAttestedOf(owner.address))[0]).to.equal(true);
      await lk.connect(owner).setSweepMode(id, LISTED);
      expect((await lk.everythingAttestedOf(owner.address))[0]).to.equal(false);
    });

    it("a new registration resets the attestation for the new cycle", async function () {
      await registerVault();
      await lk.connect(owner).enableEverythingApproval(await vaultId());
      await lk.connect(owner).close();
      await lk.connect(owner).register(30, 7, [alice.address], [10000], SECRET_HASH, PAYLOAD);
      const [attested] = await lk.everythingAttestedOf(owner.address);
      expect(attested).to.equal(false);
      expect(await lk.sweepModeOf(owner.address)).to.equal(LISTED);
    });
  });

  describe("approvalsRemaining", function () {
    it("is min(balance, allowance) to the vault, live", async function () {
      await registerVault();
      const addr = await lk.getAddress();
      const t = await token.getAddress();
      expect(await lk.approvalsRemaining(owner.address, t)).to.equal(0n);

      await token.connect(owner).approve(addr, AMOUNT * 3n);
      expect(await lk.approvalsRemaining(owner.address, t)).to.equal(AMOUNT * 3n); // allowance < balance

      await token.connect(owner).approve(addr, AMOUNT * 99n);
      expect(await lk.approvalsRemaining(owner.address, t)).to.equal(AMOUNT * 10n); // balance < allowance
    });

    it("returns 0 for a non-contract address and for a different owner's approval", async function () {
      await registerVault();
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      expect(await lk.approvalsRemaining(owner.address, stranger.address)).to.equal(0n);
      expect(await lk.approvalsRemaining(stranger.address, await token.getAddress())).to.equal(0n);
    });

    it("tracks a sweep: the approval shrinks after tokens move", async function () {
      const t0 = await registerVault();
      const addr = await lk.getAddress();
      const t = await token.getAddress();
      await token.connect(owner).approve(addr, AMOUNT);
      await lk.connect(owner).enableEverythingApproval(await vaultId());
      await setNextTime(t0 + 37 * DAY + 1);
      await lk.connect(alice).sweepAll(owner.address, [t]);
      expect(await lk.approvalsRemaining(owner.address, t)).to.equal(0n);
    });
  });

  describe("everything claim end to end", function () {
    it("pulls every approved token and pays beneficiaries from the attested vault", async function () {
      const t0 = await registerVault();
      const addr = await lk.getAddress();
      await lk.connect(owner).deposit({ value: ethers.parseEther("1") });
      await token.connect(owner).approve(addr, AMOUNT);
      await token2.connect(owner).approve(addr, AMOUNT * 2n);
      await lk.connect(owner).enableEverythingApproval(await vaultId());

      await setNextTime(t0 + 37 * DAY + 1);
      await lk.connect(watcher).sweepAll(owner.address, [await token.getAddress(), await token2.getAddress()]);
      await lk.connect(alice).claim(owner.address, SECRET);

      expect(await token.balanceOf(alice.address)).to.equal((AMOUNT * 6n) / 10n);
      expect(await token2.balanceOf(alice.address)).to.equal((AMOUNT * 2n * 6n) / 10n);
    });
  });
});
