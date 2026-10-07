# Quaestor on Monad, indexed by Envio HyperIndex

Every governor Quaestor's factory makes on Monad testnet, each trade a governor lets an AI agent
make, every change an owner makes to the rules, and every stock price Chainlink CRE writes onto
Monad: one GraphQL API over all of it, fed by Envio HyperSync.

**Hosted by Envio:** https://indexer.dev.hyperindex.xyz/3983430/v1/graphql (public; the app's Monad
page reads it). Deployed from this folder on pushes to the `envio` branch.

## What it indexes

| Contract | Events | Becomes |
|---|---|---|
| `QuaestorStocks` (the factory) `0x2e91d035D622d2ECa36B7836CBcf9651711B2D10` | `GovernorCreated` | a **Governor** and its **Agent**; the governor is registered for indexing as it is created |
| each `QuaestorStockGovernor` | `TradeExecuted` | a **Trade** (spent, received, price per token, the decision hash), and running totals on the Governor, Agent, Instrument and **DailyVolume** |
| | `PolicySet`, `SuspendedSet`, `InstrumentSet`, `PriceLimitSet`, `PriceGuardSet`, `Withdrawn` | the governor's current rules, an **Instrument** per stock with its limit price and Chainlink guard, and a **PolicyChange** for each |
| `QuaestorMirrorReceiver` (Chainlink CRE) `0xb3A434C305e9fB799118aF0aA4a1b532b56e79B1` | `Relayed`, `Skipped` | the latest **Feed** per stock and each **PriceWrite** |

A refused trade emits nothing, so it never appears here; the totals are what governors let through.

## Run it

Envio runs on Linux (or WSL) with Node 22.15 or later.

```bash
cp .env.example .env            # put an Envio API token in it: https://envio.dev/app/api-tokens
pnpm install
pnpm codegen
pnpm test                       # replays real Monad testnet blocks through HyperSync
pnpm dev                        # indexes from the factory's block; GraphQL on http://localhost:8080
```

The test replays three real blocks: the house agent's governor being created (its caps, its five
stocks, each with a limit price and a Chainlink guard), Chainlink CRE writing NVDA, SPY and AAPL,
and the house agent (Kimi deciding, a Dynamic MPC wallet signing) buying tNVDA on the price just
written.

## Queries

What has an agent spent, and through which governors?

```graphql
query {
  Agent(where: { id: { _eq: "0xc813451f9fe540b754abe526bac4ee19e4043ff8" } }) {
    tradeCount
    spent
    governors { id perTradeCap epochCap suspended tradeCount spent }
  }
}
```

The latest trades, with the hash of the reason each was committed under:

```graphql
query {
  Trade(order_by: { block: desc }, limit: 10) {
    symbol spent received pricePerToken decisionHash txHash
    governor { id owner }
  }
}
```

What each governor allows, and what it has bought:

```graphql
query {
  Instrument(where: { governor_id: { _eq: "0xd64e22ff0d0dc311d89bcc5c5113f9e7f149157c" } }) {
    symbol allowed maxPrice maxDeviationBps maxStaleness bought spent tradeCount
  }
}
```

The prices Chainlink CRE has written, and how fresh they are:

```graphql
query {
  Feed { id answer sourceUpdatedAt writes skips lastWriteAt }
}
```
