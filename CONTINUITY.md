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

As of 7 Sep: **26 commits, 36 files changed, +6,189 / −515, 22 new files**, and the test
suite went from 23 to 57. The release page itself shows the commit count since the boundary.

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
  quote per venue, and the route permit at `base × (1 + k · distinctReporters)` — the price
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

- **The cross-chain budget root** (`contracts/attested/QuaestorAttested.sol`, `test/attested.test.ts`) —
  a Creditcoin contract that consumes `Receipt` events proven through the Attestcoin BlockProver
  precompile from every registered governor and keeps one global cap per agent group across chains;
  attests `Suspended` events into the threat feed; batch verification under one continuity proof.
  Tested against real transaction bytes through the real decoder with the precompile mocked at its
  constant address.
- **Arc: the dollar-native governor** (`deployments/arcTestnet.json`, `scripts/prove-caps.ts`) — the
  August contract, unchanged, deployed to Arc testnet (5042002). USDC is Arc's gas, so `msg.value`
  caps are dollar caps: agent #1 runs on a $2 treasury with a $1/day DATA cap and $0.25 per call.
  Proven on-chain, not asserted — a $0.125 spend mined
  ([`0xf2a933…1071b1`](https://testnet.arcscan.app/tx/0xf2a933391bc634f3919d00a975a949fd345282879680d0c91d837ae4041071b1)),
  one wei over the per-call cap reverted `PerCallCapExceeded(250000000000000001, 250000000000000000)`,
  and the epoch budget fell $1.00 → $0.875. `prove-caps.ts` reproduces all three on any chain.
- **A real Hedera x402 settlement** (`scripts/hedera-preflight.ts`, `scripts/hedera-new-account.ts`,
  `scripts/hub-run.sh`, `docs/HEDERA-FEEDBACK.md`) — the lane stopped being a challenge and started
  being a payment: `0.0.7162784@1788858107.062291812`, SUCCESS, 0.0005 HBAR from the agent to the
  hub treasury, fee charged to the facilitator. Plus a nine-check preflight and a feedback document
  on the four things that cost real time (a constructor that discards its config, native HBAR
  refused by default spend controls, `payer == payTo` failing as a bare empty 402, and a missing
  re-export).
- **The relayer and the read path** (`services/attest.ts`, `scripts/attest-once.ts`,
  `services/budgetroot.ts`, `scripts/deploy-attested.ts`) — waits for a spoke block to be attested,
  fetches the inclusion + continuity proof from the proof builder, submits it to the root; the hub
  serves `GET /v1/budget/:groupId` from Creditcoin, read-only. Hardhat gains `sepolia`, `baseSepolia`,
  `creditcoinTestnet`; `scripts/deploy.ts` knows nine chains and no longer repoints the dashboard on
  every deploy (`docs/ARCHITECTURE.md` maps the whole thing).

## Where this is disclosed

1. In writing to the ETHGlobal team (Discord, with a link to this file).
2. In the submission's project description.
3. Here, in the repository, backed by the tag, the release, and CI timestamps.
4. Spoken in the demo video.
