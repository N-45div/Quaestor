/**
 * Quotes for a devnet instrument, priced from the live market.
 *
 * Devnet has no xStocks and no aggregator liquidity for them — nobody issues
 * tokenized equities there — so the instrument is a test mint. That does not
 * mean the price has to be invented: the reference the tape already samples
 * from mainnet is a real, current price for the underlying, and the devnet
 * instrument is quoted against it.
 *
 * So the *asset* is a stand-in and everything else is real: a live price, a
 * real venue program, a real transaction, and a governor that measures what
 * actually happened.
 *
 * Fails closed. Without a live price there is no quote, because a governor that
 * priced a trade off a guess would be the thing this project exists to prevent.
 */
import { randomUUID } from "node:crypto";
import type { JupiterQuoteFetcher } from "./jupiter";
import type { JupiterQuote } from "./types";
import { NoRouteError, type VenueId } from "./venues";

export interface DevnetQuoteConfig {
  /** The venue these quotes are executable through. */
  venue: VenueId;
  /**
   * The one mint this venue fills. The stub would swap anything it is handed,
   * and a quote for another instrument at this one's decimals and price is
   * worse than no quote, so anything else is answered with "no route".
   */
  mint?: string;
  /** Decimals of the instrument being bought. USDC input is always six. */
  instrumentDecimals: number;
  /** Live price of one unit of the underlying, in USD. */
  priceUsd: () => Promise<number | undefined>;
  /** How far below the expected fill the guaranteed floor sits. */
  slippageBps?: number;
  quoteTtlSeconds?: number;
  now?: () => number;
}

const USDC_DECIMALS = 6;

export class DevnetQuoteProvider implements JupiterQuoteFetcher {
  private readonly now: () => number;

  constructor(private readonly cfg: DevnetQuoteConfig) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote> {
    if (amount <= 0n) throw new Error("quote amount must be positive");
    if (this.cfg.mint !== undefined && outputMint !== this.cfg.mint) {
      throw new NoRouteError(`${this.cfg.venue} fills one instrument, and this is not it`);
    }
    const price = await this.cfg.priceUsd();
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      throw new Error("no live price for this instrument — refusing to quote");
    }

    // USDC in, instrument out, at the live price of the underlying.
    const usd = Number(amount) / 10 ** USDC_DECIMALS;
    const outAmount = BigInt(Math.floor((usd / price) * 10 ** this.cfg.instrumentDecimals));
    if (outAmount <= 0n) throw new Error("amount is too small to buy a single unit at the live price");

    const slippageBps = BigInt(this.cfg.slippageBps ?? 50);
    // The floor the venue is held to. The governor authorises on this number,
    // never on the expected fill.
    const minimumOutput = (outAmount * (10_000n - slippageBps)) / 10_000n;

    return Object.freeze({
      quoteId: randomUUID(),
      venue: this.cfg.venue,
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount,
      minimumOutput,
      route: `${this.cfg.venue} / devnet @ $${price.toFixed(2)}`,
      expiresAt: this.now() + (this.cfg.quoteTtlSeconds ?? 30),
    });
  }
}
