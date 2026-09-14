import type { StockInstrument, StockOrderRequest, StockOrderView, StockQuoteView } from "../stocks";

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
    const body = await this.call<{ instruments: StockInstrument[] }>("/v1/stocks/instruments");
    return body.instruments;
  }

  backpackAvailability(): Promise<Record<string, unknown>> {
    return this.call("/v1/stocks/backpack");
  }

  quote(agentId: string, instrumentMint: string, amountInUsdc: bigint): Promise<StockQuoteView> {
    return this.call("/v1/stocks/quotes", {
      method: "POST",
      body: { agent_id: agentId, instrument_mint: instrumentMint, amount_in_usdc: amountInUsdc.toString() },
    });
  }

  preview(request: StockOrderRequest): Promise<{
    allowed: boolean;
    refusal?: { code?: string; message?: string };
    intent_hash: string;
    decision_record_hash: string;
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
    });
  }

  order(orderId: string): Promise<StockOrderView> {
    return this.call(`/v1/stocks/orders/${encodeURIComponent(orderId)}`);
  }

  portfolio(agentId: string): Promise<Record<string, unknown>> {
    return this.call(`/v1/stocks/portfolio?agent_id=${encodeURIComponent(agentId)}`);
  }

  private async call<T>(path: string, options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    acceptStatuses?: number[];
  } = {}): Promise<T> {
    const response = await this.request(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20_000),
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
