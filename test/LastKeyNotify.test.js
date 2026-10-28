const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const SECRET = "lantern-42";
const SECRET_HASH = ethers.keccak256(ethers.toUtf8Bytes(SECRET));
const PAYLOAD = ethers.toUtf8Bytes("ciphertext-notify");

async function txAt(t, fn) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
  const tx = await fn();
  return tx.wait();
}

function parsed(lk, receipt) {
  const out = [];
  for (const l of receipt.logs) {
    try {
      out.push(lk.interface.parseLog(l));
    } catch (_) {
      // not a LastKey event (e.g. ERC-20 or ticket Transfer from another contract)
    }
  }
  return out;
}

describe("LastKey v4 notify events", function () {
  let lk, owner, alice, bob, watcher;

  beforeEach(async function () {
    [, owner, alice, bob, watcher] = await ethers.getSigners();
    lk = await (await ethers.getContractFactory("LastKey")).deploy();
    await lk.waitForDeployment();
  });

  async function registerAt(t, value = 0n) {
    await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
    const tx = await lk
      .connect(owner)
      .register(30, 7, [alice.address, bob.address], [6000, 4000], SECRET_HASH, PAYLOAD, { value });
    return { receipt: await tx.wait(), t };
  }

  async function now() {
    return BigInt((await ethers.provider.getBlock("latest")).timestamp);
  }

  it("vaultIdOf is deterministic and distinct per epoch", async function () {
    const a = await lk.vaultIdOf(owner.address, 1);
    expect(a).to.equal(await lk.vaultIdOf(owner.address, 1));
    expect(a).to.not.equal(await lk.vaultIdOf(owner.address, 2));
    expect(a).to.equal(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint64"], [owner.address, 1])));
  });

  it("register emits VaultFunded with the vault id when value is sent", async function () {
    const t = (await now()) + 10n;
    const { receipt } = await registerAt(t, ethers.parseEther("1"));
    const ev = parsed(lk, receipt);
    const funded = ev.find((e) => e.name === "VaultFunded");
    expect(funded).to.not.be.undefined;
    expect(funded.args.vaultId).to.equal(await lk.vaultIdOf(owner.address, 1));
    expect(funded.args.owner).to.equal(owner.address);
    expect(funded.args.amount).to.equal(ethers.parseEther("1"));
    expect(funded.args.deposited).to.equal(ethers.parseEther("1"));
  });

  it("register with zero value does not emit VaultFunded", async function () {
    const { receipt } = await registerAt((await now()) + 10n, 0n);
    expect(parsed(lk, receipt).map((e) => e.name)).to.not.include("VaultFunded");
  });

  it("deposit emits VaultFunded with the running total", async function () {
    await registerAt((await now()) + 10n);
    const r = await (await lk.connect(owner).deposit({ value: ethers.parseEther("0.5") })).wait();
    const funded = parsed(lk, r).find((e) => e.name === "VaultFunded");
    expect(funded.args.amount).to.equal(ethers.parseEther("0.5"));
    expect(funded.args.deposited).to.equal(ethers.parseEther("0.5"));
    expect(funded.args.funder).to.equal(owner.address);
  });

  it("checkIn emits CheckInReceived with the deadline and the caller", async function () {
    const start = (await now()) + 10n;
    await registerAt(start);
    const r = await (await lk.connect(owner).checkIn()).wait();
    const ci = parsed(lk, r).find((e) => e.name === "CheckInReceived");
    expect(ci.args.owner).to.equal(owner.address);
    expect(ci.args.by).to.equal(owner.address);
    expect(ci.args.epoch).to.equal(1n);
    expect(ci.args.deadline).to.equal(BigInt(ci.args.timestamp) + 30n * BigInt(DAY));
    expect(ci.args.vaultId).to.equal(await lk.vaultIdOf(owner.address, 1));
  });

  it("watcher check-ins report the watcher as the by address", async function () {
    await registerAt((await now()) + 10n);
    await (await lk.setWatcher(watcher.address)).wait();
    const r = await (await lk.connect(watcher).watcherCheckIn(owner.address)).wait();
    const ci = parsed(lk, r).find((e) => e.name === "CheckInReceived");
    expect(ci.args.by).to.equal(watcher.address);
  });

  it("pulse emits nothing before 80% of the interval", async function () {
    const start = (await now()) + 10n;
    await registerAt(start);
    const t = BigInt(start) + BigInt(DAY) * 23n;
    const r = await txAt(t, () => lk.pulse(owner.address));
    expect(parsed(lk, r).map((e) => e.name)).to.not.include("TimerWarning");
  });

  it("pulse emits TimerWarning once at 80% of the interval", async function () {
    const start = (await now()) + 10n;
    await registerAt(start);
    const t = BigInt(start) + BigInt(DAY) * 24n;
    const r = await txAt(t, () => lk.pulse(owner.address));
    const w = parsed(lk, r).find((e) => e.name === "TimerWarning");
    expect(w).to.not.be.undefined;
    expect(w.args.elapsedBps).to.equal(8000n);
    expect(w.args.deadline).to.equal(BigInt(start) + 30n * BigInt(DAY));
    expect(w.args.claimOpensAt).to.equal(BigInt(start) + 37n * BigInt(DAY));
    expect(w.args.vaultId).to.equal(await lk.vaultIdOf(owner.address, 1));

    const again = await txAt(t + 60n, () => lk.pulse(owner.address));
    expect(parsed(lk, again).map((e) => e.name)).to.not.include("TimerWarning");
  });

  it("a fresh check-in re-arms the TimerWarning for the next cycle", async function () {
    const start = (await now()) + 10n;
    await registerAt(start);
    await txAt(BigInt(start) + BigInt(DAY) * 24n, () => lk.pulse(owner.address));

    const ci = BigInt(start) + BigInt(DAY) * 25n;
    await txAt(ci, () => lk.connect(owner).checkIn());

    const t2 = ci + BigInt(DAY) * 24n;
    const r = await txAt(t2, () => lk.pulse(owner.address));
    expect(parsed(lk, r).map((e) => e.name)).to.include("TimerWarning");
  });

  it("pulse emits ClaimOpened once after the grace window and never again in that epoch", async function () {
    const start = (await now()) + 10n;
    await registerAt(start);
    const open = BigInt(start) + 37n * BigInt(DAY);
    const before = await txAt(open, () => lk.pulse(owner.address));
    expect(parsed(lk, before).map((e) => e.name)).to.not.include("ClaimOpened");

    const after = await txAt(open + 1n, () => lk.pulse(owner.address));
    const co = parsed(lk, after).find((e) => e.name === "ClaimOpened");
    expect(co.args.epoch).to.equal(1n);
    expect(co.args.claimOpensAt).to.equal(open);

    const repeat = await txAt(open + 100n, () => lk.pulse(owner.address));
    expect(parsed(lk, repeat).map((e) => e.name)).to.not.include("ClaimOpened");
  });

  it("pulse is a no-op for inactive vaults", async function () {
    const r = await (await lk.pulse(alice.address)).wait();
    expect(r.logs.length).to.equal(0);
  });

  it("pulse is a no-op after the vault is triggered", async function () {
    const start = (await now()) + 10n;
    await registerAt(start);
    const open = BigInt(start) + 37n * BigInt(DAY);
    await txAt(open + 1n, () => lk.pulse(owner.address));
    await txAt(open + 2n, () => lk.connect(alice).claim(owner.address, SECRET));
    const r = await txAt(open + 3n, () => lk.pulse(owner.address));
    expect(r.logs.length).to.equal(0);
  });

  it("attestationData returns the roster, shares and claim timing for the current epoch", async function () {
    const start = (await now()) + 10n;
    await registerAt(start);
    const d = await lk.attestationData(owner.address);
    expect(d.active).to.equal(true);
    expect(d.triggered).to.equal(false);
    expect(d.epoch).to.equal(1n);
    expect(d.lastCheckIn).to.equal(start);
    expect(d.claimOpensAt).to.equal(BigInt(start) + 37n * BigInt(DAY));
    expect(d.secretHash).to.equal(SECRET_HASH);
    expect(d.beneficiaries).to.deep.equal([alice.address, bob.address]);
    expect(d.sharesBps.map(Number)).to.deep.equal([6000, 4000]);
  });
});
