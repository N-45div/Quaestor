import { expect } from "chai";
import { decisionHash, StockGovernor } from "../stocks";
import type { JupiterQuote, StockTradeIntent } from "../stocks";

const OWNER = "owner:solana";
const OPERATOR = "operator:solana";
const USDC = "USDC_MINT";
const AAPL = "AAPL_MINT";

function setup() {
  let now = 1_700_000_000;
  const instrument = {
    symbol: "AAPL.US",
    issuer: "backpack-securities",
    mint: AAPL,
    usdcMint: USDC,
    decimals: 6,
    enabled: true,
  };
  const governor = new StockGovernor({
    owner: OWNER,
    operator: OPERATOR,
    usdcMint: USDC,
    instruments: [instrument],
    policy: {
      epochCapUsdc: 100n,
      perTradeCapUsdc: 60n,
      epochLengthSeconds: 3600,
      approvedMints: new Set([AAPL]),
    },
    now: () => now,
  });
  governor.depositUsdc(OWNER, 250n);
  const intentBase = {
    intentId: "intent-1",
    agentId: "agent-1",
    operator: OPERATOR,
    instrumentMint: AAPL,
    inputMint: USDC,
    amountInUsdc: 50n,
    minOutput: 4n,
    quoteId: "quote-1",
    quoteExpiresAt: now + 30,
  };
  const intent: StockTradeIntent = { ...intentBase, decisionHash: decisionHash(intentBase) };
  const quote: JupiterQuote = {
    quoteId: "quote-1",
    inputMint: USDC,
    outputMint: AAPL,
    inAmount: 50n,
    outAmount: 5n,
    route: "jupiter-route-1",
    expiresAt: now + 30,
  };
  return { governor, intent, quote, advance: (seconds: number) => { now += seconds; } };
}

describe("Solana stocks governor — Day 1", () => {
  it("executes an approved trade and commits an auditable receipt", async () => {
    const { governor, intent, quote } = setup();
    const receipt = await governor.execute(intent, quote, {
      execute: async () => ({ txSignature: "solana-tx-1", actualOutput: 5n }),
    });
    expect(receipt.decisionHash).to.equal(intent.decisionHash);
    expect(receipt.txSignature).to.equal("solana-tx-1");
    expect(receipt.spentAfter).to.equal(50n);
    expect(governor.status().usdcBalance).to.equal(200n);
    expect(governor.receipt(intent.intentId)).to.deep.equal(receipt);
  });

  it("refuses an over-budget trade before the chain executor is called", async () => {
    const { governor, intent, quote } = setup();
    const oversized = { ...intent, amountInUsdc: 61n };
    let called = false;
    try {
      await governor.execute(oversized, { ...quote, inAmount: 61n }, {
        execute: async () => { called = true; return { txSignature: "never", actualOutput: 6n }; },
      });
      expect.fail("expected cap refusal");
    } catch (error) {
      expect((error as Error).name).to.equal("StockRefusal");
      expect((error as { code: string }).code).to.equal("PER_TRADE_CAP_EXCEEDED");
    }
    expect(called).to.equal(false);
    expect(governor.status().usdcBalance).to.equal(250n);
  });

  it("refuses stale or mismatched Jupiter quotes", async () => {
    const { governor, intent, quote, advance } = setup();
    advance(31);
    await expect(governor.execute(intent, quote, { execute: async () => ({ txSignature: "never", actualOutput: 5n }) }))
      .to.be.rejectedWith("Jupiter quote has expired");
  });

  it("refuses a quote whose output cannot satisfy the requested minimum", async () => {
    const { governor, intent, quote } = setup();
    await expect(governor.execute(intent, { ...quote, outAmount: 3n }, {
      execute: async () => ({ txSignature: "never", actualOutput: 5n }),
    })).to.be.rejectedWith("quoted output is below the intent minimum");
  });

  it("supports owner pause, replay protection and withdrawal", async () => {
    const { governor, intent, quote } = setup();
    governor.suspend(OWNER);
    await expect(governor.execute(intent, quote, { execute: async () => ({ txSignature: "never", actualOutput: 5n }) }))
      .to.be.rejectedWith("stock agent is suspended");
    governor.resume(OWNER);
    await governor.execute(intent, quote, { execute: async () => ({ txSignature: "solana-tx-2", actualOutput: 5n }) });
    await expect(governor.execute(intent, quote, { execute: async () => ({ txSignature: "never", actualOutput: 5n }) }))
      .to.be.rejectedWith("intent was already executed");
    governor.withdrawUsdc(OWNER, 200n);
    expect(governor.status().usdcBalance).to.equal(0n);
  });
});
