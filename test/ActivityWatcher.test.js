const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { authorizationMessage, validateAuthorization, createActivityWatcher } = require("../keeper/lib/activity-watcher");

async function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lastkey-watch-")), "state.json");
}

describe("consent-bound activity heartbeat", function () {
  it("requires a valid, unexpired wallet signature bound to chain and contract", async function () {
    const [owner, wallet] = await ethers.getSigners();
    const addr = await owner.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const record = { chainId, lastKey: addr, owner: addr, wallet: await wallet.getAddress(), expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    record.signature = await wallet.signMessage(authorizationMessage(record));
    expect(await validateAuthorization(record, { chainId, lastKey: addr })).to.deep.equal({ owner: addr, wallet: await wallet.getAddress(), expiresAt: Number(record.expiresAt) });
    await expect(validateAuthorization(record, { chainId: chainId + 1n, lastKey: addr })).to.be.rejectedWith("authorization chain mismatch");
    await expect(validateAuthorization(record, { chainId, lastKey: ethers.ZeroAddress })).to.be.rejectedWith("authorization LastKey mismatch");
  });

  it("checks in only after successful activity from the explicitly authorized wallet", async function () {
    const [admin, owner, authorizedWallet, stranger] = await ethers.getSigners();
    const lk = await (await ethers.getContractFactory("LastKey")).deploy();
    await lk.waitForDeployment();
    await lk.connect(admin).setWatcher(await admin.getAddress());
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const record = { chainId, lastKey: await lk.getAddress(), owner: await owner.getAddress(), wallet: await authorizedWallet.getAddress(), expiresAt };
    record.signature = await authorizedWallet.signMessage(authorizationMessage(record));
    await lk.connect(owner).register(1, 1, [await stranger.getAddress()], [10000], ethers.keccak256(ethers.toUtf8Bytes("secret")), ethers.toUtf8Bytes("ciphertext"), { value: 1 });

    const file = await tempFile();
    const service = createActivityWatcher({
      provider: ethers.provider,
      signer: admin,
      lastKey: await lk.getAddress(),
      chainId,
      authorizations: [record],
      stateFile: file,
      confirmations: 1,
    });
    await service.initialize();
    const baseline = await ethers.provider.getBlockNumber();
    const beforeActivity = (await lk.attestationData(await owner.getAddress())).lastCheckIn;
    await (await stranger.sendTransaction({ to: await owner.getAddress(), value: 0 })).wait();
    await service.tick();
    expect((await lk.attestationData(await owner.getAddress())).lastCheckIn).to.equal(beforeActivity);

    await (await authorizedWallet.sendTransaction({ to: await owner.getAddress(), value: 0 })).wait();
    await service.tick();
    const status = await lk.attestationData(await owner.getAddress());
    expect(status.lastCheckIn).to.be.greaterThan(beforeActivity);
      const firstCheckIn = status.lastCheckIn;
      await service.tick();
      expect((await lk.attestationData(await owner.getAddress())).lastCheckIn).to.equal(firstCheckIn);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).lastBlock).to.be.at.least(baseline);
  });
});
