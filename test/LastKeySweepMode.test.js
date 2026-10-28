const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const SECRET = "sesame";
const SECRET_HASH = ethers.keccak256(ethers.toUtf8Bytes(SECRET));
const PAYLOAD = ethers.toUtf8Bytes("ciphertext-blob-sweep-mode");
const LISTED = 0;
const EVERYTHING = 1;

async function setNextTime(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
}
async function latest() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

describe("LastKey v3.1 sweep modes (listed / everything)", function () {
  let lk, token, token2, owner, alice, bob, watcher, other;
  const AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [, owner, alice, bob, watcher, other] = await ethers.getSigners();
    lk = await (await ethers.getContractFactory("LastKey")).deploy();
    await lk.waitForDeployment();
    const Mock = await ethers.getContractFactory("MockERC20");
    token = await Mock.deploy("Mock", "MCK");
    await token.waitForDeployment();
    token2 = await Mock.deploy("Mock2", "MC2");
    await token2.waitForDeployment();
    await (await lk.setWatcher(watcher.address)).wait();
    await token.mint(owner.address, AMOUNT * 10n);
    await token2.mint(owner.address, AMOUNT * 10n);
  });

  async function registerVault(value = 0n) {
    await lk
      .connect(owner)
      .register(30, 7, [alice.address, bob.address], [6000, 4000], SECRET_HASH, PAYLOAD, { value });
    return latest();
  }

  async function openClaimWindow(days = 37) {
    await setNextTime((await latest()) + days * DAY + 1);
  }

  async function vaultId(epoch = 1n) {
    return lk.vaultIdOf(owner.address, epoch);
  }

  describe("setSweepMode", function () {
    it("defaults to listed on registration", async function () {
      await registerVault();
      expect(await lk.sweepModeOf(owner.address)).to.equal(LISTED);
    });

    it("owner can switch to everything for the current cycle and emits SweepModeSet", async function () {
      await registerVault();
      const id = await vaultId();
      const tx = await lk.connect(owner).setSweepMode(id, EVERYTHING);
      const rc = await tx.wait();
      const ts = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;
      await expect(tx)
        .to.emit(lk, "SweepModeSet")
        .withArgs(id, owner.address, EVERYTHING, ts);
      expect(await lk.sweepModeOf(owner.address)).to.equal(EVERYTHING);
    });

    it("can switch back to listed before a claim", async function () {
      await registerVault();
      const id = await vaultId();
      await lk.connect(owner).setSweepMode(id, EVERYTHING);
      await lk.connect(owner).setSweepMode(id, LISTED);
      expect(await lk.sweepModeOf(owner.address)).to.equal(LISTED);
    });

    it("rejects an unknown mode value", async function () {
      await registerVault();
      await expect(lk.connect(owner).setSweepMode(await vaultId(), 2)).to.be.revertedWithCustomError(
        lk,
        "InvalidSweepMode"
      );
    });

    it("rejects a vault id from another cycle or owner", async function () {
      await registerVault();
      const stale = await vaultId(2n);
      await expect(lk.connect(owner).setSweepMode(stale, EVERYTHING)).to.be.revertedWithCustomError(
        lk,
        "VaultIdMismatch"
      );
      await expect(
        lk.connect(other).setSweepMode(await vaultId(), EVERYTHING)
      ).to.be.revertedWithCustomError(lk, "NoActiveVault");
    });

    it("mode switch reverts after the first claim (VaultTriggered)", async function () {
      await registerVault();
      const id = await vaultId();
      await lk.connect(owner).setSweepMode(id, EVERYTHING);
      await openClaimWindow();
      await lk.connect(alice).claim(owner.address, SECRET);
      await expect(lk.connect(owner).setSweepMode(id, LISTED)).to.be.revertedWithCustomError(
        lk,
        "VaultTriggered"
      );
      expect(await lk.sweepModeOf(owner.address)).to.equal(EVERYTHING);
    });

    it("re-registration resets the mode to listed", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await lk.connect(owner).close();
      await registerVault();
      expect(await lk.sweepModeOf(owner.address)).to.equal(LISTED);
    });
  });

  describe("sweepAll (everything mode)", function () {
    it("reverts WrongSweepMode while the vault is listed", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await openClaimWindow();
      await expect(
        lk.connect(alice).sweepAll(owner.address, [await token.getAddress()])
      ).to.be.revertedWithCustomError(lk, "WrongSweepMode");
    });

    it("pulls approved tokens only and ignores unapproved ones", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      // token is approved to the vault; token2 is held but never approved
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await openClaimWindow();

      const t1 = await token.getAddress();
      const t2 = await token2.getAddress();
      await lk.connect(alice).sweepAll(owner.address, [t1, t2]);

      expect(await lk.tokenEscrowOf(owner.address, t1)).to.equal(AMOUNT);
      expect(await lk.tokenEscrowOf(owner.address, t2)).to.equal(0n);
      expect(await token2.balanceOf(owner.address)).to.equal(AMOUNT * 10n);
      expect(await lk.escrowTokensOf(owner.address)).to.deep.equal([t1]);
    });

    it("sweeps min(balance, allowance) and leaves the rest with the owner", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT / 2n);
      await openClaimWindow();
      await lk.connect(alice).sweepAll(owner.address, [await token.getAddress()]);
      expect(await lk.tokenEscrowOf(owner.address, await token.getAddress())).to.equal(AMOUNT / 2n);
      expect(await token.balanceOf(owner.address)).to.equal(AMOUNT * 10n - AMOUNT / 2n);
    });

    it("reverts NothingToSweep when no candidate is approved", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await openClaimWindow();
      await expect(
        lk.connect(alice).sweepAll(owner.address, [await token.getAddress(), await token2.getAddress()])
      ).to.be.revertedWithCustomError(lk, "NothingToSweep");
    });

    it("skips zero addresses and non-contract addresses without reverting", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await openClaimWindow();
      await lk
        .connect(alice)
        .sweepAll(owner.address, [ethers.ZeroAddress, other.address, await token.getAddress()]);
      expect(await lk.tokenEscrowOf(owner.address, await token.getAddress())).to.equal(AMOUNT);
    });

    it("caps a single call at MAX_ESCROW_TOKENS (20)", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await openClaimWindow();
      const many = Array.from({ length: 21 }, () => ethers.Wallet.createRandom().address);
      await expect(lk.connect(alice).sweepAll(owner.address, many)).to.be.revertedWithCustomError(
        lk,
        "TooManyEscrowTokens"
      );
    });

    it("only the watcher or a beneficiary can call it after the window", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await openClaimWindow();
      await expect(
        lk.connect(other).sweepAll(owner.address, [await token.getAddress()])
      ).to.be.revertedWithCustomError(lk, "NotBeneficiary");
      // watcher is allowed even though it is not a beneficiary
      await lk.connect(watcher).sweepAll(owner.address, [await token.getAddress()]);
      expect(await lk.tokenEscrowOf(owner.address, await token.getAddress())).to.equal(AMOUNT);
    });

    it("the watcher can sweep before the claim window opens", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await lk.connect(watcher).sweepAll(owner.address, [await token.getAddress()]);
      expect(await lk.tokenEscrowOf(owner.address, await token.getAddress())).to.equal(AMOUNT);
    });

    it("a random caller cannot sweep before the window opens", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await expect(
        lk.connect(other).sweepAll(owner.address, [await token.getAddress()])
      ).to.be.revertedWithCustomError(lk, "NotYetClaimable");
    });

    it("is blocked after the first claim (VaultTriggered)", async function () {
      await registerVault();
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await openClaimWindow();
      await lk.connect(alice).claim(owner.address, SECRET);
      await expect(
        lk.connect(bob).sweepAll(owner.address, [await token.getAddress()])
      ).to.be.revertedWithCustomError(lk, "VaultTriggered");
    });
  });

  describe("everything-mode claim payouts", function () {
    it("beneficiaries get their share of native escrow and swept tokens", async function () {
      await registerVault(ethers.parseEther("1"));
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await openClaimWindow();
      const t1 = await token.getAddress();
      await lk.connect(alice).sweepAll(owner.address, [t1]);

      await lk.connect(alice).claim(owner.address, SECRET);
      expect(await token.balanceOf(alice.address)).to.equal((AMOUNT * 6000n) / 10000n);

      await lk.connect(bob).claim(owner.address, SECRET);
      expect(await token.balanceOf(bob.address)).to.equal((AMOUNT * 4000n) / 10000n);
    });
  });

  describe("listed mode keeps its caps and behavior", function () {
    it("sweepToVault still requires an owner-listed token in listed mode", async function () {
      await registerVault();
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await expect(
        lk.connect(watcher).sweepToVault(owner.address, await token.getAddress())
      ).to.be.revertedWithCustomError(lk, "SweepNotAllowed");
    });

    it("allowSweep still caps at MAX_SWEEP_TOKENS (10) in listed mode", async function () {
      await registerVault();
      const cap = Number(await lk.MAX_SWEEP_TOKENS());
      expect(cap).to.equal(10);
      for (let i = 0; i < cap; i++) {
        const t = await (await ethers.getContractFactory("MockERC20")).deploy("T" + i, "T" + i);
        await t.waitForDeployment();
        await lk.connect(owner).allowSweep(await t.getAddress());
      }
      const extra = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X");
      await extra.waitForDeployment();
      await expect(lk.connect(owner).allowSweep(await extra.getAddress())).to.be.revertedWithCustomError(
        lk,
        "TooManySweepTokens"
      );
    });

    it("listed claim pays out only the listed escrow, not unlisted approvals", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await openClaimWindow();
      await lk.connect(watcher).sweepToVault(owner.address, await token.getAddress());
      // token2 is approved to the vault but never listed, so it must not move
      await token2.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await lk.connect(alice).claim(owner.address, SECRET);
      expect(await token2.balanceOf(owner.address)).to.equal(AMOUNT * 10n);
      expect(await token.balanceOf(alice.address)).to.equal((AMOUNT * 6000n) / 10000n);
    });
  });

  describe("soulbound ticket metadata", function () {
    it("tokenURI reports listed by default and everything after the switch", async function () {
      await registerVault();
      const id = await lk.ticketIdOf(owner.address, 1n, alice.address);
      expect(await lk.tokenURI(id)).to.contain('"sweep_mode","value":"listed"');
      expect(await lk.tokenURI(id)).to.contain('"current_cycle","value":true');

      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      const uri = await lk.tokenURI(id);
      expect(uri).to.contain('"sweep_mode","value":"everything"');
      expect(uri).to.contain('"current_cycle","value":true');
    });

    it("marks a ticket from an earlier cycle as not current", async function () {
      await registerVault();
      const oldId = await lk.ticketIdOf(owner.address, 1n, alice.address);
      await lk.connect(owner).close();
      await registerVault();
      expect(await lk.tokenURI(oldId)).to.contain('"current_cycle","value":false');
    });

    it("ticketSweepMode returns the live mode for the ticket's vault", async function () {
      await registerVault();
      const id = await lk.ticketIdOf(owner.address, 1n, alice.address);
      expect(await lk.ticketSweepMode(id)).to.deep.equal([LISTED, true]);
      await lk.connect(owner).setSweepMode(await vaultId(), EVERYTHING);
      expect(await lk.ticketSweepMode(id)).to.deep.equal([EVERYTHING, true]);
    });

    it("ticketSweepMode reverts for a nonexistent ticket", async function () {
      await expect(lk.ticketSweepMode(12345n)).to.be.revertedWithCustomError(lk, "NonexistentTicket");
    });
  });
});
