import { BackpackMarketDiscovery, JupiterV2QuoteProvider, SOLANA_USDC_MINT, VERIFIED_XSTOCKS } from "../stocks";

async function main() {
  const taker = process.env.SOLANA_STOCKS_TAKER ?? VERIFIED_XSTOCKS[0].mint;
  const quotes = new JupiterV2QuoteProvider({ taker, apiKey: process.env.JUPITER_API_KEY });
  const backpack = new BackpackMarketDiscovery();
  const rows = [];
  for (const [index, instrument] of VERIFIED_XSTOCKS.entries()) {
    if (index > 0 && !process.env.JUPITER_API_KEY) {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    }
    try {
      const quote = await quotes.quote(SOLANA_USDC_MINT, instrument.mint, 1_000_000n);
      rows.push({
        symbol: instrument.symbol,
        mint: instrument.mint,
        token_program: instrument.tokenProgram,
        route: quote.route,
        one_usdc_output_base_units: quote.outAmount.toString(),
        minimum_output_base_units: quote.minimumOutput?.toString(),
        jupiter_program: quotes.buildFor(quote.quoteId)?.swapInstruction.programId,
      });
    } catch (error) {
      rows.push({ symbol: instrument.symbol, mint: instrument.mint, route_error: (error as Error).message });
    }
  }
  const availability = await backpack.availability(VERIFIED_XSTOCKS);
  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    network: "solana-mainnet",
    amount_in_usdc_base_units: "1000000",
    instruments: rows,
    backpack: availability,
  }, null, 2));
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
