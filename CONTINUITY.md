# Continuity disclosure — ETHOnline 2026

Quaestor is submitted to ETHOnline 2026 on the **Continuity / Extend Open Source** track.
This file states exactly what existed before the event and what was built during it.

## The boundary

Everything at or before the tag **[`pre-ethonline`](https://github.com/N-45div/Quaestor/releases/tag/pre-ethonline)**
(commit `8c0c8d45de7c7d10234ed624c0b863592e98772c`, 24 Aug 2026) predates the hackathon.
It was built in August 2026 for the X Layer AI Season hackathon and has been public under
MIT since 14 Aug 2026.

Hacking opened 4 Sep 2026 at 16:00 UTC. Every commit after the tag was made during the
event, and every push is timestamped server-side by the CI run it triggers.

```
git diff --stat pre-ethonline..HEAD
```

## What existed before (August 2026)

- `contracts/Quaestor.sol` — the spend governor: per-agent owner / operator / guardian roles,
  per-category (DATA / INFERENCE / EXECUTION) epoch caps and per-call caps, a treasury, a
  `Receipt` event carrying the hash of the off-chain decision record, a suspend-only guardian.
- `contracts/QuaestorDEX.sol`, `contracts/TestToken.sol` — a constant-product AMM the governor
  routes EXECUTION spends through, and faucet test tokens.
- `test/quaestor.test.ts` — 23 tests.
- `sdk/`, `mcp/`, `agent/`, `app/` — TypeScript SDK, an MCP server, the example governed agent
  (Cato), and a React dashboard.
- `services/` — a paid oracle settled through governor receipts, a decision-record ledger, an
  event indexer, the guardian watchdog, a starter-treasury faucet, an agent card at
  `/.well-known/agent.json`, and **one flat-priced x402 route** (`GET /x402/signal`) settled on
  X Layer through OKX's facilitator.
- A live deployment on X Layer testnet (chain id 1952) and hosted services on Render.

## What is new (built 4–13 Sep 2026)

_Filled in as the work lands. Each item links to the commits that introduced it._

- **Hedera x402 lane** (`services/x402hedera.ts`, `services/pricing.ts`, `services/threatfeed.ts`,
  `scripts/pay-hedera.ts`) — Quaestor's decisions sold one x402 v2 request at a time, settled in
  HBAR on Hedera testnet through the Blocky402 facilitator, with Bazaar discovery declared on
  every paid route. Priced per decision, not per request: a policy evaluation per rule, a venue
  quote per venue, and the route permit at `base × (1 + k · distinctHumanReporters)` — the price
  is the risk signal. The feed head is free. Replaces the August lane's single flat-priced route.
- **Hedera testnet in Hardhat** (`hardhat.config.ts`) — chain id 296 over the Hashio relay.
- **The hub** (`services/permits.ts`, `services/hub.ts`, `scripts/herd-demo.ts`) — one shared permit
  pricer whose `k` can only tighten; a free, gated write path (`POST /v1/threat/report`: a verified
  human or an onboarded tenant key, one reporter per tenant); and the herd moment reproduced as a
  script — tenant A reports, tenant B's permit doubles in 8 ms, B did nothing. Plus a free
  `GET /v1/risk/quote` so the herd's effect is visible without a payment lane.
- **Hosting** (`render.yaml`, `scripts/render-deploy.ts`, `app/public/config.json`) — the services
  moved from an unreachable August host to `quaestor-hub.onrender.com` in the same workspace as
  the dashboard; `npm run deploy:render` is the push-to-live step. The dashboard, which had been
  suspended, is back up.

## Where this is disclosed

1. In writing to the ETHGlobal team (Discord, with a link to this file).
2. In the submission's project description.
3. Here, in the repository, backed by the tag, the release, and CI timestamps.
4. Spoken in the demo video.
