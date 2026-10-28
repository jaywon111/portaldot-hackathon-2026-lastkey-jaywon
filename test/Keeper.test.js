const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { readStatus, formatTable, autoClaim, WARN_BPS } = require("../keeper/lib/keeper");
const { parseArgs } = require("../keeper/cli");

const DAY = 24 * 60 * 60;
const SECRET = "keeper-word";
const HASH = ethers.keccak256(ethers.toUtf8Bytes(SECRET));

// Move the chain clock and mine a block so view calls (which read the latest block) see it.
async function setTime(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
  await network.provider.send("evm_mine");
}

describe("keeper", function () {
  let lk, owner, alice, bob;
  let start;

  beforeEach(async function () {
    [, owner, alice, bob] = await ethers.getSigners();
    lk = await (await ethers.getContractFactory("LastKey")).deploy();
    await setTime(BigInt((await ethers.provider.getBlock("latest")).timestamp) + 10n);
    await (
      await lk
        .connect(owner)
        .register(30, 7, [alice.address, bob.address], [6000, 4000], HASH, ethers.toUtf8Bytes("x"), {
          value: ethers.parseEther("1"),
        })
    ).wait();
    start = BigInt((await lk.attestationData(owner.address)).lastCheckIn);
  });

  it("classifies active, warning, claimable and triggered", async function () {
    const addr = await lk.getAddress();
    const ownerAddr = owner.address;
    const at = (t) => readStatus(ethers.provider, addr, ownerAddr, Number(t));

    expect((await at(start + 1n)).status).to.equal("active");
    const warnAt = start + BigInt(Math.floor((30 * DAY * WARN_BPS) / 10000)) + 1n;
    const warn = await at(warnAt);
    expect(warn.status).to.equal("warning");
    expect(warn.elapsedBps).to.be.gte(WARN_BPS);
    expect((await at(start + 37n * BigInt(DAY) + 1n)).status).to.equal("claimable");
  });

  it("reports inactive for an owner with no vault", async function () {
    const r = await readStatus(ethers.provider, await lk.getAddress(), alice.address, Number(start));
    expect(r.status).to.equal("inactive");
  });

  it("formats a status table with one row per owner", async function () {
    const r = await readStatus(ethers.provider, await lk.getAddress(), owner.address, Number(start));
    const table = formatTable([r]);
    const lines = table.split("\n");
    expect(lines.length).to.equal(2);
    expect(lines[0]).to.match(/owner\s+status\s+epoch/);
    expect(lines[1]).to.include("active");
  });

  it("auto-claim skips before the window opens", async function () {
    const r = await autoClaim({ signer: alice, lkAddress: await lk.getAddress(), owner: owner.address, secret: SECRET });
    expect(r.action).to.equal("skip");
    expect(r.reason).to.equal("not claimable yet");
  });

  it("auto-claim pays the beneficiary and then skips as already claimed", async function () {
    await setTime(start + 37n * BigInt(DAY) + 1n);
    const before = await ethers.provider.getBalance(alice.address);
    const r = await autoClaim({ signer: alice, lkAddress: await lk.getAddress(), owner: owner.address, secret: SECRET });
    expect(r.action).to.equal("claimed");
    expect(r.payout).to.equal(ethers.parseEther("0.6").toString());
    const after = await ethers.provider.getBalance(alice.address);
    expect(after).to.be.gt(before);

    const again = await autoClaim({ signer: alice, lkAddress: await lk.getAddress(), owner: owner.address, secret: SECRET });
    expect(again.action).to.equal("skip");
    expect(again.reason).to.equal("already claimed");
  });

  it("auto-claim skips a non-beneficiary without sending a transaction", async function () {
    await setTime(start + 37n * BigInt(DAY) + 1n);
    const stranger = (await ethers.getSigners())[5];
    const r = await autoClaim({ signer: stranger, lkAddress: await lk.getAddress(), owner: owner.address, secret: SECRET });
    expect(r.action).to.equal("skip");
    expect(r.reason).to.equal("not claimable yet");
  });

  it("auto-claim with the wrong secret reverts instead of paying", async function () {
    await setTime(start + 37n * BigInt(DAY) + 1n);
    await expect(
      autoClaim({ signer: alice, lkAddress: await lk.getAddress(), owner: owner.address, secret: "wrong" })
    ).to.be.reverted;
  });

  it("parses CLI flags and keeps the key out of argv", function () {
    const { cmd, opts } = parseArgs(["auto-claim", "--rpc", "https://x", "--owner", "0xabc", "--secret-env", "LK_SECRET"]);
    expect(cmd).to.equal("auto-claim");
    expect(opts.rpc).to.equal("https://x");
    expect(opts["secret-env"]).to.equal("LK_SECRET");
    expect(Object.keys(opts)).to.not.include("private-key");
  });
});
