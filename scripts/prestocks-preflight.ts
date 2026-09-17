/**
 * What PreStocks lists, and which of it can actually be traded.
 *
 *   npm run stocks:prestocks:preflight
 *
 * The catalogue half was always here: live provider data with every mint
 * verified against Token-2022 on-chain. The second half asks each configured
 * venue for a small quote, because a listed instrument and a tradeable one are
 * different facts and only a venue can settle the difference.
 *
 * Set SOLANA_STOCKS_TAKER to probe live Jupiter. Without it the run still
 * reports the catalogue, and every instrument is honestly discovery-only.
 */
import * as dotenv from "dotenv";
import {
  JupiterV2QuoteProvider,
  PreStocksRegistry,
  quoteProbeRoutability,
  SolanaRpcMintVerifier,
  type QuoteProbe,
  type VenueId,
} from "../stocks";

dotenv.config();

/** One USDC: large enough for a router to price, small enough to ask about often. */
const PROBE_AMOUNT = 1_000_000n;

function probes(): Partial<Record<VenueId, QuoteProbe>> {
  const taker = process.env.SOLANA_STOCKS_TAKER;
  if (!taker) return {};
  return {
    jupiter: new JupiterV2QuoteProvider({
      taker,
      apiKey: process.env.JUPITER_API_KEY,
      // A probe is a question, not an order. The tightest slippage that still
      // returns a route is the one that tells us a real fill exists.
      slippageBps: Number(process.env.JUPITER_PROBE_SLIPPAGE_BPS ?? 50),
    }),
  };
}

async function main(): Promise<void> {
  const configured = probes();
  const venues = Object.keys(configured) as VenueId[];
  const registry = new PreStocksRegistry(
    new SolanaRpcMintVerifier(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"),
    venues.length > 0
      ? {
        routability: quoteProbeRoutability(configured, {
          probeAmount: PROBE_AMOUNT,
          attempts: 3,
          // Jupiter's public tier rate-limits well below the rate a parallel
          // probe would ask at, and a throttled probe reads as an illiquid
          // market unless it is slowed down.
          spacingMs: Number(process.env.JUPITER_PROBE_SPACING_MS ?? 400),
        }),
      }
      : {},
  );

  const instruments = await registry.instruments();
  const tradeable = instruments.filter((instrument) => instrument.enabled);
  const unknown = instruments.filter((i) => (i.routabilityUnknownVenues?.length ?? 0) > 0);

  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    provider: registry.provider,
    probed_venues: venues,
    probe_amount_usdc: PROBE_AMOUNT.toString(),
    // Say so, rather than letting "nothing was probed" read as "nothing trades".
    note: venues.length === 0
      ? "no venue probed — set SOLANA_STOCKS_TAKER to test routability; every instrument is reported discovery-only"
      : undefined,
    count: instruments.length,
    tradeable_count: tradeable.length,
    // Reported separately: a venue that could not be asked has not said no.
    routability_unknown_count: unknown.length,
    instruments: instruments.map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      mint: instrument.mint,
      token_program: instrument.tokenProgram,
      decimals: instrument.decimals,
      execution_status: instrument.executionStatus,
      tradable_venues: instrument.tradableVenues ?? [],
      routability_unknown_venues: instrument.routabilityUnknownVenues ?? [],
      provider_reported_supply: instrument.referenceData?.providerReportedSupply,
      onchain_mint_supply: instrument.referenceData?.onchainMintSupply,
      mark_price_usd: instrument.referenceData?.markPriceUsd,
      token_price_usd: instrument.referenceData?.tokenPriceUsd,
      premium_bps: instrument.referenceData?.premiumBps,
    })),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
