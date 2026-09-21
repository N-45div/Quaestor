import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Keypair } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  DEVNET,
  MAX_SLIPPAGE_BPS,
  amountOf,
  checkFlags,
  commitDecision,
  keygen,
  loadKey,
  reasonOf,
  refusalFromLogs,
  registerUrl,
  run,
  slippageOf,
} from "../cli/quaestor-sol";

/**
 * The Solana agent command, where it does not need a chain: what it accepts,
 * what it refuses before asking the program, how it reads a refusal out of
 * the logs, and the hashes it commits, which must be the hub's own scheme.
 */
describe("cli — the Solana agent's command", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "quaestor-sol-"));

  it("takes only its own flags, and a dry run only as a bare flag", () => {
    expect(() => checkFlags("buy", { usdc: "1", dryrun: "true" })).to.throw(/does not take --dryrun/);
    expect(() => checkFlags("buy", { "dry-run": "no" })).to.throw(/takes no value/);
    expect(() => checkFlags("quote", { governor: "x" })).to.throw(/does not take --governor/);
    expect(() => checkFlags("sell", {})).to.throw(/unknown command/);
    checkFlags("buy", { usdc: "1", reason: "x", "dry-run": "true", "min-out": "0.003", governor: "g", "slippage-bps": "50" });
  });

  it("reads six-decimal amounts exactly, and refuses anything else", () => {
    expect(amountOf({ usdc: "1" }, "usdc")).to.equal(1_000_000n);
    expect(amountOf({ usdc: "0.000001" }, "usdc")).to.equal(1n);
    expect(amountOf({ usdc: "2.5" }, "usdc")).to.equal(2_500_000n);
    expect(() => amountOf({ usdc: "0" }, "usdc")).to.throw(/more than zero/);
    expect(() => amountOf({ usdc: "1.0000001" }, "usdc")).to.throw(/at most 6 decimals/);
    expect(() => amountOf({ usdc: "1,000" }, "usdc")).to.throw(/amount such as/);
    expect(() => amountOf({}, "usdc")).to.throw(/--usdc is required/);
  });

  it("will not widen the slippage past the ceiling", () => {
    expect(slippageOf({})).to.equal(100);
    expect(() => slippageOf({ "slippage-bps": String(MAX_SLIPPAGE_BPS + 1) })).to.throw(/at most/);
  });

  it("refuses a reason carrying the agent's own key", () => {
    const key = Keypair.generate();
    expect(reasonOf({ reason: " buy the dip " }, key)).to.equal("buy the dip");
    expect(() => reasonOf({ reason: `backup ${JSON.stringify([...key.secretKey])}` }, key)).to.throw(/contains this agent's key/);
    expect(() => reasonOf({})).to.throw(/--reason is required/);
  });

  it("writes a key only the user reads, never replaces one, and refuses while one is in the environment", () => {
    const file = path.join(tmp(), "k", "solana-operator.json");
    const address = keygen(file, {});
    expect(loadKey(file, {}).publicKey.equals(address)).to.equal(true);
    expect(() => keygen(file, {})).to.throw(/not replaced/);
    expect(() => keygen(path.join(tmp(), "other.json"), { QUAESTOR_SOLANA_KEY: "[1]" })).to.throw(/QUAESTOR_SOLANA_KEY is set/);
    expect(() => loadKey(path.join(tmp(), "none.json"), {})).to.throw(/keygen/);
  });

  it("builds the owner's register link with the numbers agreed, checked", () => {
    const url = registerUrl(DEVNET.app, "Dd2Gc6kiqEQjQHE5EcWDAamPazMQoyDQqq5hyyi2mftZ", { deposit: "50", "per-trade": "5", "epoch-cap": "25", epoch: "day" });
    const q = new URLSearchParams(url.split("?")[1]);
    expect(url).to.contain("/#/app/sol/register?");
    expect([q.get("operator"), q.get("deposit"), q.get("perTrade"), q.get("epochCap"), q.get("epoch")]).to.deep.equal(["Dd2Gc6kiqEQjQHE5EcWDAamPazMQoyDQqq5hyyi2mftZ", "50", "5", "25", "86400"]);
    expect(() => registerUrl(DEVNET.app, "x", { "per-trade": "30", "epoch-cap": "25" })).to.throw(/larger than/);
    expect(() => registerUrl(DEVNET.app, "x", { epoch: "month" })).to.throw(/hour, day or week/);
  });

  it("reads a refusal out of the program's logs, and nothing out of logs without one", () => {
    const logs = [
      "Program 7whS... invoke [1]",
      "Program log: AnchorError caused by account: governor. Error Code: PerTradeCapExceeded. Error Number: 6006. Error Message: trade exceeds the per-trade cap.",
      "Program 7whS... failed: custom program error: 0x1776",
    ];
    expect(refusalFromLogs(logs)).to.deep.equal({ code: "PerTradeCapExceeded", detail: "PerTradeCapExceeded: trade exceeds the per-trade cap." });
    expect(refusalFromLogs(["Program log: Instruction: Swap"])).to.equal(null);
    expect(refusalFromLogs(undefined)).to.equal(null);
  });

  it("commits the record by the hub's scheme: keccak256 of its JSON, and of the intent that names it", () => {
    const record = { agent: "agent-x", action: "buy", rationale: "dip", timestamp: "2026-09-22T00:00:00.000Z" };
    const intent = { intentId: "0x" + "11".repeat(32), governor: "g", instrumentMint: DEVNET.curveMint, amountIn: 1_000_000n, minOutput: 3_042n };
    const a = commitDecision(record, intent);
    const expected = "0x" + Buffer.from(keccak_256(new TextEncoder().encode(JSON.stringify(record)))).toString("hex");
    expect(a.decisionRecordHash).to.equal(expected);
    expect(commitDecision(record, intent)).to.deep.equal(a);
    expect(commitDecision(record, { ...intent, minOutput: 3_043n }).decisionHash).to.not.equal(a.decisionHash);
  });

  it("answers every mistake as JSON before it touches the chain", async () => {
    const env = { QUAESTOR_SOLANA_KEY_FILE: path.join(tmp(), "none.json"), QUAESTOR_SOLANA_RPC_URL: "http://127.0.0.1:9" };
    const wide = await run(["buy", "--usdc", "1", "--reason", "x", "--slippage-bps", "900"], env);
    expect(wide).to.deep.include({ code: 1 });
    expect(wide.out).to.include({ error: "SLIPPAGE_TOO_WIDE" });
    expect((await run(["buy", "--usdc", "1", "--reason", "x"], env)).out).to.include({ error: "NO_KEY" });
    expect((await run(["help"], env)).out).to.be.a("string").and.contain("buy --usdc");
  });
});
