const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const lib = require("../keeper/lib/attest");

const DAY = 24 * 60 * 60;
const SECRET = "lantern-42";
const SECRET_HASH = ethers.keccak256(ethers.toUtf8Bytes(SECRET));
const PAYLOAD = ethers.toUtf8Bytes("ciphertext-bridge");
const SRC_CHAIN = 420420777n; // Portaldot id used as the source label in tests
const ZERO32 = ethers.ZeroHash;

async function setTime(t) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
}
async function latestTs() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

describe("LastKeyBridgeReceiver (watcher-quorum, ICrossChainReceiver)", function () {
  let src, bridge, admin, owner, alice, bob, carol, stranger, w1, w2, w3, w4, start;
  let watcherWallets;

  beforeEach(async function () {
    [admin, owner, alice, bob, carol, stranger] = await ethers.getSigners();
    // Three watchers, threshold 2. Wallets are local, as on the Portaldot testnet.
    w1 = ethers.Wallet.createRandom();
    w2 = ethers.Wallet.createRandom();
    w3 = ethers.Wallet.createRandom();
    w4 = ethers.Wallet.createRandom();
    watcherWallets = [w1, w2, w3];

    src = await (await ethers.getContractFactory("LastKey")).deploy();
    await src.waitForDeployment();

    bridge = await (await ethers.getContractFactory("LastKeyBridgeReceiver")).deploy(
      [w1.address, w2.address, w3.address],
      2
    );
    await bridge.waitForDeployment();

    start = (await latestTs()) + 10n;
    await setTime(start);
    await (
      await src
        .connect(owner)
        .register(30, 7, [alice.address, bob.address], [6000, 4000], SECRET_HASH, PAYLOAD, {
          value: ethers.parseEther("2"),
        })
    ).wait();
  });

  const srcAddr = () => src.getAddress();
  const ownerAddr = () => owner.address;

  // Build attestations exactly like a watcher does, from the source vault.
  async function attestations({ expiresAt } = {}) {
    const exp = expiresAt ?? (await latestTs()) + 365n * BigInt(DAY);
    return lib.buildAttestations({
      sourceProvider: ethers.provider,
      srcChainId: SRC_CHAIN,
      srcVault: await srcAddr(),
      owner: ownerAddr(),
      expiresAt: exp,
      nonceSeed: "t",
    });
  }

  async function signed(att, signers = watcherWallets) {
    const digest = lib.attestationDigest({
      chainId: (await ethers.provider.getNetwork()).chainId,
      receiver: await bridge.getAddress(),
      att,
    });
    const threshold = Number(await bridge.threshold());
    const sigs = await lib.quorumSignatures(signers, digest, threshold);
    return { bytes: lib.encodeAttestation(att), sigs };
  }

  async function fund(amount = ethers.parseEther("1")) {
    return bridge.connect(stranger).fundMirror(SRC_CHAIN, await srcAddr(), ownerAddr(), 1, { value: amount });
  }

  async function mirrorId() {
    return bridge.mirrorIdOf(SRC_CHAIN, await srcAddr(), ownerAddr(), 1);
  }

  // Claim window opens at start + 37 days.
  const openAt = () => start + 37n * BigInt(DAY) + 1n;

  describe("setup and quorum", function () {
    it("records admin, threshold and signer set", async function () {
      expect(await bridge.admin()).to.equal(admin.address);
      expect(await bridge.threshold()).to.equal(2n);
      expect(await bridge.isSigner(w1.address)).to.equal(true);
      expect(await bridge.isSigner(w4.address)).to.equal(false);
      expect((await bridge.signerSet()).length).to.equal(3);
    });

    it("rejects an invalid quorum", async function () {
      const F = await ethers.getContractFactory("LastKeyBridgeReceiver");
      await expect(F.deploy([w1.address], 2)).to.be.revertedWithCustomError(bridge, "InvalidQuorum");
      await expect(F.deploy([w1.address], 0)).to.be.revertedWithCustomError(bridge, "InvalidQuorum");
      await expect(F.deploy([], 1)).to.be.revertedWithCustomError(bridge, "InvalidQuorum");
    });

    it("rejects duplicate and zero signers", async function () {
      const F = await ethers.getContractFactory("LastKeyBridgeReceiver");
      await expect(F.deploy([w1.address, w1.address], 1)).to.be.revertedWithCustomError(bridge, "DuplicateSigner");
      await expect(F.deploy([ethers.ZeroAddress], 1)).to.be.revertedWithCustomError(bridge, "ZeroAddress");
    });

    it("only the admin can rotate the watcher set, and rotation replaces old signers", async function () {
      await expect(bridge.connect(stranger).setQuorum([w4.address], 1)).to.be.revertedWithCustomError(bridge, "NotAdmin");
      await bridge.connect(admin).setQuorum([w4.address, w2.address], 1);
      expect(await bridge.isSigner(w1.address)).to.equal(false);
      expect(await bridge.isSigner(w4.address)).to.equal(true);
      expect(await bridge.threshold()).to.equal(1n);
    });

    it("transfers admin and blocks the old admin", async function () {
      await bridge.connect(admin).transferAdmin(stranger.address);
      expect(await bridge.admin()).to.equal(stranger.address);
      await expect(bridge.connect(admin).setQuorum([w1.address], 1)).to.be.revertedWithCustomError(bridge, "NotAdmin");
      await expect(bridge.connect(admin).transferAdmin(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        bridge,
        "NotAdmin"
      );
    });

    it("exposes the ICrossChainReceiver selector set as a stable interface id", function () {
      const id = lib.receiverInterfaceId();
      expect(id).to.match(/^0x[0-9a-f]{8}$/);
      expect(id).to.equal(lib.receiverInterfaceId());
    });
  });

  describe("mirror funding", function () {
    it("ids are deterministic per (chain, vault, owner, epoch)", async function () {
      const a = await mirrorId();
      expect(a).to.equal(await bridge.mirrorIdOf(SRC_CHAIN, await srcAddr(), ownerAddr(), 1));
      expect(a).to.not.equal(await bridge.mirrorIdOf(SRC_CHAIN + 1n, await srcAddr(), ownerAddr(), 1));
      expect(a).to.not.equal(await bridge.mirrorIdOf(SRC_CHAIN, await srcAddr(), ownerAddr(), 2));
    });

    it("anyone can fund a mirror and the event carries the running balance", async function () {
      const tx = await fund(ethers.parseEther("1"));
      await expect(tx).to.emit(bridge, "MirrorFunded").withArgs(await mirrorId(), stranger.address, ethers.parseEther("1"), ethers.parseEther("1"));
      await fund(ethers.parseEther("0.5"));
      const [balance, , triggered, exists] = await bridge.mirrorOf(await mirrorId());
      expect(balance).to.equal(ethers.parseEther("1.5"));
      expect(triggered).to.equal(false);
      expect(exists).to.equal(true);
    });

    it("rejects zero funding", async function () {
      await expect(
        bridge.connect(stranger).fundMirror(SRC_CHAIN, await srcAddr(), ownerAddr(), 1, { value: 0 })
      ).to.be.revertedWithCustomError(bridge, "ZeroFunding");
    });
  });

  describe("claimCrossChain", function () {
    beforeEach(async function () {
      await fund(ethers.parseEther("1"));
    });

    it("pays alice 60% of the mirror after the source claim window opens", async function () {
      const [attA] = (await attestations()).filter((a) => a.beneficiary === alice.address);
      const { bytes, sigs } = await signed(attA);
      await setTime(openAt());
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await bridge.connect(alice).claimCrossChain(bytes, sigs, SECRET);
      const rec = await tx.wait();
      const gas = rec.gasUsed * rec.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);
      expect(after - before + gas).to.equal(ethers.parseEther("0.6"));
      await expect(tx).to.emit(bridge, "CrossChainClaimed");
      expect(await bridge.claimedBy(await mirrorId(), alice.address)).to.equal(true);
    });

    it("the first claim snapshots the pool; bob still gets 40% of the snapshot", async function () {
      const atts = await attestations();
      const aAtt = atts.find((a) => a.beneficiary === alice.address);
      const bAtt = atts.find((a) => a.beneficiary === bob.address);
      const a = await signed(aAtt);
      const b = await signed(bAtt);
      await setTime(openAt());
      await (await bridge.connect(alice).claimCrossChain(a.bytes, a.sigs, SECRET)).wait();
      // extra funding after the trigger must be refused
      await expect(fund(ethers.parseEther("3"))).to.be.revertedWithCustomError(bridge, "MirrorTriggered");

      const before = await ethers.provider.getBalance(bob.address);
      const tx = await bridge.connect(bob).claimCrossChain(b.bytes, b.sigs, SECRET);
      const rec = await tx.wait();
      const after = await ethers.provider.getBalance(bob.address);
      expect(after - before + rec.gasUsed * rec.gasPrice).to.equal(ethers.parseEther("0.4"));
      const [balance, pool, triggered] = await bridge.mirrorOf(await mirrorId());
      expect(pool).to.equal(ethers.parseEther("1"));
      expect(triggered).to.equal(true);
      expect(balance).to.equal(0n);
      expect(await bridge.claimedBps(await mirrorId())).to.equal(10000n);
    });

    it("rejects a wrong secret", async function () {
      const { bytes, sigs } = await signed((await attestations()).find((a) => a.beneficiary === alice.address));
      await setTime(openAt());
      await expect(bridge.connect(alice).claimCrossChain(bytes, sigs, "nope")).to.be.revertedWithCustomError(
        bridge,
        "WrongSecret"
      );
    });

    it("rejects a claim before the source window opens", async function () {
      const { bytes, sigs } = await signed((await attestations()).find((a) => a.beneficiary === alice.address));
      await setTime(start + 37n * BigInt(DAY) - 10n);
      await expect(bridge.connect(alice).claimCrossChain(bytes, sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "NotYetClaimable"
      );
    });

    it("rejects an attestation issued to someone else", async function () {
      const { bytes, sigs } = await signed((await attestations()).find((a) => a.beneficiary === alice.address));
      await setTime(openAt());
      await expect(bridge.connect(bob).claimCrossChain(bytes, sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "AttestationNotForSender"
      );
      await expect(bridge.connect(carol).claimCrossChain(bytes, sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "AttestationNotForSender"
      );
    });

    it("rejects an expired attestation", async function () {
      const exp = start + 38n * BigInt(DAY);
      const atts = await attestations({ expiresAt: exp });
      const { bytes, sigs } = await signed(atts.find((a) => a.beneficiary === alice.address));
      await setTime(start + 39n * BigInt(DAY));
      await expect(bridge.connect(alice).claimCrossChain(bytes, sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "AttestationExpired"
      );
    });

    it("rejects a second claim by the same beneficiary", async function () {
      const { bytes, sigs } = await signed((await attestations()).find((a) => a.beneficiary === alice.address));
      await setTime(openAt());
      await (await bridge.connect(alice).claimCrossChain(bytes, sigs, SECRET)).wait();
      // same attestation: the nonce check fires first; a fresh nonce still hits AlreadyClaimed
      const att = (await attestations()).find((a) => a.beneficiary === alice.address);
      const fresh = { ...att, nonce: ethers.keccak256(ethers.toUtf8Bytes("fresh")) };
      const s2 = await signed(fresh);
      await expect(bridge.connect(alice).claimCrossChain(s2.bytes, s2.sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "AlreadyClaimed"
      );
    });

    it("replay protection: a reused nonce is rejected even for another beneficiary", async function () {
      const atts = await attestations();
      const aAtt = atts.find((a) => a.beneficiary === alice.address);
      const bAtt = atts.find((a) => a.beneficiary === bob.address);
      const reused = { ...bAtt, nonce: aAtt.nonce };
      const { bytes, sigs } = await signed(aAtt);
      await setTime(openAt());
      await (await bridge.connect(alice).claimCrossChain(bytes, sigs, SECRET)).wait();
      const s2 = await signed(reused);
      await expect(bridge.connect(bob).claimCrossChain(s2.bytes, s2.sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "NonceReused"
      );
      expect(await bridge.nonceUsed(aAtt.nonce)).to.equal(true);
    });

    it("rejects a claim against a mirror that was never funded", async function () {
      const att = { ...(await attestations()).find((a) => a.beneficiary === alice.address), epoch: 9n };
      const s = await signed(att);
      await setTime(openAt());
      await expect(bridge.connect(alice).claimCrossChain(s.bytes, s.sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "WrongMirror"
      );
    });

    it("rejects too few signatures", async function () {
      const { bytes, sigs } = await signed(
        (await attestations()).find((a) => a.beneficiary === alice.address),
        [w1]
      );
      await setTime(openAt());
      await expect(bridge.connect(alice).claimCrossChain(bytes, [sigs[0]], SECRET)).to.be.revertedWithCustomError(
        bridge,
        "InsufficientSignatures"
      );
    });

    it("rejects a signature from a non-watcher", async function () {
      const att = (await attestations()).find((a) => a.beneficiary === alice.address);
      const { bytes, sigs } = await signed(att, [w1, w4]);
      await setTime(openAt());
      await expect(bridge.connect(alice).claimCrossChain(bytes, sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "UnknownSigner"
      );
    });

    it("rejects the same watcher signing twice (duplicate signer)", async function () {
      const att = (await attestations()).find((a) => a.beneficiary === alice.address);
      const { bytes, sigs } = await signed(att, [w1, w1]);
      await setTime(openAt());
      await expect(bridge.connect(alice).claimCrossChain(bytes, sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "SignerOrder"
      );
    });

    it("rejects signatures not sorted by signer address", async function () {
      const att = (await attestations()).find((a) => a.beneficiary === alice.address);
      const digest = lib.attestationDigest({
        chainId: (await ethers.provider.getNetwork()).chainId,
        receiver: await bridge.getAddress(),
        att,
      });
      const sorted = [w1, w2].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
      const reversed = [sorted[1], sorted[0]];
      const sigs = [];
      for (const w of reversed) sigs.push(await lib.signDigest(w, digest));
      await setTime(openAt());
      await expect(
        bridge.connect(alice).claimCrossChain(lib.encodeAttestation(att), sigs, SECRET)
      ).to.be.revertedWithCustomError(bridge, "SignerOrder");
    });

    it("a tampered share fails: signatures bind the attested share", async function () {
      const att = (await attestations()).find((a) => a.beneficiary === alice.address);
      const { sigs } = await signed(att);
      const tampered = { ...att, shareBps: 10000 };
      await setTime(openAt());
      await expect(bridge.connect(alice).claimCrossChain(lib.encodeAttestation(tampered), sigs, SECRET)).to.be.reverted;
    });

    it("a signature for another chain's digest is rejected (domain separation)", async function () {
      const att = (await attestations()).find((a) => a.beneficiary === alice.address);
      const wrongDigest = lib.attestationDigest({ chainId: 1, receiver: await bridge.getAddress(), att });
      const sigs = await lib.quorumSignatures(watcherWallets, wrongDigest, 2);
      await setTime(openAt());
      await expect(bridge.connect(alice).claimCrossChain(lib.encodeAttestation(att), sigs, SECRET)).to.be.reverted;
    });

    it("rejects a malformed (non-65-byte) signature", async function () {
      const att = (await attestations()).find((a) => a.beneficiary === alice.address);
      const { bytes, sigs } = await signed(att);
      await setTime(openAt());
      await expect(
        bridge.connect(alice).claimCrossChain(bytes, [sigs[0].slice(0, 130), sigs[1]], SECRET)
      ).to.be.revertedWithCustomError(bridge, "BadSignature");
    });

    it("the rotated watcher set is what counts after setQuorum", async function () {
      const att = (await attestations()).find((a) => a.beneficiary === alice.address);
      await bridge.connect(admin).setQuorum([w4.address], 1);
      const { bytes, sigs } = await signed(att, [w1, w2]);
      await setTime(openAt());
      await expect(bridge.connect(alice).claimCrossChain(bytes, sigs, SECRET)).to.be.revertedWithCustomError(
        bridge,
        "UnknownSigner"
      );
      const ok = await signed(att, [w4]);
      await bridge.connect(alice).claimCrossChain(ok.bytes, ok.sigs, SECRET);
      expect(await bridge.claimedBy(await mirrorId(), alice.address)).to.equal(true);
    });
  });
});
