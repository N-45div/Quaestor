# Quaestor on Bankr x402 Cloud

Three paid tools, hosted by Bankr, discoverable in its x402 marketplace, paid for
in USDC on Base by any Bankr agent. Each handler is a thin proxy: Bankr takes
the payment, the handler asks the Quaestor hub, the hub does the work.

| Service | Price | What it answers |
|---|---|---|
| `quaestor-quote-check` | $0.005 | Is this quote fair? For a quote from any venue. |
| `quaestor-market-evidence` | $0.002 | What each source says, how far they disagree, the premium, the session. |
| `quaestor-price-tape` | $0.001 | Where token and underlying have been over a window, with a narrative. |

The same tools are sold on Solana, settled by PayAI, at `/v1/intel/*` on the hub.

## Deploy

```bash
cd integrations/bankr-x402
npx @bankr/cli login --api-key "$BANKR_API_KEY"
npx @bankr/cli x402 env set QUAESTOR_HUB_URL=https://quaestor-stocks.onrender.com
npx @bankr/cli x402 env set QUAESTOR_PROXY_KEY=<the hub's INTEL_PROXY_KEY>
npx @bankr/cli x402 deploy
```

`QUAESTOR_PROXY_KEY` lets the hub know payment was already taken. It opens three
read-only routes and nothing else: it cannot trade, and it is neither the agent
key nor the operator token.

Bankr settles after the response, so the handlers answer non-2xx whenever the
caller did not get an answer worth paying for.
