import { createHash, timingSafeEqual } from "node:crypto";
import { ethers } from "ethers";
import type { JupiterQuoteFetcher } from "./jupiter";
import { decisionHash, type StockChainExecutor, StockGovernor } from "./governor";
import { StockRefusal, type JupiterQuote, type StockInstrument, type StockReceipt, type StockTradeIntent } from "./types";
import type { StockMarketDiscovery } from "./backpack";
import type { StockMarketAssessment, StockMarketGuard } from "./pyth";

export interface StockDecisionRecord {
  strategy: string;
  rationale: string;
  model?: string;
  inputs?: Record<string, unknown>;
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
  expires_at: string;
  market?: StockMarketAssessment;
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
  agents: StockAgentRegistration[];
  quotes: JupiterQuoteFetcher;
  executor: StockChainExecutor;
  marketDiscovery?: StockMarketDiscovery;
  marketGuard?: StockMarketGuard;
  executionMode?: "live" | "simulation" | "disabled";
  now?: () => number;
}

type QuoteRecord = { quote: JupiterQuote; agentId: string; instrumentMint: string; market?: StockMarketAssessment };
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
  }

  discovery() {
    return {
      version: "2026-09-14",
      network: "solana-mainnet",
      execution: this.cfg.executionMode ?? "live",
      amounts: "integer base-unit strings",
      endpoints: {
        instruments: "GET /v1/stocks/instruments",
        backpack_market_data: "GET /v1/stocks/backpack",
        pyth_market_evidence: "GET /v1/stocks/markets/:instrumentMint",
        quote: "POST /v1/stocks/quotes",
        policy_preview: "POST /v1/stocks/policy/preview",
        execute: "POST /v1/stocks/orders",
        order_status: "GET /v1/stocks/orders/:orderId",
        portfolio: "GET /v1/stocks/portfolio?agent_id=...",
      },
    };
  }

  listInstruments(): StockInstrument[] {
    return [...this.instruments.values()].map((instrument) => ({ ...instrument, transferRules: [...(instrument.transferRules ?? [])] }));
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

  async market(instrumentMint: string): Promise<StockMarketAssessment> {
    const instrument = this.instruments.get(instrumentMint);
    if (!instrument?.enabled) throw new StockPlatformError("UNKNOWN_INSTRUMENT", "instrument is not available", 404);
    if (!this.cfg.marketGuard) {
      throw new StockPlatformError("MARKET_GUARD_DISABLED", "Pyth market guard is not configured", 503);
    }
    return this.cfg.marketGuard.assess(instrument);
  }

  async createQuote(agentId: string, instrumentMint: string, amountInUsdc: string): Promise<StockQuoteView> {
    this.requireAgent(agentId);
    const instrument = this.instruments.get(instrumentMint);
    if (!instrument?.enabled) throw new StockPlatformError("UNKNOWN_INSTRUMENT", "instrument is not available", 404);
    const amount = parseAmount(amountInUsdc, "amount_in_usdc");
    const [quote, market] = await Promise.all([
      this.cfg.quotes.quote(instrument.usdcMint, instrument.mint, amount),
      this.cfg.marketGuard?.assess(instrument) ?? Promise.resolve(undefined),
    ]);
    const minimum = quote.minimumOutput ?? quote.outAmount;
    this.quotes.set(quote.quoteId, { quote: Object.freeze({ ...quote }), agentId, instrumentMint, market });
    return quoteView(agentId, quote, minimum, market);
  }

  preview(request: StockOrderRequest) {
    const { agent, intent, quote, market } = this.resolveIntent(request);
    const result = agent.governor.preview(intent, quote);
    const refusal = market?.refusal ?? (result.allowed ? undefined : { code: result.refusalCode, message: result.reason });
    return {
      allowed: result.allowed && market?.allowed !== false,
      refusal,
      intent_hash: intent.decisionHash,
      decision_record_hash: intent.decisionRecordHash,
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
    const { agent, intent, quote, market } = this.resolveIntent(request);
    this.authorize(agent, bearerToken, intent.instrumentMint);

    const fingerprint = stableHash(request);
    const replayKey = `${request.agent_id}:${idempotencyKey}`;
    const existingId = this.idempotency.get(replayKey);
    if (existingId) {
      const existing = this.orders.get(existingId)!;
      if (existing.requestFingerprint !== fingerprint) {
        throw new StockPlatformError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different order", 409);
      }
      return publicOrder(existing);
    }
    const intentKey = `${request.agent_id}:${request.intent_id}`;
    const existingIntentOrderId = this.intentOrders.get(intentKey);
    if (existingIntentOrderId) {
      const existing = this.orders.get(existingIntentOrderId)!;
      if (existing.requestFingerprint !== fingerprint) {
        throw new StockPlatformError("INTENT_CONFLICT", "intent_id was already used for a different order", 409);
      }
      this.idempotency.set(replayKey, existingIntentOrderId);
      return publicOrder(existing);
    }

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
      const receipt = await agent.governor.execute(intent, quote, this.cfg.executor);
      order.status = "settled";
      order.receipt = receiptView(receipt);
    } catch (error) {
      if (error instanceof StockRefusal) {
        order.status = agent.governor.intentStatus(intent.intentId) === "pending" ? "pending_reconciliation" : "refused";
        order.refusal = { code: error.code, message: error.message };
      } else {
        order.status = "pending_reconciliation";
        order.refusal = { code: "EXECUTION_UNRESOLVED", message: (error as Error).message ?? String(error) };
      }
    }
    order.updated_at = iso(this.now());
    return publicOrder(order);
  }

  order(orderId: string): StockOrderView {
    const order = this.orders.get(orderId);
    if (!order) throw new StockPlatformError("ORDER_NOT_FOUND", "order was not found", 404);
    return publicOrder(order);
  }

  portfolio(agentId: string) {
    const agent = this.requireAgent(agentId);
    const portfolio = agent.governor.portfolio();
    const status = agent.governor.status();
    return {
      agent_id: agentId,
      network: "solana-mainnet",
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
    const record = {
      ...request.decision,
      agent_id: request.agent_id,
      intent_id: request.intent_id,
      quote_id: request.quote_id,
      market_evidence: market ? {
        provider: market.provider,
        evidence_hash: market.evidence_hash,
        premium_bps: market.premium_bps,
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
      minOutput: quoteRecord.quote.minimumOutput ?? quoteRecord.quote.outAmount,
      quoteId: quoteRecord.quote.quoteId,
      quoteExpiresAt: quoteRecord.quote.expiresAt,
      intentExpiresAt: Math.floor(intentExpiresAt / 1000),
      decisionRecordHash,
    };
    return { agent, quote: quoteRecord.quote, market, intent: { ...base, decisionHash: decisionHash(base) } };
  }

  private authorize(agent: StockAgentRegistration, bearerToken: string, mint: string): void {
    const credential = agent.credentials.find((candidate) => safeEqual(candidate.token, bearerToken));
    if (!credential) throw new StockPlatformError("UNAUTHORIZED_OPERATOR", "operator credential is invalid", 401);
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
    market: view.market ? cloneMarket(view.market) : undefined,
    receipt: view.receipt ? { ...view.receipt } : undefined,
    refusal: view.refusal ? { ...view.refusal } : undefined,
  };
}

function cloneMarket(market: StockMarketAssessment): StockMarketAssessment {
  return {
    ...market,
    refusal: market.refusal ? { ...market.refusal } : undefined,
    policy: { ...market.policy },
    feeds: {
      underlying: { ...market.feeds.underlying },
      tokenized: { ...market.feeds.tokenized },
    },
  };
}
