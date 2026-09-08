# Quaestor

**Every agent guardrail protects one agent. Quaestor protects the herd.**

When one tenant's agent is attacked through a venue, every other tenant's price
to route through that venue rises within seconds — and Quaestor blocks nothing.
The permit simply costs more until it exceeds the per-call cap its owner set
on-chain, and the *chain* refuses. Nobody was told no; the trade just stopped
being affordable.

One governed endpoint, any chain: budgets the chain enforces, venues the herd
prices, a receipt that binds the reason to the payment, and — across chains —
one global cap held by proofs rather than by a relayer anyone has to trust.

![License: MIT](https://img.shields.io/badge/license-MIT-d4a843)
![CI](https://github.com/N-45div/Quaestor/actions/workflows/ci.yml/badge.svg)
![Tests](https://img.shields.io/badge/tests-57%20passing-199e70)
![Chain](https://img.shields.io/badge/X%20Layer%20testnet-1952-3987e5)

**Live app:** https://quaestor-app.onrender.com ·
**Services:** https://quaestor-hub.onrender.com/healthz

> **ETHOnline 2026 — Continuity track.** Quaestor was built in August 2026 for
> the X Layer AI Season hackathon and has been public under MIT since 14 Aug.
> Everything up to the tag
> [`pre-ethonline`](https://github.com/N-45div/Quaestor/releases/tag/pre-ethonline)
> predates the event; everything after it was built during ETHOnline and is
> listed, commit by commit, in [`CONTINUITY.md`](CONTINUITY.md).
> `git diff --stat pre-ethonline..HEAD` is the honest size of the new work.

```bash
# A real governed on-chain spend, right now, no wallet needed:
curl -s https://quaestor-hub.onrender.com/api/heartbeat
# → Pulse (the house agent) pays the oracle through the governor and returns
#   the receipt, the committed decision hash, the explorer proof link, and its
#   remaining on-chain budget. Drain its budget and the chain says no — that
#   refusal is the product, not an outage.
```

---

## What it is, in one diagram

_The full system — three enforcement layers, the herd moment, the budget root, trust
boundaries — is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)._

```
                owner (your wallet)                 guardian (watchdog key)
                   │  register · fund · caps             │  suspend ONLY
                   ▼                                     ▼
 agent ──operator──▶ Quaestor.sol ───────────▶ Receipt(agentId, category, payee,
  loop      key       per-epoch + per-call      amount, keccak256(decision),
   │                  caps per category         epoch, epochSpentAfter)
   │                                                      │
   │  GET /v1/risk/check?venue=X  ──▶ 402: permit = base × (1 + k · reporters(X))
   │        pays the permit (x402, or a governor receipt)  │
   │  pay(DATA)      ──▶ paid oracle / paid decisions       ▼
   │  pay(INFERENCE) ──▶ metered LLM cost          decision ledger
   │  swap(EXECUTION)──▶ the venue, if the permit was affordable
   └─ publishes decision JSON ─────────▶ any browser re-hashes & verifies ✓

 tenant A's agent is attacked through X ──▶ POST /v1/threat/report
                                              │
                                              ▼  seconds later, nobody touched B
 tenant B's permit for X: 0.005 → 0.01 → 0.015 as distinct tenants report
```

## The three things the chain enforces (August 2026)

**1 · Purpose-scoped budgets.** Spending is capped per epoch *and* per action
across `DATA` (paid API calls), `INFERENCE` (metered LLM cost) and `EXECUTION`
(trades). "0.005 a day on inference, 0.01 on trades" is one struct on-chain and
inexpressible as a session key. An agent trusted to buy data can still be
barred from trading with it.

**2 · The reason and the payment are one atomic on-chain fact.** Every spend
emits a `Receipt` committing the keccak-256 of the decision record — prompt,
signal, rationale — in the same transaction as the transfer. The operator
publishes the record; **anyone re-computes the hash in their own browser**. No
trusted validator, no log file someone rotated.

**3 · Stop-authority without spend-authority.** The owner can appoint a
**guardian**: an address the chain permits to do exactly one thing — suspend.
It can never spend, withdraw, resume or change policy, so the kill-switch is
safe to hand to a bot. Ours watches the receipt stream and vetoes burst
spending on its own.

## The three things the hub adds (ETHOnline 2026)

**4 · The price is the risk signal.** A route permit costs
`base × (1 + k · distinctReporters(venue, 24h))`. Reporters are counted **per
onboarded tenant, never per key or per agent**, so an operator who spawns a
thousand agents still moves the price exactly once. When the premium exceeds the
owner's per-call cap, `_authorize` reverts `PerCallCapExceeded` — the refusal is
the agent's own budget, on-chain, with a named error on the explorer. Quaestor
blocked nothing.

*Honest limit:* one-per-tenant is sybil-resistant at the tenant boundary, not
proof-of-personhood. Binding a reporter to a verified human is a swap of the
`humanId` the gate already carries — the counting rule does not change.

**5 · Herd immunity.** Every other guardrail protects one agent. Quaestor is a
hub: a tenant whose agent is attacked through a venue reports it, and every
other tenant's permit for that venue moves on the next quote. Run against the
live host with [`scripts/herd-demo.ts`](scripts/herd-demo.ts):

```
08:50:56.798  tenant B asks the permit price for 0x…dEaD: 0.005 HBAR (0 reporters)
08:50:56.798  tenant A is attacked through 0x…dEaD — A's agent reports it
08:50:57.060  report → 201 {"before_hbar":"0.005","after_hbar":"0.01","reporters":1}
08:50:57.337  tenant B asks the permit price for 0x…dEaD: 0.01 HBAR (1 reporter)
              B never touched anything.          — against quaestor-hub.onrender.com
```

Reporting is free — the herd wants reports — but gated, because a shared feed's
only real attack is poisoning. The gate has two tiers: an onboarded tenant key
(live today), or a verified human once an identity middleware sets one on the
request. The feed is add-only: there is no delete, and
[`test/threatfeed.test.ts`](test/threatfeed.test.ts) asserts the absence rather
than trusting the convention.

**6 · A policy that can only tighten.** `k` is the one scalar the hub's
harness may raise; nothing in the process can lower it. Loosening is a human
action that arrives as new configuration, never as a method call.
`GET /v1/policy/k` reads it; there is deliberately no route to write it down.

## Decisions, sold one request at a time

Every decision the hub makes is a paid HTTP resource over
[x402](https://github.com/x402-foundation/x402) v2, priced **per decision, not
per request**, and declared to the Bazaar so agents can find it:

| Route | Price | What you get |
|---|---|---|
| `GET /v1/threat/feed/head` | **free** | Is the herd alive? Count, last report, venues |
| `GET /v1/risk/quote?venue=` | **free** | What a permit would cost right now — the same number the paid route puts in its 402 |
| `GET /v1/threat/lookup?venue=` | 0.0005 HBAR | Distinct human reporters and the patterns seen |
| `GET /v1/risk/check?venue=` | base × (1 + k·reporters) | The route permit — its price *is* the verdict |
| `GET /v1/venue/quote?venues=a,b,c` | 0.001 HBAR × venues | Quotes, priced per venue quoted |
| `GET /v1/policy/evaluate?…&rules=N` | 0.0002 HBAR × rules | Seven rules against your **real** budget, read from the governor — not from what you claim. Two of them need spend history and refuse rather than guess when the index is stale |

Settlement is native HBAR on `hedera:testnet` through the
[Blocky402](https://blocky402.com) facilitator. **A real payment settles today** —
`npm run hedera:pay` runs the whole flow and prints each step:

```
1. GET /v1/threat/lookup?venue=0x…dEaD → 402
   PAYMENT-REQUIRED: network=hedera:testnet asset=0.0.0 amount=50000
                     payTo=0.0.10419048 feePayer=0.0.7162784
2. paid → 200 in 3841ms
   PAYMENT-RESPONSE: {"success":true,"payer":"0.0.10418423",
                      "transaction":"0.0.7162784@1788858107.062291812"}
```

On the [mirror node](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788858107-062291812):
`SUCCESS`, agent `0.0.10418423` −0.0005 HBAR, hub treasury `0.0.10419048` +0.0005 HBAR,
and the network fee charged to the **facilitator** — so the agent needs no gas
budget, only a price. `npm run hedera:preflight` checks the nine things that
have to be true first, and [`docs/HEDERA-FEEDBACK.md`](docs/HEDERA-FEEDBACK.md)
writes up the four that cost us real time.

## One governor, many chains

Nothing in [`Quaestor.sol`](contracts/Quaestor.sol) knows which chain it is on.
Budgets are denominated in the chain's native unit, and the venue sits behind a
one-function interface, `IQuaestorRouter`.

| Chain | Role | Status |
|---|---|---|
| **X Layer testnet** (1952) | Home. Governor `0x7C8772…5921`, AMM `0x7cf23d…8c12`, qUSD, qBTC | live since August |
| **Arc testnet** (5042002) | **Live.** Dollar-native: USDC is Arc's gas, so `msg.value` caps *are* dollar caps — same contract, no changes. Governor [`0x99D7fc…3b24`](https://testnet.arcscan.app/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24), AMM [`0x2e91d0…2D10`](https://testnet.arcscan.app/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10) | live |
| **Arc mainnet** | The same deploy, at launch (16 Sep) | ready |
| **Base Sepolia** (84532) | **Live.** Governor [`0x99D7fc…3b24`](https://sepolia.basescan.org/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24) — the same address as Arc, because the same contract from the same nonce lands in the same place. This is the chain the subgraph indexes | live |

**This week's additions, in order** (each a small commit, each listed in
[`CONTINUITY.md`](CONTINUITY.md)): governor on Arc testnet · governor on Base
Sepolia · a subgraph over `Receipt` / `PolicySet` / `Suspended` that the router
now reads live · an Aqua/SwapVM adapter behind `IQuaestorRouter` so `EXECUTION`
hits a real DEX instead of the demo AMM · the hub dashboard.

## What the chain keeps, and what it does not

The governor does **not** forget its sums. `spentIn[agentId][category][epoch]`
is a persistent mapping — the total for any epoch you can name stays readable
forever, and `remainingBudget()` is authoritative right now. Anyone telling you
an indexer is needed to answer "how much is left" is selling something.

What a running total erases is the **shape** of the spend:

| Question | On-chain | In the [subgraph](subgraph/) |
|---|---|---|
| How much is left this epoch? | ✅ `remainingBudget` | ✅ |
| What did I spend in epoch 41? | ✅ `spentIn(…, 41)` | ✅ |
| What was my **largest single** payment that epoch? | ❌ | ✅ `maxReceipt` |
| How many payments made up that total? | ❌ | ✅ `receiptCount` |
| Did they arrive over an hour or in one second? | ❌ | ✅ `firstAt` / `lastAt` |
| **Which** epochs are non-empty at all? | ❌ — a mapping has no iterator | ✅ |

So the subgraph is not a faster mirror of the chain. It answers questions the
chain structurally cannot, and [`/v1/policy/evaluate`](services/x402hedera.ts)
spends those answers:

```jsonc
"rules": [
  { "name": "per_call_cap", "pass": true,  "evaluated": true,  "source": "subgraph" },
  { "name": "no_burst",     "pass": false, "evaluated": false, "source": "subgraph",
    "basis": "chain source cannot see spend shape — burst and frequency
              exist only in the event stream" }
],
"allowed": false,
"denied_because": "could not evaluate no_burst, within_precedent —
                   refusing rather than assuming"
```

That is the design in one response. A stale index reports *less* spend than the
chain holds, which **overstates** remaining budget — the failure mode is
permissive, so the two rules with no fallback refuse instead of passing. Caps
and balances do have a fallback (a direct contract read, labelled
`"source": "governor"`), so they never refuse. `evaluated: false` is not
`pass: false`, and the response says which happened.

It also stops taking the agent's word for its own budget. Pass the old
self-asserted field and you get told what was used instead:

```jsonc
"superseded": { "epoch_left_hbar": "99999", "used_instead": "0.00175",
                "note": "ignored — epoch headroom now comes from the governor" }
```

`npx ts-node scripts/graph-check.ts` prints both sources side by side: they
agree on all seven chain-authoritative fields, and the shape block underneath
has no governor column at all. Agents get the same thing as an MCP tool
(`quaestor_budget`) and a skill,
[`skills/quaestor-budget-history`](skills/quaestor-budget-history/SKILL.md).

## Repository map

| Piece | What it is | Since |
|---|---|---|
| [`contracts/Quaestor.sol`](contracts/Quaestor.sol) | The governor: agents, treasuries, category budgets, receipts, guardian, kill-switch | Aug |
| [`contracts/QuaestorDEX.sol`](contracts/QuaestorDEX.sol) | Constant-product AMM behind `IQuaestorRouter`; the venue is swappable | Aug |
| [`sdk/`](sdk/) | Operator client — `pay`, `swap`, decision records, `verifyReceipt` | Aug |
| [`mcp/`](mcp/) | The governed treasury as MCP tools; refuses to run with an owner key | Aug |
| [`agent/`](agent/) | **Cato**, the governed DCA agent | Aug |
| [`app/`](app/) | Dashboard: keygen, funding, caps, live burn-down, receipt verification, kill-switch | Aug |
| [`services/oracle.ts`](services/oracle.ts) · [`ledger.ts`](services/ledger.ts) · [`guardian.ts`](services/guardian.ts) · [`indexer.ts`](services/indexer.ts) · [`starter.ts`](services/starter.ts) | Paid oracle, decision ledger, watchdog, event indexer, starter faucet | Aug |
| [`services/x402lane.ts`](services/x402lane.ts) · [`discovery.ts`](services/discovery.ts) | One flat-priced x402 route on X Layer; `/.well-known/agent.json` | Aug |
| [`services/pricing.ts`](services/pricing.ts) | Pure permit arithmetic, tinybar-exact | **Sep** |
| [`services/threatfeed.ts`](services/threatfeed.ts) | Add-only feed, reporters per human | **Sep** |
| [`services/permits.ts`](services/permits.ts) | The one price function; `k` tightens only | **Sep** |
| [`services/hub.ts`](services/hub.ts) | The write path, two-tier gate | **Sep** |
| [`services/x402hedera.ts`](services/x402hedera.ts) | Pay-per-decision lane, Bazaar-declared | **Sep** |
| [`scripts/herd-demo.ts`](scripts/herd-demo.ts) · [`pay-hedera.ts`](scripts/pay-hedera.ts) | The herd moment; the paying side | **Sep** |
| [`subgraph/`](subgraph/) | Schema and mappings over `Receipt` / `PolicySet` / `Suspended`; derives the spend shape the chain cannot hold | **Sep** |
| [`services/graph.ts`](services/graph.ts) | Budget reader: subgraph first, governor as fallback, refuses on a stale index | **Sep** |
| [`skills/quaestor-budget-history/`](skills/quaestor-budget-history/SKILL.md) | How an agent asks what its own spending looks like — and the four traps in doing it | **Sep** |

## Give it to your agent (MCP)

Any MCP client — Claude Code, Claude Desktop, Cursor — gets
`quaestor_agent_status`, `quaestor_pay_url` (the full 402 flow: fetch → pay
through the governor → retry), `quaestor_pay`, `quaestor_swap`,
`quaestor_receipts`, `quaestor_verify_receipt`, and, with a guardian key,
`quaestor_suspend` — deliberately no resume: an agent may halt itself; only
the human owner restarts it.

```jsonc
// Claude Code: claude mcp add quaestor -- npx -y ts-node mcp/server.ts
{
  "mcpServers": {
    "quaestor": {
      "command": "npx",
      "args": ["-y", "ts-node", "mcp/server.ts"],
      "cwd": "<path to this repo>",
      "env": {
        "QUAESTOR_ADDRESS": "0x7C8772fbdF1A1d9Ded219E51D3147d7C04475921",
        "DEX_ADDRESS": "0x7cf23d5D7A49ca4113ed4b72e465b227E7978c12",
        "AGENT_ID": "<your agent id>",
        "OPERATOR_KEY": "<your operator key>",
        "DECISION_LEDGER_URL": "https://quaestor-hub.onrender.com"
      }
    }
  }
}
```

The key in that config is safe to be there: it can spend only through the
governor, only within on-chain caps, and the server prints the blast radius at
startup. `rationale` is a required parameter on every spending tool — the model
must say why before money moves, and that reason is hash-committed on-chain
with the payment.

## Run it

```bash
npm install
npx hardhat test                                       # 23 contract + 25 service tests

# local chain, full stack
npx hardhat node                                       # terminal 1
npx hardhat run scripts/deploy.ts --network localhost  # deploys, seeds pools, writes app config
npx hardhat run scripts/register-agent.ts --network localhost

npm run services                                       # terminal 2 — oracle, ledger, hub (+ guardian, + lanes)
npm run agent                                          # terminal 3 — Cato
cd app && npm install && npm run dev                   # terminal 4 — http://localhost:4180

# the herd moment, against a running services process
TENANT_KEYS=alpha:correct-horse-battery HERD_TENANT_A_KEY=correct-horse-battery \
  npx ts-node scripts/herd-demo.ts

# push to live — this workspace has no GitHub auto-deploy, so after `git push`:
npm run deploy:render                                  # hub + dashboard, waits until live
```

Copy [`.env.example`](.env.example) to `.env`. Contract addresses come from
`deployments/<network>.json` after a deploy. Networks in
[`hardhat.config.ts`](hardhat.config.ts): `localhost`, `xlayerTestnet`,
`xlayer`, `hederaTestnet`.

## Honest limits

- **Inference metering trusts the operator's numbers.** The chain cannot see
  an LLM call. What it enforces: the *reported* spend is capped, monotonic and
  public — a private, deniable overrun becomes a public, attributable one.
- **The threat feed is in-memory today.** It loses state on restart, which is
  fine for one process and wrong for a hub. The durable version is an
  append-only log with network-assigned timestamps; the interface does not
  change.
- **Tier-2 reporters are tenants, not humans.** Until agents carry a
  proof-of-human, "distinct reporters" means distinct onboarded tenant keys.
  Still one-per-tenant, still not one-per-agent.
- **One event per spend.** Sane above ~$0.01 per spend; true micropayments
  want epoch batching under one Merkle root.
- The decision ledger is an **availability** layer, never a trust layer —
  records verify client-side against the on-chain hash.

## FAQ

**Why price instead of block?** A block is a bit that someone has to flip, and
whoever can flip it can be talked into flipping it back. A price is a number
that emerges from many observers and is enforced by a cap the agent cannot
edit. And a price degrades gracefully: a venue with one report is expensive,
not forbidden.

**Why not just session keys or spending-limit modules?** They compose with
this — hold the operator key inside one. But they cap *amount × recipient ×
time*; they can't express purpose, attach no reason to any spend, and the
principal who edits the policy also controls the funds, so the stop button
can't be safely delegated. Quaestor is a policy object, not a signer
restriction.

**Isn't the guardian just a multisig?** No. A multisig shares full authority.
The guardian holds a strictly smaller right — suspend, nothing else — enforced
in the contract. That's why it's safe to give the key to a bot.

**What if the operator never publishes a decision record?** The hash still
binds them: any record produced later must match byte for byte, and
unpublished records are visible — the dashboard shows exactly which receipts
were never opened.

**Who is this for?** Anyone funding an agent they don't fully trust — which is
everyone funding an agent.

## License

[MIT](LICENSE) © 2026 Divij N
