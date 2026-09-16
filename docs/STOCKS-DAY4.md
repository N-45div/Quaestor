# Quaestor Stocks — Day 4

Day 4 adds a unified instrument catalog for public xStocks and private-company
exposure products from PreStocks. The catalog is public and needs no wallet.
It preserves where every field came from and states whether Quaestor can
execute that product.

## One discovery API, explicit product differences

`GET /v1/stocks/instruments` now returns:

- the static, reviewed xStocks execution allowlist;
- the live PreStocks product list;
- provider, asset class and execution status for every instrument; and
- a status for each upstream source, so one provider outage does not hide the
  other instruments.

The same response is available through `instrumentCatalog()` in the SDK and
`quaestor_stock_instruments` in MCP. xStocks remain `executionStatus: enabled`.
Every PreStocks product is `executionStatus: discovery-only` and `enabled:
false`. Dynamic catalog providers are rejected if they attempt to publish an
executable instrument. Quote requests for those mints return
`UNKNOWN_INSTRUMENT`, so discovery cannot silently expand the governor's
allowlist.

## Provenance and rights

For each live PreStocks product, Quaestor reads the provider's name, symbol,
description, product URL, mint, mark price, token price, valuations and supply.
It then independently queries Solana `getMultipleAccounts` with `jsonParsed`
encoding and verifies that every advertised mint:

- exists on Solana mainnet;
- is a parsed mint account;
- is owned by the Token-2022 program; and
- has an explicit decimal count and on-chain mint supply.

The provider-reported supply and on-chain mint supply remain separate fields.
They describe different source observations and are not forced to match.

PreStocks describes its products as economic exposure backed through an SPV.
Quaestor therefore labels them as private-company exposure and displays the
provider's current limits: the tokens do not give direct ownership, voting,
dividend or information rights in the referenced company. Eligibility also
depends on the provider's jurisdiction rules.

Corporate actions can change a product after discovery. The catalog includes a
lifecycle notice directing agents and users to the current product page before
use. This matters for events such as acquisitions, public listings, swaps and
expiry windows.

## Live verification

On 16 September 2026, `npm run stocks:prestocks:preflight` discovered and
verified eight Token-2022 mints:

| Symbol | Referenced company or market |
|---|---|
| `ANDURIL` | Anduril |
| `ANTHROPIC` | Anthropic |
| `FIGUREAI` | Figure AI |
| `KALSHI` | Kalshi |
| `NEURALINK` | Neuralink |
| `OPENAI` | OpenAI |
| `POLYMARKET` | Polymarket |
| `SPACEX` | SpaceX |

The preflight uses the same adapter and RPC verification path as the service.
`SOLANA_RPC_URL` can override the public mainnet endpoint.

Sources: [PreStocks products](https://prestocks.com/products),
[PreStocks FAQ](https://prestocks.com/faq), and the
[SpaceX lifecycle page](https://prestocks.com/spacex).
