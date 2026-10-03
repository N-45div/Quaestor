import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * The Chainlink CRE receiver on Monad: a report reaches a governor's price feed only through
 * the forwarder, only from the simulation sender while there is one, only from the workflow
 * named once there is one, and only for the stocks the owner listed. An older round is dropped,
 * never written backwards.
 */
describe("QuaestorMirrorReceiver — Chainlink CRE writes stock prices onto Monad", () => {
  const NVDA = ethers.encodeBytes32String("NVDA");
  const SPY = ethers.encodeBytes32String("SPY");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const report = (symbols: string[], answers: bigint[], times: number[]) => coder.encode(["bytes32[]", "int256[]", "uint256[]"], [symbols, answers, times]);
  const NO_METADATA = "0x";

  async function setup() {
    const [owner, broadcaster, stranger] = await ethers.getSigners();
    const forwarder = await (await ethers.getContractFactory("TestForwarder")).deploy();
    const receiver = await (await ethers.getContractFactory("QuaestorMirrorReceiver")).deploy(await forwarder.getAddress(), broadcaster.address);
    const Feed = await ethers.getContractFactory("MirrorFeed");
    const nvda = await Feed.deploy(await receiver.getAddress(), 8, ethers.ZeroAddress, "NVDA / USD (test)");
    const spy = await Feed.deploy(await receiver.getAddress(), 8, ethers.ZeroAddress, "SPY / USD (test)");
    await receiver.setFeed(NVDA, await nvda.getAddress());
    await receiver.setFeed(SPY, await spy.getAddress());
    const deliver = (from: typeof owner, payload: string, metadata = NO_METADATA) =>
      forwarder.connect(from).report(receiver.getAddress(), metadata, payload);
    return { owner, broadcaster, stranger, forwarder, receiver, nvda, spy, deliver };
  }

  it("copies each stock in a report into its feed, as Chainlink's latestRoundData", async () => {
    const { broadcaster, receiver, nvda, spy, deliver } = await setup();
    await expect(deliver(broadcaster, report([NVDA, SPY], [23_499_711_907n, 77_071_210_575n], [1_759_500_000, 1_759_500_100])))
      .to.emit(receiver, "Relayed").withArgs(NVDA, 23_499_711_907n, 1_759_500_000);
    const [, nvdaAnswer, , nvdaAt] = await nvda.latestRoundData();
    const [, spyAnswer, , spyAt] = await spy.latestRoundData();
    expect([nvdaAnswer, nvdaAt, spyAnswer, spyAt]).to.deep.equal([23_499_711_907n, 1_759_500_000n, 77_071_210_575n, 1_759_500_100n]);
  });

  it("takes reports only through the forwarder", async () => {
    const { stranger, receiver } = await setup();
    await expect(receiver.connect(stranger).onReport(NO_METADATA, report([NVDA], [1n], [1])))
      .to.be.revertedWithCustomError(receiver, "NotForwarder").withArgs(stranger.address);
  });

  it("while on the simulation forwarder, which checks no signature, takes only the simulation sender's transactions", async () => {
    const { stranger, receiver, nvda, deliver } = await setup();
    await expect(deliver(stranger, report([NVDA], [1n], [1])))
      .to.be.revertedWithCustomError(receiver, "NotSimulationSender").withArgs(stranger.address);
    expect((await nvda.latestRoundData())[1]).to.equal(0n);
  });

  it("once a workflow ID is set, takes only that workflow's reports, whoever sends them", async () => {
    const { owner, stranger, forwarder, receiver, nvda, deliver } = await setup();
    const id = ethers.id("quaestor-stock-mirror");
    await receiver.setForwarder(await forwarder.getAddress(), ethers.ZeroAddress);
    await receiver.setWorkflowId(id);
    // The production forwarder passes 64 bytes: workflow ID, name, owner, report ID.
    const metadata = (workflowId: string) => ethers.concat([workflowId, ethers.zeroPadBytes("0x01", 10), owner.address, "0x0000"]);
    await expect(deliver(stranger, report([NVDA], [5n], [10]), metadata(ethers.id("another"))))
      .to.be.revertedWithCustomError(receiver, "WrongWorkflow");
    await expect(deliver(stranger, report([NVDA], [5n], [10]), NO_METADATA)).to.be.revertedWithCustomError(receiver, "WrongWorkflow");
    await deliver(stranger, report([NVDA], [5n], [10]), metadata(id));
    expect((await nvda.latestRoundData())[1]).to.equal(5n);
  });

  it("writes only the stocks the owner listed, and never a zero or negative price", async () => {
    const { broadcaster, receiver, deliver } = await setup();
    const AAPL = ethers.encodeBytes32String("AAPL");
    await expect(deliver(broadcaster, report([AAPL], [1n], [1]))).to.be.revertedWithCustomError(receiver, "UnknownSymbol").withArgs(AAPL);
    await expect(deliver(broadcaster, report([NVDA], [0n], [1]))).to.be.revertedWithCustomError(receiver, "BadAnswer");
    await expect(deliver(broadcaster, report([NVDA], [-1n], [1]))).to.be.revertedWithCustomError(receiver, "BadAnswer");
    await expect(deliver(broadcaster, coder.encode(["bytes32[]", "int256[]", "uint256[]"], [[NVDA], [1n, 2n], [1]])))
      .to.be.revertedWithCustomError(receiver, "LengthMismatch");
  });

  it("drops an older round than the feed holds instead of failing the whole report", async () => {
    const { broadcaster, receiver, nvda, spy, deliver } = await setup();
    await deliver(broadcaster, report([NVDA], [200n], [100]));
    await expect(deliver(broadcaster, report([NVDA, SPY], [150n, 700n], [90, 100])))
      .to.emit(receiver, "Skipped").withArgs(NVDA, 90, 100)
      .and.to.emit(receiver, "Relayed").withArgs(SPY, 700n, 100);
    expect((await nvda.latestRoundData())[1]).to.equal(200n);
    expect((await spy.latestRoundData())[1]).to.equal(700n);
  });

  it("leaves its settings to the owner, and tells CRE's forwarder it is a receiver", async () => {
    const { stranger, receiver } = await setup();
    const asStranger = receiver.connect(stranger);
    for (const call of [
      () => asStranger.setFeed(NVDA, stranger.address),
      () => asStranger.setForwarder(stranger.address, ethers.ZeroAddress),
      () => asStranger.setWorkflowId(ethers.id("x")),
      () => asStranger.setOwner(stranger.address),
    ]) await expect(call()).to.be.revertedWithCustomError(receiver, "NotOwner");
    const onReport = ethers.id("onReport(bytes,bytes)").slice(0, 10);
    expect(await receiver.supportsInterface(onReport)).to.equal(true);
    expect(await receiver.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await receiver.supportsInterface("0xffffffff")).to.equal(false);
  });
});
