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
  const config = {
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
  };
  const governor = new StockGovernor(config);
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
  return { governor, config, intent, quote, advance: (seconds: number) => { now += seconds; }, time: () => now };
}

describe("Solana stocks governor — Day 1", () => {
  it("executes an approved trade and commits an auditable receipt", async () => {
    const { governor, intent, quote } = setup();
    const receipt = await governor.execute(intent, quote, {
      execute: async () => ({ txSignature: "solana-tx-1", actualOutput: 5n, outcome: "settled" as const }),
    });
    expect(receipt.decisionHash).to.equal(intent.decisionHash);
    expect(receipt.txSignature).to.equal("solana-tx-1");
    expect(receipt.spentAfter).to.equal(50n);
    expect(governor.status().usdcBalance).to.equal(200n);
    expect(governor.receipt(intent.intentId)).to.deep.equal(receipt);
  });

  it("refuses an over-budget trade before the chain executor is called", async () => {
    const { governor, intent, quote } = setup();
    const oversizedBase = { ...intent, amountInUsdc: 61n };
    const oversized = { ...oversizedBase, decisionHash: decisionHash(oversizedBase) };
    let called = false;
    try {
      await governor.execute(oversized, { ...quote, inAmount: 61n }, {
        execute: async () => { called = true; return { txSignature: "never", actualOutput: 6n, outcome: "settled" as const }; },
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
    await expect(governor.execute(intent, quote, { execute: async () => ({ txSignature: "never", actualOutput: 5n, outcome: "settled" as const }) }))
      .to.be.rejectedWith("Jupiter quote has expired");
  });

  it("refuses a quote whose output cannot satisfy the requested minimum", async () => {
    const { governor, intent, quote } = setup();
    await expect(governor.execute(intent, { ...quote, outAmount: 3n }, {
      execute: async () => ({ txSignature: "never", actualOutput: 5n, outcome: "settled" as const }),
    })).to.be.rejectedWith("quoted output is below the intent minimum");
  });

  it("supports owner pause, replay protection and withdrawal", async () => {
    const { governor, intent, quote } = setup();
    governor.suspend(OWNER);
    await expect(governor.execute(intent, quote, { execute: async () => ({ txSignature: "never", actualOutput: 5n, outcome: "settled" as const }) }))
      .to.be.rejectedWith("stock agent is suspended");
    governor.resume(OWNER);
    await governor.execute(intent, quote, { execute: async () => ({ txSignature: "solana-tx-2", actualOutput: 5n, outcome: "settled" as const }) });
    await expect(governor.execute(intent, quote, { execute: async () => ({ txSignature: "never", actualOutput: 5n, outcome: "settled" as const }) }))
      .to.be.rejectedWith("intent was already executed");
    governor.withdrawUsdc(OWNER, 200n);
    expect(governor.status().usdcBalance).to.equal(0n);
  });

  it("reserves the epoch and rejects concurrent duplicate or oversubscribed intents", async () => {
    const { governor, intent, quote } = setup();
    let release!: (value: { txSignature: string; actualOutput: bigint; outcome: "settled" }) => void;
    const executor = { execute: () => new Promise<{ txSignature: string; actualOutput: bigint; outcome: "settled" }>((resolve) => { release = resolve; }) };
    const first = governor.execute(intent, quote, executor);
    await expect(governor.execute(intent, quote, executor)).to.be.rejectedWith("intent is already executing");
    const secondBase = { ...intent, intentId: "intent-2", quoteId: "quote-2", amountInUsdc: 60n };
    const second = { ...secondBase, decisionHash: decisionHash(secondBase) };
    const secondQuote = { ...quote, quoteId: "quote-2", inAmount: 60n };
    await expect(governor.execute(second, secondQuote, executor)).to.be.rejectedWith("trade exceeds the epoch cap");
    release({ txSignature: "solana-tx-1", actualOutput: 5n, outcome: "settled" });
    await first;
    expect(governor.status().spent).to.equal(50n);
  });

  it("freezes the intent snapshot and keeps ambiguous executor failures pending", async () => {
    const { governor, intent, quote } = setup();
    let release!: (value: { txSignature: string; actualOutput: bigint; outcome: "settled" }) => void;
    const pending = governor.execute(intent, quote, {
      execute: () => new Promise<{ txSignature: string; actualOutput: bigint; outcome: "settled" }>((resolve) => { release = resolve; }),
    });
    intent.amountInUsdc = 500n;
    release({ txSignature: "solana-tx-1", actualOutput: 5n, outcome: "settled" });
    await pending;
    expect(governor.status().spent).to.equal(50n);
    expect(governor.status().usdcBalance).to.equal(200n);

    const retry = { ...intent, amountInUsdc: 50n, decisionHash: decisionHash({ ...intent, amountInUsdc: 50n }) };
    await expect(governor.execute(retry, quote, { execute: async () => ({ txSignature: "never", actualOutput: 5n, outcome: "settled" as const }) }))
      .to.be.rejectedWith("intent was already executed");
  });

  it("uses a stable decision hash field order", () => {
    const { intent } = setup();
    const reordered = {
      quoteExpiresAt: intent.quoteExpiresAt,
      quoteId: intent.quoteId,
      minOutput: intent.minOutput,
      amountInUsdc: intent.amountInUsdc,
      inputMint: intent.inputMint,
      instrumentMint: intent.instrumentMint,
      operator: intent.operator,
      agentId: intent.agentId,
      intentId: intent.intentId,
    };
    expect(decisionHash(reordered)).to.equal(intent.decisionHash);
  });

  it("charges a pending trade to the epoch where it was authorized", async () => {
    const { governor, intent, quote, advance, time } = setup();
    let release!: (value: { txSignature: string; actualOutput: bigint; outcome: "settled" }) => void;
    const first = governor.execute(intent, quote, {
      execute: () => new Promise<{ txSignature: string; actualOutput: bigint; outcome: "settled" }>((resolve) => { release = resolve; }),
    });
    advance(3600);
    const secondBase = { ...intent, intentId: "intent-next-epoch", quoteId: "quote-next-epoch", amountInUsdc: 60n, quoteExpiresAt: time() + 30 };
    const second = { ...secondBase, decisionHash: decisionHash(secondBase) };
    const secondQuote = { ...quote, quoteId: "quote-next-epoch", inAmount: 60n, expiresAt: time() + 30 };
    const nextReceipt = await governor.execute(second, secondQuote, {
      execute: async () => ({ txSignature: "solana-tx-next", actualOutput: 9n, outcome: "settled" as const }),
    });
    release({ txSignature: "solana-tx-first", actualOutput: 5n, outcome: "settled" });
    const firstReceipt = await first;
    expect(firstReceipt.epoch).to.equal(nextReceipt.epoch - 1);
    expect(firstReceipt.spentAfter).to.equal(50n);
    expect(nextReceipt.spentAfter).to.equal(60n);
  });

  it("does not make an invalid settlement retryable", async () => {
    const { governor, intent, quote } = setup();
    const receipt = await governor.execute(intent, quote, {
      execute: async () => ({ txSignature: "solana-tx-bad", actualOutput: 3n, outcome: "settled" as const }),
    });
    expect(receipt.slippageSatisfied).to.equal(false);
    expect(receipt.outputAmount).to.equal(3n);
    expect(governor.intentStatus(intent.intentId)).to.equal("settled");
    expect(governor.status().spent).to.equal(50n);
    expect(governor.status().usdcBalance).to.equal(200n);
    await expect(governor.execute(intent, quote, {
      execute: async () => ({ txSignature: "must-not-run", actualOutput: 5n, outcome: "settled" as const }),
    })).to.be.rejectedWith("intent was already executed");
  });

  it("releases a confirmed non-execution without making the intent retryable", async () => {
    const { governor, intent, quote } = setup();
    await expect(governor.execute(intent, quote, {
      execute: async () => ({ txSignature: "solana-rejected", actualOutput: 0n, outcome: "not-executed" as const }),
    })).to.be.rejectedWith("chain confirmed that the trade did not execute");
    expect(governor.status().reservedBalance).to.equal(0n);
    expect(governor.status().usdcBalance).to.equal(250n);
    await expect(governor.execute(intent, quote, {
      execute: async () => ({ txSignature: "must-not-run", actualOutput: 5n, outcome: "settled" as const }),
    })).to.be.rejectedWith("intent already failed; create a new intent");
  });

  it("keeps a timeout pending until the owner reconciles chain state", async () => {
    const { governor, intent, quote } = setup();
    await expect(governor.execute(intent, quote, {
      execute: async () => { throw new Error("RPC timeout"); },
    })).to.be.rejectedWith("RPC timeout");
    expect(governor.intentStatus(intent.intentId)).to.equal("pending");
    await expect(governor.execute(intent, quote, {
      execute: async () => ({ txSignature: "must-not-run", actualOutput: 5n, outcome: "settled" as const }),
    })).to.be.rejectedWith("intent is already executing");
    const unresolved = await governor.reconcilePending(OWNER, intent.intentId, {
      resolve: async () => null,
    });
    expect(unresolved).to.equal(null);
    const resolved = await governor.reconcilePending(OWNER, intent.intentId, {
      resolve: async () => ({ txSignature: "solana-reconciled", actualOutput: 5n, outcome: "settled" as const }),
    });
    expect(resolved?.txSignature).to.equal("solana-reconciled");
    expect(governor.intentStatus(intent.intentId)).to.equal("settled");
  });

  it("makes concurrent reconciliation idempotent for identical evidence", async () => {
    const { governor, intent, quote } = setup();
    await expect(governor.execute(intent, quote, {
      execute: async () => { throw new Error("RPC timeout"); },
    })).to.be.rejectedWith("RPC timeout");
    const lookup = {
      resolve: async () => ({ txSignature: "solana-same", actualOutput: 5n, outcome: "settled" as const }),
    };
    const results = await Promise.all([
      governor.reconcilePending(OWNER, intent.intentId, lookup),
      governor.reconcilePending(OWNER, intent.intentId, lookup),
    ]);
    expect(results[0]?.txSignature).to.equal("solana-same");
    expect(results[1]?.txSignature).to.equal("solana-same");
    expect(governor.status().spent).to.equal(50n);
  });

  it("rejects conflicting reconciliation outcomes", async () => {
    const { governor, intent, quote } = setup();
    await expect(governor.execute(intent, quote, {
      execute: async () => { throw new Error("RPC timeout"); },
    })).to.be.rejectedWith("RPC timeout");
    await expect(governor.reconcilePending(OWNER, intent.intentId, {
      resolve: async () => ({ txSignature: "solana-rejected", actualOutput: 0n, outcome: "not-executed" as const }),
    })).to.be.rejectedWith("chain confirmed that the trade did not execute");
    await expect(governor.reconcilePending(OWNER, intent.intentId, {
      resolve: async () => ({ txSignature: "solana-late-fill", actualOutput: 5n, outcome: "settled" as const }),
    })).to.be.rejectedWith("intent is not pending reconciliation");
  });

  it("keeps authority fields immutable after construction", async () => {
    const { governor, config, intent, quote } = setup();
    config.owner = "replacement-owner";
    config.operator = "replacement-operator";
    await expect(governor.execute({ ...intent, operator: "replacement-operator" }, quote, {
      execute: async () => ({ txSignature: "must-not-run", actualOutput: 5n, outcome: "settled" as const }),
    })).to.be.rejectedWith("operator is not authorized");
    expect(() => governor.withdrawUsdc("replacement-owner", 1n)).to.throw("owner authorization required");
  });
});
