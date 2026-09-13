import { StockRefusal } from "./types";
import type { JupiterQuote, StockInstrument, StockTradeIntent } from "./types";

/**
 * The small part of Jupiter that the governor needs to trust: a quote must be
 * for the exact mints and input amount in the intent, and it must still be
 * live when execution begins.
 */
export function validateJupiterQuote(
  intent: StockTradeIntent,
  instrument: StockInstrument,
  quote: JupiterQuote,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (quote.expiresAt <= nowSeconds || intent.quoteExpiresAt <= nowSeconds) {
    throw new StockRefusal("QUOTE_EXPIRED", "Jupiter quote has expired");
  }
  if (quote.quoteId !== intent.quoteId || quote.route.length === 0) {
    throw new StockRefusal("QUOTE_MISMATCH", "quote identity or route does not match intent");
  }
  if (quote.inputMint !== intent.inputMint || quote.outputMint !== instrument.mint) {
    throw new StockRefusal("QUOTE_MISMATCH", "quote mints do not match the approved instrument");
  }
  if (quote.inAmount !== intent.amountInUsdc || quote.outAmount < intent.minOutput) {
    throw new StockRefusal("SLIPPAGE_EXCEEDED", "quoted output is below the intent minimum");
  }
}

export interface JupiterQuoteFetcher {
  quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote>;
}

/**
 * Production adapter boundary. The network implementation can use Jupiter's
 * /quote and /build endpoints without putting HTTP details into policy code.
 */
export interface JupiterTransactionBuilder {
  build(quote: JupiterQuote, owner: string): Promise<unknown>;
}
