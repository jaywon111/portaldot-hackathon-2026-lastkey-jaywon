const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { sweepAllAndClaim, chunkList, scanHoldings, transferSources, MAX_TOKENS_PER_TX } = require("../keeper/lib/sweep");

const DAY = 24 * 60 * 60;
const SECRET = "integration-secret";
const HASH = ethers.keccak256(ethers.toUtf8Bytes(SECRET));

async function setTime(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
  await network.provider.send("evm_mine");
}

describe("keeper sweep-all (integration, local hardhat chain)", function () {
  let lk, owner, alice, bob, beneficiaryKeyWallet, provider;
  const N = 7; // more tokens than one batch of 5 to exercise batching

  beforeEach(async function () {
    [, owner, alice, bob] = await ethers.getSigners();
    provider = ethers.provider;
    lk = await (await ethers.getContractFactory("LastKey")).deploy();
    await setTime(BigInt((await provider.getBlock("latest")).timestamp) + 10n);
    await (
      await lk
        .connect(owner)
        .register(30, 7, [alice.address, bob.address], [6000, 4000], HASH, ethers.toUtf8Bytes("ct"), {
          value: ethers.parseEther("1"),
        })
    ).wait();
  });

  async function deployTokens(count) {
    const Mock = await ethers.getContractFactory("MockERC20");
    const out = [];
    for (let i = 0; i < count; i++) {
      const t = await Mock.deploy("T" + i, "T" + i);
      await t.waitForDeployment();
      await (await t.mint(owner.address, ethers.parseEther("10"))).wait();
      out.push(t);
    }
    return out;
  }

  it("scans holdings, batches pulls under the cap, then claims for the beneficiary", async function () {
    const tokens = await deployTokens(N);
    // approve six of seven; the seventh is held but never approved
    for (let i = 0; i < 6; i++) {
      await (await tokens[i].connect(owner).approve(await lk.getAddress(), ethers.parseEther("10"))).wait();
    }
    await (await lk.connect(owner).enableEverythingApproval(await lk.vaultIdOf(owner.address, 1))).wait();

    // beneficiary "keeper" signer is alice (a real beneficiary) so sweepAll + claim both work
    const signer = alice;
    const lkAddr = await lk.getAddress();
    const addrs = await Promise.all(tokens.map((t) => t.getAddress()));

    // move the chain clock past claimOpensAt, then run the keeper against real chain time
    const data = await lk.attestationData(owner.address);
    await setTime(Number(data.claimOpensAt) + 2 * DAY);

    const report = await sweepAllAndClaim({
      signer,
      provider,
      lkAddress: lkAddr,
      owner: owner.address,
      vaultId: await lk.vaultIdOf(owner.address, 1),
      secret: SECRET,
      knownTokens: addrs,
      batchSize: 5,
      lookback: 1000,
      chunk: 200,
    });

    // six approved tokens pulled, seventh (no allowance) skipped
    expect(report.pullable.length).to.equal(6);
    expect(report.skipped.some((s) => s.reason === "no allowance to vault")).to.equal(true);
    // 6 tokens at batch size 5 -> 2 batches, both swept
    expect(report.batches.filter((b) => b.status === "swept").length).to.be.gte(2);
    expect(report.batches.every((b) => b.status === "swept")).to.equal(true);
    // the claim ran (payout snapshot)
    expect(report.claim.action).to.equal("claimed");

    // the claim ran after the sweeps: alice (60%) took her token share, so 40% of each swept token stays in escrow
    for (let i = 0; i < 6; i++) {
      expect(await lk.tokenEscrowOf(owner.address, addrs[i])).to.equal(ethers.parseEther("4"));
    }
    // approved tokens left the owner (pulled into escrow); the unapproved one stayed put
    for (let i = 0; i < 6; i++) {
      expect(await tokens[i].balanceOf(owner.address)).to.equal(0n);
    }
    expect(await tokens[6].balanceOf(owner.address)).to.equal(ethers.parseEther("10"));
  });

  it("refuses to run when the owner has not attested", async function () {
    let err;
    try {
      await sweepAllAndClaim({
        signer: alice,
        provider,
        lkAddress: await lk.getAddress(),
        owner: owner.address,
        vaultId: await lk.vaultIdOf(owner.address, 1),
        secret: SECRET,
        knownTokens: [],
        now: 9999999999,
      });
    } catch (e) {
      err = e;
    }
    expect(err && err.message).to.include("not enabled everything");
  });

  it("chunkList splits into batches of at most MAX_TOKENS_PER_TX", function () {
    const xs = Array.from({ length: 13 }, (_, i) => i);
    const parts = chunkList(xs, 5);
    expect(parts.map((p) => p.length)).to.deep.equal([5, 5, 3]);
    expect(MAX_TOKENS_PER_TX).to.equal(20);
  });

  it("transferSources finds tokens that sent a Transfer to the owner in range", async function () {
    const [t] = await deployTokens(1);
    await (await t.connect(owner).transfer(alice.address, 1n)).wait();
    await (await t.mint(owner.address, 5n)).wait();
    const found = await transferSources(provider, owner.address, { lookback: 1000, chunk: 200 });
    expect(found).to.include(await t.getAddress());
  });
});
