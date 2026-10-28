const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const SECRET = "open sesame";
const SECRET_HASH = ethers.keccak256(ethers.toUtf8Bytes(SECRET));
const PAYLOAD = ethers.toUtf8Bytes("ciphertext-blob-v3");

async function setNextTime(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
}
async function latest() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

describe("LastKey v3 token sweep", function () {
  let lk, token, token2, owner, alice, bob, watcher, other;
  const AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [, owner, alice, bob, watcher, other] = await ethers.getSigners();
    lk = await (await ethers.getContractFactory("LastKey")).deploy();
    await lk.waitForDeployment();
    token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock", "MCK");
    await token.waitForDeployment();
    token2 = await (await ethers.getContractFactory("MockERC20")).deploy("Mock2", "MC2");
    await token2.waitForDeployment();
    await lk.connect(owner).setWatcher ? null : null;
    await (await lk.setWatcher(watcher.address)).wait();
    await token.mint(owner.address, AMOUNT * 10n);
    await token2.mint(owner.address, AMOUNT * 10n);
  });

  async function registerVault(opts = {}) {
    const interval = opts.interval ?? 30;
    const grace = opts.grace ?? 7;
    await lk.connect(owner).register(
      interval,
      grace,
      [alice.address, bob.address],
      [6000, 4000],
      SECRET_HASH,
      PAYLOAD,
      { value: opts.value ?? 0 }
    );
    return latest();
  }

  async function claimOpen(days = 37) {
    const t = (await latest()) + days * DAY + 1;
    await setNextTime(t);
  }

  describe("allowSweep / revokeSweep", function () {
    it("owner can allow a token and it is listed", async function () {
      await lk.connect(owner).allowSweep(await token.getAddress());
      expect(await lk.isSweepAllowed(owner.address, await token.getAddress())).to.equal(true);
      expect(await lk.sweepTokensOf(owner.address)).to.deep.equal([await token.getAddress()]);
    });

    it("emits SweepAllowed", async function () {
      await expect(lk.connect(owner).allowSweep(await token.getAddress())).to.emit(lk, "SweepAllowed");
    });

    it("rejects allowing the same token twice", async function () {
      await lk.connect(owner).allowSweep(await token.getAddress());
      await expect(lk.connect(owner).allowSweep(await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "SweepAlreadyAllowed"
      );
    });

    it("rejects zero address and non-contract addresses", async function () {
      await expect(lk.connect(owner).allowSweep(ethers.ZeroAddress)).to.be.revertedWithCustomError(lk, "InvalidToken");
      await expect(lk.connect(owner).allowSweep(other.address)).to.be.revertedWithCustomError(lk, "InvalidToken");
    });

    it("caps approved tokens at MAX_SWEEP_TOKENS (10)", async function () {
      expect(await lk.MAX_SWEEP_TOKENS()).to.equal(10n);
      for (let i = 0; i < 10; i++) {
        const t = await (await ethers.getContractFactory("MockERC20")).deploy("T" + i, "T" + i);
        await lk.connect(owner).allowSweep(await t.getAddress());
      }
      const extra = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X");
      await expect(lk.connect(owner).allowSweep(await extra.getAddress())).to.be.revertedWithCustomError(
        lk,
        "TooManySweepTokens"
      );
    });

    it("revokeSweep removes permission and emits SweepRevoked", async function () {
      await lk.connect(owner).allowSweep(await token.getAddress());
      await expect(lk.connect(owner).revokeSweep(await token.getAddress())).to.emit(lk, "SweepRevoked");
      expect(await lk.isSweepAllowed(owner.address, await token.getAddress())).to.equal(false);
      expect(await lk.sweepTokensOf(owner.address)).to.deep.equal([]);
    });

    it("revoke keeps the remaining list intact (swap-and-pop)", async function () {
      const a = await (await ethers.getContractFactory("MockERC20")).deploy("A", "A");
      const b = await (await ethers.getContractFactory("MockERC20")).deploy("B", "B");
      const c = await (await ethers.getContractFactory("MockERC20")).deploy("C", "C");
      await lk.connect(owner).allowSweep(await a.getAddress());
      await lk.connect(owner).allowSweep(await b.getAddress());
      await lk.connect(owner).allowSweep(await c.getAddress());
      await lk.connect(owner).revokeSweep(await a.getAddress());
      const list = await lk.sweepTokensOf(owner.address);
      expect(list.length).to.equal(2);
      expect(list).to.include(await c.getAddress());
      expect(list).to.include(await b.getAddress());
      expect(await lk.isSweepAllowed(owner.address, await c.getAddress())).to.equal(true);
    });

    it("revoke of a token not approved reverts", async function () {
      await expect(lk.connect(owner).revokeSweep(await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "SweepNotAllowed"
      );
    });
  });

  describe("sweepToVault", function () {
    it("reverts for a token the owner never approved", async function () {
      await registerVault();
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await expect(lk.connect(watcher).sweepToVault(owner.address, await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "SweepNotAllowed"
      );
    });

    it("watcher can sweep an approved token into escrow", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await expect(lk.connect(watcher).sweepToVault(owner.address, await token.getAddress())).to.emit(lk, "TokenSwept");
      expect(await lk.tokenEscrowOf(owner.address, await token.getAddress())).to.equal(AMOUNT);
      expect(await token.balanceOf(await lk.getAddress())).to.equal(AMOUNT);
      expect(await token.balanceOf(owner.address)).to.equal(AMOUNT * 9n);
    });

    it("sweeps only min(balance, allowance)", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT / 2n);
      await lk.connect(watcher).sweepToVault(owner.address, await token.getAddress());
      expect(await lk.tokenEscrowOf(owner.address, await token.getAddress())).to.equal(AMOUNT / 2n);
    });

    it("reverts with NothingToSweep when there is no allowance", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await expect(lk.connect(watcher).sweepToVault(owner.address, await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "NothingToSweep"
      );
    });

    it("non-watcher cannot sweep before the claim window opens", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await expect(lk.connect(other).sweepToVault(owner.address, await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "NotYetClaimable"
      );
    });

    it("anyone can sweep once the claim window is open", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await claimOpen();
      await lk.connect(other).sweepToVault(owner.address, await token.getAddress());
      expect(await lk.tokenEscrowOf(owner.address, await token.getAddress())).to.equal(AMOUNT);
    });

    it("reverts with NoActiveVault when the owner has no vault", async function () {
      await lk.connect(owner).allowSweep(await token.getAddress());
      await expect(lk.connect(watcher).sweepToVault(owner.address, await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "NoActiveVault"
      );
    });

    it("reverts after the revoke", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await lk.connect(owner).revokeSweep(await token.getAddress());
      await expect(lk.connect(watcher).sweepToVault(owner.address, await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "SweepNotAllowed"
      );
    });

    it("caps escrow tokens at MAX_ESCROW_TOKENS (20)", async function () {
      await registerVault();
      expect(await lk.MAX_ESCROW_TOKENS()).to.equal(20n);
      for (let i = 0; i < 20; i++) {
        const t = await (await ethers.getContractFactory("MockERC20")).deploy("E" + i, "E" + i);
        await t.mint(owner.address, 1n);
        await lk.connect(owner).allowSweep(await t.getAddress());
        await t.connect(owner).approve(await lk.getAddress(), 1n);
        await lk.connect(watcher).sweepToVault(owner.address, await t.getAddress());
        // revoke so the allow list stays under MAX_SWEEP_TOKENS; escrow list keeps the token
        await lk.connect(owner).revokeSweep(await t.getAddress());
      }
      const extra = await (await ethers.getContractFactory("MockERC20")).deploy("EX", "EX");
      await extra.mint(owner.address, 1n);
      await lk.connect(owner).allowSweep(await extra.getAddress());
      await extra.connect(owner).approve(await lk.getAddress(), 1n);
      await expect(lk.connect(watcher).sweepToVault(owner.address, await extra.getAddress())).to.be.revertedWithCustomError(
        lk,
        "TooManyEscrowTokens"
      );
    });
  });

  describe("sweep after claim and payouts", function () {
    it("claim pays token shares at the pool frozen by the first claim", async function () {
      await registerVault({ value: ethers.parseEther("1") });
      const tokenAddr = await token.getAddress();
      await lk.connect(owner).allowSweep(tokenAddr);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await lk.connect(watcher).sweepToVault(owner.address, tokenAddr);

      await claimOpen();
      const aliceBefore = await token.balanceOf(alice.address);
      await lk.connect(alice).claim(owner.address, SECRET);
      expect((await token.balanceOf(alice.address)) - aliceBefore).to.equal((AMOUNT * 6000n) / 10000n);
      expect(await lk.tokenEscrowOf(owner.address, tokenAddr)).to.equal(AMOUNT - (AMOUNT * 6000n) / 10000n);
    });

    it("bob receives his 40% of token escrow after alice claimed", async function () {
      await registerVault({ value: ethers.parseEther("1") });
      const tokenAddr = await token.getAddress();
      await lk.connect(owner).allowSweep(tokenAddr);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await lk.connect(watcher).sweepToVault(owner.address, tokenAddr);

      await claimOpen();
      await lk.connect(alice).claim(owner.address, SECRET);
      await lk.connect(bob).claim(owner.address, SECRET);
      expect(await token.balanceOf(bob.address)).to.equal((AMOUNT * 4000n) / 10000n);
      expect(await token.balanceOf(await lk.getAddress())).to.equal(0n);
    });

    it("sweeping is blocked after the first claim (VaultTriggered)", async function () {
      await registerVault();
      const tokenAddr = await token.getAddress();
      await lk.connect(owner).allowSweep(tokenAddr);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await claimOpen();
      await lk.connect(alice).claim(owner.address, SECRET);
      await expect(lk.connect(other).sweepToVault(owner.address, tokenAddr)).to.be.revertedWithCustomError(
        lk,
        "VaultTriggered"
      );
    });
  });

  describe("close refunds token escrow", function () {
    it("owner gets swept tokens back on close", async function () {
      await registerVault();
      const tokenAddr = await token.getAddress();
      await lk.connect(owner).allowSweep(tokenAddr);
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await lk.connect(watcher).sweepToVault(owner.address, tokenAddr);
      await lk.connect(owner).close();
      expect(await token.balanceOf(owner.address)).to.equal(AMOUNT * 10n);
      expect(await lk.tokenEscrowOf(owner.address, tokenAddr)).to.equal(0n);
    });
  });

  describe("access control", function () {
    it("only the watcher or the claim window can sweep, not a random caller", async function () {
      await registerVault();
      await lk.connect(owner).allowSweep(await token.getAddress());
      await token.connect(owner).approve(await lk.getAddress(), AMOUNT);
      await expect(lk.connect(other).sweepToVault(owner.address, await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "NotYetClaimable"
      );
    });

    it("only the owner can allow or revoke", async function () {
      await lk.connect(owner).allowSweep(await token.getAddress());
      // another account has no approval of its own, so its revoke reverts
      await expect(lk.connect(other).revokeSweep(await token.getAddress())).to.be.revertedWithCustomError(
        lk,
        "SweepNotAllowed"
      );
    });

    it("approvals are per owner", async function () {
      await lk.connect(owner).allowSweep(await token.getAddress());
      expect(await lk.isSweepAllowed(other.address, await token.getAddress())).to.equal(false);
    });

    it("plain ETH transfers are rejected", async function () {
      await expect(owner.sendTransaction({ to: await lk.getAddress(), value: 1n })).to.be.reverted;
    });
  });
});
