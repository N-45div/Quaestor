# Quaestor Stocks — Day 3

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
