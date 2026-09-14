import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import { QuaestorStocksApiError, QuaestorStocksClient } from "../sdk";
import { runLlmStockAgent, type StockPlanner } from "../agent/stocks-llm";
import { runRulesBasedStockAgent } from "../agent/stocks-rules";
import { mountStocks } from "../services/stocks";
import {
  SOLANA_USDC_MINT,
  StockGovernor,
  StockPlatform,
  VERIFIED_XSTOCKS,
  type JupiterQuoteFetcher,
  type StockOrderRequest,
} from "../stocks";

describe("Quaestor Stocks agent API — Day 2", () => {
  const nowSeconds = 1_700_000_000;
  const aapl = VERIFIED_XSTOCKS[0];
  const nvda = VERIFIED_XSTOCKS[1];
  let server: Server;
  let baseUrl: string;
  let executions = 0;

  const governor = (operator: string) => {
    const instance = new StockGovernor({
      owner: `owner:${operator}`,
      operator,
      usdcMint: SOLANA_USDC_MINT,
      instruments: [...VERIFIED_XSTOCKS],
      policy: {
        perTradeCapUsdc: 60_000_000n,
        epochCapUsdc: 100_000_000n,
        epochLengthSeconds: 3600,
        approvedMints: new Set(VERIFIED_XSTOCKS.map((instrument) => instrument.mint)),
      },
      now: () => nowSeconds,
    });
    instance.depositUsdc(`owner:${operator}`, 250_000_000n);
    return instance;
  };

  before(async () => {
    let sequence = 0;
    const quotes: JupiterQuoteFetcher = {
      quote: async (inputMint, outputMint, amount) => ({
        quoteId: `quote-${++sequence}-${outputMint}`,
        inputMint,
        outputMint,
        inAmount: amount,
        outAmount: amount * 2n,
        minimumOutput: (amount * 198n) / 100n,
        route: "Jupiter / test-liquidity",
        expiresAt: nowSeconds + 30,
      }),
    };
    const platform = new StockPlatform({
      instruments: VERIFIED_XSTOCKS,
      agents: [
        {
          agentId: "rules-agent",
          operator: "operator:rules",
          governor: governor("operator:rules"),
          credentials: [{ token: "rules-token-strong", allowedMints: new Set([aapl.mint]) }],
        },
        {
          agentId: "llm-agent",
          operator: "operator:llm",
          governor: governor("operator:llm"),
          credentials: [{ token: "llm-token-is-strong", allowedMints: new Set([aapl.mint, nvda.mint]) }],
        },
      ],
      quotes,
      executor: {
        execute: async (_intent, quote) => {
          executions += 1;
          return { txSignature: `solana-test-${executions}`, actualOutput: quote.outAmount, outcome: "settled" };
        },
      },
      now: () => nowSeconds,
    });
    const app = express();
    mountStocks(app, platform);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("lets rules and LLM agents use the same quote-preview-execute contract", async () => {
    const rulesClient = new QuaestorStocksClient({ baseUrl, operatorToken: "rules-token-strong" });
    const llmClient = new QuaestorStocksClient({ baseUrl, operatorToken: "llm-token-is-strong" });
    const rulesOrder = await runRulesBasedStockAgent(rulesClient, "rules-agent", aapl.mint, 10_000_000n, {
      discountBps: 75,
      volatilityBps: 200,
    });
    const planner: StockPlanner = {
      plan: async () => ({ symbol: "NVDAx", amount_usdc: "12.5", rationale: "Momentum is positive while position size stays below the configured risk budget." }),
    };
    const llmOrder = await runLlmStockAgent(
      llmClient,
      planner,
      "llm-agent",
      [{ symbol: "AAPLx", mint: aapl.mint }, { symbol: "NVDAx", mint: nvda.mint }],
      { momentum_bps: 120 },
    );
    expect(rulesOrder?.status).to.equal("settled");
    expect(llmOrder?.status).to.equal("settled");
    expect(rulesOrder?.receipt?.decision_record_hash).to.match(/^0x[0-9a-f]{64}$/);
    expect(llmOrder?.receipt?.decision_record_hash).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("returns a structured cap refusal without invoking the executor", async () => {
    const client = new QuaestorStocksClient({ baseUrl, operatorToken: "rules-token-strong" });
    const quote = await client.quote("rules-agent", aapl.mint, 61_000_000n);
    const before = executions;
    const refused = await client.execute(makeOrder("rules-agent", quote.quote_id, "over-budget-order"));
    expect(refused.status).to.equal("refused");
    expect(refused.refusal?.code).to.equal("PER_TRADE_CAP_EXCEEDED");
    expect(executions).to.equal(before);
  });

  it("makes a retried idempotency key return the original order exactly once", async () => {
    const client = new QuaestorStocksClient({ baseUrl, operatorToken: "llm-token-is-strong" });
    const quote = await client.quote("llm-agent", aapl.mint, 5_000_000n);
    const request = makeOrder("llm-agent", quote.quote_id, "same-intent-123");
    const before = executions;
    const first = await client.execute(request, "same-request-123");
    const replay = await client.execute(request, "same-request-123");
    const replayWithNewKey = await client.execute(request, "same-request-456");
    expect(replay).to.deep.equal(first);
    expect(replayWithNewKey).to.deep.equal(first);
    expect(executions).to.equal(before + 1);

    try {
      await client.execute({ ...request, decision: { ...request.decision, rationale: "A different decision must not overwrite the original intent." } }, "same-request-789");
      expect.fail("expected intent conflict");
    } catch (error) {
      expect(error).to.be.instanceOf(QuaestorStocksApiError);
      expect((error as QuaestorStocksApiError).code).to.equal("INTENT_CONFLICT");
    }
  });

  it("enforces credential mint scope and rejects expired intents", async () => {
    const client = new QuaestorStocksClient({ baseUrl, operatorToken: "rules-token-strong" });
    const nvdaQuote = await client.quote("rules-agent", nvda.mint, 1_000_000n);
    try {
      await client.execute(makeOrder("rules-agent", nvdaQuote.quote_id, "scope-violation"));
      expect.fail("expected scope refusal");
    } catch (error) {
      expect(error).to.be.instanceOf(QuaestorStocksApiError);
      expect((error as QuaestorStocksApiError).status).to.equal(403);
      expect((error as QuaestorStocksApiError).code).to.equal("OPERATOR_SCOPE_VIOLATION");
    }

    const aaplQuote = await client.quote("rules-agent", aapl.mint, 1_000_000n);
    const expired = makeOrder("rules-agent", aaplQuote.quote_id, "expired-intent");
    expired.intent_expires_at = new Date((nowSeconds - 1) * 1000).toISOString();
    const preview = await client.preview(expired);
    expect(preview.allowed).to.equal(false);
    expect(preview.refusal?.code).to.equal("INTENT_EXPIRED");
  });

  it("exposes public holdings and order evidence without a wallet", async () => {
    const publicClient = new QuaestorStocksClient({ baseUrl });
    const instruments = await publicClient.instruments();
    const portfolio = await publicClient.portfolio("llm-agent") as { holdings: { symbol: string }[] };
    expect(instruments.map((instrument) => instrument.symbol)).to.include.members(["AAPLx", "NVDAx", "SPYx"]);
    expect(portfolio.holdings.map((holding) => holding.symbol)).to.include.members(["AAPLx", "NVDAx"]);
  });

  function makeOrder(agentId: string, quoteId: string, intentId: string): StockOrderRequest {
    return {
      agent_id: agentId,
      intent_id: intentId,
      quote_id: quoteId,
      intent_expires_at: new Date((nowSeconds + 20) * 1000).toISOString(),
      decision: { strategy: "test", rationale: "A deterministic test decision with enough context for a receipt." },
    };
  }
});
