import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ethers } from "ethers";
import {
  MAX_SLIPPAGE_BPS,
  budgetAmountOf,
  checkFlags,
  keygen,
  loadKey,
  networkFrom,
  reasonOf,
  refuseIfPending,
  registerUrl,
  run,
  settingsFrom,
  slippageOf,
  unitsOf,
} from "../cli/quaestor-evm";
import { GOVERNOR_ABI, MONAD_TESTNET, ROBINHOOD, commitDecision, fillPrice, refusalOfData } from "../sdk/evm-stocks";

/**
 * The EVM agent command, where it needs no chain: what it accepts, what it
 * refuses before asking the governor, how it reads a refusal out of revert
 * data in each amount's own units, and the decision hash it commits.
 */
describe("cli — the EVM agent's command", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "quaestor-evm-"));
  const errors = new ethers.Interface(GOVERNOR_ABI.filter((l) => l.startsWith("error ")));

  it("takes only its own flags, and a dry run only as a bare flag", () => {
    expect(() => checkFlags("buy", { stock: "AAPL", dryrun: "true" })).to.throw(/does not take --dryrun/);
    expect(() => checkFlags("buy", { "dry-run": "no" })).to.throw(/takes no value/);
    expect(() => checkFlags("quote", { reason: "x" })).to.throw(/does not take --reason/);
    expect(() => checkFlags("sell", {})).to.throw(/unknown command/);
    checkFlags("buy", { stock: "AAPL", usdg: "1", reason: "x", "dry-run": "true", "min-out": "0.01", governor: "0x", "slippage-bps": "50", network: "robinhood" });
  });

  it("reads amounts exactly in the budget's decimals, under the budget's own name", () => {
    expect(unitsOf("1", "usdg", 6)).to.equal(1_000_000n);
    expect(unitsOf("0.000001", "usdg", 6)).to.equal(1n);
    expect(() => unitsOf("0.0000001", "usdg", 6)).to.throw(/at most 6 decimals/);
    expect(() => unitsOf("1,000", "usdg", 6)).to.throw(/amount such as/);
    expect(() => unitsOf("0", "usdg", 6)).to.throw(/more than zero/);
    expect(budgetAmountOf({ usdg: "5" }, ROBINHOOD).units).to.equal(5_000_000n);
    expect(budgetAmountOf({ amount: "5" }, ROBINHOOD).units).to.equal(5_000_000n);
    expect(() => budgetAmountOf({ usdc: "5" }, ROBINHOOD)).to.throw(/budget on Robinhood Chain is USDG/);
    expect(() => budgetAmountOf({ usdg: "5", amount: "5" }, ROBINHOOD)).to.throw(/give the amount once/);
    expect(budgetAmountOf({ usdc: "2" }, MONAD_TESTNET).units).to.equal(2_000_000n);
  });

  it("refuses a slippage too wide to protect anything", () => {
    expect(slippageOf({})).to.equal(100);
    expect(() => slippageOf({ "slippage-bps": String(MAX_SLIPPAGE_BPS + 1) })).to.throw(/at most/);
    expect(() => slippageOf({ "slippage-bps": "0" })).to.throw(/at least 1/);
  });

  it("needs a reason, and never one holding the key", () => {
    const key = ethers.Wallet.createRandom().privateKey;
    expect(() => reasonOf({})).to.throw(/--reason is required/);
    expect(() => reasonOf({ reason: "x".repeat(501) })).to.throw(/at most 500/);
    expect(() => reasonOf({ reason: `buy with ${key.slice(2)}` }, key)).to.throw(/contains this agent's key/);
    expect(reasonOf({ reason: " buy AAPL " }, key)).to.equal("buy AAPL");
  });

  it("builds the owner's link with only the numbers and stocks it can check", () => {
    const s = settingsFrom({}, {});
    const url = registerUrl(s, "0x0000000000000000000000000000000000000001", { deposit: "20", "per-trade": "5", "epoch-cap": "20", epoch: "day", stocks: "aapl,NVDA", limit: "AAPL=375" });
    expect(url).to.match(/#\/app\/evm\/robinhood\/register\?/);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("deposit")).to.equal("20");
    expect(q.get("epoch")).to.equal("86400");
    expect(q.get("stocks")).to.equal("AAPL,NVDA");
    expect(q.get("limit")).to.equal("AAPL=375");
    expect(() => registerUrl(s, "0x1", { stocks: "GME" })).to.throw(/not a Stock Token/);
    expect(() => registerUrl(s, "0x1", { limit: "AAPL" })).to.throw(/SYMBOL=price/);
    expect(() => registerUrl(s, "0x1", { "per-trade": "30", "epoch-cap": "20" })).to.throw(/larger than/);
    expect(() => registerUrl(s, "0x1", { epoch: "month" })).to.throw(/hour, day or week/);
  });

  it("reads a network from the table or a file, and refuses one it does not know", () => {
    expect(networkFrom({}, {}).chainId).to.equal(4663);
    expect(networkFrom({ network: "monad-testnet" }, {}).chainId).to.equal(10143);
    expect(() => networkFrom({ network: "base" }, {})).to.throw(/must be one of/);
    const dir = tmp();
    const file = path.join(dir, "n.json");
    fs.writeFileSync(file, JSON.stringify({ ...ROBINHOOD, name: "local", factory: "0x0000000000000000000000000000000000000002" }));
    expect(networkFrom({}, { QUAESTOR_EVM_NETWORK_FILE: file }).name).to.equal("local");
  });

  it("makes a key once, never prints it, and will not replace it", () => {
    const file = path.join(tmp(), "k", "evm.key");
    const address = keygen(file, {});
    expect(ethers.isAddress(address)).to.equal(true);
    expect(new ethers.Wallet(loadKey(file, {})).address).to.equal(address);
    expect(() => keygen(file, {})).to.throw(/already holds a key/);
    expect(() => keygen(path.join(tmp(), "x.key"), { QUAESTOR_EVM_KEY: "0x" + "11".repeat(32) })).to.throw(/QUAESTOR_EVM_KEY is set/);
    expect(() => loadKey(path.join(tmp(), "none.key"), {})).to.throw(/run "keygen" first/);
  });

  it("reads each refusal in its own units: money in USDG, output in shares, prices a share", () => {
    const cap = refusalOfData(errors.encodeErrorResult("PerTradeCapExceeded", [6_000_000n, 5_000_000n]));
    expect(cap).to.deep.equal({ code: "PerTradeCapExceeded", detail: "PerTradeCapExceeded: amount=6.0, cap=5.0" });
    const short = refusalOfData(errors.encodeErrorResult("MinimumOutputNotMet", [10n ** 15n, 2n * 10n ** 15n]));
    expect(short!.detail).to.equal("MinimumOutputNotMet: received=0.001, minimum=0.002");
    const hijacked = refusalOfData(errors.encodeErrorResult("PriceAboveLimit", [1_000_000n, 989_998_669_948n, 370_000_000n]));
    expect(hijacked!.detail).to.equal("PriceAboveLimit: spent=1.0, received=0.000000989998669948, maxPrice=370.0");
    const oracle = refusalOfData(errors.encodeErrorResult("FillAboveOracle", [412_000_000n, 340_430_000n, 100]));
    expect(oracle!.detail).to.equal("FillAboveOracle: fillPrice=412.0, oraclePrice=340.43, maxDeviationBps=100");
    const venue = refusalOfData(errors.encodeErrorResult("VenueCallFailed", [new ethers.Interface(["error Error(string)"]).encodeErrorResult("Error", ["Too little received"])]));
    expect(venue!.detail).to.equal("VenueCallFailed: Too little received");
    expect(refusalOfData("0xdeadbeef")).to.equal(null);
  });

  it("prices a fill per whole share, and hashes the decision it commits to", () => {
    expect(fillPrice(5_000_000n, 14_664_211_616_027_710n, 18)).to.equal(340_966_165n);
    expect(fillPrice(1n, 0n, 18)).to.equal(0n);
    const { text, decisionHash } = commitDecision({ reason: "buy AAPL", spend: "5000000" });
    expect(decisionHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes(text)));
  });

  it("will not start a buy while an earlier one is unsettled", () => {
    const dir = tmp();
    const s = settingsFrom({ "key-file": path.join(dir, "evm.key") }, {});
    expect(refuseIfPending(s)).to.equal(null);
    fs.writeFileSync(path.join(dir, "evm-robinhood-pending.json"), JSON.stringify({ hash: "0xabc" }));
    expect(refuseIfPending(s)!.error).to.equal("PENDING_BUY");
  });

  it("answers help, and an unknown command, without a chain", async () => {
    expect((await run(["help"], {})).out).to.match(/quaestor-evm/);
    const bad = await run(["sell"], {});
    expect(bad.code).to.equal(1);
    expect((bad.out as { error: string }).error).to.equal("UNKNOWN_COMMAND");
  });
});
