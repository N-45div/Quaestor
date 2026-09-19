# Quaestor Stocks — Day 3

> **Superseded — note added 19 Sep 2026.** This is a dated build log and the
> text below is left as it was written, but almost none of it describes the
> running system. The Pyth guard was removed on 18 Sep 2026 (commit `aea10cf`):
> the sponsor was dropped and the Pyth Pro API would not serve us equity feeds,
> so the guard could never run. `stocks/pyth.ts`, `test/pyth-stocks.test.ts`,
> `scripts/pyth-stocks-preflight.ts` and the `stocks:pyth:preflight` script no
> longer exist, and nothing reads `PYTH_PRO_API_KEY` or any
> `SOLANA_STOCK_PYTH_*` variable.
>
> What replaced it is the multi-source price gate in `stocks/market-guard.ts`.
> Before an intent is signed it measures the floor a quote guarantees against
> prices observed independently of the venue: two reference sources (the
> Backpack perp index and the issuer's underlying price carried in Jupiter's
> price v3 response) plus Jupiter for the token. It reads the tape the hub
> already samples, fails closed, and widens the premium band outside regular US
> hours. Its refusal codes are `MARKET_DATA_UNAVAILABLE`, `MARKET_DATA_STALE`,
> `MARKET_SOURCES_DISAGREE`, `SESSION_CLOSED`, `PRICE_DISLOCATION` and
> `QUOTE_OFF_MARKET`; the `PYTH_*` codes below are gone. Its thresholds are
> `SOLANA_STOCK_MAX_PRICE_AGE_SECONDS` (180), `SOLANA_STOCK_MAX_SOURCE_DISAGREEMENT_BPS`
> (150), `SOLANA_STOCK_MAX_PREMIUM_BPS` (300), `SOLANA_STOCK_MAX_PREMIUM_BPS_AFTER_HOURS`
> (800) and `SOLANA_STOCK_MAX_QUOTE_DEVIATION_BPS` (300), wired in
> `services/stocks.ts`. None of the sources is signed, and the assessment says
> so by naming each one.
>
> What survives from this page: `GET /v1/stocks/markets/:instrumentMint` and the
> `quaestor_stock_market` MCP tool, now returning the gate's assessment
> (`allowed`, `refusal`, `session`, `premium_bps`, `observations[]`,
> `consensus.{tokenized,reference}`, and `quote` once a quote has been measured);
> the assessment travelling with the quote and being revalidated at preview and
> execution; and `evidence_hash` being bound into the decision record.

Day 3 makes live Pyth data part of the authorization path. Quaestor compares
each tokenized stock with its underlying US equity before an agent may execute
the Jupiter route. Pyth is therefore producing a decision, not decorating the
interface after the trade.

## The guard

Each quote stores one Pyth Pro snapshot containing:

- the underlying equity price and the 24/7 xStock price;
- each feed's update timestamp, publisher count, confidence and market session;
- the signed Solana payload hash returned by Pyth; and
- the calculated token premium or discount in basis points.

The policy fails closed with one structured code:

| Code | Meaning |
|---|---|
| `PYTH_PRICE_STALE` | Either price was carried forward past the configured age |
| `PYTH_PUBLISHERS_LOW` | Either side lacks the required publisher coverage |
| `PYTH_CONFIDENCE_WIDE` | Publisher disagreement exceeds the confidence ceiling |
| `PYTH_PRICE_DISLOCATION` | The token and underlying differ beyond the premium ceiling |

The server revalidates snapshot age during preview and execution. It embeds the
Pyth `evidence_hash`, observed premium and exact policy thresholds in the
decision record before computing `decision_record_hash`. A rejected Pyth check
creates a public refused order and never calls the chain executor.

Day 3 trusts the Pyth Pro response received over the authenticated server
connection and commits the returned Solana payload hash. Cryptographic
verification of that payload inside the Solana settlement transaction belongs
to the native execution work on Day 6; the current API does not label the hash
as on-chain verified.

## Feed pairs

The public Pyth symbol catalog was checked on 16 September 2026:

| Asset | Underlying Pyth Pro feed | xStock Pyth Pro feed |
|---|---|---|
| AAPLx | `Equity.US.AAPL/USD` (`922`) | `Crypto.AAPLX/USD` (`1792`) |
| NVDAx | `Equity.US.NVDA/USD` (`1314`) | `Crypto.NVDAX/USD` (`1833`) |
| SPYx | `Equity.US.SPY/USD` (`1398`) | `Crypto.SPYX/USD` (`1843`) |

`npm run stocks:pyth:preflight` verifies all six Lazer and Hermes identifiers
against the live public catalog. When `PYTH_PRO_API_KEY` is present it also
requests current signed prices and evaluates the complete guard.

Pyth Pro credentials remain server-side. The browser, SDK and MCP clients only
receive the bounded assessment and evidence hashes through:

```text
GET /v1/stocks/markets/:instrumentMint
```

The route also appears as `quaestor_stock_market` in MCP. Quote responses carry
the exact assessment used later by policy preview and execution.

## Configuration

The Solana stock service now requires `PYTH_PRO_API_KEY` whenever
`SOLANA_STOCKS_ENABLED=1`. The owner controls four integer thresholds:

```text
SOLANA_STOCK_PYTH_MAX_AGE_SECONDS=30
SOLANA_STOCK_PYTH_MAX_PREMIUM_BPS=300
SOLANA_STOCK_PYTH_MAX_CONFIDENCE_BPS=100
SOLANA_STOCK_PYTH_MIN_PUBLISHERS=2
```

These defaults refuse data older than 30 seconds, premiums beyond 3%,
confidence wider than 1%, or feed pairs with fewer than two publishers.

Sources: [Pyth Pro REST API](https://docs.pyth.network/price-feeds/pro/api/rest),
[payload reference](https://docs.pyth.network/price-feeds/pro/payload-reference),
and [price-data guidance](https://docs.pyth.network/price-feeds/pro/understanding-price-data).
