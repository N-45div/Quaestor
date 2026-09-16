import { expect } from "chai";
import { ethers } from "ethers";
import express from "express";
import type { Server } from "node:http";
import { QuaestorStocksApiError, QuaestorStocksClient } from "../sdk";
import { runLlmStockAgent, type StockPlanner } from "../agent/stocks-llm";
import { runRulesBasedStockAgent } from "../agent/stocks-rules";
import { mountStocks } from "../services/stocks";
import { mountServiceCors } from "../services/cors";
import {
  SOLANA_USDC_MINT,
  StockGovernor,
  StockPlatform,
  VERIFIED_XSTOCKS,
  type JupiterQuoteFetcher,
  type StockInstrument,
  type StockMarketAssessment,
  type StockMarketGuard,
  type StockOrderRequest,
} from "../stocks";

describe("Quaestor Stocks agent API — Days 2–4", () => {
  const nowSeconds = 1_700_000_000;
  const aapl = VERIFIED_XSTOCKS[0];
  const nvda = VERIFIED_XSTOCKS[1];
  const openAi: StockInstrument = {
    symbol: "OPENAI",
    name: "OpenAI",
    issuer: "PreStocks",
    provider: "prestocks",
    assetClass: "private-company-exposure",
    executionStatus: "discovery-only",
    mint: "11111111111111111111111111111111",
    usdcMint: SOLANA_USDC_MINT,
    decimals: 9,
    enabled: false,
    network: "solana-mainnet",
    rightsNotice: "Economic exposure only.",
  };
  let server: Server;
  let baseUrl: string;
  let executions = 0;
  let blockedMarketMint: string | undefined;

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
          credentials: [{ token: "llm-token-is-strong", allowedMints: new Set(VERIFIED_XSTOCKS.map((instrument) => instrument.mint)) }],
        },
      ],
      quotes,
      executor: {
        execute: async (_intent, quote) => {
          executions += 1;
          return { txSignature: `solana-test-${executions}`, actualOutput: quote.outAmount, outcome: "settled" };
        },
      },
      marketGuard: marketGuard(),
      instrumentSources: [
        { provider: "prestocks", instruments: async () => [openAi] },
        { provider: "offline-provider", instruments: async () => { throw new Error("provider timed out"); } },
      ],
      now: () => nowSeconds,
    });
    const app = express();
    mountServiceCors(app);
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
    expect(rulesOrder?.decision_record.strategy).to.equal("discount-and-volatility");
    expect(rulesOrder?.decision_record.rationale).to.include("discount 75bps");
    expect(rulesOrder?.decision_record.market_evidence?.evidence_hash).to.equal(rulesOrder?.market?.evidence_hash);
    expect(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(rulesOrder?.decision_record))))
      .to.equal(rulesOrder?.decision_record_hash);
  });

  it("allows browser clients to send authenticated execution headers", async () => {
    const response = await fetch(`${baseUrl}/v1/stocks/orders`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://quaestor.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,idempotency-key,content-type",
      },
    });
    const allowed = response.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    expect(response.status).to.equal(204);
    expect(allowed).to.include("authorization");
    expect(allowed).to.include("idempotency-key");
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

  it("makes a pre-execution vault shortfall terminal without reconciliation", async () => {
    const underfundedGovernor = governor("operator:underfunded");
    underfundedGovernor.withdrawUsdc("owner:operator:underfunded", 245_000_000n);
    let localExecutions = 0;
    const local = new StockPlatform({
      instruments: VERIFIED_XSTOCKS,
      agents: [{
        agentId: "underfunded-agent",
        operator: "operator:underfunded",
        governor: underfundedGovernor,
        credentials: [{ token: "underfunded-token-strong", allowedMints: new Set([aapl.mint]) }],
      }],
      quotes: {
        quote: async (inputMint, outputMint, amount) => ({
          quoteId: "underfunded-quote",
          inputMint,
          outputMint,
          inAmount: amount,
          outAmount: amount * 2n,
          minimumOutput: amount,
          route: "test-route",
          expiresAt: nowSeconds + 30,
        }),
      },
      executor: {
        execute: async (_intent, quote) => {
          localExecutions += 1;
          return { txSignature: "must-not-execute", actualOutput: quote.outAmount, outcome: "settled" };
        },
      },
      now: () => nowSeconds,
    });
    const quote = await local.createQuote("underfunded-agent", aapl.mint, "10000000");
    await expect(local.createQuote("underfunded-agent", aapl.mint, "10000000"))
      .to.be.rejectedWith("quote provider reused a previously issued quote identifier");
    const order = await local.execute(
      "underfunded-token-strong",
      "underfunded-request",
      makeOrder("underfunded-agent", quote.quote_id, "underfunded-intent"),
    );
    expect(order.status).to.equal("refused");
    expect(order.refusal?.code).to.equal("INVALID_AMOUNT");
    expect(localExecutions).to.equal(0);
    expect(underfundedGovernor.intentStatus("underfunded-intent")).to.equal(undefined);
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

  it("makes Pyth dislocation a structured pre-execution refusal", async () => {
    const client = new QuaestorStocksClient({ baseUrl, operatorToken: "llm-token-is-strong" });
    const spy = VERIFIED_XSTOCKS[2];
    blockedMarketMint = spy.mint;
    try {
      const market = await client.market(spy.mint);
      expect(market.refusal?.code).to.equal("PYTH_PRICE_DISLOCATION");
      const quote = await client.quote("llm-agent", spy.mint, 1_000_000n);
      expect(quote.market?.evidence_hash).to.equal(market.evidence_hash);
      const request = makeOrder("llm-agent", quote.quote_id, "pyth-dislocation");
      const preview = await client.preview(request);
      expect(preview.allowed).to.equal(false);
      expect(preview.refusal?.code).to.equal("PYTH_PRICE_DISLOCATION");
      const before = executions;
      const order = await client.execute(request);
      expect(order.status).to.equal("refused");
      expect(order.market?.provider).to.equal("pyth-pro");
      expect(executions).to.equal(before);
    } finally {
      blockedMarketMint = undefined;
    }
  });

  it("exposes public holdings and order evidence without a wallet", async () => {
    const publicClient = new QuaestorStocksClient({ baseUrl });
    const catalog = await publicClient.instrumentCatalog();
    const instruments = catalog.instruments;
    const portfolio = await publicClient.portfolio("llm-agent") as { holdings: { symbol: string }[] };
    expect(instruments.map((instrument) => instrument.symbol)).to.include.members(["AAPLx", "NVDAx", "SPYx", "OPENAI"]);
    expect(catalog.sources).to.deep.include({ provider: "prestocks", status: "ok", count: 1 });
    expect(catalog.sources).to.deep.include({ provider: "offline-provider", status: "unavailable", count: 0, error: "provider timed out" });
    expect(instruments.find((instrument) => instrument.symbol === "OPENAI")?.executionStatus).to.equal("discovery-only");
    expect(portfolio.holdings.map((holding) => holding.symbol)).to.include.members(["AAPLx", "NVDAx"]);
  });

  it("does not turn discovery-only private-market products into executable instruments", async () => {
    const client = new QuaestorStocksClient({ baseUrl, operatorToken: "llm-token-is-strong" });
    try {
      await client.quote("llm-agent", openAi.mint, 1_000_000n);
      expect.fail("expected discovery-only quote refusal");
    } catch (error) {
      expect(error).to.be.instanceOf(QuaestorStocksApiError);
      expect((error as QuaestorStocksApiError).status).to.equal(404);
      expect((error as QuaestorStocksApiError).code).to.equal("UNKNOWN_INSTRUMENT");
    }
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

  function marketGuard(): StockMarketGuard {
    return {
      assess: async (instrument) => assessment(instrument),
      revalidate: (value) => ({ ...value, refusal: value.refusal ? { ...value.refusal } : undefined }),
    };
  }

  function assessment(instrument: StockInstrument): StockMarketAssessment {
    const blocked = instrument.mint === blockedMarketMint;
    const point = (symbol: string) => ({
      feed_id: symbol.includes("Crypto") ? 2 : 1,
      symbol,
      mantissa: "20000000",
      exponent: -5,
      confidence: "1000",
      confidence_bps: 1,
      publisher_count: 4,
      market_session: "regular",
      feed_update_timestamp_us: String(nowSeconds * 1_000_000),
      age_ms: 0,
    });
    return {
      provider: "pyth-pro",
      instrument_mint: instrument.mint,
      observed_at: new Date(nowSeconds * 1000).toISOString(),
      timestamp_us: String(nowSeconds * 1_000_000),
      premium_bps: blocked ? 500 : 0,
      allowed: !blocked,
      refusal: blocked
        ? { code: "PYTH_PRICE_DISLOCATION", message: "tokenized price differs from the underlying by 500bps" }
        : undefined,
      policy: {
        max_feed_age_seconds: 30,
        max_absolute_premium_bps: 300,
        max_confidence_bps: 100,
        min_publishers: 2,
      },
      feeds: {
        underlying: point(`Equity.US.${instrument.underlyingSymbol}/USD`),
        tokenized: point(`Crypto.${instrument.symbol.toUpperCase()}/USD`),
      },
      solana_payload_hash: "11".repeat(32),
      evidence_hash: "22".repeat(32),
    };
  }
});
