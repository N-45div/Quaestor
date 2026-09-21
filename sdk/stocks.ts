import type {
  CommittedStockDecisionRecord,
  StockInstrument,
  StockInstrumentCatalog,
  StockMarketAssessment,
  StockOrderRequest,
  StockOrderView,
  StockQuoteView,
  StockVenueView,
  PriceSummary,
} from "../stocks";

export class QuaestorStocksApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "QuaestorStocksApiError";
  }
}

export interface QuaestorStocksClientConfig {
  baseUrl: string;
  operatorToken?: string;
  fetch?: typeof fetch;
  /**
   * How long to wait for an execution. Longer than any other call: the hub may
   * wait out a blockhash to learn what an ambiguous submission did, and giving
   * up first reports a failure for a trade that is still in flight.
   */
  executeTimeoutMs?: number;
}

/** HTTP client shared by rules engines, LLM agents and the MCP adapter. */
export class QuaestorStocksClient {
  private readonly request: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly cfg: QuaestorStocksClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.request = cfg.fetch ?? fetch;
  }

  discovery(): Promise<Record<string, unknown>> {
    return this.call("/v1/stocks");
  }

  async instruments(): Promise<StockInstrument[]> {
    return (await this.instrumentCatalog()).instruments;
  }

  instrumentCatalog(): Promise<StockInstrumentCatalog> {
    return this.call("/v1/stocks/instruments");
  }

  backpackAvailability(): Promise<Record<string, unknown>> {
    return this.call("/v1/stocks/backpack");
  }

  /** Where a stock and its underlying have traded over a window, pre-summarised. */
  prices(instrumentMint: string, window = "1h"): Promise<PriceSummary> {
    return this.call(`/v1/stocks/prices/${encodeURIComponent(instrumentMint)}?window=${encodeURIComponent(window)}`);
  }

  market(instrumentMint: string): Promise<StockMarketAssessment> {
    return this.call(`/v1/stocks/markets/${encodeURIComponent(instrumentMint)}`);
  }

  /** Venues this deployment can quote. An agent picks from these; it cannot add one. */
  async venues(): Promise<StockVenueView[]> {
    return (await this.call<{ venues: StockVenueView[] }>("/v1/stocks/venues")).venues;
  }

  /**
   * A quote from one venue. Omitting `venue` uses the deployment's default, so
   * callers written before venues existed keep working unchanged.
   */
  quote(agentId: string, instrumentMint: string, amountInUsdc: bigint, venue?: string): Promise<StockQuoteView> {
    return this.call("/v1/stocks/quotes", {
      method: "POST",
      body: {
        agent_id: agentId,
        instrument_mint: instrumentMint,
        amount_in_usdc: amountInUsdc.toString(),
        ...(venue ? { venue } : {}),
      },
    });
  }

  preview(request: StockOrderRequest): Promise<{
    allowed: boolean;
    refusal?: { code?: string; message?: string };
    intent_hash: string;
    decision_record_hash: string;
    decision_record: CommittedStockDecisionRecord;
    market?: StockMarketAssessment;
    policy: Record<string, string | number>;
  }> {
    return this.call("/v1/stocks/policy/preview", { method: "POST", body: request });
  }

  execute(request: StockOrderRequest, idempotencyKey = request.intent_id): Promise<StockOrderView> {
    if (!this.cfg.operatorToken) throw new Error("operatorToken is required for stock execution");
    return this.call("/v1/stocks/orders", {
      method: "POST",
      body: request,
      headers: {
        Authorization: `Bearer ${this.cfg.operatorToken}`,
        "Idempotency-Key": idempotencyKey,
      },
      acceptStatuses: [422],
      timeoutMs: this.cfg.executeTimeoutMs,
    });
  }

  order(orderId: string): Promise<StockOrderView> {
    return this.call(`/v1/stocks/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * One trade by the intent id its agent used, from the program's own record.
   *
   * An order id is the hub's name for a trade and dies with the process that
   * made it; the intent id is the agent's, and the program hashed it into an
   * account that outlives any hub.
   */
  intent(intentId: string): Promise<Record<string, unknown>> {
    return this.call(`/v1/stocks/intents/${encodeURIComponent(intentId)}`);
  }

  /** Every settled trade, newest first, as the program recorded them. */
  trades(limit = 50): Promise<Record<string, unknown>> {
    return this.call(`/v1/stocks/trades?limit=${encodeURIComponent(String(limit))}`);
  }

  portfolio(agentId: string): Promise<Record<string, unknown>> {
    return this.call(`/v1/stocks/portfolio?agent_id=${encodeURIComponent(agentId)}`);
  }

  private async call<T>(path: string, options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    acceptStatuses?: number[];
    timeoutMs?: number;
  } = {}): Promise<T> {
    const response = await this.request(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok && !options.acceptStatuses?.includes(response.status)) {
      const error = body && typeof body === "object" && "error" in body
        ? (body as { error: { code?: string; message?: string } }).error
        : {};
      throw new QuaestorStocksApiError(response.status, error.code ?? "HTTP_ERROR", error.message ?? response.statusText);
    }
    return body as T;
  }
}
