import express, { type Express, type Request } from "express";
import { z } from "zod";
import {
  JupiterV2QuoteProvider,
  BackpackMarketDiscovery,
  PythProStockSource,
  PythStockGuard,
  PreStocksRegistry,
  SOLANA_USDC_MINT,
  SolanaRpcMintVerifier,
  StockGovernor,
  StockPlatform,
  StockPlatformError,
  VERIFIED_XSTOCKS,
  type StockChainExecutor,
} from "../stocks";

const quoteRequestSchema = z.object({
  agent_id: z.string().min(1),
  instrument_mint: z.string().min(32),
  amount_in_usdc: z.string().regex(/^\d+$/),
  /** Omitted means the default venue, which keeps existing callers working. */
  venue: z.string().min(1).max(32).optional(),
});

const orderRequestSchema = z.object({
  agent_id: z.string().min(1),
  intent_id: z.string().min(8).max(128),
  quote_id: z.string().min(8),
  intent_expires_at: z.string().datetime({ offset: true }),
  decision: z.object({
    strategy: z.string().min(1).max(80),
    rationale: z.string().min(1).max(1000),
    model: z.string().max(120).optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }),
});

export function mountStocks(app: Express, platform: StockPlatform): void {
  const json = express.json({ limit: "32kb" });
  const route = (handler: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: express.Response) => {
    try {
      const body = await handler(req);
      const status = body && typeof body === "object" && "status" in body && body.status === "refused" ? 422 : 200;
      res.status(status).json(body);
    } catch (error) {
      sendStockError(res, error);
    }
  };

  app.get("/v1/stocks", route(() => platform.discovery()));
  app.get("/v1/stocks/instruments", route(() => platform.catalog()));
  app.get("/v1/stocks/backpack", route(() => platform.backpackAvailability()));
  // Which venues this deployment can quote. An agent should not have to guess
  // the name to put in a quote request, nor learn it from a 503.
  app.get("/v1/stocks/venues", route(() => ({ venues: platform.venues() })));
  app.get("/v1/stocks/markets/:instrumentMint", route((req) => platform.market(req.params.instrumentMint)));
  app.post("/v1/stocks/quotes", json, route(async (req) => {
    const body = quoteRequestSchema.parse(req.body);
    return platform.createQuote(body.agent_id, body.instrument_mint, body.amount_in_usdc, body.venue);
  }));
  app.post("/v1/stocks/policy/preview", json, route((req) => platform.preview(orderRequestSchema.parse(req.body))));
  app.post("/v1/stocks/orders", json, route(async (req) => {
    const body = orderRequestSchema.parse(req.body);
    return platform.execute(bearer(req), String(req.header("idempotency-key") ?? ""), body);
  }));
  app.get("/v1/stocks/orders/:orderId", route((req) => platform.order(req.params.orderId)));
  app.get("/v1/stocks/portfolio", route((req) => platform.portfolio(String(req.query.agent_id ?? ""))));

  console.log("[stocks] mounted — discovery, venues, Pyth evidence, quote, policy preview, orders, status and portfolio");
}

function bearer(req: Request): string {
  const authorization = String(req.header("authorization") ?? "");
  if (!authorization.startsWith("Bearer ")) {
    throw new StockPlatformError("UNAUTHORIZED_OPERATOR", "Authorization: Bearer <operator token> is required", 401);
  }
  return authorization.slice("Bearer ".length);
}

function sendStockError(res: express.Response, error: unknown): void {
  if (error instanceof StockPlatformError) {
    res.status(error.httpStatus).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: error.issues[0]?.message ?? "invalid request" } });
    return;
  }
  res.status(503).json({
    error: { code: "UPSTREAM_UNAVAILABLE", message: (error as Error).message ?? String(error) },
  });
}

export function stockPlatformFromEnv(): StockPlatform | null {
  if (process.env.SOLANA_STOCKS_ENABLED !== "1") return null;
  const taker = process.env.SOLANA_STOCKS_TAKER;
  const token = process.env.SOLANA_STOCK_OPERATOR_TOKEN;
  const pythApiKey = process.env.PYTH_PRO_API_KEY;
  if (!taker || !token || token.length < 16 || !pythApiKey) {
    console.error("[stocks] not mounted — SOLANA_STOCKS_TAKER, PYTH_PRO_API_KEY and a 16+ character SOLANA_STOCK_OPERATOR_TOKEN are required");
    return null;
  }
  const agentId = process.env.SOLANA_STOCK_AGENT_ID ?? "solana-agent-1";
  const operator = process.env.SOLANA_STOCK_OPERATOR ?? taker;
  const now = () => Math.floor(Date.now() / 1000);
  const governor = new StockGovernor({
    owner: process.env.SOLANA_STOCK_OWNER ?? "owner:service",
    operator,
    usdcMint: SOLANA_USDC_MINT,
    instruments: [...VERIFIED_XSTOCKS],
    policy: {
      perTradeCapUsdc: BigInt(process.env.SOLANA_STOCK_PER_TRADE_CAP ?? "10000000"),
      epochCapUsdc: BigInt(process.env.SOLANA_STOCK_EPOCH_CAP ?? "50000000"),
      epochLengthSeconds: Number(process.env.SOLANA_STOCK_EPOCH_SECONDS ?? 86400),
      approvedMints: new Set(VERIFIED_XSTOCKS.map((instrument) => instrument.mint)),
    },
    now,
  });
  governor.depositUsdc(process.env.SOLANA_STOCK_OWNER ?? "owner:service", BigInt(process.env.SOLANA_STOCK_VAULT_USDC ?? "100000000"));

  const simulation = process.env.SOLANA_STOCKS_SIMULATION === "1";
  const executor: StockChainExecutor = simulation
    ? { execute: async (_intent, quote) => ({ txSignature: `simulation:${quote.quoteId}`, actualOutput: quote.outAmount, outcome: "settled" }) }
    : { execute: async () => { throw new Error("Solana transaction signer is not configured"); } };
  return new StockPlatform({
    instruments: VERIFIED_XSTOCKS,
    agents: [{
      agentId,
      operator,
      governor,
      credentials: [{ token, allowedMints: new Set(VERIFIED_XSTOCKS.map((instrument) => instrument.mint)) }],
    }],
    quotes: new JupiterV2QuoteProvider({
      taker,
      apiKey: process.env.JUPITER_API_KEY,
      slippageBps: Number(process.env.SOLANA_STOCK_SLIPPAGE_BPS ?? 50),
    }),
    executor,
    marketDiscovery: new BackpackMarketDiscovery(),
    marketGuard: new PythStockGuard(
      new PythProStockSource({ apiKey: pythApiKey }),
      {
        max_feed_age_seconds: Number(process.env.SOLANA_STOCK_PYTH_MAX_AGE_SECONDS ?? 30),
        max_absolute_premium_bps: Number(process.env.SOLANA_STOCK_PYTH_MAX_PREMIUM_BPS ?? 300),
        max_confidence_bps: Number(process.env.SOLANA_STOCK_PYTH_MAX_CONFIDENCE_BPS ?? 100),
        min_publishers: Number(process.env.SOLANA_STOCK_PYTH_MIN_PUBLISHERS ?? 2),
      },
    ),
    instrumentSources: [new PreStocksRegistry(
      new SolanaRpcMintVerifier(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"),
    )],
    executionMode: simulation ? "simulation" : "disabled",
    now,
  });
}
