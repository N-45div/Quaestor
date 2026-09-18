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
  quoteProbeRoutability,
  BackpackIndexSource,
  GeckoTerminalHistorySource,
  JupiterPriceSource,
  PriceSampler,
  PriceTape,
  VERIFIED_XSTOCKS,
  type JupiterQuoteFetcher,
  type StockChainExecutor,
  type StockInstrument,
  type VenueId,
} from "../stocks";
import { devnetLaneFromEnv } from "./stocks-devnet";

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
  app.get("/v1/stocks/prices/:instrumentMint", route((req) =>
    platform.prices(req.params.instrumentMint, String(req.query.window ?? "1h"))));
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

  console.log("[stocks] mounted — discovery, venues, live prices, quote, policy preview, orders, status and portfolio");
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
  if (!taker || !token || token.length < 16) {
    console.error("[stocks] not mounted — SOLANA_STOCKS_TAKER and a 16+ character SOLANA_STOCK_OPERATOR_TOKEN are required");
    return null;
  }
  const jupiter = new JupiterV2QuoteProvider({
    taker,
    apiKey: process.env.JUPITER_API_KEY,
    slippageBps: Number(process.env.SOLANA_STOCK_SLIPPAGE_BPS ?? 50),
  });
  // Only venues this deployment can actually price. An owner approves venues
  // on-chain; this is the separate question of whether we can quote them.
  const venueQuotes: Partial<Record<VenueId, JupiterQuoteFetcher>> = {};

  // The live price tape. Sampled here rather than on request, so when an agent
  // asks where a price has been the history already exists — and one request
  // per source per tick keeps free APIs inside their limits however many
  // instruments are listed.
  const priceTape = new PriceTape();
  // On devnet the hub signs and sends for real; without it the order endpoint
  // is a simulation and says so.
  const devnet = devnetLaneFromEnv(priceTape);
  // The tape follows whatever is listed, so a devnet instrument gets a
  // reference price from its underlying just like a mainnet one.
  const sampled: StockInstrument[] = [...VERIFIED_XSTOCKS, ...(devnet ? [devnet.instrument] : [])];
  if (process.env.SOLANA_STOCK_PRICES !== "0") {
    const warned = new Map<string, number>();
    new PriceSampler(
      priceTape,
      () => sampled,
      [new BackpackIndexSource(), new JupiterPriceSource(), new GeckoTerminalHistorySource()],
      {
        intervalMs: Number(process.env.SOLANA_STOCK_PRICE_INTERVAL_MS ?? 20_000),
        backfillSeconds: Number(process.env.SOLANA_STOCK_PRICE_BACKFILL_SECONDS ?? 6 * 3_600),
        onError: (source, error) => {
          // A source that is down fails every tick; say so once every ten minutes.
          const last = warned.get(source) ?? 0;
          if (Date.now() - last < 600_000) return;
          warned.set(source, Date.now());
          console.warn(`[stocks] price source ${source} failed: ${(error as Error).message}`);
        },
      },
    ).start();
  }

  const agentId = process.env.SOLANA_STOCK_AGENT_ID ?? "solana-agent-1";
  // The intent must name the operator the deployed governor will accept.
  const operator = devnet ? devnet.operator : (process.env.SOLANA_STOCK_OPERATOR ?? taker);
  // Only what this deployment can actually execute is offered as tradeable.
  const listed: StockInstrument[] = devnet ? [devnet.instrument] : [...VERIFIED_XSTOCKS];
  if (devnet) venueQuotes[devnet.venue] = devnet.quotes;
  const now = () => Math.floor(Date.now() / 1000);
  const governor = new StockGovernor({
    owner: devnet ? devnet.owner : (process.env.SOLANA_STOCK_OWNER ?? "owner:service"),
    operator,
    usdcMint: devnet ? devnet.usdcMint : SOLANA_USDC_MINT,
    instruments: listed,
    policy: {
      perTradeCapUsdc: BigInt(process.env.SOLANA_STOCK_PER_TRADE_CAP ?? "10000000"),
      epochCapUsdc: BigInt(process.env.SOLANA_STOCK_EPOCH_CAP ?? "50000000"),
      epochLengthSeconds: Number(process.env.SOLANA_STOCK_EPOCH_SECONDS ?? 86400),
      // Off-chain policy mirrors what the deployed governor will accept: on
      // devnet only the instrument and venue the owner approved on chain.
      approvedMints: new Set(listed.map((instrument) => instrument.mint)),
      approvedVenues: devnet ? [devnet.venue] : (["jupiter", ...Object.keys(venueQuotes)] as VenueId[]),
    },
    now,
  });
  const vaultOwner = devnet ? devnet.owner : (process.env.SOLANA_STOCK_OWNER ?? "owner:service");
  governor.depositUsdc(vaultOwner, BigInt(process.env.SOLANA_STOCK_VAULT_USDC ?? "100000000"));

  // Without a price feed the divergence guard cannot run, so the lane serves
  // reads and refuses to trade. Listing an instrument and buying one are
  // different privileges: the catalogue needs no oracle, and an execution path
  // that cannot check a price against the underlying must not be reachable.
  const simulation = process.env.SOLANA_STOCKS_SIMULATION === "1" && Boolean(pythApiKey);
  if (!pythApiKey) {
    console.warn("[stocks] PYTH_PRO_API_KEY absent — discovery and quotes only, execution disabled");
  }
  const executor: StockChainExecutor = devnet
    ? devnet.executor
    : simulation
      ? { execute: async (_intent, quote) => ({ txSignature: `simulation:${quote.quoteId}`, actualOutput: quote.outAmount, outcome: "settled" }) }
      : { execute: async () => { throw new Error("Solana transaction signer is not configured"); } };
  return new StockPlatform({
    instruments: listed,
    agents: [{
      agentId,
      operator,
      governor,
      credentials: [{ token, allowedMints: new Set(listed.map((instrument) => instrument.mint)) }],
    }],
    quotes: jupiter,
    executor,
    marketDiscovery: new BackpackMarketDiscovery(),
    marketGuard: pythApiKey ? new PythStockGuard(
      new PythProStockSource({ apiKey: pythApiKey }),
      {
        max_feed_age_seconds: Number(process.env.SOLANA_STOCK_PYTH_MAX_AGE_SECONDS ?? 30),
        max_absolute_premium_bps: Number(process.env.SOLANA_STOCK_PYTH_MAX_PREMIUM_BPS ?? 300),
        max_confidence_bps: Number(process.env.SOLANA_STOCK_PYTH_MAX_CONFIDENCE_BPS ?? 100),
        min_publishers: Number(process.env.SOLANA_STOCK_PYTH_MIN_PUBLISHERS ?? 2),
      },
    ) : undefined,
    venueQuotes,
    priceTape,
    instrumentSources: [new PreStocksRegistry(
      new SolanaRpcMintVerifier(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"),
    )],
    // Measured across the whole catalogue. Probing only the pre-IPO source
    // would leave the xStocks unmeasured, and an unmeasured instrument is not
    // an instrument nothing will fill.
    routability: quoteProbeRoutability({ jupiter, ...venueQuotes }, {
      probeAmount: BigInt(process.env.SOLANA_STOCK_PROBE_USDC ?? "1000000"),
      attempts: 3,
      spacingMs: Number(process.env.JUPITER_PROBE_SPACING_MS ?? 400),
    }),
    network: devnet ? "solana-devnet" : "solana-mainnet",
    executionMode: devnet ? "live" : simulation ? "simulation" : "disabled",
    now,
  });
}
