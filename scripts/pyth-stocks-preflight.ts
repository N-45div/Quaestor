import {
  PYTH_STOCK_FEEDS,
  PythProStockSource,
  PythStockGuard,
  VERIFIED_XSTOCKS,
} from "../stocks";

async function main() {
  const catalogs = await Promise.all(VERIFIED_XSTOCKS.map(async (instrument) => {
    const definitions = PYTH_STOCK_FEEDS[instrument.mint];
    const response = await fetch(`https://pyth.dourolabs.app/v1/symbols?query=${encodeURIComponent(instrument.underlyingSymbol ?? instrument.symbol)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Pyth symbol catalog failed (${response.status})`);
    const rows = await response.json() as { pyth_lazer_id?: number; symbol?: string; hermes_id?: string; state?: string }[];
    const verify = (expected: typeof definitions.underlying) => {
      const actual = rows.find((row) => row.symbol === expected.symbol);
      return {
        symbol: expected.symbol,
        expected_lazer_id: expected.lazerId,
        expected_hermes_id: expected.hermesId,
        live_lazer_id: actual?.pyth_lazer_id,
        live_hermes_id: actual?.hermes_id,
        state: actual?.state,
        matches: actual?.pyth_lazer_id === expected.lazerId && actual?.hermes_id === expected.hermesId && actual?.state === "stable",
      };
    };
    return {
      instrument: instrument.symbol,
      underlying: verify(definitions.underlying),
      tokenized: verify(definitions.tokenized),
    };
  }));

  if (catalogs.some((item) => !item.underlying.matches || !item.tokenized.matches)) {
    throw new Error("one or more configured Pyth feeds no longer match the live catalog");
  }

  const apiKey = process.env.PYTH_PRO_API_KEY;
  const assessments = apiKey
    ? await Promise.all(VERIFIED_XSTOCKS.map((instrument) => new PythStockGuard(
      new PythProStockSource({ apiKey }),
      {
        max_feed_age_seconds: Number(process.env.SOLANA_STOCK_PYTH_MAX_AGE_SECONDS ?? 30),
        max_absolute_premium_bps: Number(process.env.SOLANA_STOCK_PYTH_MAX_PREMIUM_BPS ?? 300),
        max_confidence_bps: Number(process.env.SOLANA_STOCK_PYTH_MAX_CONFIDENCE_BPS ?? 100),
        min_publishers: Number(process.env.SOLANA_STOCK_PYTH_MIN_PUBLISHERS ?? 2),
      },
    ).assess(instrument)))
    : { status: "not_run", reason: "set PYTH_PRO_API_KEY to check current signed prices" };

  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    catalog_source: "https://pyth.dourolabs.app/v1/symbols",
    catalogs,
    price_assessments: assessments,
  }, null, 2));
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
