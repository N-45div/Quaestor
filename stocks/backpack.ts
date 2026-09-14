import { z } from "zod";
import type { StockInstrument } from "./types";

const securitySchema = z.object({
  asset: z.string(),
  name: z.string(),
  cusip: z.string().nullable().optional(),
  sessions: z.array(z.object({
    name: z.string(),
    minQuantity: z.string(),
    maxQuantity: z.string(),
    stepSize: z.string(),
  })),
});

const marketSchema = z.object({
  symbol: z.string(),
  baseSymbol: z.string(),
  quoteSymbol: z.string(),
  marketType: z.string(),
  rwaMarketType: z.string().nullable().optional(),
  orderBookState: z.string().optional(),
  visible: z.boolean().optional(),
});

export interface BackpackInstrumentView {
  instrument_mint: string;
  xstock_symbol: string;
  security: z.infer<typeof securitySchema> | null;
  markets: z.infer<typeof marketSchema>[];
}

export interface StockMarketDiscovery {
  availability(instruments: readonly StockInstrument[]): Promise<BackpackInstrumentView[]>;
}

/** Public Backpack data enriches discovery; execution remains on-chain via Jupiter. */
export class BackpackMarketDiscovery implements StockMarketDiscovery {
  private cache: { expiresAt: number; value: BackpackInstrumentView[] } | null = null;

  constructor(private readonly baseUrl = "https://api.backpack.exchange", private readonly cacheMs = 60_000) {}

  async availability(instruments: readonly StockInstrument[]): Promise<BackpackInstrumentView[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value.map(cloneView);
    const [securitiesResponse, marketsResponse] = await Promise.all([
      fetch(`${this.baseUrl}/api/v1/securities`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${this.baseUrl}/api/v1/markets`, { signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!securitiesResponse.ok || !marketsResponse.ok) {
      throw new Error(`Backpack discovery failed (${securitiesResponse.status}/${marketsResponse.status})`);
    }
    const securities = z.array(securitySchema).parse(await securitiesResponse.json());
    const markets = z.array(marketSchema).parse(await marketsResponse.json());
    const value = instruments.map((instrument) => {
      const asset = `${instrument.underlyingSymbol ?? instrument.symbol.replace(/x$/, "")}.US`;
      return {
        instrument_mint: instrument.mint,
        xstock_symbol: instrument.symbol,
        security: securities.find((item) => item.asset === asset) ?? null,
        markets: markets.filter((item) => item.baseSymbol === asset && item.rwaMarketType === "STOCK"),
      };
    });
    this.cache = { expiresAt: Date.now() + this.cacheMs, value };
    return value.map(cloneView);
  }
}

function cloneView(view: BackpackInstrumentView): BackpackInstrumentView {
  return {
    ...view,
    security: view.security ? { ...view.security, sessions: view.security.sessions.map((session) => ({ ...session })) } : null,
    markets: view.markets.map((market) => ({ ...market })),
  };
}

