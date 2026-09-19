# Quaestor Stocks — Day 2

> **Note added 19 Sep 2026.** This is a dated build log and the text below is
> left as it was written. Three things in it have since been superseded:
>
> - **"Pyth market evidence".** The Pyth guard was removed on 18 Sep 2026 and
>   replaced by the multi-source price gate in `stocks/market-guard.ts`. The
>   `quaestor_stock_market` tool still exists; it now returns that gate's
>   assessment. See the note at the top of [STOCKS-DAY3.md](STOCKS-DAY3.md).
> - **The MCP tools.** There are now nine, not seven (venues and the price tape
>   were added), defined in `mcp/stocks.ts` and served over stdio
>   (`npm run mcp:stocks`) and over HTTP (`services/mcp-http.ts`), where a caller
>   without an agent key is not offered the execute tool at all. The preview tool
>   takes only `quote_id`, `strategy` and `rationale` and mints `intent_id` and
>   `intent_expires_at` itself; execute **requires** those two values exactly as
>   preview returned them in `request`. An execute that made up its own id would
>   turn a retry after a timeout into a second trade.
> - **Tool results.** Every MCP tool result is JSON text of the shape
>   `{ "notice": ..., "data": ... }`, and every failure is
>   `{ "error": { "code", "message" }, "final": true }`. The HTTP refusal shape
>   shown below is unchanged.
>
> "Live signing remains disabled" is also no longer true of the devnet lane: the
> hub signs and submits there. The Day 6 reference to "the Pyth and
> private-market instrument layers" describes the plan as it stood on the day.

Day 2 turns the governed stock path into one interface that a rules engine, an
LLM agent or an MCP client can use. All amounts at the HTTP boundary are
integer base-unit strings. Reading instruments, orders and portfolios is public;
only execution needs an operator credential.

## Agent API

| Operation | Endpoint | Authentication |
|---|---|---|
| Discover the capability | `GET /v1/stocks` | Public |
| List verified instruments | `GET /v1/stocks/instruments` | Public |
| Read Backpack support and session constraints | `GET /v1/stocks/backpack` | Public |
| Request a Jupiter quote | `POST /v1/stocks/quotes` | Public |
| Preview the exact policy decision | `POST /v1/stocks/policy/preview` | Public |
| Execute an order | `POST /v1/stocks/orders` | Bearer credential + `Idempotency-Key` |
| Read an order or receipt | `GET /v1/stocks/orders/:orderId` | Public |
| Read holdings and allowance use | `GET /v1/stocks/portfolio?agent_id=...` | Public |

The operator credential is bound to one agent and an explicit mint set. The
server derives the operator identity from that registration; a caller cannot
replace it in an order body. An order also carries a short expiry. Reusing the
same idempotency key and body returns the original order. Reusing it for a
different body returns `IDEMPOTENCY_CONFLICT` and never calls the executor.

Every refusal is structured:

```json
{
  "status": "refused",
  "refusal": {
    "code": "PER_TRADE_CAP_EXCEEDED",
    "message": "trade exceeds the per-trade cap"
  }
}
```

Successful receipts carry both hashes: `intent_hash` binds every executable
field, while `decision_record_hash` binds the strategy, rationale, model and
inputs that caused the order.

## Clients

`sdk/stocks.ts` is the common HTTP client. `agent/stocks-rules.ts` and
`agent/stocks-llm.ts` use the same sequence:

```text
quote -> policy preview -> execute with intent ID as idempotency key -> order status
```

The MCP server adds seven matching tools when `STOCKS_API_URL` is configured:
instrument discovery, Pyth market evidence, quote, preview, execute, order
lookup and portfolio. The
preview tool returns the complete request; passing its exact `intent_id` and
`intent_expires_at` to execute preserves the previewed authorization hash.

## Jupiter and Backpack

Jupiter is the execution boundary. `JupiterV2QuoteProvider` uses the current
Router endpoint, `GET https://api.jup.ag/swap/v2/build`, validates every amount
and mint at runtime, retains the raw swap instruction and exposes the encoded
minimum output. The route can therefore be handed to the Solana governor rather
than signed directly by an agent wallet.

Backpack is supplemental discovery and market context. Its public
`/api/v1/securities` and `/api/v1/markets` endpoints expose stock sessions,
quantity constraints and venue market availability. Quaestor does not submit
Backpack exchange orders: those require a separate ED25519 exchange credential
and would bypass the on-chain Jupiter receipt path.

On 14 September 2026 the checked universe was:

| Instrument | Solana mint | Token program | Backpack discovery |
|---|---|---|---|
| AAPLx | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | Token-2022 | Security sessions + stock-classified PERP market |
| NVDAx | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | Token-2022 | Security sessions + stock-classified PERP market |
| SPYx | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | Token-2022 | Security sessions; no matching visible venue market in the sampled response |

The mints and ISINs come from the xStocks public asset API. Solana RPC confirms
8 decimals and the Token-2022 pausable, permanent-delegate, scaled-UI-amount and
confidential-transfer extensions. A live 1 USDC Jupiter check for AAPLx returned
a Raydium CLMM route through Jupiter v6; route availability and output are
time-sensitive, so run the preflight again before a demo:

```text
npm run stocks:preflight
```

Instrument discovery also returns the issuer's jurisdiction notice and legal
documentation link. The current xStocks terms exclude the United States,
United Kingdom and other restricted jurisdictions; the API does not claim that
an on-chain route makes a caller eligible.

Sources: [xStocks asset API](https://api.xstocks.fi/api/v2/public/assets),
[Backpack API](https://docs.backpack.exchange/), and
[Jupiter Router build API](https://developers.jup.ag/docs/api-reference/swap/build).

## Service configuration

Set `SOLANA_STOCKS_ENABLED=1`, a public-key `SOLANA_STOCKS_TAKER`, and a
16-character-or-longer `SOLANA_STOCK_OPERATOR_TOKEN`. Live signing remains
disabled until a native chain executor is configured. Explicitly setting
`SOLANA_STOCKS_SIMULATION=1` enables a labelled simulation for local UI and
agent development; simulated signatures always start with `simulation:`.

The Day 2 order and quote indexes are process-local. A production deployment
must rebuild them from Solana signatures or a durable indexer after restart;
the revised Stocklana plan schedules that chain-backed settlement and history
adapter for Day 6 after the Pyth and private-market instrument layers.
