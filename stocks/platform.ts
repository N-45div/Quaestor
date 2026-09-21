import { createHash, timingSafeEqual } from "node:crypto";
import { ethers } from "ethers";
import type { JupiterQuoteFetcher } from "./jupiter";
import { decisionHash, type StockChainExecutor, StockGovernor } from "./governor";
import {
  StockRefusal,
  type JupiterQuote,
  type StockInstrument,
  type StockInstrumentCatalog,
  type StockInstrumentCatalogSource,
  type StockReceipt,
  type StockTradeIntent,
} from "./types";
import type { StockMarketDiscovery } from "./backpack";
import type { QuotedPrice, StockMarketAssessment, StockMarketGuard } from "./market-guard";
import { parseWindow, summarize, type PriceSummary, type PriceTape } from "./prices";
import { safeMessage } from "./redact";
import type { ChainTrade } from "./solana-ledger";
import {
  DEFAULT_VENUE,
  NoRouteError,
  knownVenues,
  resolveVenue,
  type InstrumentRoutability,
  type VenueId,
} from "./venues";

export interface StockDecisionRecord {
  strategy: string;
  rationale: string;
  model?: string;
  inputs?: Record<string, unknown>;
}

export interface CommittedStockDecisionRecord extends StockDecisionRecord {
  agent_id: string;
  intent_id: string;
  quote_id: string;
  market_evidence?: {
    provider: StockMarketAssessment["provider"];
    evidence_hash: string;
    /** Absent unless both the token and its underlying had a price. */
    premium_bps?: number;
    /** How far the enforced floor sat from the observed market when signed. */
    quote_deviation_bps?: number;
    policy: StockMarketAssessment["policy"];
  };
}

export interface StockQuoteView {
  quote_id: string;
  agent_id: string;
  input_mint: string;
  instrument_mint: string;
  amount_in_usdc: string;
  estimated_output: string;
  minimum_output: string;
  route: string;
  /** Which venue filled this quote, so an agent can reconcile it with the receipt. */
  venue: VenueId;
  expires_at: string;
  market?: StockMarketAssessment;
}

export interface StockVenueView {
  id: VenueId;
  label: string;
  program_id: string;
  kind: string;
}

/** A bonding curve this deployment launched, as its issuer would want to watch it. */
export interface StockCurveView {
  venue: VenueId;
  pool: string;
  instrument_mint: string;
  symbol: string;
  /** The plan it was launched with. These do not change. */
  anchored_to_usd: number;
  band_bps: number;
  opening_price_usd: number;
  graduation_price_usd: number;
  graduation_usdc: number;
  /** What was last seen, and when. Absent until the pool has been read once. */
  observed_at?: string;
  graduated?: boolean;
  pool_price_usd?: number;
  /** Share of the graduation threshold taken in, 0..1, and the same in USDC. */
  progress?: number;
  raised_usdc?: number;
  /** The share's price now, from the gate's fresh reference sources only. */
  reference_price_usd?: number;
  health?: "tracking" | "reference-above-range" | "reference-below-range" | "graduated";
  premium_bps?: number;
  reference_drift_bps?: number;
  range_position?: number;
  summary: string;
}

export interface StockOrderRequest {
  agent_id: string;
  intent_id: string;
  quote_id: string;
  intent_expires_at: string;
  decision: StockDecisionRecord;
}

export type StockOrderStatus = "executing" | "settled" | "refused" | "pending_reconciliation";

export interface StockOrderView {
  order_id: string;
  intent_id: string;
  agent_id: string;
  quote_id: string;
  instrument_mint: string;
  status: StockOrderStatus;
  created_at: string;
  updated_at: string;
  intent_hash: string;
  decision_record_hash: string;
  decision_record: CommittedStockDecisionRecord;
  market?: StockMarketAssessment;
  receipt?: ReturnType<typeof receiptView>;
  refusal?: { code: string; message: string };
}

export interface StockOperatorCredential {
  token: string;
  allowedMints: ReadonlySet<string>;
}

export interface StockAgentRegistration {
  agentId: string;
  operator: string;
  governor: StockGovernor;
  credentials: StockOperatorCredential[];
}

export interface StockPlatformConfig {
  instruments: readonly StockInstrument[];
  instrumentSources?: readonly StockInstrumentCatalogSource[];
  agents: StockAgentRegistration[];
  quotes: JupiterQuoteFetcher;
  executor: StockChainExecutor;
  marketDiscovery?: StockMarketDiscovery;
  marketGuard?: StockMarketGuard;
  /**
   * Quote sources for venues beyond the default. `quotes` still serves Jupiter,
   * so an existing deployment keeps working; adding Meteora is adding an entry
   * here, not replacing the field every caller already configures.
   */
  venueQuotes?: Partial<Record<VenueId, JupiterQuoteFetcher>>;
  /**
   * Measures which venues can fill each listed mint.
   *
   * It belongs to the catalogue rather than to one provider: an instrument that
   * was never probed is not an instrument nothing will fill, and leaving the
   * static list unmeasured reports the most liquid names on the venue as having
   * no route at all.
   */
  routability?: InstrumentRoutability;
  /**
   * The live price tape, sampled by the service. Optional: without it the
   * platform still governs trades; it just cannot tell an agent where a price
   * has been.
   */
  priceTape?: PriceTape;
  /**
   * The cluster this deployment actually executes on. Reported as-is: a hub
   * settling on devnet must not tell an agent it is on mainnet.
   */
  network?: "solana-mainnet" | "solana-devnet";
  executionMode?: "live" | "simulation" | "disabled";
  /**
   * The venue a quote goes to when the caller names none. It follows the
   * deployment: on devnet the aggregator has no route for a test mint, and a
   * default that always fails teaches an agent that quoting is broken while
   * spending the owner's upstream quota on every attempt.
   */
  defaultVenue?: VenueId;
  /**
   * The smallest trade, in USDC base units. The USDC caps bound how much an
   * agent can spend; they say nothing about how *often*. Every executed trade
   * costs the fee payer rent for an on-chain record, so without a floor a key
   * holder can drain it with dust while spending almost no USDC at all.
   */
  minTradeUsdc?: bigint;
  /** Executions per agent per UTC day: the other half of the same bound. */
  maxExecutionsPerDay?: number;
  /** Live quotes held at once. Quotes are anonymous, so this is a public surface. */
  maxLiveQuotes?: number;
  /** Finished orders kept for lookup before the oldest are dropped. */
  maxStoredOrders?: number;
  /** How long a built catalogue is served before it is measured again. */
  catalogTtlMs?: number;
  /**
   * Instruments this deployment can price and assess but does not trade.
   *
   * What an agent may buy here and what it may ask about are different sets. A
   * devnet deployment trades one test mint, yet its tape samples the real
   * mainnet tokens, and "is this quote fair?" is worth answering for those to
   * an agent that will execute somewhere else entirely.
   */
  /**
   * Instruments this deployment prices and gives a verdict on without trading
   * them. A function where the list is discovered while the hub runs.
   */
  watchInstruments?: readonly StockInstrument[] | (() => readonly StockInstrument[]);
  /**
   * Where this deployment's governor lives on chain. Public addresses only:
   * published so that anyone can open the vault in an explorer and check the
   * trades this hub reports against the ones the chain recorded.
   */
  onchain?: {
    cluster: "devnet" | "mainnet-beta"; program: string; governor: string; vault: string; owner: string; operator: string;
    /** Whether this process holds the operator's whole key, or one share of an MPC wallet. */
    operator_custody?: "local-keypair" | "dynamic-mpc";
  };
  /** Bonding curves this deployment launched and watches. The platform only serves them. */
  curves?: () => Promise<StockCurveView[]>;
  /**
   * What the chain remembers. The orders above are this process's memory of a
   * trade and are lost when it restarts; these are the program's own records,
   * which are not.
   */
  chain?: {
    trades(limit: number): Promise<ChainTrade[]>;
    tradeFor(intentId: string): Promise<ChainTrade | null>;
  };
  now?: () => number;
}

type QuoteRecord = {
  quote: JupiterQuote;
  venue: VenueId;
  /** The route's on-chain guaranteed floor, proven present when the quote was issued. */
  minimumOutput: bigint;
  agentId: string;
  instrumentMint: string;
  market?: StockMarketAssessment;
  /** The one intent this quote has been spent on. */
  consumedBy?: string;
};
type StoredOrder = StockOrderView & { requestFingerprint: string };

export class StockPlatformError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
    this.name = "StockPlatformError";
  }
}

export class StockPlatform {
  private readonly instruments = new Map<string, StockInstrument>();
  private readonly agents = new Map<string, StockAgentRegistration>();
  private readonly quotes = new Map<string, QuoteRecord>();
  private readonly orders = new Map<string, StoredOrder>();
  private readonly idempotency = new Map<string, string>();
  private readonly intentOrders = new Map<string, string>();
  private readonly executionsByDay = new Map<string, number>();
  private catalogCache?: { expiresAtMs: number; value: StockInstrumentCatalog };
  private catalogInFlight?: Promise<StockInstrumentCatalog>;
  private readonly now: () => number;

  constructor(private readonly cfg: StockPlatformConfig) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    for (const instrument of cfg.instruments) {
      if (this.instruments.has(instrument.mint)) throw new Error(`duplicate instrument mint ${instrument.mint}`);
      const transferRules = Object.freeze([...(instrument.transferRules ?? [])]);
      this.instruments.set(instrument.mint, Object.freeze({ ...instrument, transferRules }));
    }
    const allTokens = new Set<string>();
    for (const agent of cfg.agents) {
      if (this.agents.has(agent.agentId)) throw new Error(`duplicate stock agent ${agent.agentId}`);
      if (!agent.agentId || !agent.operator) throw new Error("stock agent id and operator are required");
      const credentials = agent.credentials.map((credential) => {
        if (credential.token.length < 16) throw new Error(`operator token for ${agent.agentId} must contain at least 16 characters`);
        if (allTokens.has(credential.token)) throw new Error("operator tokens must be unique across stock agents");
        allTokens.add(credential.token);
        const allowedMints = new Set(credential.allowedMints);
        for (const mint of allowedMints) {
          if (!this.instruments.has(mint)) throw new Error(`operator scope contains unknown mint ${mint}`);
        }
        return { token: credential.token, allowedMints };
      });
      this.agents.set(agent.agentId, { ...agent, credentials });
    }
    // A default nobody can quote would turn every quote that names no venue
    // into a 503 at request time. Better to refuse to start.
    const fallback = cfg.defaultVenue;
    if (fallback && fallback !== DEFAULT_VENUE && !cfg.venueQuotes?.[fallback]) {
      throw new Error(`default venue "${fallback}" has no quote source configured`);
    }
  }

  discovery() {
    return {
      version: "2026-09-14",
      network: this.cfg.network ?? "solana-mainnet",
      execution: this.cfg.executionMode ?? "live",
      amounts: "integer base-unit strings",
      limits: this.publicLimits(),
      onchain: this.cfg.onchain ? { ...this.cfg.onchain } : undefined,
      endpoints: {
        instruments: "GET /v1/stocks/instruments",
        backpack_market_data: "GET /v1/stocks/backpack",
        market_evidence: "GET /v1/stocks/markets/:instrumentMint",
        live_prices: "GET /v1/stocks/prices/:instrumentMint?window=1h",
        venues: "GET /v1/stocks/venues",
        curves: "GET /v1/stocks/curves",
        settled_trades: "GET /v1/stocks/trades",
        trade_by_intent: "GET /v1/stocks/intents/:intentId",
        quote: "POST /v1/stocks/quotes",
        quote_check: "POST /v1/stocks/quote-check (free, for instruments traded here)",
        policy_preview: "POST /v1/stocks/policy/preview",
        execute: "POST /v1/stocks/orders",
        order_status: "GET /v1/stocks/orders/:orderId",
        portfolio: "GET /v1/stocks/portfolio?agent_id=...",
      },
    };
  }

  /** The owner's policy as an agent will meet it, from the first registered agent's governor. */
  private publicLimits() {
    const governor = this.cfg.agents[0]?.governor;
    if (!governor) return undefined;
    const limits = governor.limits();
    return {
      per_trade_cap_usdc: limits.perTradeCapUsdc.toString(),
      epoch_cap_usdc: limits.epochCapUsdc.toString(),
      epoch_length_seconds: limits.epochLengthSeconds,
      min_trade_usdc: (this.cfg.minTradeUsdc ?? 1_000_000n).toString(),
      max_executions_per_day: this.cfg.maxExecutionsPerDay ?? 40,
      approved_venues: limits.approvedVenues,
    };
  }

  /**
   * The quote check, free, for what is traded here.
   *
   * A trade through this hub already carries the check inside its quote, so
   * charging to see the same verdict for the same instrument would be selling
   * back what is given away. The paid tool is for everything else: mainnet
   * instruments, quoted by other venues, executed somewhere else.
   */
  async checkListedQuote(
    instrumentMint: string,
    quoted: { usdcIn: bigint; tokensOut: bigint; minimumTokensOut?: bigint; venue?: string },
  ): Promise<StockMarketAssessment> {
    const instrument = this.instruments.get(instrumentMint);
    if (!instrument?.enabled) {
      throw new StockPlatformError("UNKNOWN_INSTRUMENT", "the free check covers instruments traded here; others are a paid tool at /v1/intel", 404);
    }
    return this.checkExternalQuote(instrument.mint, quoted);
  }

  listInstruments(): StockInstrument[] {
    return [...this.instruments.values()].map(cloneInstrument);
  }

  /**
   * Public discovery joins the governed allowlist with read-only providers.
   *
   * Building it asks every provider and may probe every venue for every mint,
   * and the route is anonymous, so one stranger's request must not become
   * dozens of upstream calls on the owner's quota. It is built once, shared by
   * everyone who asks while it is being built, and served until it goes stale.
   */
  async catalog(): Promise<StockInstrumentCatalog> {
    const nowMs = this.now() * 1000;
    if (this.catalogCache && this.catalogCache.expiresAtMs > nowMs) return structuredClone(this.catalogCache.value);
    this.catalogInFlight ??= this.buildCatalog()
      .then((value) => {
        // A catalogue with a failed source is kept only briefly: long enough
        // not to hammer what is down, short enough not to pin the failure.
        const degraded = value.sources.some((source) => source.status !== "ok");
        const ttl = degraded ? 60_000 : (this.cfg.catalogTtlMs ?? 10 * 60_000);
        this.catalogCache = { expiresAtMs: this.now() * 1000 + ttl, value };
        return value;
      })
      .finally(() => { this.catalogInFlight = undefined; });
    return structuredClone(await this.catalogInFlight);
  }

  private async buildCatalog(): Promise<StockInstrumentCatalog> {
    const instruments = this.listInstruments();
    const seen = new Set(instruments.map((instrument) => instrument.mint));
    const sources: StockInstrumentCatalog["sources"] = [{
      provider: "xstocks",
      status: "ok",
      count: instruments.length,
    }];
    const dynamic = this.cfg.instrumentSources ?? [];
    const results = await Promise.allSettled(dynamic.map((source) => source.instruments()));
    results.forEach((result, index) => {
      const provider = dynamic[index].provider;
      if (result.status === "rejected") {
        sources.push({ provider, status: "unavailable", count: 0, error: errorMessage(result.reason) });
        return;
      }
      try {
        const sourceMints = new Set<string>();
        for (const instrument of result.value) {
          if (sourceMints.has(instrument.mint) || seen.has(instrument.mint)) {
            throw new Error(`duplicate instrument mint ${instrument.mint}`);
          }
          if (instrument.enabled || instrument.executionStatus !== "discovery-only") {
            throw new Error("dynamic catalog sources may only publish discovery-only instruments");
          }
          sourceMints.add(instrument.mint);
        }
        for (const instrument of result.value) {
          seen.add(instrument.mint);
          instruments.push(cloneInstrument(instrument));
        }
        sources.push({ provider, status: "ok", count: result.value.length });
      } catch (error) {
        sources.push({ provider, status: "unavailable", count: 0, error: errorMessage(error) });
      }
    });
    // Only what a source did not already measure, so a provider that probed its
    // own catalogue is not asked again.
    const unmeasured = instruments.filter((instrument) => instrument.tradableVenues === undefined);
    if (this.cfg.routability && unmeasured.length > 0) {
      try {
        const routes = await this.cfg.routability.routable(
          unmeasured.map((instrument) => instrument.mint),
          unmeasured[0].usdcMint,
        );
        for (const instrument of unmeasured) {
          const routing = routes.get(instrument.mint);
          instrument.tradableVenues = routing?.venues ?? [];
          instrument.routabilityUnknownVenues = routing?.undetermined ?? [];
        }
      } catch {
        // A probe that could not run leaves the field absent, which reads as
        // unmeasured rather than as a refusal — and marks the catalogue as one
        // to rebuild soon rather than serve for the full lifetime.
        sources.push({ provider: "routability", status: "unavailable", count: 0, error: "venue routability could not be measured" });
      }
    }
    return { observed_at: new Date(this.now() * 1000).toISOString(), instruments, sources };
  }

  async backpackAvailability() {
    if (!this.cfg.marketDiscovery) {
      throw new StockPlatformError("MARKET_DATA_DISABLED", "Backpack market discovery is not configured", 503);
    }
    return {
      role: "supplemental public discovery and market constraints",
      execution_venue: false,
      instruments: await this.cfg.marketDiscovery.availability(this.listInstruments()),
    };
  }

  /**
   * Where a tokenized stock and its underlying have traded over a window,
   * already summarised for a model to read.
   */
  prices(instrumentMint: string, window = "1h"): PriceSummary {
    const instrument = this.instruments.get(instrumentMint);
    if (!instrument) throw new StockPlatformError("UNKNOWN_INSTRUMENT", "instrument is not available", 404);
    if (!this.cfg.priceTape) {
      throw new StockPlatformError("PRICES_DISABLED", "no live price tape is running on this deployment", 503);
    }
    let windowSeconds: number;
    try {
      windowSeconds = parseWindow(window);
    } catch (error) {
      throw new StockPlatformError("INVALID_WINDOW", (error as Error).message, 400);
    }
    return summarize(this.cfg.priceTape, instrument, { windowSeconds, buckets: 48, now: this.now() });
  }

  private watchList(): readonly StockInstrument[] {
    const watch = this.cfg.watchInstruments;
    return typeof watch === "function" ? watch() : (watch ?? []);
  }

  /** By mint, by symbol, or by the underlying's ticker — among what is traded or merely watched. */
  private watchable(reference: string): StockInstrument {
    const wanted = reference.trim();
    const pool = [...this.instruments.values(), ...this.watchList()];
    const lower = wanted.toLowerCase();
    const found = pool.find((i) => i.mint === wanted)
      ?? pool.find((i) => i.symbol.toLowerCase() === lower)
      ?? pool.find((i) => i.underlyingSymbol?.toLowerCase() === lower && i.network !== "solana-devnet")
      ?? pool.find((i) => i.underlyingSymbol?.toLowerCase() === lower);
    if (!found) {
      throw new StockPlatformError(
        "UNKNOWN_INSTRUMENT",
        `not an instrument this deployment watches; known: ${pool.map((i) => i.symbol).join(", ")}`,
        404,
      );
    }
    return found;
  }

  /** The symbols the intelligence tools will answer for. */
  watched(): Array<{ symbol: string; mint: string; underlying?: string; network?: string; tradeable_here: boolean }> {
    const traded = new Set(this.instruments.keys());
    return [...this.instruments.values(), ...this.watchList()]
      .filter((instrument, index, all) => all.findIndex((other) => other.mint === instrument.mint) === index)
      .map((i) => ({
        symbol: i.symbol,
        mint: i.mint,
        underlying: i.underlyingSymbol,
        network: i.network,
        tradeable_here: traded.has(i.mint) && i.enabled,
      }));
  }

  private requireGuard(): StockMarketGuard {
    if (!this.cfg.marketGuard) {
      throw new StockPlatformError("MARKET_GUARD_DISABLED", "no price source is configured for the market guard", 503);
    }
    return this.cfg.marketGuard;
  }

  /** The gate's current evidence for anything watched, traded here or not. */
  async watchMarket(reference: string): Promise<StockMarketAssessment> {
    return this.requireGuard().assess(this.watchable(reference));
  }

  /** The tape's summary for anything watched. */
  watchPrices(reference: string, window = "1h"): PriceSummary {
    const instrument = this.watchable(reference);
    if (!this.cfg.priceTape) {
      throw new StockPlatformError("PRICES_DISABLED", "no live price tape is running on this deployment", 503);
    }
    let windowSeconds: number;
    try {
      windowSeconds = parseWindow(window);
    } catch (error) {
      throw new StockPlatformError("INVALID_WINDOW", (error as Error).message, 400);
    }
    return summarize(this.cfg.priceTape, instrument, { windowSeconds, buckets: 48, now: this.now() });
  }

  /**
   * "Is this quote fair?" — for a quote from any venue, executed anywhere.
   *
   * The caller states what they would pay and what they were promised; the
   * answer is the same verdict a trade through this hub would get, measured
   * against the same independently observed prices. Nothing is stored and
   * nothing is reserved: it is an opinion, with its evidence attached.
   */
  async checkExternalQuote(
    reference: string,
    quoted: { usdcIn: bigint; tokensOut: bigint; minimumTokensOut?: bigint; venue?: string },
  ): Promise<StockMarketAssessment> {
    const instrument = this.watchable(reference);
    if (quoted.usdcIn <= 0n || quoted.tokensOut <= 0n) {
      throw new StockPlatformError("INVALID_AMOUNT", "usdc_in and tokens_out must be positive base-unit integers");
    }
    const floor = quoted.minimumTokensOut ?? quoted.tokensOut;
    if (floor <= 0n || floor > quoted.tokensOut) {
      throw new StockPlatformError("INVALID_AMOUNT", "min_tokens_out must be positive and no more than tokens_out");
    }
    const guard = this.requireGuard();
    const price: QuotedPrice = {
      quote_id: "external",
      venue: quoted.venue,
      in_amount: quoted.usdcIn,
      out_amount: quoted.tokensOut,
      minimum_output: floor,
      out_decimals: instrument.decimals,
    };
    return guard.checkQuote(await guard.assess(instrument), price);
  }

  async market(instrumentMint: string): Promise<StockMarketAssessment> {
    const instrument = this.instruments.get(instrumentMint);
    if (!instrument?.enabled) throw new StockPlatformError("UNKNOWN_INSTRUMENT", "instrument is not available", 404);
    if (!this.cfg.marketGuard) {
      throw new StockPlatformError("MARKET_GUARD_DISABLED", "no price source is configured for the market guard", 503);
    }
    return this.cfg.marketGuard.assess(instrument);
  }

  async createQuote(
    agentId: string,
    instrumentMint: string,
    amountInUsdc: string,
    venueId?: string,
  ): Promise<StockQuoteView> {
    this.requireAgent(agentId);
    const instrument = this.instruments.get(instrumentMint);
    if (!instrument?.enabled) throw new StockPlatformError("UNKNOWN_INSTRUMENT", "instrument is not available", 404);
    const amount = parseAmount(amountInUsdc, "amount_in_usdc");
    const minimumTrade = this.cfg.minTradeUsdc ?? 1_000_000n;
    if (amount < minimumTrade) {
      throw new StockPlatformError("AMOUNT_TOO_SMALL", `the smallest trade is ${minimumTrade} base units of USDC`, 400);
    }
    this.evictExpiredQuotes();
    if (this.quotes.size >= (this.cfg.maxLiveQuotes ?? 5_000)) {
      throw new StockPlatformError("QUOTE_CAPACITY", "too many live quotes; retry shortly", 429);
    }
    const { venue, source } = this.resolveQuoteSource(venueId ?? this.venueFor(instrument));
    // Asked before the source is, because this route is anonymous: a venue the
    // owner has not approved can only ever produce a quote that is refused.
    if (!this.requireAgent(agentId).governor.isVenueApproved(venue)) {
      throw new StockPlatformError("UNAPPROVED_VENUE", `the owner has not approved venue "${venue}"`, 403);
    }
    const [raw, market] = await Promise.all([
      source.quote(instrument.usdcMint, instrument.mint, amount).catch((error: unknown) => {
        // The venue answered, and the answer was no. That is a fact about this
        // instrument on this venue, and an agent should be able to tell it from
        // an outage: one is worth retrying and the other is not.
        if (error instanceof NoRouteError) throw new StockPlatformError("NO_ROUTE", safeMessage(error, 160), 422);
        throw error;
      }),
      this.cfg.marketGuard?.assess(instrument) ?? Promise.resolve(undefined),
    ]);
    // Stamp the venue the platform routed to rather than trusting the source to
    // label itself; the intent is later checked against the owner's allowlist,
    // and a source that mislabelled a quote would be checked against the wrong
    // permission.
    const quote: JupiterQuote = { ...raw, venue };
    if (this.quotes.has(quote.quoteId)) {
      throw new StockPlatformError("DUPLICATE_QUOTE_ID", "quote provider reused a previously issued quote identifier", 503);
    }
    // Falling back to `outAmount` here would report the most optimistic possible
    // number to the agent as though the route guaranteed it, and then write that
    // invented floor into the intent. A source that states no threshold has
    // promised nothing, so there is no honest floor to quote.
    if (quote.minimumOutput === undefined) {
      throw new StockPlatformError(
        "QUOTE_WITHOUT_GUARANTEE",
        "quote provider returned no guaranteed minimum output",
        503,
      );
    }
    const minimum = quote.minimumOutput;
    // The floor is the number the chain will enforce, so the floor is the number
    // the gate measures against the market. Checking the expected fill instead
    // would grade the venue on a promise rather than on its guarantee.
    const checked = market && this.cfg.marketGuard
      ? this.cfg.marketGuard.checkQuote(market, {
        quote_id: quote.quoteId,
        venue,
        in_amount: quote.inAmount,
        out_amount: quote.outAmount,
        minimum_output: minimum,
        out_decimals: instrument.decimals,
      })
      : market;
    this.quotes.set(quote.quoteId, {
      quote: Object.freeze({ ...quote }),
      venue,
      minimumOutput: minimum,
      agentId,
      instrumentMint,
      market: checked,
    });
    return quoteView(agentId, quote, minimum, checked);
  }

  /** Which venues this deployment can actually quote, for an agent to choose from. */
  venues(): StockVenueView[] {
    return knownVenues()
      .filter((v) => v.id === this.defaultVenue() || this.cfg.venueQuotes?.[v.id])
      .map((v) => ({ id: v.id, label: v.label, program_id: v.programId, kind: v.kind }));
  }

  /**
   * Every settled trade, from the program's own records rather than this
   * process's memory. One account per intent, written by the trade itself.
   */
  async trades(limit = 50): Promise<{ source: string; trades: ChainTrade[]; note: string }> {
    if (!this.cfg.chain) throw new StockPlatformError("CHAIN_LEDGER_UNAVAILABLE", "this deployment does not execute on chain, so there are no on-chain records to read", 503);
    return {
      source: "chain",
      trades: await this.cfg.chain.trades(Math.min(Math.max(1, limit), 200)),
      note: "Written by the program, one per settled trade. The decision behind each is off-chain; only its hash is here.",
    };
  }

  /**
   * One trade by the intent id its agent used, which survives a restart of this
   * hub because the program wrote it down and this process did not.
   */
  async intent(intentId: string): Promise<{ intent_id: string; settled: boolean; trade?: ChainTrade; order?: StockOrderView }> {
    if (!intentId || intentId.length > 128) throw new StockPlatformError("INVALID_REQUEST", "an intent id is required", 400);
    const stored = [...this.orders.values()].find((order) => order.intent_id === intentId);
    if (!this.cfg.chain) {
      if (!stored) throw new StockPlatformError("ORDER_NOT_FOUND", "no order for that intent", 404);
      return { intent_id: intentId, settled: stored.status === "settled", order: publicOrder(stored) };
    }
    const trade = await this.cfg.chain.tradeFor(intentId);
    if (!trade && !stored) {
      throw new StockPlatformError("INTENT_NOT_FOUND", "the program has no record of that intent, and this hub has no order for it", 404);
    }
    return { intent_id: intentId, settled: Boolean(trade), trade: trade ?? undefined, order: stored ? publicOrder(stored) : undefined };
  }

  /** The curves this deployment watches; none is an answer, not an error. */
  async curves(): Promise<StockCurveView[]> {
    return (await this.cfg.curves?.()) ?? [];
  }

  private defaultVenue(): VenueId {
    return this.cfg.defaultVenue ?? DEFAULT_VENUE;
  }

  /**
   * The venue for a quote that names none.
   *
   * The deployment's default, unless this instrument is known to fill somewhere
   * else and not there: a curve's token trades on its curve, and sending it to
   * the default would only fetch a quote no route could settle. Only a venue
   * this deployment can quote is chosen, and an instrument nobody has measured
   * keeps the default, because an absent measurement is not a "no".
   */
  private venueFor(instrument: StockInstrument): VenueId {
    const fallback = this.defaultVenue();
    const fills = instrument.tradableVenues;
    if (!fills || fills.length === 0 || fills.includes(fallback)) return fallback;
    return fills.find((venue) => this.cfg.venueQuotes?.[venue]) ?? fallback;
  }

  /**
   * A quote is dead thirty seconds after it is issued but was kept forever, on
   * a route anyone can call. The map is insertion-ordered and the lifetime is
   * constant, so the expired ones are always at the front.
   */
  private evictExpiredQuotes(): void {
    const now = this.now();
    for (const [id, record] of this.quotes) {
      if (record.quote.expiresAt + 5 >= now) break;
      this.quotes.delete(id);
    }
  }

  /** Drop the oldest finished orders past the cap; one in flight is never dropped. */
  private evictOldOrders(): void {
    const cap = this.cfg.maxStoredOrders ?? 2_000;
    if (this.orders.size <= cap) return;
    for (const [id, order] of this.orders) {
      if (this.orders.size <= cap) break;
      if (order.status === "executing" || order.status === "pending_reconciliation") continue;
      this.orders.delete(id);
      for (const [key, orderId] of this.idempotency) if (orderId === id) this.idempotency.delete(key);
      for (const [key, orderId] of this.intentOrders) if (orderId === id) this.intentOrders.delete(key);
    }
  }

  private resolveQuoteSource(venueId?: string): { venue: VenueId; source: JupiterQuoteFetcher } {
    const venue = (venueId ?? this.defaultVenue()) as VenueId;
    try {
      resolveVenue(venue);
    } catch {
      throw new StockPlatformError("UNKNOWN_VENUE", `venue "${venue}" is not in the registry`, 400);
    }
    const source = this.cfg.venueQuotes?.[venue] ?? (venue === DEFAULT_VENUE ? this.cfg.quotes : undefined);
    if (!source) {
      // Configured venues and approved venues are different things: an owner may
      // allow Meteora on-chain long before this deployment can quote it.
      throw new StockPlatformError(
        "VENUE_UNAVAILABLE",
        `no quote source is configured for venue "${venue}"`,
        503,
      );
    }
    return { venue, source };
  }

  preview(request: StockOrderRequest) {
    const { agent, intent, quote, market, decisionRecord } = this.resolveIntent(request);
    const result = agent.governor.preview(intent, quote);
    const refusal = market?.refusal ?? (result.allowed ? undefined : { code: result.refusalCode, message: result.reason });
    return {
      allowed: result.allowed && market?.allowed !== false,
      refusal,
      intent_hash: intent.decisionHash,
      decision_record_hash: intent.decisionRecordHash,
      decision_record: cloneDecisionRecord(decisionRecord),
      market,
      policy: {
        epoch: result.epoch,
        per_trade_cap_usdc: result.perTradeCapUsdc.toString(),
        epoch_cap_usdc: result.epochCapUsdc.toString(),
        spent_usdc: result.spentUsdc.toString(),
        reserved_usdc: result.reservedUsdc.toString(),
        available_vault_usdc: result.availableVaultUsdc.toString(),
      },
    };
  }

  async execute(bearerToken: string, idempotencyKey: string, request: StockOrderRequest): Promise<StockOrderView> {
    if (this.cfg.executionMode === "disabled") {
      throw new StockPlatformError("EXECUTION_DISABLED", "Solana transaction signing is not configured", 503);
    }
    if (idempotencyKey.trim().length < 8) {
      throw new StockPlatformError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key must contain at least 8 characters");
    }
    // Who is asking comes before anything about what they are asking for: a
    // caller with no credential learns nothing about which orders exist.
    this.authenticate(this.requireAgent(request.agent_id), bearerToken);
    const fingerprint = stableHash(request);
    const replayKey = `${request.agent_id}:${idempotencyKey}`;
    const existingId = this.idempotency.get(replayKey);
    if (existingId) {
      const existing = this.orders.get(existingId)!;
      if (existing.requestFingerprint !== fingerprint) {
        throw new StockPlatformError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different order", 409);
      }
      this.authorize(this.requireAgent(request.agent_id), bearerToken, existing.instrument_mint);
      return publicOrder(existing);
    }
    const intentKey = `${request.agent_id}:${request.intent_id}`;
    const existingIntentOrderId = this.intentOrders.get(intentKey);
    if (existingIntentOrderId) {
      const existing = this.orders.get(existingIntentOrderId)!;
      if (existing.requestFingerprint !== fingerprint) {
        throw new StockPlatformError("INTENT_CONFLICT", "intent_id was already used for a different order", 409);
      }
      this.authorize(this.requireAgent(request.agent_id), bearerToken, existing.instrument_mint);
      this.idempotency.set(replayKey, existingIntentOrderId);
      return publicOrder(existing);
    }

    const { agent, intent, quote, market, decisionRecord } = this.resolveIntent(request);
    this.authorize(agent, bearerToken, intent.instrumentMint);

    // One quote, one attempt. Idempotency is keyed on the intent, so without
    // this an agent that timed out and previewed the same quote again would
    // hold a second intent for it — and a second intent is a second trade.
    const quoteRecord = this.quotes.get(request.quote_id);
    if (quoteRecord?.consumedBy && quoteRecord.consumedBy !== request.intent_id) {
      throw new StockPlatformError(
        "QUOTE_ALREADY_USED",
        "this quote was already executed under another intent; read that order instead of trading again",
        409,
      );
    }
    if (quoteRecord) quoteRecord.consumedBy = request.intent_id;

    const today = new Date(this.now() * 1000).toISOString().slice(0, 10);
    const dayKey = `${request.agent_id}:${today}`;
    const executionsToday = this.executionsByDay.get(dayKey) ?? 0;
    if (executionsToday >= (this.cfg.maxExecutionsPerDay ?? 40)) {
      throw new StockPlatformError(
        "EXECUTION_LIMIT",
        "this agent has used its executions for today; the limit resets at 00:00 UTC",
        429,
      );
    }
    for (const key of this.executionsByDay.keys()) if (!key.endsWith(today)) this.executionsByDay.delete(key);
    this.evictOldOrders();
    // The count exists to protect the fee payer, so it counts what costs the
    // fee payer: attempts that reach the chain. A refusal by the price gate or
    // the caps spends nothing and must not use up an agent's day.
    const counted: StockChainExecutor = {
      execute: (executing, quoted) => {
        this.executionsByDay.set(dayKey, (this.executionsByDay.get(dayKey) ?? 0) + 1);
        return this.cfg.executor.execute(executing, quoted);
      },
    };

    const orderId = `ord_${stableHash({ agent: request.agent_id, intent: request.intent_id }).slice(0, 24)}`;
    const timestamp = iso(this.now());
    const order: StoredOrder = {
      order_id: orderId,
      intent_id: request.intent_id,
      agent_id: request.agent_id,
      quote_id: request.quote_id,
      instrument_mint: intent.instrumentMint,
      status: "executing",
      created_at: timestamp,
      updated_at: timestamp,
      intent_hash: intent.decisionHash,
      decision_record_hash: intent.decisionRecordHash,
      decision_record: cloneDecisionRecord(decisionRecord),
      market,
      requestFingerprint: fingerprint,
    };
    this.orders.set(orderId, order);
    this.idempotency.set(replayKey, orderId);
    this.intentOrders.set(intentKey, orderId);

    if (market && !market.allowed) {
      order.status = "refused";
      order.refusal = market.refusal;
      order.updated_at = iso(this.now());
      return publicOrder(order);
    }

    try {
      const receipt = await agent.governor.execute(intent, quote, counted);
      order.status = "settled";
      order.receipt = receiptView(receipt);
    } catch (error) {
      if (error instanceof StockRefusal) {
        order.status = agent.governor.intentStatus(intent.intentId) === "pending" ? "pending_reconciliation" : "refused";
        order.refusal = { code: error.code, message: safeMessage(error.message) };
      } else {
        const pending = agent.governor.intentStatus(intent.intentId) === "pending";
        order.status = pending ? "pending_reconciliation" : "refused";
        order.refusal = {
          code: pending ? "EXECUTION_UNRESOLVED" : "EXECUTION_FAILED",
          // An RPC client puts the URL it was calling in its errors, and that
          // URL carries an API key. Order records are public.
          message: safeMessage(error),
        };
      }
    }
    order.updated_at = iso(this.now());
    return publicOrder(order);
  }

  order(orderId: string): StockOrderView {
    const order = this.orders.get(orderId);
    if (!order) {
      // An order id is this process's name for a trade, and nothing on chain
      // carries it. So a restarted hub cannot find one and must not imply the
      // trade did not happen: the intent id is what survives, and it says where.
      throw new StockPlatformError(
        "ORDER_NOT_FOUND",
        this.cfg.chain
          ? "this hub has no order by that id. Order ids do not survive a restart of the hub; ask for the trade by its intent id at GET /v1/stocks/intents/:intentId, which reads the program's own record."
          : "order was not found",
        404,
      );
    }
    return publicOrder(order);
  }

  portfolio(agentId: string) {
    const agent = this.requireAgent(agentId);
    const portfolio = agent.governor.portfolio();
    const status = agent.governor.status();
    return {
      agent_id: agentId,
      network: this.cfg.network ?? "solana-mainnet",
      usdc: {
        mint: this.listInstruments()[0]?.usdcMint,
        balance: portfolio.usdcBalance.toString(),
        reserved: portfolio.reservedUsdc.toString(),
        available: (portfolio.usdcBalance - portfolio.reservedUsdc).toString(),
      },
      policy: {
        suspended: status.suspended,
        epoch: status.epoch,
        spent_usdc: status.spent.toString(),
        pending_usdc: status.pending.toString(),
      },
      holdings: portfolio.holdings.map(({ mint, amount }) => ({
        mint,
        symbol: this.instruments.get(mint)?.symbol ?? "UNKNOWN",
        amount: amount.toString(),
      })),
    };
  }

  private resolveIntent(request: StockOrderRequest): {
    agent: StockAgentRegistration;
    intent: StockTradeIntent;
    quote: JupiterQuote;
    market?: StockMarketAssessment;
    decisionRecord: CommittedStockDecisionRecord;
  } {
    const agent = this.requireAgent(request.agent_id);
    const quoteRecord = this.quotes.get(request.quote_id);
    if (!quoteRecord || quoteRecord.agentId !== request.agent_id) {
      throw new StockPlatformError("QUOTE_NOT_FOUND", "quote is unknown or belongs to another agent", 404);
    }
    const instrument = this.instruments.get(quoteRecord.instrumentMint);
    if (!instrument) throw new StockPlatformError("UNKNOWN_INSTRUMENT", "quoted instrument is no longer registered", 404);
    const market = quoteRecord.market && this.cfg.marketGuard
      ? this.cfg.marketGuard.revalidate(quoteRecord.market)
      : quoteRecord.market;
    const intentExpiresAt = Date.parse(request.intent_expires_at);
    if (!Number.isFinite(intentExpiresAt)) throw new StockPlatformError("INVALID_INTENT_EXPIRY", "intent_expires_at must be an ISO timestamp");
    if (!request.decision?.strategy?.trim() || !request.decision?.rationale?.trim()) {
      throw new StockPlatformError("DECISION_REQUIRED", "decision.strategy and decision.rationale are required");
    }
    const record: CommittedStockDecisionRecord = {
      ...request.decision,
      agent_id: request.agent_id,
      intent_id: request.intent_id,
      quote_id: request.quote_id,
      market_evidence: market ? {
        provider: market.provider,
        evidence_hash: market.evidence_hash,
        premium_bps: market.premium_bps,
        quote_deviation_bps: market.quote?.deviation_bps,
        policy: market.policy,
      } : undefined,
    };
    const decisionRecordHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(record)));
    const base: Omit<StockTradeIntent, "decisionHash"> = {
      intentId: request.intent_id,
      agentId: request.agent_id,
      operator: agent.operator,
      instrumentMint: quoteRecord.instrumentMint,
      inputMint: quoteRecord.quote.inputMint,
      amountInUsdc: quoteRecord.quote.inAmount,
      minOutput: quoteRecord.minimumOutput,
      quoteId: quoteRecord.quote.quoteId,
      quoteExpiresAt: quoteRecord.quote.expiresAt,
      intentExpiresAt: Math.floor(intentExpiresAt / 1000),
      decisionRecordHash,
    };
    return {
      agent,
      quote: quoteRecord.quote,
      market,
      decisionRecord: record,
      intent: { ...base, decisionHash: decisionHash(base) },
    };
  }

  private authenticate(agent: StockAgentRegistration, bearerToken: string): StockOperatorCredential {
    const credential = agent.credentials.find((candidate) => safeEqual(candidate.token, bearerToken));
    if (!credential) throw new StockPlatformError("UNAUTHORIZED_OPERATOR", "operator credential is invalid", 401);
    return credential;
  }

  private authorize(agent: StockAgentRegistration, bearerToken: string, mint: string): void {
    const credential = this.authenticate(agent, bearerToken);
    if (!credential.allowedMints.has(mint)) {
      throw new StockPlatformError("OPERATOR_SCOPE_VIOLATION", "operator credential is not scoped for this instrument", 403);
    }
  }

  private requireAgent(agentId: string): StockAgentRegistration {
    const agent = this.agents.get(agentId);
    if (!agent) throw new StockPlatformError("AGENT_NOT_FOUND", "stock agent was not found", 404);
    return agent;
  }
}

function parseAmount(value: string, field: string): bigint {
  if (!/^\d+$/.test(value ?? "")) throw new StockPlatformError("INVALID_AMOUNT", `${field} must be an integer base-unit string`);
  const amount = BigInt(value);
  if (amount <= 0n) throw new StockPlatformError("INVALID_AMOUNT", `${field} must be positive`);
  return amount;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function cloneInstrument(instrument: StockInstrument): StockInstrument {
  return {
    ...instrument,
    transferRules: [...(instrument.transferRules ?? [])],
    tradableVenues: instrument.tradableVenues ? [...instrument.tradableVenues] : undefined,
    routabilityUnknownVenues: instrument.routabilityUnknownVenues
      ? [...instrument.routabilityUnknownVenues]
      : undefined,
    referenceData: instrument.referenceData ? { ...instrument.referenceData } : undefined,
  };
}

/** A provider's failure, as shown to anyone who lists the catalogue. */
function errorMessage(error: unknown): string {
  return safeMessage(error, 160);
}

function quoteView(
  agentId: string,
  quote: JupiterQuote,
  minimumOutput: bigint,
  market?: StockMarketAssessment,
): StockQuoteView {
  return {
    quote_id: quote.quoteId,
    agent_id: agentId,
    input_mint: quote.inputMint,
    instrument_mint: quote.outputMint,
    amount_in_usdc: quote.inAmount.toString(),
    estimated_output: quote.outAmount.toString(),
    minimum_output: minimumOutput.toString(),
    route: quote.route,
    venue: quote.venue ?? DEFAULT_VENUE,
    expires_at: iso(quote.expiresAt),
    market: market ? cloneMarket(market) : undefined,
  };
}

function receiptView(receipt: StockReceipt) {
  return {
    intent_id: receipt.intentId,
    agent_id: receipt.agentId,
    instrument_mint: receipt.instrumentMint,
    input_amount_usdc: receipt.inputAmount.toString(),
    output_amount: receipt.outputAmount.toString(),
    minimum_output_satisfied: receipt.slippageSatisfied,
    intent_hash: receipt.decisionHash,
    decision_record_hash: receipt.decisionRecordHash,
    transaction_signature: receipt.txSignature,
    epoch: receipt.epoch,
    spent_after_usdc: receipt.spentAfter.toString(),
    committed_at: receipt.committedAt,
  };
}

function publicOrder(order: StoredOrder): StockOrderView {
  const { requestFingerprint: _private, ...view } = order;
  return {
    ...view,
    decision_record: cloneDecisionRecord(view.decision_record),
    market: view.market ? cloneMarket(view.market) : undefined,
    receipt: view.receipt ? { ...view.receipt } : undefined,
    refusal: view.refusal ? { ...view.refusal } : undefined,
  };
}

function cloneDecisionRecord(record: CommittedStockDecisionRecord): CommittedStockDecisionRecord {
  return structuredClone(record);
}

function cloneMarket(market: StockMarketAssessment): StockMarketAssessment {
  return structuredClone(market);
}
