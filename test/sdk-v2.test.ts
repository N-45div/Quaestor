import { expect } from "chai";
import { ethers } from "hardhat";
import {
  Category,
  credentialIn,
  decodeQuaestorError,
  metaHashOf,
  QUAESTOR_ABI,
  QUAESTOR_LOG_ABI,
  QUAESTOR_V2_ABI,
  QuaestorAgent,
  verifyReceipt,
  type DecisionMeta,
} from "../sdk";

const ONE = 10n ** 18n;
const EXECUTION = 2;

/** An ABI's fragments, normalised and sorted, so two can be compared whatever their order. */
const shape = (abi: ReadonlyArray<unknown>) =>
  new ethers.Interface(abi as ethers.InterfaceAbi).format(false)
    .filter((line) => !line.startsWith("constructor") && !line.startsWith("receive"))
    .sort();

describe("SDK — the V2 governor and the on-chain log", () => {
  describe("the ABIs are the contracts', not a copy that can drift", () => {
    it("QUAESTOR_V2_ABI matches the compiled QuaestorV2 exactly", async () => {
      const compiled = (await ethers.getContractFactory("QuaestorV2")).interface.fragments;
      expect(shape(QUAESTOR_V2_ABI)).to.deep.equal(shape(compiled));
    });

    it("QUAESTOR_LOG_ABI matches the compiled QuaestorLog exactly", async () => {
      const compiled = (await ethers.getContractFactory("QuaestorLog")).interface.fragments;
      expect(shape(QUAESTOR_LOG_ABI)).to.deep.equal(shape(compiled));
    });

    it("shows why a reader must know which governor it reads: same topic, payee in a different place", () => {
      const v1 = new ethers.Interface(QUAESTOR_ABI).getEvent("Receipt")!;
      const v2 = new ethers.Interface(QUAESTOR_V2_ABI).getEvent("Receipt")!;
      expect(v1.topicHash).to.equal(v2.topicHash);
      expect(Boolean(v1.inputs.find((i) => i.name === "payee")!.indexed)).to.equal(false);
      expect(v2.inputs.find((i) => i.name === "payee")!.indexed).to.equal(true);
    });
  });

  describe("a record that looks like it holds a credential is never published", () => {
    it("catches the usual shapes", () => {
      expect(credentialIn('{"note":"sk-proj-abcdefghijklmnopqrstuvwx"}')).to.contain("OpenAI");
      expect(credentialIn('{"t":"glpat-abcdefghij0123456789"}')).to.contain("GitLab");
      expect(credentialIn('{"privateKey":"0xabcdef0123456789"}')).to.contain("secret");
      expect(credentialIn('{"h":"Authorization: Bearer abcdefghijklmnop"}')).to.not.equal(null);
      expect(credentialIn("https://rpc.example/?api-key=abcdef123456")).to.contain("URL");
      expect(credentialIn("-----BEGIN PRIVATE KEY-----")).to.contain("PEM");
    });

    it("does not refuse Cato's own records", () => {
      // tokenOut contains "token"; a tx hash has the shape of a private key.
      const record = JSON.stringify({
        agent: "Cato", action: "dca-buy", rationale: "dip below the SMA",
        inputs: { tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTokens: 5, lastTx: `0x${"ab".repeat(32)}` },
        timestamp: "2026-09-22T00:00:00Z",
      });
      expect(credentialIn(record)).to.equal(null);
    });
  });

  describe("QuaestorAgent against a V2 governor and the log", () => {
    async function deploy() {
      const [owner, operator, stranger] = await ethers.getSigners();
      const governor = await (await ethers.getContractFactory("QuaestorV2")).deploy();
      const log = await (await ethers.getContractFactory("QuaestorLog")).deploy();
      const token = await (await ethers.getContractFactory("MockToken")).deploy();
      const venue = await (await ethers.getContractFactory("HonestVenue")).deploy(await token.getAddress(), 1n);
      await governor.connect(owner).registerAgent(operator.address, 86_400, "ipfs://cato", { value: 10n * ONE });
      await governor.connect(owner).setPolicy(1, EXECUTION, 5n * ONE, 2n * ONE);
      await governor.connect(owner).setPolicy(1, Category.DATA, ONE, ONE);
      await governor.connect(owner).setVenue(1, await venue.getAddress(), true);
      await governor.connect(owner).setInstrument(1, await token.getAddress(), true);
      const agent = new QuaestorAgent({
        rpcUrl: "unused",
        signer: operator,
        quaestorAddress: await governor.getAddress(),
        governorVersion: 2,
        logAddress: await log.getAddress(),
        receiptDir: require("node:os").tmpdir(),
      });
      return { governor, log, token, venue, agent, owner, operator, stranger };
    }

    const meta = (action: string, extra: Record<string, unknown> = {}): DecisionMeta => ({
      agent: "Cato", action, rationale: "test", inputs: extra, timestamp: new Date().toISOString(),
    });
    const buy = (to: string) => new ethers.Interface(["function buy(address to)"]).encodeFunctionData("buy", [to]);

    it("swaps through a venue, reads what arrived from the receipt, and publishes the record behind it", async () => {
      const { agent, log, venue, token, owner } = await deploy();
      const record = meta("dca-buy");
      const result = await agent.swapThrough(1n, await venue.getAddress(), buy(owner.address), await token.getAddress(), ONE, ONE, record);

      expect(result.amountOut).to.equal(ONE);
      expect(result.recordTx).to.be.a("string");
      // The record on chain hashes to exactly what the Receipt committed.
      const published = (await ethers.provider.getTransactionReceipt(result.recordTx!))!.logs
        .map((l) => log.interface.parseLog(l)).find((p) => p?.name === "Published")!;
      expect(published.args.metaHash).to.equal(result.metaHash);
      expect(published.args.metaHash).to.equal(metaHashOf(record));
      expect(ethers.toUtf8String(published.args.record)).to.equal(JSON.stringify(record));
    });

    it("never publishes a record that looks like it carries a credential, and says why", async () => {
      const { agent, venue, token, owner } = await deploy();
      const result = await agent.swapThrough(
        1n, await venue.getAddress(), buy(owner.address), await token.getAddress(), ONE, ONE,
        meta("dca-buy", { leaked: "glpat-abcdefghij0123456789" }),
      );
      // The spend still happened: a record's fate never undoes a trade.
      expect(result.amountOut).to.equal(ONE);
      expect(result.recordTx).to.equal(undefined);
      expect(result.recordSkipped).to.contain("GitLab");
    });

    it("refuses the original governor's swap on a V2, and V2's swap on the original", async () => {
      const { agent } = await deploy();
      await agent.swap(1n, ONE, ONE, ethers.ZeroAddress, meta("x")).then(
        () => expect.fail("should have refused"),
        (error: Error) => expect(error.message).to.contain("swapThrough"),
      );
    });

    it("pays a service and publishes the record, and verifyReceipt reads V2's indexed payee", async () => {
      const { agent, governor, stranger } = await deploy();
      const result = await agent.pay(1n, Category.DATA, stranger.address, ONE / 10n, meta("buy-signal"));
      expect(result.recordTx).to.be.a("string");

      const address = await governor.getAddress();
      const v2 = await verifyReceipt(ethers.provider, address, result.txHash, { payee: stranger.address, minAmountWei: 1n, version: 2 });
      expect(v2.ok).to.equal(true);
      expect(v2.amount).to.equal(ONE / 10n);
      // Read as the original governor, the same receipt does not find the payee.
      const v1 = await verifyReceipt(ethers.provider, address, result.txHash, { payee: stranger.address, minAmountWei: 1n, version: 1 });
      expect(v1.ok).to.equal(false);
    });

    it("decodes V2's refusals by name", async () => {
      const { agent, venue, token, owner } = await deploy();
      const error = await agent.swapThrough(1n, await venue.getAddress(), buy(owner.address), await token.getAddress(), 3n * ONE, ONE, meta("too-big"))
        .then(() => null, (e: unknown) => e);
      expect(decodeQuaestorError(error)).to.match(/^PerCallCapExceeded\(3\.0, 2\.0\)$/);

      const thief = await (await ethers.getContractFactory("ThievingVenue")).deploy(await token.getAddress());
      const governor = await ethers.getContractAt("QuaestorV2", await agent.quaestor.getAddress());
      await governor.connect(owner).setVenue(1, await thief.getAddress(), true);
      const stolen = await agent.swapThrough(1n, await thief.getAddress(), buy(owner.address), await token.getAddress(), ONE, ONE, meta("thief"))
        .then(() => null, (e: unknown) => e);
      expect(decodeQuaestorError(stolen)).to.match(/^MinimumOutputNotMet/);
    });

    it("publishes nothing when a spend is refused, since no Receipt would point at it", async () => {
      const { agent, log, venue, token, owner } = await deploy();
      const before = await ethers.provider.getLogs({ address: await log.getAddress(), fromBlock: 0 });
      await agent.swapThrough(1n, await venue.getAddress(), buy(owner.address), await token.getAddress(), 3n * ONE, ONE, meta("refused"))
        .catch(() => undefined);
      const after = await ethers.provider.getLogs({ address: await log.getAddress(), fromBlock: 0 });
      expect(after.length).to.equal(before.length);
    });
  });
});
