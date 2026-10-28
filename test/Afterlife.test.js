const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const ZERO = ethers.ZeroHash;
const hashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function setNextTime(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
}
async function mineAt(t) {
  await setNextTime(t);
  await network.provider.send("evm_mine");
}
async function latest() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp;
}

describe("Afterlife", function () {
  let afterlife, owner, alice, bob, carol, dave, admin;

  beforeEach(async function () {
    [admin, owner, alice, bob, carol, dave] = await ethers.getSigners();
    const F = await ethers.getContractFactory("Afterlife");
    afterlife = await F.deploy();
    await afterlife.waitForDeployment();
  });

  async function registerDefault(signer = owner, interval = 30) {
    const ben = [alice.address, bob.address];
    const hashes = [hashOf("alice-payload"), hashOf("bob-payload")];
    const tx = await afterlife.connect(signer).register(interval, ben, hashes);
    return { tx, ben, hashes };
  }

  describe("deployment defaults", function () {
    it("sets admin and fee sink to the deployer and keeps fees disabled", async function () {
      expect(await afterlife.admin()).to.equal(admin.address);
      expect(await afterlife.feeSink()).to.equal(admin.address);
      expect(await afterlife.feeEnabled()).to.equal(false);
      expect(await afterlife.registrationFee()).to.equal(0n);
    });
  });

  describe("registration", function () {
    it("stores interval, beneficiaries and payload hashes and emits VaultRegistered", async function () {
      const { tx, ben, hashes } = await registerDefault();
      await expect(tx)
        .to.emit(afterlife, "VaultRegistered")
        .withArgs(owner.address, 1n, 30, 2n, (v) => v > 0n);

      const v = await afterlife.getVault(owner.address);
      expect(v.active).to.equal(true);
      expect(v.triggered).to.equal(false);
      expect(v.intervalDays).to.equal(30);
      expect(v.epoch).to.equal(1n);
      expect(v.beneficiaries).to.deep.equal(ben);
      expect(await afterlife.payloadHashOf(owner.address, alice.address)).to.equal(hashes[0]);
      expect(await afterlife.payloadHashOf(owner.address, bob.address)).to.equal(hashes[1]);
      expect(await afterlife.isClaimable(owner.address, alice.address)).to.equal(false);
    });

    it("rejects a second registration while the vault is active", async function () {
      await registerDefault();
      await expect(registerDefault()).to.be.revertedWithCustomError(afterlife, "VaultAlreadyActive");
    });

    it("rejects bad intervals", async function () {
      await expect(registerDefault(owner, 0)).to.be.revertedWithCustomError(afterlife, "InvalidInterval");
      await expect(registerDefault(owner, 3651)).to.be.revertedWithCustomError(afterlife, "InvalidInterval");
    });

    it("rejects zero, self, zero-hash, duplicate and mismatched beneficiary inputs", async function () {
      const h = [hashOf("x")];
      await expect(
        afterlife.connect(owner).register(30, [], [])
      ).to.be.revertedWithCustomError(afterlife, "InvalidBeneficiaryCount");
      await expect(
        afterlife.connect(owner).register(30, [alice.address], [])
      ).to.be.revertedWithCustomError(afterlife, "LengthMismatch");
      await expect(
        afterlife.connect(owner).register(30, [ethers.ZeroAddress], h)
      ).to.be.revertedWithCustomError(afterlife, "ZeroAddress");
      await expect(
        afterlife.connect(owner).register(30, [owner.address], h)
      ).to.be.revertedWithCustomError(afterlife, "SelfBeneficiary");
      await expect(
        afterlife.connect(owner).register(30, [alice.address], [ZERO])
      ).to.be.revertedWithCustomError(afterlife, "EmptyPayloadHash");
      await expect(
        afterlife.connect(owner).register(30, [alice.address, alice.address], [h[0], h[0]])
      ).to.be.revertedWithCustomError(afterlife, "DuplicateBeneficiary");
    });

    it("rejects value when fees are disabled", async function () {
      await expect(
        afterlife.connect(owner).register(30, [alice.address], [hashOf("a")], { value: 1n })
      ).to.be.revertedWithCustomError(afterlife, "IncorrectFee");
    });
  });

  describe("check-in", function () {
    it("resets lastCheckIn to now, emits CheckedIn, and pushes the deadline forward", async function () {
      await registerDefault();
      const before = (await afterlife.getVault(owner.address)).lastCheckIn;

      // Advance 10 days, then check in.
      const t = before + BigInt(10 * DAY);
      await setNextTime(t);
      await expect(afterlife.connect(owner).checkIn())
        .to.emit(afterlife, "CheckedIn")
        .withArgs(owner.address, 1n, t);

      const v = await afterlife.getVault(owner.address);
      expect(v.lastCheckIn).to.equal(t);
      expect(v.deadline).to.equal(t + BigInt(30 * DAY));
    });

    it("a check-in right before the deadline keeps claims closed", async function () {
      await registerDefault(owner, 30);
      const start = (await afterlife.getVault(owner.address)).lastCheckIn;
      // Day 29: check in again.
      await mineAt(start + BigInt(29 * DAY));
      await afterlife.connect(owner).checkIn();
      // Day 31 from the original registration: still inside the new window.
      await setNextTime(start + BigInt(31 * DAY));
      await expect(
        afterlife.connect(alice).claim(owner.address)
      ).to.be.revertedWithCustomError(afterlife, "NotYetClaimable");
    });

    it("reverts for an address with no active vault", async function () {
      await expect(afterlife.connect(carol).checkIn()).to.be.revertedWithCustomError(afterlife, "NoActiveVault");
    });
  });

  describe("premature claims", function () {
    it("rejects a claim before the deadline", async function () {
      await registerDefault(owner, 30);
      await expect(
        afterlife.connect(alice).claim(owner.address)
      ).to.be.revertedWithCustomError(afterlife, "NotYetClaimable");
    });

    it("rejects a claim at exactly the deadline (strictly greater is required)", async function () {
      await registerDefault(owner, 30);
      const deadline = await afterlife.deadlineOf(owner.address);
      await setNextTime(deadline);
      await expect(
        afterlife.connect(alice).claim(owner.address)
      ).to.be.revertedWithCustomError(afterlife, "NotYetClaimable");
    });

    it("isClaimable is false before the deadline", async function () {
      await registerDefault(owner, 30);
      expect(await afterlife.isClaimable(owner.address, alice.address)).to.equal(false);
    });
  });

  describe("valid claim after lapse", function () {
    it("lets a beneficiary claim after the deadline and emits ClaimProof", async function () {
      await registerDefault(owner, 30);
      const deadline = await afterlife.deadlineOf(owner.address);
      const t = deadline + 1n;
      await setNextTime(t);

      const tx = await afterlife.connect(alice).claim(owner.address);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      expect(block.timestamp).to.equal(Number(t));

      await expect(tx)
        .to.emit(afterlife, "ClaimProof")
        .withArgs(
          owner.address,
          alice.address,
          1n,
          hashOf("alice-payload"),
          (id) => id !== ZERO,
          t
        );

      expect(await afterlife.hasClaimed(owner.address, alice.address)).to.equal(true);
      expect(await afterlife.isClaimable(owner.address, alice.address)).to.equal(false);
      expect((await afterlife.getVault(owner.address)).triggered).to.equal(true);
    });

    it("prevents the same beneficiary from claiming twice", async function () {
      await registerDefault(owner, 30);
      await setNextTime((await afterlife.deadlineOf(owner.address)) + 1n);
      await afterlife.connect(alice).claim(owner.address);
      await expect(
        afterlife.connect(alice).claim(owner.address)
      ).to.be.revertedWithCustomError(afterlife, "AlreadyClaimed");
    });

    it("lets a second beneficiary claim their own payload after the first claim", async function () {
      await registerDefault(owner, 30);
      await setNextTime((await afterlife.deadlineOf(owner.address)) + 1n);
      await afterlife.connect(alice).claim(owner.address);
      await expect(afterlife.connect(bob).claim(owner.address))
        .to.emit(afterlife, "ClaimProof")
        .withArgs(owner.address, bob.address, 1n, hashOf("bob-payload"), (id) => id !== ZERO, (v) => v > 0n);
    });

    it("blocks check-in and close once a claim has triggered the vault", async function () {
      await registerDefault(owner, 30);
      await setNextTime((await afterlife.deadlineOf(owner.address)) + 1n);
      await afterlife.connect(alice).claim(owner.address);
      await expect(afterlife.connect(owner).checkIn()).to.be.revertedWithCustomError(afterlife, "VaultTriggered");
      await expect(afterlife.connect(owner).close()).to.be.revertedWithCustomError(afterlife, "VaultTriggered");
    });
  });

  describe("beneficiary-only claims", function () {
    it("rejects a claim from a non-beneficiary, even after the lapse", async function () {
      await registerDefault(owner, 30);
      await setNextTime((await afterlife.deadlineOf(owner.address)) + 1n);
      await expect(
        afterlife.connect(carol).claim(owner.address)
      ).to.be.revertedWithCustomError(afterlife, "NotBeneficiary");
    });

    it("rejects the owner claiming their own vault", async function () {
      await registerDefault(owner, 30);
      await setNextTime((await afterlife.deadlineOf(owner.address)) + 1n);
      await expect(
        afterlife.connect(owner).claim(owner.address)
      ).to.be.revertedWithCustomError(afterlife, "NotBeneficiary");
    });

    it("rejects claims against a vault that does not exist", async function () {
      await expect(
        afterlife.connect(alice).claim(dave.address)
      ).to.be.revertedWithCustomError(afterlife, "NoActiveVault");
    });

    it("rejects a claim against a closed vault", async function () {
      await registerDefault(owner, 30);
      await afterlife.connect(owner).close();
      await setNextTime((await afterlife.deadlineOf(owner.address)) + 1n);
      await expect(
        afterlife.connect(alice).claim(owner.address)
      ).to.be.revertedWithCustomError(afterlife, "NoActiveVault");
    });
  });

  describe("close and re-registration", function () {
    it("close deactivates the vault and blocks check-ins", async function () {
      await registerDefault(owner, 30);
      await expect(afterlife.connect(owner).close())
        .to.emit(afterlife, "VaultClosed")
        .withArgs(owner.address, 1n, (v) => v > 0n);
      expect((await afterlife.getVault(owner.address)).active).to.equal(false);
      await expect(afterlife.connect(owner).checkIn()).to.be.revertedWithCustomError(afterlife, "NoActiveVault");
    });

    it("can re-register after close with a new epoch and new beneficiaries", async function () {
      await registerDefault(owner, 30);
      await afterlife.connect(owner).close();

      const newHash = hashOf("carol-payload");
      await afterlife.connect(owner).register(7, [carol.address], [newHash]);

      const v = await afterlife.getVault(owner.address);
      expect(v.active).to.equal(true);
      expect(v.epoch).to.equal(2n);
      expect(v.intervalDays).to.equal(7);
      expect(v.beneficiaries).to.deep.equal([carol.address]);
      expect(await afterlife.payloadHashOf(owner.address, carol.address)).to.equal(newHash);
      // Old beneficiaries have no rights in the new epoch.
      expect(await afterlife.payloadHashOf(owner.address, alice.address)).to.equal(ZERO);
      await setNextTime((await afterlife.deadlineOf(owner.address)) + 1n);
      await expect(
        afterlife.connect(alice).claim(owner.address)
      ).to.be.revertedWithCustomError(afterlife, "NotBeneficiary");
      await expect(afterlife.connect(carol).claim(owner.address)).to.emit(afterlife, "ClaimProof");
    });

    it("can re-register after a triggered claim, starting a clean epoch", async function () {
      await registerDefault(owner, 30);
      await setNextTime((await afterlife.deadlineOf(owner.address)) + 1n);
      await afterlife.connect(alice).claim(owner.address);

      // Owner is back: re-register. Triggered flag clears and bob has no claim yet in epoch 2.
      await afterlife.connect(owner).register(30, [bob.address], [hashOf("bob-v2")]);
      const v = await afterlife.getVault(owner.address);
      expect(v.epoch).to.equal(2n);
      expect(v.triggered).to.equal(false);
      expect(await afterlife.hasClaimed(owner.address, bob.address)).to.equal(false);
      expect(await afterlife.payloadHashOf(owner.address, bob.address)).to.equal(hashOf("bob-v2"));
    });

    it("re-registration resets lastCheckIn to the new registration time", async function () {
      await registerDefault(owner, 30);
      await afterlife.connect(owner).close();
      const t = await latest();
      await setNextTime(t + 5 * DAY);
      await afterlife.connect(owner).register(10, [alice.address], [hashOf("a2")]);
      const v = await afterlife.getVault(owner.address);
      expect(v.lastCheckIn).to.be.greaterThan(BigInt(t));
      expect(v.deadline).to.equal(v.lastCheckIn + BigInt(10 * DAY));
    });
  });

  describe("registration fee sink (disabled by default)", function () {
    it("admin can enable a fee; registration must then pay exactly that fee", async function () {
      const fee = ethers.parseEther("0.01");
      await afterlife.connect(admin).setFee(true, fee);
      await expect(
        afterlife.connect(owner).register(30, [alice.address], [hashOf("a")], { value: fee - 1n })
      ).to.be.revertedWithCustomError(afterlife, "IncorrectFee");
      await afterlife.connect(owner).register(30, [alice.address], [hashOf("a")], { value: fee });
      expect(await ethers.provider.getBalance(await afterlife.getAddress())).to.equal(fee);
    });

    it("non-admin cannot change fee settings or withdraw", async function () {
      await expect(afterlife.connect(owner).setFee(true, 1n)).to.be.revertedWithCustomError(afterlife, "NotAdmin");
      await expect(afterlife.connect(owner).withdrawFees()).to.be.revertedWithCustomError(afterlife, "NotAdmin");
    });

    it("admin can sweep accumulated fees to the fee sink", async function () {
      const fee = ethers.parseEther("0.02");
      await afterlife.connect(admin).setFee(true, fee);
      await afterlife.connect(owner).register(30, [alice.address], [hashOf("a")], { value: fee });
      await afterlife.connect(admin).setFeeSink(dave.address);
      await expect(afterlife.connect(admin).withdrawFees())
        .to.emit(afterlife, "FeesWithdrawn")
        .withArgs(dave.address, fee);
      expect(await ethers.provider.getBalance(await afterlife.getAddress())).to.equal(0n);
    });

    it("withdraw with no balance reverts", async function () {
      await expect(afterlife.connect(admin).withdrawFees()).to.be.revertedWithCustomError(afterlife, "NothingToWithdraw");
    });
  });
});
