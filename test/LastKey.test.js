const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const ZERO = ethers.ZeroHash;
const SECRET = "lantern-42";
const hashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const SECRET_HASH = hashOf(SECRET);
const PAYLOAD = ethers.toUtf8Bytes("ciphertext-blob-v2");

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

describe("LastKey v2", function () {
  let lk, admin, owner, alice, bob, carol, dave, eve, watcher;

  beforeEach(async function () {
    [admin, owner, alice, bob, carol, dave, eve, watcher] = await ethers.getSigners();
    const F = await ethers.getContractFactory("LastKey");
    lk = await F.deploy();
    await lk.waitForDeployment();
  });

  // default vault: interval 30 days, grace 7 days, alice 60%, bob 40%
  async function registerDefault(signer = owner, opts = {}) {
    const interval = opts.interval ?? 30;
    const grace = opts.grace ?? 7;
    const ben = opts.ben ?? [alice.address, bob.address];
    const shares = opts.shares ?? [6000, 4000];
    const secretHash = opts.secretHash ?? SECRET_HASH;
    const payload = opts.payload ?? PAYLOAD;
    const value = opts.value ?? 0n;
    const tx = await lk
      .connect(signer)
      .register(interval, grace, ben, shares, secretHash, payload, { value });
    return { tx, ben, shares };
  }

  // --------------------------------------------------------------------
  describe("deployment", function () {
    it("sets the deployer as admin and leaves the watcher unset", async function () {
      expect(await lk.admin()).to.equal(admin.address);
      expect(await lk.watcher()).to.equal(ethers.ZeroAddress);
    });

    it("exposes the ticket name and symbol", async function () {
      expect(await lk.name()).to.equal("LastKey Claim Ticket");
      expect(await lk.symbol()).to.equal("LKT");
    });

    it("reports ERC-165, ERC-721 and metadata interfaces", async function () {
      expect(await lk.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await lk.supportsInterface("0x80ac58cd")).to.equal(true);
      expect(await lk.supportsInterface("0x5b5e139f")).to.equal(true);
      expect(await lk.supportsInterface("0xffffffff")).to.equal(false);
    });

    it("rejects plain ETH transfers (no receive or fallback)", async function () {
      await expect(
        owner.sendTransaction({ to: await lk.getAddress(), value: 1n })
      ).to.be.reverted;
    });
  });

  // --------------------------------------------------------------------
  describe("registration", function () {
    it("stores the vault and emits VaultRegistered", async function () {
      const { tx } = await registerDefault();
      await expect(tx)
        .to.emit(lk, "VaultRegistered")
        .withArgs(owner.address, 1n, 30, 7, 2n, 0n, (v) => v > 0n);

      const v = await lk.getVault(owner.address);
      expect(v.active).to.equal(true);
      expect(v.triggered).to.equal(false);
      expect(v.intervalDays).to.equal(30);
      expect(v.graceDays).to.equal(7);
      expect(v.epoch).to.equal(1n);
      expect(v.deposited).to.equal(0n);
      expect(v.beneficiaries).to.deep.equal([alice.address, bob.address]);
    });

    it("records each beneficiary's share", async function () {
      await registerDefault();
      const [a, , sa] = await lk.slotOf(owner.address, alice.address);
      const [b, , sb] = await lk.slotOf(owner.address, bob.address);
      expect(a).to.equal(true);
      expect(b).to.equal(true);
      expect(sa).to.equal(6000);
      expect(sb).to.equal(4000);
    });

    it("mints one soulbound ticket to each beneficiary", async function () {
      await registerDefault();
      expect(await lk.balanceOf(alice.address)).to.equal(1n);
      expect(await lk.balanceOf(bob.address)).to.equal(1n);
      expect(await lk.balanceOf(owner.address)).to.equal(0n);

      const id = await lk.ticketIdOf(owner.address, 1n, alice.address);
      expect(await lk.ownerOf(id)).to.equal(alice.address);
      const info = await lk.ticketInfo(id);
      expect(info.vaultOwner).to.equal(owner.address);
      expect(info.epoch).to.equal(1n);
      expect(info.beneficiary).to.equal(alice.address);
    });

    it("emits Transfer from zero address when minting tickets", async function () {
      const tx = await lk
        .connect(owner)
        .register(30, 7, [alice.address], [10000], SECRET_HASH, PAYLOAD);
      const id = await lk.ticketIdOf(owner.address, 1n, alice.address);
      await expect(tx)
        .to.emit(lk, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, id);
    });

    it("rejects a second registration while the vault is active", async function () {
      await registerDefault();
      await expect(registerDefault()).to.be.revertedWithCustomError(lk, "VaultAlreadyActive");
    });

    it("rejects intervals outside 1 to 3650 days", async function () {
      await expect(registerDefault(owner, { interval: 0 })).to.be.revertedWithCustomError(lk, "InvalidInterval");
      await expect(registerDefault(owner, { interval: 3651 })).to.be.revertedWithCustomError(lk, "InvalidInterval");
    });

    it("rejects grace above 365 days", async function () {
      await expect(registerDefault(owner, { grace: 366 })).to.be.revertedWithCustomError(lk, "InvalidGrace");
    });

    it("accepts zero grace", async function () {
      await registerDefault(owner, { grace: 0 });
      const v = await lk.getVault(owner.address);
      expect(v.graceDays).to.equal(0);
    });

    it("rejects a zero secret hash", async function () {
      await expect(
        registerDefault(owner, { secretHash: ZERO })
      ).to.be.revertedWithCustomError(lk, "EmptySecretHash");
    });

    it("rejects an empty or oversized payload", async function () {
      await expect(registerDefault(owner, { payload: "0x" })).to.be.revertedWithCustomError(lk, "InvalidPayloadSize");
      const big = new Uint8Array(8193);
      await expect(registerDefault(owner, { payload: big })).to.be.revertedWithCustomError(lk, "InvalidPayloadSize");
    });

    it("accepts a payload of exactly 8192 bytes", async function () {
      const max = new Uint8Array(8192).fill(7);
      await registerDefault(owner, { payload: max });
      expect((await lk.getVault(owner.address)).active).to.equal(true);
    });

    it("rejects zero beneficiaries and more than 20", async function () {
      await expect(registerDefault(owner, { ben: [], shares: [] })).to.be.revertedWithCustomError(lk, "InvalidBeneficiaryCount");
      const many = Array.from({ length: 21 }, () => ethers.Wallet.createRandom().address);
      const shares = Array.from({ length: 21 }, () => 1);
      shares[0] = 10000 - 20;
      await expect(registerDefault(owner, { ben: many, shares })).to.be.revertedWithCustomError(lk, "InvalidBeneficiaryCount");
    });

    it("accepts exactly 20 beneficiaries", async function () {
      const ben = Array.from({ length: 20 }, () => ethers.Wallet.createRandom().address);
      const shares = Array.from({ length: 20 }, () => 500);
      await registerDefault(owner, { ben, shares });
      expect((await lk.getVault(owner.address)).beneficiaries.length).to.equal(20);
    });

    it("rejects mismatched shares and beneficiary lengths", async function () {
      await expect(
        lk.connect(owner).register(30, 7, [alice.address, bob.address], [10000], SECRET_HASH, PAYLOAD)
      ).to.be.revertedWithCustomError(lk, "LengthMismatch");
    });

    it("rejects a zero share", async function () {
      await expect(
        registerDefault(owner, { shares: [10000, 0] })
      ).to.be.revertedWithCustomError(lk, "ZeroShare");
    });

    it("rejects shares that do not sum to 10000", async function () {
      await expect(
        registerDefault(owner, { shares: [6000, 3000] })
      ).to.be.revertedWithCustomError(lk, "InvalidShares");
      await expect(
        registerDefault(owner, { shares: [6000, 5000] })
      ).to.be.revertedWithCustomError(lk, "InvalidShares");
    });

    it("rejects zero, self and duplicate beneficiaries", async function () {
      await expect(
        registerDefault(owner, { ben: [ethers.ZeroAddress, bob.address] })
      ).to.be.revertedWithCustomError(lk, "ZeroAddress");
      await expect(
        registerDefault(owner, { ben: [owner.address, bob.address] })
      ).to.be.revertedWithCustomError(lk, "SelfBeneficiary");
      await expect(
        registerDefault(owner, { ben: [alice.address, alice.address] })
      ).to.be.revertedWithCustomError(lk, "DuplicateBeneficiary");
    });

    it("takes escrow sent with register", async function () {
      await registerDefault(owner, { value: 1000n });
      const v = await lk.getVault(owner.address);
      expect(v.deposited).to.equal(1000n);
      expect(await ethers.provider.getBalance(await lk.getAddress())).to.equal(1000n);
    });

    it("starts a new epoch after close and drops old beneficiaries", async function () {
      await registerDefault();
      await lk.connect(owner).close();
      await lk.connect(owner).register(30, 7, [carol.address], [10000], hashOf("new"), PAYLOAD);
      const v = await lk.getVault(owner.address);
      expect(v.epoch).to.equal(2n);
      expect(v.beneficiaries).to.deep.equal([carol.address]);
      const [isB] = await lk.slotOf(owner.address, alice.address);
      expect(isB).to.equal(false);
    });

    it("gives a fresh ticket id per epoch", async function () {
      await registerDefault();
      await lk.connect(owner).close();
      await lk.connect(owner).register(30, 7, [alice.address], [10000], SECRET_HASH, PAYLOAD);
      const id1 = await lk.ticketIdOf(owner.address, 1n, alice.address);
      const id2 = await lk.ticketIdOf(owner.address, 2n, alice.address);
      expect(id1).to.not.equal(id2);
      expect(await lk.balanceOf(alice.address)).to.equal(2n);
    });
  });

  // --------------------------------------------------------------------
  describe("check-ins", function () {
    it("lets the owner check in and resets the deadline", async function () {
      await registerDefault();
      const before = (await lk.timing(owner.address)).deadline;
      const t = Number(before) - 5 * DAY;
      await mineAt(t);
      await lk.connect(owner).checkIn();
      const after = (await lk.timing(owner.address)).deadline;
      expect(after).to.be.gt(before);
    });

    it("reverts check-in with no active vault", async function () {
      await expect(lk.connect(owner).checkIn()).to.be.revertedWithCustomError(lk, "NoActiveVault");
    });

    it("lets the trusted watcher check in for an owner", async function () {
      await registerDefault();
      await lk.connect(admin).setWatcher(watcher.address);
      const before = (await lk.timing(owner.address)).deadline;
      await mineAt(Number(before) - 3 * DAY);
      await expect(lk.connect(watcher).watcherCheckIn(owner.address))
        .to.emit(lk, "CheckedIn")
        .withArgs(owner.address, 1n, watcher.address, (t) => t > 0n);
      expect((await lk.timing(owner.address)).deadline).to.be.gt(before);
    });

    it("rejects watcher check-ins from anyone but the watcher", async function () {
      await registerDefault();
      await lk.connect(admin).setWatcher(watcher.address);
      await expect(lk.connect(eve).watcherCheckIn(owner.address)).to.be.revertedWithCustomError(lk, "NotWatcher");
    });

    it("rejects watcher check-ins when no watcher is set", async function () {
      await registerDefault();
      await expect(lk.connect(watcher).watcherCheckIn(owner.address)).to.be.revertedWithCustomError(lk, "NotWatcher");
    });

    it("rejects watcher check-ins when the watcher is cleared", async function () {
      await registerDefault();
      await lk.connect(admin).setWatcher(watcher.address);
      await lk.connect(admin).setWatcher(ethers.ZeroAddress);
      await expect(lk.connect(watcher).watcherCheckIn(owner.address)).to.be.revertedWithCustomError(lk, "NotWatcher");
    });

    it("rejects a watcher check-in for an owner with no vault", async function () {
      await lk.connect(admin).setWatcher(watcher.address);
      await expect(lk.connect(watcher).watcherCheckIn(owner.address)).to.be.revertedWithCustomError(lk, "NoActiveVault");
    });

    it("blocks check-ins once a beneficiary has claimed", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      await expect(lk.connect(owner).checkIn()).to.be.revertedWithCustomError(lk, "VaultTriggered");
    });
  });

  // --------------------------------------------------------------------
  describe("escrow", function () {
    it("adds to escrow with deposit", async function () {
      await registerDefault();
      await expect(lk.connect(owner).deposit({ value: 500n }))
        .to.emit(lk, "Deposited")
        .withArgs(owner.address, 500n, 500n);
      expect((await lk.getVault(owner.address)).deposited).to.equal(500n);
    });

    it("rejects deposit with no active vault", async function () {
      await expect(lk.connect(owner).deposit({ value: 1n })).to.be.revertedWithCustomError(lk, "NoActiveVault");
    });

    it("rejects zero-value deposit", async function () {
      await registerDefault();
      await expect(lk.connect(owner).deposit({ value: 0n })).to.be.revertedWithCustomError(lk, "ZeroDeposit");
    });

    it("refunds escrow on close and deactivates the vault", async function () {
      await registerDefault(owner, { value: 900n });
      const before = await ethers.provider.getBalance(owner.address);
      const tx = await lk.connect(owner).close();
      const rcpt = await tx.wait();
      const gas = rcpt.gasUsed * rcpt.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);
      expect(after - before + gas).to.equal(900n);
      const v = await lk.getVault(owner.address);
      expect(v.active).to.equal(false);
      expect(v.deposited).to.equal(0n);
    });

    it("rejects close with no active vault", async function () {
      await expect(lk.connect(owner).close()).to.be.revertedWithCustomError(lk, "NoActiveVault");
    });

    it("rejects close after a claim has triggered the vault", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      await expect(lk.connect(owner).close()).to.be.revertedWithCustomError(lk, "VaultTriggered");
    });

    it("rejects deposit after a claim has triggered the vault", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      await expect(lk.connect(owner).deposit({ value: 1n })).to.be.revertedWithCustomError(lk, "VaultTriggered");
    });
  });

  // --------------------------------------------------------------------
  describe("timing and grace window", function () {
    it("reports deadline and claimOpensAt = deadline + grace", async function () {
      await registerDefault(owner, { interval: 30, grace: 7 });
      const v = await lk.getVault(owner.address);
      const [deadline, opens] = await lk.timing(owner.address);
      const base = BigInt(v.lastCheckIn);
      expect(deadline).to.equal(base + 30n * BigInt(DAY));
      expect(opens).to.equal(base + 37n * BigInt(DAY));
    });

    it("keeps claims closed at the deadline itself during grace", async function () {
      await registerDefault(owner, { interval: 10, grace: 5 });
      const [deadline] = await lk.timing(owner.address);
      await mineAt(Number(deadline) + 1);
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.be.revertedWithCustomError(lk, "NotYetClaimable");
    });

    it("keeps claims closed at exactly deadline plus grace", async function () {
      await registerDefault(owner, { interval: 10, grace: 5 });
      const [, opens] = await lk.timing(owner.address);
      await setNextTime(Number(opens));
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.be.revertedWithCustomError(lk, "NotYetClaimable");
    });

    it("opens claims one second after the grace window", async function () {
      await registerDefault(owner, { interval: 10, grace: 5 });
      const [, opens] = await lk.timing(owner.address);
      await setNextTime(Number(opens) + 1);
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.emit(lk, "ClaimProof");
    });

    it("opens claims right after the deadline when grace is zero", async function () {
      await registerDefault(owner, { interval: 10, grace: 0 });
      const [deadline] = await lk.timing(owner.address);
      await setNextTime(Number(deadline) + 1);
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.emit(lk, "ClaimProof");
    });

    it("isClaimable follows the window", async function () {
      await registerDefault(owner, { interval: 10, grace: 5 });
      const [, opens] = await lk.timing(owner.address);
      expect(await lk.isClaimable(owner.address, alice.address)).to.equal(false);
      await mineAt(Number(opens) + 10);
      expect(await lk.isClaimable(owner.address, alice.address)).to.equal(true);
    });

    it("check-in during grace moves the window forward", async function () {
      await registerDefault(owner, { interval: 10, grace: 5 });
      const [deadline] = await lk.timing(owner.address);
      await mineAt(Number(deadline) + DAY);
      await lk.connect(owner).checkIn();
      const [, opens] = await lk.timing(owner.address);
      expect(opens).to.be.gt(Number(deadline) + DAY + 4 * DAY);
    });
  });

  // --------------------------------------------------------------------
  describe("secret-word claim", function () {
    it("pays out the beneficiary's share with the correct secret", async function () {
      await registerDefault(owner, { value: 10000n });
      const [, opens] = await lk.timing(owner.address);
      await setNextTime(Number(opens) + 1);
      await expect(lk.connect(alice).claim(owner.address, SECRET))
        .to.emit(lk, "ClaimProof")
        .withArgs(owner.address, alice.address, 1n, 6000, 6000n, (id) => id !== ZERO, (t) => t > 0n);
      expect(await lk.hasClaimed(owner.address, alice.address)).to.equal(true);
    });

    it("rejects a wrong secret after the window", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await expect(lk.connect(alice).claim(owner.address, "wrong")).to.be.revertedWithCustomError(lk, "WrongSecret");
    });

    it("rejects an empty secret", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await expect(lk.connect(alice).claim(owner.address, "")).to.be.revertedWithCustomError(lk, "WrongSecret");
    });

    it("rejects a non-beneficiary even with the right secret", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await expect(lk.connect(eve).claim(owner.address, SECRET)).to.be.revertedWithCustomError(lk, "NotBeneficiary");
    });

    it("rejects a double claim", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.be.revertedWithCustomError(lk, "AlreadyClaimed");
    });

    it("rejects a claim with no vault", async function () {
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.be.revertedWithCustomError(lk, "NoActiveVault");
    });

    it("rejects a claim against a closed vault", async function () {
      await registerDefault();
      await lk.connect(owner).close();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.be.revertedWithCustomError(lk, "NoActiveVault");
    });

    it("stores only the hash: the secret never appears in the vault view", async function () {
      await registerDefault();
      const v = await lk.getVault(owner.address);
      const encoded = JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
      expect(encoded.includes(Buffer.from(SECRET).toString("hex"))).to.equal(false);
      expect(encoded.includes(SECRET)).to.equal(false);
    });

    it("blocks a beneficiary of a previous epoch after re-registration", async function () {
      await registerDefault();
      await lk.connect(owner).close();
      await lk.connect(owner).register(30, 0, [carol.address], [10000], hashOf("epoch2"), PAYLOAD);
      await mineAt(Number((await lk.timing(owner.address))[1]) + 1);
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.be.revertedWithCustomError(lk, "NotBeneficiary");
      await expect(lk.connect(carol).claim(owner.address, "epoch2")).to.emit(lk, "ClaimProof");
    });
  });

  // --------------------------------------------------------------------
  describe("split inheritance", function () {
    it("splits the escrow by share between beneficiaries", async function () {
      await registerDefault(owner, { value: 10000n });
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      const aTx = await lk.connect(alice).claim(owner.address, SECRET);
      const aEv = (await aTx.wait()).logs.find((l) => l.fragment && l.fragment.name === "ClaimProof");
      expect(aEv.args.payout).to.equal(6000n);

      const bTx = await lk.connect(bob).claim(owner.address, SECRET);
      const bEv = (await bTx.wait()).logs.find((l) => l.fragment && l.fragment.name === "ClaimProof");
      expect(bEv.args.payout).to.equal(4000n);

      expect(await lk.payoutOf(owner.address, alice.address)).to.equal(0n);
      const v = await lk.getVault(owner.address);
      expect(v.pool).to.equal(10000n);
      expect(v.deposited).to.equal(0n);
    });

    it("pays exactly 60% and 40% of the pool", async function () {
      await registerDefault(owner, { value: 1000n });
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      const claimTx = await lk.connect(alice).claim(owner.address, SECRET);
      await expect(claimTx).to.emit(lk, "ClaimProof");
      const rcpt = await claimTx.wait();
      const ev = rcpt.logs.find((l) => l.fragment && l.fragment.name === "ClaimProof");
      expect(ev.args.payout).to.equal(600n);
      const bobTx = await lk.connect(bob).claim(owner.address, SECRET);
      const rb = await bobTx.wait();
      const evb = rb.logs.find((l) => l.fragment && l.fragment.name === "ClaimProof");
      expect(evb.args.payout).to.equal(400n);
    });

    it("freezes the pool at the first claim", async function () {
      await registerDefault(owner, { value: 1000n });
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      const v = await lk.getVault(owner.address);
      expect(v.triggered).to.equal(true);
      expect(v.pool).to.equal(1000n);
      expect(await lk.payoutOf(owner.address, bob.address)).to.equal(400n);
    });

    it("handles rounding dust across three beneficiaries", async function () {
      const ben = [alice.address, bob.address, carol.address];
      await registerDefault(owner, { ben, shares: [3333, 3333, 3334], value: 100n });
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      await lk.connect(bob).claim(owner.address, SECRET);
      await lk.connect(carol).claim(owner.address, SECRET);
      // 100 wei split 33/33/33 pays 99; the 1 wei dust stays in escrow by design
      const left = await lk.getVault(owner.address);
      expect(left.deposited).to.equal(1n);
      expect(await ethers.provider.getBalance(await lk.getAddress())).to.equal(1n);
    });

    it("projects payout before the claim and zero after", async function () {
      await registerDefault(owner, { value: 500n });
      expect(await lk.payoutOf(owner.address, alice.address)).to.equal(300n);
      expect(await lk.payoutOf(owner.address, eve.address)).to.equal(0n);
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      expect(await lk.payoutOf(owner.address, alice.address)).to.equal(0n);
    });

    it("pays zero when the escrow is empty but still records the claim", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await expect(lk.connect(alice).claim(owner.address, SECRET)).to.emit(lk, "ClaimProof");
      expect(await lk.hasClaimed(owner.address, alice.address)).to.equal(true);
    });
  });

  // --------------------------------------------------------------------
  describe("encrypted payload", function () {
    it("returns the ciphertext to a beneficiary who has claimed", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      const got = await lk.connect(alice).readPayload(owner.address);
      expect(ethers.hexlify(got)).to.equal(ethers.hexlify(PAYLOAD));
    });

    it("refuses to show the payload before the claim", async function () {
      await registerDefault();
      await expect(lk.connect(alice).readPayload(owner.address)).to.be.revertedWithCustomError(lk, "NotClaimedYet");
    });

    it("refuses the payload to a non-beneficiary", async function () {
      await registerDefault();
      await expect(lk.connect(eve).readPayload(owner.address)).to.be.revertedWithCustomError(lk, "NotBeneficiary");
    });

    it("refuses to read a payload from an earlier epoch", async function () {
      await registerDefault();
      await lk.connect(owner).close();
      await lk.connect(owner).register(30, 0, [carol.address], [10000], hashOf("e2"), ethers.toUtf8Bytes("new"));
      await expect(lk.connect(alice).readPayload(owner.address)).to.be.revertedWithCustomError(lk, "NotBeneficiary");
    });
  });

  // --------------------------------------------------------------------
  describe("soulbound claim ticket", function () {
    it("reverts transferFrom", async function () {
      await registerDefault();
      const id = await lk.ticketIdOf(owner.address, 1n, alice.address);
      await expect(lk.connect(alice).transferFrom(alice.address, carol.address, id)).to.be.revertedWithCustomError(lk, "SoulboundTransfer");
    });

    it("reverts both safeTransferFrom overloads", async function () {
      await registerDefault();
      const id = await lk.ticketIdOf(owner.address, 1n, alice.address);
      await expect(
        lk.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, carol.address, id)
      ).to.be.revertedWithCustomError(lk, "SoulboundTransfer");
      await expect(
        lk.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, carol.address, id, "0x")
      ).to.be.revertedWithCustomError(lk, "SoulboundTransfer");
    });

    it("reverts approve and setApprovalForAll", async function () {
      await registerDefault();
      const id = await lk.ticketIdOf(owner.address, 1n, alice.address);
      await expect(lk.connect(alice).approve(carol.address, id)).to.be.revertedWithCustomError(lk, "SoulboundTransfer");
      await expect(lk.connect(alice).setApprovalForAll(carol.address, true)).to.be.revertedWithCustomError(lk, "SoulboundTransfer");
    });

    it("reports no approvals", async function () {
      await registerDefault();
      const id = await lk.ticketIdOf(owner.address, 1n, alice.address);
      expect(await lk.getApproved(id)).to.equal(ethers.ZeroAddress);
      expect(await lk.isApprovedForAll(alice.address, carol.address)).to.equal(false);
    });

    it("reverts ownerOf and tokenURI for a nonexistent ticket", async function () {
      await expect(lk.ownerOf(12345n)).to.be.revertedWithCustomError(lk, "NonexistentTicket");
      await expect(lk.tokenURI(12345n)).to.be.revertedWithCustomError(lk, "NonexistentTicket");
    });

    it("keeps the ticket with the beneficiary after a claim", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      await lk.connect(alice).claim(owner.address, SECRET);
      expect(await lk.balanceOf(alice.address)).to.equal(1n);
    });

    it("reverts balanceOf for the zero address", async function () {
      await expect(lk.balanceOf(ethers.ZeroAddress)).to.be.revertedWithCustomError(lk, "ZeroAddress");
    });
  });

  // --------------------------------------------------------------------
  describe("admin", function () {
    it("lets the admin set and clear the watcher, and emits WatcherUpdated", async function () {
      await expect(lk.connect(admin).setWatcher(watcher.address))
        .to.emit(lk, "WatcherUpdated")
        .withArgs(ethers.ZeroAddress, watcher.address);
      expect(await lk.watcher()).to.equal(watcher.address);
    });

    it("rejects setWatcher from a non-admin", async function () {
      await expect(lk.connect(eve).setWatcher(watcher.address)).to.be.revertedWithCustomError(lk, "NotAdmin");
    });

    it("transfers the admin role", async function () {
      await expect(lk.connect(admin).transferAdmin(dave.address))
        .to.emit(lk, "AdminTransferred")
        .withArgs(admin.address, dave.address);
      expect(await lk.admin()).to.equal(dave.address);
      await expect(lk.connect(admin).setWatcher(watcher.address)).to.be.revertedWithCustomError(lk, "NotAdmin");
    });

    it("rejects transferAdmin to the zero address", async function () {
      await expect(lk.connect(admin).transferAdmin(ethers.ZeroAddress)).to.be.revertedWithCustomError(lk, "ZeroAddress");
    });

    it("rejects transferAdmin from a non-admin", async function () {
      await expect(lk.connect(eve).transferAdmin(eve.address)).to.be.revertedWithCustomError(lk, "NotAdmin");
    });
  });

  // --------------------------------------------------------------------
  describe("views", function () {
    it("isClaimable is false for a non-beneficiary and for a claimed beneficiary", async function () {
      await registerDefault();
      const [, opens] = await lk.timing(owner.address);
      await mineAt(Number(opens) + 1);
      expect(await lk.isClaimable(owner.address, eve.address)).to.equal(false);
      await lk.connect(alice).claim(owner.address, SECRET);
      expect(await lk.isClaimable(owner.address, alice.address)).to.equal(false);
      expect(await lk.isClaimable(owner.address, bob.address)).to.equal(true);
    });

    it("isClaimable is false with no active vault", async function () {
      expect(await lk.isClaimable(owner.address, alice.address)).to.equal(false);
    });

    it("payoutOf is zero for an unknown owner", async function () {
      expect(await lk.payoutOf(owner.address, alice.address)).to.equal(0n);
    });
  });
});
