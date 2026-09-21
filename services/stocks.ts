import express, { type Express, type Request } from "express";
import { z } from "zod";
import {
  JupiterV2QuoteProvider,
  BackpackMarketDiscovery,
  PreStocksMarkSource,
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
  ReferenceMirrorSource,
  TapeMarketGuard,
  VERIFIED_XSTOCKS,
  type PriceSide,
  type JupiterQuoteFetcher,
  type StockChainExecutor,
  type StockInstrument,
  type VenueId,
} from "../stocks";
import { devnetLaneFromEnv, type DevnetLane } from "./stocks-devnet";
import { safeMessage } from "../stocks/redact";

const quoteRequestSchema = z.object({
  agent_id: z.string().min(1),
  instrument_mint: z.string().min(32),
  amount_in_usdc: z.string().regex(/^\d+$/),
  /** Omitted means the default venue, which keeps existing callers working. */
  venue: z.string().min(1).max(32).optional(),
});

const quoteCheckSchema = z.object({
  instrument_mint: z.string().min(32).max(64),
  usdc_in: z.string().regex(/^\d{1,30}$/),
  tokens_out: z.string().regex(/^\d{1,30}$/),
  min_tokens_out: z.string().regex(/^\d{1,30}$/).optional(),
  venue: z.string().max(40).optional(),
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
  // A curve this deployment launched, as its issuer would watch it: where the
  // pool is, how far it has to run, and whether the share is still in its range.
  app.get("/v1/stocks/curves", route(async () => ({ curves: await platform.curves() })));
  // What the program wrote down, which outlives this process. The orders above
  // are the hub's memory of a trade; these are the chain's.
  app.get("/v1/stocks/trades", route((req) => platform.trades(Number(req.query.limit ?? 50))));
  app.get("/v1/stocks/intents/:intentId", route((req) => platform.intent(req.params.intentId)));
  app.get("/v1/stocks/markets/:instrumentMint", route((req) => platform.market(req.params.instrumentMint)));
  app.get("/v1/stocks/prices/:instrumentMint", route((req) =>
    platform.prices(req.params.instrumentMint, String(req.query.window ?? "1h"))));
  app.post("/v1/stocks/quotes", json, route(async (req) => {
    const body = quoteRequestSchema.parse(req.body);
    return platform.createQuote(body.agent_id, body.instrument_mint, body.amount_in_usdc, body.venue);
  }));
  app.post("/v1/stocks/policy/preview", json, route((req) => platform.preview(orderRequestSchema.parse(req.body))));
  // The same verdict a quote through this hub carries, for a quote the caller
  // describes. Free here because it is already free inside a governed quote;
  // nothing is stored and nothing is reserved.
  app.post("/v1/stocks/quote-check", json, route(async (req) => {
    const body = quoteCheckSchema.parse(req.body);
    return platform.checkListedQuote(body.instrument_mint, {
      usdcIn: BigInt(body.usdc_in),
      tokensOut: BigInt(body.tokens_out),
      minimumTokensOut: body.min_tokens_out === undefined ? undefined : BigInt(body.min_tokens_out),
      venue: body.venue,
    });
  }));
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
    throw new StockPlatformError("UNAUTHORIZED_OPERATOR", "an operator bearer credential is required in the Authorization header", 401);
  }
  return authorization.slice("Bearer ".length);
}

function sendStockError(res: express.Response, error: unknown): void {
  if (error instanceof StockPlatformError) {
    res.status(error.httpStatus).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: safeMessage(error.issues[0]?.message ?? "invalid request", 160) } });
    return;
  }
  // Whatever this is, it came from an upstream client, and those put the URL
  // they were calling — API key and all — into their messages. The detail goes
  // to the log; the caller gets a message with nothing in it to steal.
  console.error("[stocks] upstream failure:", safeMessage(error, 200));
  res.status(503).json({
    error: { code: "UPSTREAM_UNAVAILABLE", message: safeMessage(error, 160) },
  });
}

/**
 * Take the chain's word for the vault, the spend and the positions.
 *
 * Runs at boot and then on a timer. A trade in flight holds a reservation
 * against an outcome nobody knows yet, so the governor refuses to be overwritten
 * then; that is not a failure, and the next pass picks it up.
 */
let blockedPasses = 0;

async function reconcileFromChain(devnet: DevnetLane, governor: StockGovernor, when: "boot" | "refresh"): Promise<void> {
  try {
    // Marked before the read: a trade that settles while the chain is being
    // read leaves nothing pending, and a balance from before it settled.
    const readSince = governor.activityMark();
    const state = await devnet.ledger.state();
    const { capChanges } = governor.adoptChainState({ ...state, readSince });
    for (const change of capChanges) {
      console.warn(`[stocks] effective cap changed to the smaller of this deployment's and the chain's: ${change}`);
    }
    blockedPasses = 0;
    if (when === "boot") {
      console.log(
        `[stocks] adopted the chain's state — vault ${state.vaultUsdc} USDC, ${state.spentInEpoch} spent this epoch, `
        + `${state.holdings.filter((h) => h.amount > 0n).length} position(s)${state.suspended ? ", SUSPENDED by the owner" : ""}`,
      );
    }
  } catch (error) {
    const message = safeMessage(error, 160);
    if (/in flight/.test(message)) { // both refusals: pending now, or settled mid-read
      // One trade in flight is a reason to wait. Many passes in a row is a
      // trade that never resolved, and it holds both its reservation and every
      // refresh after it until the owner reconciles that intent.
      blockedPasses += 1;
      if (blockedPasses % 12 === 0) {
        console.error(`[stocks] the chain's state has not been re-read for ${blockedPasses} passes: an intent is still in flight and is holding its reservation. It needs reconciling by the owner.`);
      }
      return;
    }
    console.error(`[stocks] could not read the chain's state (${when}): ${message}`);
  }
}

/**
 * Hands decision records to a Quaestor ledger (POST /decisions), which stores
 * each under its own keccak256 and answers with it. That answer must be the
 * hash the trade committed; anything else means the bytes changed on the way.
 */
export function ledgerPublisher(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const url = `${baseUrl.replace(/\/+$/, "")}/decisions`;
  return async ({ raw, hash }: { raw: string; hash: string }): Promise<void> => {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "text/plain" }, body: raw, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`the ledger answered ${res.status}`);
    const { metaHash } = (await res.json()) as { metaHash?: string };
    if (metaHash?.toLowerCase() !== hash.toLowerCase()) throw new Error(`the ledger stored it as ${metaHash}, not ${hash}`);
  };
}

export function stockPlatformFromEnv(): StockPlatform | null {
  if (process.env.SOLANA_STOCKS_ENABLED !== "1") return null;
  const taker = process.env.SOLANA_STOCKS_TAKER;
  const token = process.env.SOLANA_STOCK_OPERATOR_TOKEN;
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
  const traded: StockInstrument[] = devnet ? [devnet.instrument, ...(devnet.curve ? [devnet.curve.instrument] : [])] : [];
  const sampled: StockInstrument[] = [...VERIFIED_XSTOCKS, ...traded];
  // Held rather than inlined: it is also where the scaled-UI multiplier is
  // observed, and the price gate needs that to read a raw amount as shares.
  const jupiterPrices = new JupiterPriceSource();
  const pricesEnabled = process.env.SOLANA_STOCK_PRICES !== "0";
  // One registry for the catalogue and the tape, so the provider is asked once
  // a minute in total rather than once a minute by each.
  const prestocks = new PreStocksRegistry(
    new SolanaRpcMintVerifier(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"),
  );
  // Pre-IPO tokens are priced and judged here, never traded: they exist only on
  // mainnet, and a devnet governor has no business pretending otherwise.
  const prestocksMarks = process.env.SOLANA_STOCK_PRESTOCKS_PRICES === "0" ? undefined : new PreStocksMarkSource(prestocks);
  if (pricesEnabled) {
    const warned = new Map<string, number>();
    // The devnet test mint has no market of its own, so it borrows the real
    // share's — from the same two sources, keeping the gate's cross-check real.
    // The curve's token borrows it too, but only the reference side: its own
    // price is the pool's, observed below, and the gap between the two is what
    // the gate is there to judge.
    const mirrors = new Map<string, string>(
      devnet?.referenceMint ? traded.map((instrument): [string, string] => [instrument.mint, devnet.referenceMint as string]) : [],
    );
    new PriceSampler(
      priceTape,
      // What the registry listed a moment ago is priced on chain too, so a
      // pre-IPO token gets an observation that is not the issuer's own.
      () => [...sampled, ...(prestocksMarks?.known() ?? [])],
      [
        new BackpackIndexSource(),
        jupiterPrices,
        new GeckoTerminalHistorySource(),
        new ReferenceMirrorSource(priceTape, mirrors),
        ...(prestocksMarks ? [prestocksMarks] : []),
        ...(devnet?.curve ? [devnet.curve.priceSource] : []),
      ],
      {
        intervalMs: Number(process.env.SOLANA_STOCK_PRICE_INTERVAL_MS ?? 20_000),
        backfillSeconds: Number(process.env.SOLANA_STOCK_PRICE_BACKFILL_SECONDS ?? 6 * 3_600),
        onError: (source, error) => {
          // A source that is down fails every tick; say so once every ten minutes.
          const last = warned.get(source) ?? 0;
          if (Date.now() - last < 600_000) return;
          warned.set(source, Date.now());
          console.warn(`[stocks] price source ${source} failed: ${safeMessage(error, 160)}`);
        },
      },
    ).start();
  }

  const agentId = process.env.SOLANA_STOCK_AGENT_ID ?? "solana-agent-1";
  // The intent must name the operator the deployed governor will accept.
  const operator = devnet ? devnet.operator : (process.env.SOLANA_STOCK_OPERATOR ?? taker);
  // Only what this deployment can actually execute is offered as tradeable.
  const listed: StockInstrument[] = devnet ? traded : [...VERIFIED_XSTOCKS];
  if (devnet) venueQuotes[devnet.venue] = devnet.quotes;
  if (devnet?.curve) venueQuotes[devnet.curve.venue] = devnet.curve.quotes;
  const now = () => Math.floor(Date.now() / 1000);
  const governor = new StockGovernor({
    owner: devnet ? devnet.owner : (process.env.SOLANA_STOCK_OWNER ?? "owner:service"),
    operator,
    usdcMint: devnet ? devnet.usdcMint : SOLANA_USDC_MINT,
    instruments: listed,
    // On a lane that settles on chain, nothing trades until the chain's state
    // has been read: zeroes are not a balance, they are an absence of one.
    awaitChainState: Boolean(devnet),
    policy: {
      perTradeCapUsdc: BigInt(process.env.SOLANA_STOCK_PER_TRADE_CAP ?? "10000000"),
      epochCapUsdc: BigInt(process.env.SOLANA_STOCK_EPOCH_CAP ?? "50000000"),
      epochLengthSeconds: Number(process.env.SOLANA_STOCK_EPOCH_SECONDS ?? 86400),
      // Off-chain policy mirrors what the deployed governor will accept: on
      // devnet only the instrument and venue the owner approved on chain.
      approvedMints: new Set(listed.map((instrument) => instrument.mint)),
      approvedVenues: devnet
        ? [devnet.venue, ...(devnet.curve ? [devnet.curve.venue] : [])]
        : (["jupiter", ...Object.keys(venueQuotes)] as VenueId[]),
    },
    now,
  });
  const vaultOwner = devnet ? devnet.owner : (process.env.SOLANA_STOCK_OWNER ?? "owner:service");
  if (devnet) {
    // The vault's balance is the vault's balance. Reading it, rather than
    // crediting a configured figure, is also what makes a restart harmless:
    // the chain kept the spend and the positions this process just lost.
    //
    // Until the first read succeeds the vault is empty here, so trades refuse
    // for want of funds. That is the wrong answer in the safe direction; a hub
    // that invented a balance would give the wrong one in the other.
    void reconcileFromChain(devnet, governor, "boot");
    const everyMs = Number(process.env.SOLANA_STOCK_RECONCILE_MS ?? 300_000);
    if (everyMs > 0) {
      const timer = setInterval(() => void reconcileFromChain(devnet, governor, "refresh"), everyMs);
      timer.unref?.();
    }
  } else {
    governor.depositUsdc(vaultOwner, BigInt(process.env.SOLANA_STOCK_VAULT_USDC ?? "100000000"));
  }

  // The gate reads the tape the hub is already sampling, so it costs a trade no
  // request and no latency — which is what lets it sit in the path of every one.
  //
  // On devnet the token side is a test mint with no market, so only the
  // underlying is required; on mainnet both sides must price, because the gap
  // between them is the thing worth checking.
  const marketGuard = pricesEnabled
    ? new TapeMarketGuard({
      tape: priceTape,
      uiMultiplier: (mint) => jupiterPrices.multiplier(mint),
      policy: {
        max_price_age_seconds: Number(process.env.SOLANA_STOCK_MAX_PRICE_AGE_SECONDS ?? 180),
        required_sides: (devnet ? ["reference"] : ["tokenized", "reference"]) as PriceSide[],
        max_source_disagreement_bps: Number(process.env.SOLANA_STOCK_MAX_SOURCE_DISAGREEMENT_BPS ?? 150),
        max_absolute_premium_bps: Number(process.env.SOLANA_STOCK_MAX_PREMIUM_BPS ?? 300),
        max_absolute_premium_bps_after_hours: Number(process.env.SOLANA_STOCK_MAX_PREMIUM_BPS_AFTER_HOURS ?? 800),
        max_quote_deviation_bps: Number(process.env.SOLANA_STOCK_MAX_QUOTE_DEVIATION_BPS ?? 300),
      },
      // A pre-IPO token is measured against an issuer's mark, not an exchange:
      // there is no session to be closed, the mark moves with funding rounds
      // rather than ticks, and a thin token wanders much further from it than a
      // listed share does from its index. The same gate, the owner's numbers
      // for this kind of thing. Both sides are required here even on devnet:
      // the gap between token and mark is the whole of what is being judged.
      policies: {
        "pre-ipo": {
          required_sides: ["tokenized", "reference"] as PriceSide[],
          max_price_age_seconds: Number(process.env.SOLANA_STOCK_PREIPO_MAX_PRICE_AGE_SECONDS ?? 300),
          max_source_disagreement_bps: Number(process.env.SOLANA_STOCK_PREIPO_MAX_SOURCE_DISAGREEMENT_BPS ?? 300),
          max_absolute_premium_bps: Number(process.env.SOLANA_STOCK_PREIPO_MAX_PREMIUM_BPS ?? 1500),
          max_absolute_premium_bps_after_hours: Number(process.env.SOLANA_STOCK_PREIPO_MAX_PREMIUM_BPS ?? 1500),
          max_quote_deviation_bps: Number(process.env.SOLANA_STOCK_PREIPO_MAX_QUOTE_DEVIATION_BPS ?? 500),
        },
        // A curve launched around a share's price has a market of its own, the
        // pool, so both sides are required: the pool's price and the share's.
        // It is meant to sit inside its band, and the share moves after the
        // curve is anchored, so the limit is the band plus room for that drift
        // and no more. Past it the curve has stopped tracking anything, and a
        // cheap token is not a bargain, it is a different asset. A curve does
        // not close when the exchange does, so the limit is one number.
        ...(devnet?.curve ? {
          "anchored-curve": {
            required_sides: ["tokenized", "reference"] as PriceSide[],
            max_absolute_premium_bps: devnet.curve.bandBps + Number(process.env.SOLANA_STOCK_CURVE_DRIFT_BPS ?? 300),
            max_absolute_premium_bps_after_hours: devnet.curve.bandBps + Number(process.env.SOLANA_STOCK_CURVE_DRIFT_BPS ?? 300),
            max_quote_deviation_bps: Number(process.env.SOLANA_STOCK_CURVE_MAX_QUOTE_DEVIATION_BPS ?? 300),
          },
        } : {}),
      },
      policyFor: (mint) => {
        if (mint === devnet?.curve?.instrument.mint) return "anchored-curve";
        return prestocksMarks?.known().some((instrument) => instrument.mint === mint) ? "pre-ipo" : undefined;
      },
      now,
    })
    : undefined;

  // Without the gate the lane serves reads and refuses to trade. Listing an
  // instrument and buying one are different privileges: the catalogue needs no
  // price, and an execution path that cannot check one must not be reachable.
  if (!marketGuard) {
    console.warn("[stocks] price sampling is off — the price gate cannot run, so execution is disabled");
  }
  const simulation = process.env.SOLANA_STOCKS_SIMULATION === "1" && Boolean(marketGuard);
  const executor: StockChainExecutor = devnet && marketGuard
    ? devnet.executor
    : simulation
      ? { execute: async (_intent, quote) => ({ txSignature: `simulation:${quote.quoteId}`, actualOutput: quote.outAmount, outcome: "settled" }) }
      : { execute: async () => { throw new Error("Solana transaction signer is not configured"); } };
  const watchedCurve = devnet?.curve;
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
    // Only a lane that settles on chain publishes: a simulated trade committed
    // nothing, so there is no hash for its record to be checked against.
    publishRecord: devnet && marketGuard && process.env.DECISION_LEDGER_URL ? ledgerPublisher(process.env.DECISION_LEDGER_URL) : undefined,
    marketDiscovery: new BackpackMarketDiscovery(),
    marketGuard,
    venueQuotes,
    priceTape,
    instrumentSources: [prestocks],
    // Measured across the whole catalogue. Probing only the pre-IPO source
    // would leave the xStocks unmeasured, and an unmeasured instrument is not
    // an instrument nothing will fill.
    //
    // Only the aggregator is probed: the devnet test venue fills any mint it is
    // handed, so asking it would report every instrument as routable. And on a
    // devnet deployment nothing here is tradeable through Jupiter anyway, so
    // the probe — dozens of upstream calls on the owner's key — is not run.
    routability: devnet ? undefined : quoteProbeRoutability({ jupiter }, {
      probeAmount: BigInt(process.env.SOLANA_STOCK_PROBE_USDC ?? "1000000"),
      attempts: 3,
      spacingMs: Number(process.env.JUPITER_PROBE_SPACING_MS ?? 400),
    }),
    defaultVenue: devnet ? devnet.venue : undefined,
    // A devnet deployment trades one test mint, but its tape samples the real
    // mainnet tokens — so it can still answer questions about them.
    watchInstruments: () => [...(devnet ? VERIFIED_XSTOCKS : []), ...(prestocksMarks?.known() ?? [])],
    // The share's price comes from the gate, so the monitor sees only what the
    // gate would trade on: fresh sources, their median, nothing stale.
    chain: devnet ? { trades: (limit) => devnet.ledger.trades(limit), tradeFor: (intentId) => devnet.ledger.tradeFor(intentId) } : undefined,
    curves: watchedCurve
      ? async () => {
        const market = await marketGuard?.assess(watchedCurve.instrument);
        return [watchedCurve.monitor(market?.consensus.reference?.price)];
      }
      : undefined,
    onchain: devnet
      ? { cluster: "devnet", program: devnet.program, governor: devnet.governor, vault: devnet.vault, owner: devnet.owner, operator: devnet.operator, operator_custody: devnet.operatorCustody }
      : undefined,
    minTradeUsdc: BigInt(process.env.SOLANA_STOCK_MIN_TRADE_USDC ?? "1000000"),
    maxExecutionsPerDay: Number(process.env.SOLANA_STOCK_MAX_EXECUTIONS_PER_DAY ?? 40),
    network: devnet ? "solana-devnet" : "solana-mainnet",
    executionMode: devnet && marketGuard ? "live" : simulation ? "simulation" : "disabled",
    now,
  });
}
