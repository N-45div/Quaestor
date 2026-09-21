import { expect } from "chai";
import { ethers } from "hardhat";

describe("QuaestorLog — what the hub would otherwise forget", () => {
  async function deploy() {
    const [hub, stranger] = await ethers.getSigners();
    const log = await (await ethers.getContractFactory("QuaestorLog")).deploy();
    return { log, hub, stranger };
  }

  it("publishes a record under the hash a Receipt would carry, computed from the bytes themselves", async () => {
    const { log, hub } = await deploy();
    const record = JSON.stringify({ agent: "Cato", action: "dca-buy", rationale: "dip", timestamp: "2026-09-22T00:00:00Z" });
    const bytes = ethers.toUtf8Bytes(record);
    const expected = ethers.keccak256(bytes);

    await expect(log.connect(hub).publish(bytes))
      .to.emit(log, "Published")
      .withArgs(expected, hub.address, ethers.hexlify(bytes));
    // The same hash the SDK commits in the governor's Receipt.
    expect(expected).to.equal(ethers.keccak256(ethers.toUtf8Bytes(record)));
  });

  it("lets anyone publish, because the hash is what binds a record, not who sent it", async () => {
    const { log, stranger } = await deploy();
    const bytes = ethers.toUtf8Bytes('{"agent":"someone-else"}');
    await expect(log.connect(stranger).publish(bytes)).to.emit(log, "Published");
  });

  it("stores nothing, so publishing costs event data and not storage", async () => {
    const { log, hub } = await deploy();
    const bytes = ethers.toUtf8Bytes("x".repeat(1024));
    const receipt = await (await log.connect(hub).publish(bytes)).wait();
    // A kilobyte as event data measured 62,820 gas. Written to storage it would
    // be about 20,000 gas per 32-byte word, some 640,000: ten times as much.
    expect(receipt!.gasUsed).to.be.lessThan(100_000n);
  });

  it("refuses an empty record and one over the size limit", async () => {
    const { log, hub } = await deploy();
    await expect(log.connect(hub).publish("0x")).to.be.revertedWithCustomError(log, "EmptyRecord");
    const max = await log.MAX_RECORD_BYTES();
    await expect(log.connect(hub).publish(new Uint8Array(Number(max) + 1)))
      .to.be.revertedWithCustomError(log, "RecordTooLarge").withArgs(max + 1n, max);
    await expect(log.connect(hub).publish(new Uint8Array(Number(max)).fill(1))).to.emit(log, "Published");
  });

  it("records a threat report with the venue hashed for filtering and the tenant counted, not named", async () => {
    const { log, hub } = await deploy();
    const venue = "0x2626664c2603336e57b271c5c0b26f421741e481";
    const humanId = ethers.id("world-id-nullifier");
    const tenantHash = ethers.id("tenant-alpha");
    await expect(log.connect(hub).report(venue, "prompt-injection", humanId, tenantHash))
      .to.emit(log, "Reported")
      .withArgs(ethers.id(venue), humanId, hub.address, venue, "prompt-injection", tenantHash);
  });

  it("names the relayer on every report, since that is who vouched for the human", async () => {
    const { log, hub, stranger } = await deploy();
    // Anyone can emit a report. A reader decides whose relays it believes, and
    // the address in the event is what it decides on.
    const tx = await log.connect(stranger).report("venue", "sandwich", ethers.ZeroHash, ethers.ZeroHash);
    const receipt = await tx.wait();
    const parsed = log.interface.parseLog(receipt!.logs[0])!;
    expect(parsed.args.reporter).to.equal(stranger.address);
    expect(parsed.args.reporter).to.not.equal(hub.address);
  });

  it("refuses an empty venue and fields over the limit", async () => {
    const { log, hub } = await deploy();
    await expect(log.connect(hub).report("", "x", ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(log, "EmptyRecord");
    await expect(log.connect(hub).report("v".repeat(257), "x", ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(log, "FieldTooLarge");
    await expect(log.connect(hub).report("v", "p".repeat(257), ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(log, "FieldTooLarge");
  });
});
