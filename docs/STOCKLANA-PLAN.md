# Stocklana execution plan — Days 3–8

The product remains one coherent wedge: **a governed execution and public
decision explorer for autonomous agents trading tokenized public and private
stocks on Solana**. Sponsor integrations enter as data, instruments or
liquidity inside that path.

The live event header currently gives a deadline of **25 September 2026**,
which is **26 September at 1:30 AM IST**. The older timeline paragraph on the
same page still says 18 September, so the working schedule finishes core work
by Day 8 and keeps the remaining days as submission buffer.

| Day | Deliverable | Sponsor fit | Completion test |
|---|---|---|---|
| **3 — Pyth policy evidence** | Compare underlying equities with their 24/7 xStocks twins; gate quotes on freshness, confidence, publisher count and price divergence; bind signed payload evidence to the decision record | Pyth | A stale or dislocated feed creates a structured refusal and the executor is never called |
| **4 — Unified private-market registry ✅** | Added live PreStocks discovery with issuer, mark price, token price, valuation, separate provider/on-chain supply and verified Solana mint provenance; normalized it beside xStocks with explicit product rights and a discovery-only execution boundary | PreStocks | Eight live products, including OpenAI and SpaceX, pass the public API and Token-2022 preflight; quote attempts still fail closed |
| **5 — T-Token intelligence** | Add Tessera OpenAI and Kalshi T-Tokens, compare overlapping private-company marks across Tessera and PreStocks, and expose an agent-readable opportunity/risk view | Tessera, PreStocks | One governed agent can compare multiple representations and stand down on a configured divergence |
| **6 — Native settlement and durable history** | Wire the Solana signer/vault boundary, confirm token-account deltas, reconcile timeouts by signature and rebuild public order state after restart | Solana, Jupiter | One funded test order settles once; restart preserves its status; a timeout cannot double-fill |
| **7 — Agent explorer experience** | Build the public Stocks arm: instrument pages, Pyth evidence, live decisions, refusals, receipts, portfolios and a scripted rules/LLM agent run | Main track, Pyth, PreStocks, Tessera | A judge understands the problem and watches a complete decision in under 90 seconds without connecting a wallet |
| **8 — Liquidity and submission pass** | Add Meteora DBC pool configuration/monitoring only where it improves thin-market price discovery; make a Clawpump launch a separate go/no-go; finish mobile QA, video, README and submission evidence | Meteora; Clawpump optional | No mock sponsor claims, all links work, and the final demo is below the event limit |

## Bounty decisions

- **Pyth:** core integration. It controls whether an order may execute.
- **PreStocks:** core extension. It expands Quaestor into governed pre-IPO exposure.
- **Tessera:** core extension where OpenAI/Kalshi overlap creates a useful
  cross-product comparison rather than another token list.
- **Meteora DBC:** pursue on Day 8 as issuer/liquidity infrastructure after the
  execution and explorer paths are complete. Mainnet working code is the stated
  judging preference.
- **Clawpump:** optional. Its requirement is a separate token launch with a
  stock-paired Meteora pool. We should enter only if the launch has a durable
  Quaestor utility and can be represented honestly in the demo.

Official bounty criteria: [Stocklana](https://hackathons.solana.com/hackathons/stocklana).
