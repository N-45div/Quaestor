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
| **3 — Price evidence in the authorization path ✅** | Built on Day 3 against Pyth Pro feeds, then replaced on 18 Sep 2026 by the multi-source price gate in `stocks/market-guard.ts`: before an intent is signed, the floor a quote guarantees is measured against prices observed independently of the venue (Backpack perp index and the issuer's underlying price from Jupiter's price v3 response as references, Jupiter for the token); it gates on missing or stale data, source disagreement, session, token-to-underlying premium and quote deviation, and binds the evidence hash to the decision record. The sources are unsigned | None (Pyth dropped) | A stale, missing, disputed or dislocated price creates a structured refusal and the executor is never called |
| **4 — Unified private-market registry ✅** | Added live PreStocks discovery with issuer, mark price, token price, valuation, separate provider/on-chain supply and verified Solana mint provenance; normalized it beside xStocks with explicit product rights and a discovery-only execution boundary | PreStocks | Eight live products, including OpenAI and SpaceX, pass the public API and Token-2022 preflight; quote attempts still fail closed |
| **5 — T-Token intelligence ✗ dropped** | Dropped on 20 Sep 2026 before any of it was built: the PreStocks bounty makes a project that integrates any other pre-IPO token ineligible, so no Tessera token was added. The divergence check it described runs on PreStocks' own marks instead (the `pre-ipo` gate policy) | PreStocks | Nothing from Tessera is integrated |
| **6 — Native settlement and durable history** | Wire the Solana signer/vault boundary, confirm token-account deltas, reconcile timeouts by signature and rebuild public order state after restart | Solana, Jupiter | One funded test order settles once; restart preserves its status; a timeout cannot double-fill |
| **7 — Agent explorer experience** | Build the public Stocks arm: instrument pages, price-gate evidence, live decisions, refusals, receipts, portfolios and a scripted rules/LLM agent run | Main track, PreStocks | A judge understands the problem and watches a complete decision in under 90 seconds without connecting a wallet |
| **8 — Liquidity and submission pass** | Add Meteora DBC pool configuration/monitoring only where it improves thin-market price discovery; make a Clawpump launch a separate go/no-go; finish mobile QA, video, README and submission evidence | Meteora; Clawpump optional | No mock sponsor claims, all links work, and the final demo is below the event limit |

## Bounty decisions

- **Pyth:** dropped on 18 Sep 2026. The Pyth Pro API would not serve us equity
  feeds, so the Day 3 guard could never run against live data, and a guard that
  cannot run is not a fallback. The role it held — deciding whether an order may
  execute — is now the price gate's (`stocks/market-guard.ts`), which is not a
  sponsor integration. [STOCKS-DAY3.md](STOCKS-DAY3.md) keeps the original log.
- **PreStocks:** core extension. It expands Quaestor into governed pre-IPO exposure.
- **Tessera:** dropped on 20 Sep 2026, never integrated. The PreStocks bounty
  makes a project that integrates any non-PreStocks pre-IPO token ineligible.
- **Meteora DBC:** pursue on Day 8 as issuer/liquidity infrastructure after the
  execution and explorer paths are complete. Mainnet working code is the stated
  judging preference.
- **Clawpump:** dropped. What it publishes is a token mint rather than a venue,
  and it launches onto pump.fun, so there was no honest place for it in the
  governed trade path.

Official bounty criteria: [Stocklana](https://hackathons.solana.com/hackathons/stocklana).
