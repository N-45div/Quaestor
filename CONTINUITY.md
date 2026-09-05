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

## Where this is disclosed

1. In writing to the ETHGlobal team (Discord, with a link to this file).
2. In the submission's project description.
3. Here, in the repository, backed by the tag, the release, and CI timestamps.
4. Spoken in the demo video.
