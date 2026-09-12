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

As of 12 Sep: **72 commits, 100 files changed, +8,997 / −567** — excluding
`package-lock.json`, which on its own accounts for nearly 10,000 of the raw insertion count
and would flatter that figure by 2.1×. The test suite went from 23 to 66 (verified,
`npx hardhat test`). The release page shows the commit count since the boundary.

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
- **The index, and the router reading it** (`subgraph/`, `services/graph.ts`,
  `scripts/graph-check.ts`, `skills/quaestor-budget-history/`) — the governor went live on Base
  Sepolia and a subgraph now derives what a running total erases: the largest single payment in
  an epoch, how many payments made it up, and the window they arrived in. `/v1/policy/evaluate`
  stopped reading the caller's asserted budget off the query string and reads the governor
  instead, with a contract call as fallback; the two rules that need spend history have no
  fallback, so a stale index makes them `evaluated: false` and the verdict a refusal. Proven
  live both ways with two settled Hedera payments — allowed with a fresh index, refused for the
  identical spend with `GRAPH_MAX_LAG_S=0`. Agents get the same via a `quaestor_budget` MCP tool
  and a skill. The commit before it is a correction: the schema had claimed the governor
  "forgets" each epoch, which is false — `spentIn` is a persistent mapping — so the claim was
  narrowed to the one that survives scrutiny before anything was built on it.

- **The agent using its own history, and the whole thing live** (`agent/selfcheck.ts`,
  `test/selfcheck.test.ts`, `scripts/arc-preflight.ts`, `docs/ARC-MAINNET.md`) — Cato now asks
  whether a spend is unusual *for itself* before proposing it, standing down at more than 3×
  its largest ever payment, with the verdict inside the keccak-committed decision record. It
  fails **open** where the router fails closed, because refusing here would strand a live agent
  to protect what the governor already enforces. The wiring exposed a bug worth recording: the
  budget source was labelling itself with the *caller's* governor address, which would have
  handed X-Layer Cato the Base Sepolia history for agent #1 — a confident wrong number, since
  that agent exists on both chains with different treasuries. The source now takes its identity
  from what it indexes, and live Cato correctly logs `different governor, so not consulted`.
  Arc mainnet readiness ships as a runnable preflight rather than a promise: it opens 16 Sep,
  three days after this deadline, so no entry can deploy there before submitting.
  Everything above is deployed at https://quaestor-hub.onrender.com — all six x402 routes live,
  the policy gate answering from the subgraph, verified with a settled Hedera payment against
  the deployed host.

- **The agent explorer** (`app/src/views/`, `app/src/components/ExplorerShell.tsx`,
  `services/explorer.ts`) — the dashboard became a public, Etherscan-style record of agents,
  decisions, routes and networks. Every receipt endpoint declares its chain id and governor;
  Arc, Base and X Layer histories cannot be mixed even where contract addresses or agent ids
  coincide. Agent pages expose authority and purpose-scoped budgets, decision pages recompute
  the published record's keccak hash in the browser, and the routes page quotes the live herd
  price. Browsing requires no wallet; signing is isolated to an individual agent's management
  page. The indexer serves the newest block range first, fills history behind it, checkpoints
  progress and reports its coverage instead of presenting a partial list as complete.

- **The budget root, fed by a proof** (`deployments/sepolia.json`,
  `deployments/attested-creditcoinTestnet.json`, the watcher wired in `services/main.ts`) — a
  governor went live on Ethereum Sepolia as the attestable source chain, and the watcher carried
  one of its receipts into the Creditcoin root: block 11683810 attested, proof fetched, credited on
  Creditcoin at `0x550bfa…496b`. `GET /v1/budget/1` on the hub now reports four attested spends —
  counted only because a proof the precompile verified said so, never because a relayer reported
  them. That is the cross-chain cap the August README promised in one sentence and could not
  deliver without a chain that verifies other chains natively.

## Where this is disclosed

1. In writing to the ETHGlobal team (Discord, with a link to this file).
2. In the submission's project description.
3. Here, in the repository, backed by the tag, the release, and CI timestamps.
4. Spoken in the demo video.
