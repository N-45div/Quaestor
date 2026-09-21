# Quaestor

**Don't give your agent a wallet. Give it an allowance.**

Quaestor is an on-chain spend governor for AI agents. The agent never holds the
money. A program does, and it enforces the limits the owner set — how much, on
what, through which venues — on every spend. An agent that has been talked into
sending the money somewhere finds it has no tool that does that.

It governs two kinds of agent today:

- **Agents that trade tokenized stocks on Solana.** A program holds the USDC,
  checks caps and allowlists, and measures the balances itself after every
  swap. A price gate in front of it refuses quotes the market does not support.
  Any agent reaches it over MCP, and the hosted hub does not hold the key that
  signs its trades.
- **Agents that pay and trade on EVM chains.** A contract holds the treasury,
  caps spending by purpose (data, inference, execution), and commits the hash
  of the agent's reason in the same transaction as the payment. A hub prices
  venue risk across all of its tenants, so an attack on one agent raises the
  price for every other.

![License: MIT](https://img.shields.io/badge/license-MIT-d4a843)
![Tests](https://img.shields.io/badge/tests-332%20passing-199e70)

**App:** https://quaestor-app.onrender.com ·
**Stocks view:** https://quaestor-app.onrender.com/#/app/stocks ·
**Stocks hub:** https://quaestor-stocks.onrender.com ·
**EVM hub:** https://quaestor-hub.onrender.com/healthz

## Try it

No wallet, no key, no checkout:

```bash
# What the price gate sees right now for the instrument the hosted hub trades:
# each source, how far they disagree, the session, and whether it would allow a trade.
curl -s https://quaestor-stocks.onrender.com/v1/stocks/markets/AAbNhnPT35sgR1KRrMzNhsuLjT2XPA2S83ABbJPCuAB1

# A real governed spend on an EVM chain, made as you ask for it: the house agent
# pays an oracle through the governor and returns the receipt, the committed
# decision hash, the explorer link and its remaining on-chain budget.
curl -s https://quaestor-hub.onrender.com/api/heartbeat
```

Both hosts are free instances and sleep when idle; the first call may take a
minute to wake one. Drain the house agent's budget and the chain says no. That
refusal is the product, not an outage.

Give the stock tools to an agent with one line:

```bash
claude mcp add --transport http quaestor-stocks https://quaestor-stocks.onrender.com/mcp
```

## How it works

```
 agent (any MCP client)                        owner (a wallet that is never on the hub)
   │  quote → preview → execute                  │  caps · allowlists · pause · withdraw
   ▼                                             ▼
 Quaestor hub ──▶ price gate: the floor a quote guarantees, measured against
   │              prices observed independently of the venue. Fails closed.
   │  the operator co-signs (two-of-two MPC, one share on the hub)
   ▼
 quaestor_stocks (Solana program) ──▶ venue swap ──▶ measures vault and position
   caps · instrument and venue allowlists              reverts on any shortfall
   one IntentRecord per intent                         a retry is a replay, refused
```

```
                owner (your wallet)                 guardian (watchdog key)
                   │  register · fund · caps             │  suspend ONLY
                   ▼                                     ▼
 agent ──operator──▶ Quaestor.sol ───────────▶ Receipt(agentId, category, payee,
  loop      key       per-epoch + per-call      amount, keccak256(decision),
   │                  caps per category         epoch, epochSpentAfter)
   │                                                      │
   │  pay(DATA)      ──▶ paid oracle (one receipt, one signal)  ▼
   │  pay(INFERENCE) ──▶ metered LLM cost          decision ledger
   │  swap(EXECUTION)──▶ the venue, inside the per-call and epoch caps
   └─ publishes decision JSON ─────────▶ any browser re-hashes & verifies ✓

 before it routes, any agent can ask the hub what a venue costs today:
   GET /v1/risk/quote?venue=X ──▶ free: permit = base × (1 + k · reporters(X))
   GET /v1/risk/check?venue=X ──▶ 402, paid over x402 in HBAR: the permit itself

 tenant A's agent is attacked through X ──▶ POST /v1/threat/report
                                              │
                                              ▼  seconds later, nobody touched B
 tenant B's permit for X: 0.005 → 0.01 → 0.015 as distinct tenants report
```

The EVM system, with its trust boundaries, is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the Solana program, its
authority model and the reasoning behind its checks are in
[`solana/README.md`](solana/README.md).

## Tokenized stocks on Solana

The allowance model, applied to an agent buying tokenized stocks with USDC. The
catalog is xStocks; PreStocks are listed for discovery only and cannot be
traded.

### What the program enforces

[`quaestor_stocks`](solana/programs/quaestor-stocks/src/lib.rs) holds the USDC
in a vault. The operator key has one instruction, `execute_trade`, and it
passes only if all of this holds:

- the amount is inside the per-trade cap and the epoch cap;
- the instrument is on the owner's allowlist (a PDA per mint);
- the venue is on the owner's allowlist (an `ApprovedRouter` PDA per program);
- the intent has not run before (a replay fails creating its `IntentRecord`);
- after the swap, measured from the token accounts rather than read from the
  route: the vault gave up no more than `amountIn`, and the position gained at
  least `minOutput`. If not, the whole transaction reverts.

Each position is owned by a PDA derived from its own mint, and that authority is
never lent to a router, so a route holding the vault's signature still cannot
sell a position the agent already has. The operator has no withdrawal
instruction: `withdraw_usdc` is the owner's, and so are the caps, both
allowlists and the operator itself. Inside a trade the program does not read
the route, so it does not decide where the USDC goes; what it bounds is how much
can leave (at most `amountIn`, inside the caps) and what must arrive (at least
`minOutput`). Whether `minOutput` is a fair price is the price gate's job, below.
An agent never composes a route: it has quote, preview and execute, and the hub
builds the trade. 21 tests run against
the program on a local validator
([`solana/tests/governor.test.ts`](solana/tests/governor.test.ts)), and the
reasoning is in [`solana/README.md`](solana/README.md).

The same program also exists as a lean build
([`solana/programs/quaestor-stocks-lite`](solana/programs/quaestor-stocks-lite/src/lib.rs)):
a Pinocchio port that keeps Anchor's wire format byte for byte, so the client
and all 21 tests run against it unchanged. It is 43,560 bytes against 329,136,
which is 0.22 SOL of refundable rent to deploy instead of 1.67. It is built and tested, not
deployed.

| Devnet | Address |
|---|---|
| Program `quaestor_stocks` | [`7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG`](https://explorer.solana.com/address/7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG?cluster=devnet) |
| Governor | [`7dWHCaSbywwN1XUTN1eB5yKBC6DFmue9GfS5nd1attQU`](https://explorer.solana.com/address/7dWHCaSbywwN1XUTN1eB5yKBC6DFmue9GfS5nd1attQU?cluster=devnet) |
| Vault | [`BW2tXcPUBJvhK3pYMHK4QRiQjuvGJZGGEemyj4YWTapg`](https://explorer.solana.com/address/BW2tXcPUBJvhK3pYMHK4QRiQjuvGJZGGEemyj4YWTapg?cluster=devnet) |
| Operator | [`VGxcgHoikyvGHiMEtzW25eVwSzymREaF8fhTbGJSFuT`](https://explorer.solana.com/address/VGxcgHoikyvGHiMEtzW25eVwSzymREaF8fhTbGJSFuT?cluster=devnet) |

### The price gate

The chain enforces `minOutput`, but `minOutput` comes from the quote. A venue
that quotes far off the market passes every on-chain check while handing the
agent a bad trade, because the chain has never seen a price. So before an intent
is signed, [`stocks/market-guard.ts`](stocks/market-guard.ts) measures the
*floor* the quote guarantees against prices observed independently of the venue:
two reference sources for the underlying (Backpack's perp index, and the
issuer's underlying price carried in Jupiter's price v3 response) plus Jupiter
for the token. A refusal is one of `MARKET_DATA_UNAVAILABLE`,
`MARKET_DATA_STALE`, `MARKET_SOURCES_DISAGREE`, `SESSION_CLOSED`,
`PRICE_DISLOCATION` or `QUOTE_OFF_MARKET`. It fails closed: no data refuses,
stale data refuses, disagreement refuses. The premium band widens outside
regular US hours, and because xStocks are Token-2022 scaled-UI-amount mints, the
multiplier is applied before a raw amount is priced.

One set of numbers does not fit every kind of instrument, so the owner's policy
is named per kind and every assessment says which one judged it (`policy_scope`):

| Policy | For | What differs |
|---|---|---|
| `default` | listed shares (xStocks) | the numbers above |
| `pre-ipo` | PreStocks, which are priced and judged here and never traded | measured against the issuer's mark rather than an exchange: both sides required, no session to be closed, a 1,500 bps band. The mark arriving by two routes is one party's number, and the gate does not call it two sources |
| `anchored-curve` | a bonding curve launched around a share's price | the pool's price is the token side and the share's the reference, both required. The band is the curve's launch band plus an allowance for the share moving after the anchor, the same in every session |

*Honest limit:* none of these sources are signed, and the gate runs in the hub,
not on-chain. It is evidence for a decision — each source named in the
assessment, the assessment's hash carried in the decision record, the record
hashed into the intent — not a substitute for the postconditions.

### A real venue: Meteora's bonding curve

Nearly every bonding-curve launch starts near zero and pays whoever arrives
first. A tokenized stock already has a price, so
[`stocks/dbc-launch.ts`](stocks/dbc-launch.ts) plans a Meteora DBC curve that
lives entirely inside a band around it: it opens 300 bps under the reference,
graduates 300 bps over it, and puts its depth in the middle, with a fee that
starts high and decays so that being first costs more, not less. The reference
comes from the hub's own price gate, and with no fresh price there is no launch.

One is live on devnet, anchored to AAPL at $334.49, and the governor buys from
it. DBC's swap is built with the vault's PDA as its payer and the instrument's
position account as its destination, so the one signature the governor lends is
the only one the venue needs, and nothing in the hub signs for the pool. That is
the difference between this and the test venue. A whole launch cost 0.0266 SOL.

The same launch is live on Solana mainnet, under a name with no company's ticker
in it: pool [`5cbDfFRG…`](https://explorer.solana.com/address/5cbDfFRGsAUUMGM5XJsKgkzZUJeLuD7H2QtkjkBXmz4N),
anchored to AAPL at $334.88, for 0.0266 SOL. The launch is on mainnet; the
governor, and so the governed buy, is on devnet.

| | Transaction |
|---|---|
| The governor buys 2 USDC of the curve through a CPI into Meteora's program | [NbBAPSLW…](https://explorer.solana.com/tx/NbBAPSLWdesMw5FXzBdo6ckpCqtSgS1NxgotbqMY3Jn9AEkGw7REp5oewUhZwZRvGVN7E1zWrKuL5yzb1NVMkcE?cluster=devnet) |
| DBC is told to accept anything and its swap succeeds; the governor measures half of what the intent committed to and reverts: `MinimumOutputNotMet` | [66UqTivo…](https://explorer.solana.com/tx/66UqTivorx2k4SD25d7DXrSTRsks83rdzEvBNKincxKCsSZPvpRH56pqDUBPEdCbKmJmLWFqCuNoSAZm6AUiwtKm?cluster=devnet) |

On the hosted hub it is a second instrument, `qAAPLdemo`, through the venue
`meteora-dbc`: quotes come from the curve's own state as a guaranteed floor, a
quote that names no venue goes to the curve because that is where it fills, and
once the curve graduates the venue answers `NO_ROUTE` instead of quoting
something no route could settle. After launch the share keeps moving and the
curve's range does not, so `GET /v1/stocks/curves` tells the issuer whether fair
value is still inside it: above the range the curve is bought out and graduates
at a discount, below it the curve is stranded above fair value, and either is
the moment to retire it for one around the new price. The launch plan, the costs
and the CPI's measured depth and compute are in
[`solana/README.md`](solana/README.md).

*Honest limit:* `qAAPLdemo` is a devnet demo token with no claim on anything,
and nothing arbitrages it against the share. It is anchored to AAPL's price, it
does not track it, and the gap is what the `anchored-curve` policy measures.

### A restart forgets; the chain does not

The hub keeps its orders, its spend and its holdings in memory, so a redeploy
loses them. The caps were never at risk — the program enforces its own — but the
hub's *answers* were: a fresh process reported nothing spent and a vault balance
it had been configured with, so a preview promised a trade the chain would
refuse and a portfolio showed none of what the agent held.

That needs no database, because the governor already writes the facts down. At
boot, and on a timer after, the hub reads the vault's balance, each position's,
and the governor's own spend and epoch, and takes them over its own
([`stocks/solana-ledger.ts`](stocks/solana-ledger.ts)). It refuses to do so
while a trade is in flight, because a reservation is a claim on the vault that
would be lost, and it adopts a cap from the chain only when the chain's is
tighter than the one this deployment runs. Until the first read succeeds the
vault reads empty and trades refuse for want of funds: the wrong answer, in the
safe direction.

`GET /v1/stocks/trades` is then the program's own record of every settled trade,
one account per intent, which a replay cannot add to.
`GET /v1/stocks/intents/:intentId` finds one by the id its agent used. An order
id is only this process's name for a trade, so after a restart it is gone, and
the 404 says where to look instead of implying the trade never happened.

*Honest limit:* the chain holds what happened, not why. The decision record's
hash is on chain and its text is the hub's, so a restarted hub can prove the
trade and cannot reconstruct the reasoning behind it. It says so rather than
inventing the difference.

### Who holds the key that signs

The operator's key is the one trading secret a hosted hub needs, and a host that
holds a keypair holds all of it. The hosted hub does not: its operator is a
two-of-two MPC wallet with [Dynamic](https://www.dynamic.xyz), made by importing
the operator the governor already records, so nothing changed on chain. The hub
has one share, Dynamic the other, and a signature takes both
([`solana/dynamic-signer.ts`](solana/dynamic-signer.ts)). The transaction goes
out to be co-signed before the fee payer has signed it, so what leaves the
process cannot be submitted by anyone else. A co-signer that refuses, stalls or
signs a different message is a trade that was never submitted, and its
reservation is released. `DYNAMIC_OPERATOR=1` turns it on; without it the hub
signs with a keypair.

*Honest limit:* this changes who can sign, not what a signature can do. Someone
holding everything on the host could still sign governed trades, or ask Dynamic
to export the key, until the owner revokes the API token. If they exported it
first, revoking is not enough and the owner replaces the operator with
`set_operator`. The governor's caps bind every signature either way.

### See it

- The Stocks view: https://quaestor-app.onrender.com/#/app/stocks
- The same view, opened on a quote the gate refuses (a venue delivering 6% too
  little): https://quaestor-app.onrender.com/#/app/stocks?shortfall=6
- The hosted hub: https://quaestor-stocks.onrender.com — devnet, live execution,
  capped at 5 USDC per trade and 25 USDC per day, with a 1 USDC minimum trade
  and 40 executions per day.

### Bring an agent

The hub serves MCP over Streamable HTTP, stateless:
`POST https://quaestor-stocks.onrender.com/mcp`.

| Caller | Tools |
|---|---|
| No key | Nine that read: `quaestor_stock_instruments`, `_venues`, `_market`, `_prices`, `_quote`, `_policy_preview`, `_order`, `_intent`, `_portfolio`. The execute tool is absent from the list, not merely refused |
| Agent key, as `X-API-Key: <key>` or `Authorization: Bearer <key>` | The same eight, plus `quaestor_stock_execute` |

A key that is presented and wrong is refused outright rather than downgraded to
the public tier, so a typo is visible to the one person who made it. Retrying an
intent returns the same order, never a second trade. The procedure — quote,
preview, execute, and how to read a refusal — is a skill,
[`skills/quaestor-trading`](skills/quaestor-trading/SKILL.md), in the one format
Bankr's agent, xAI's Grok bot, Claude Code and Codex all read. Tell the agent:

```
install the skill at https://gitlab.com/ndivij2004/quaestor/-/tree/main/skills/quaestor-trading
```

### Paid tools

Governance is free. What is sold is the gate's judgement, one call at a time, to
agents that trade somewhere else:

| Tool | Price | Route on the hub | What it answers |
|---|---|---|---|
| quote-check | $0.005 | `POST /v1/intel/quote-check` | Is this quote, from any venue, a price the observed market supports? |
| market-evidence | $0.002 | `GET /v1/intel/market-evidence?instrument=AAPLx` | What each source says, how far they disagree, the premium, the session |
| price-tape | $0.001 | `GET /v1/intel/price-tape?instrument=AAPLx&window=1h` | Where token and underlying have been over a window |

`GET /v1/intel` is the free index. The tools answer for live mainnet AAPLx,
NVDAx and SPYx, which the hub watches but does not trade, as well as for the
devnet instrument. There are two ways to pay:

- **x402 on Solana, in USDC, settled by PayAI**, directly on the hub: call the
  route, answer the 402. The hosted hub's lane is on Solana devnet, so the 402
  asks for Circle's devnet USDC (from faucet.circle.com), not mainnet USDC.
  PayAI pays the network fee, so the agent wallet needs that USDC and nothing
  else. `npm run intel:pay` does it end to end.
- **Bankr x402 Cloud, in USDC on Base.** Three handlers in
  [`integrations/bankr-x402/`](integrations/bankr-x402/) are deployed with
  `npx @bankr/cli x402 deploy`. Bankr takes the payment; the handler calls the
  hub's `/internal/intel/*` routes with a server-to-server key that opens those
  three reads and nothing else.

An instrument the deployment itself trades can be checked for free at
`POST /v1/stocks/quote-check`.

*Honest limits:* this is devnet. Nobody issues tokenized stocks on devnet, so
one traded instrument is a Token-2022 test mint, `dAAPLx`, priced from the live
mainnet AAPL reference through a test program (`router-stub`, kind `test`), and
the other is a demo token on a real venue program, Meteora's DBC. What is real:
the governor program and every check it makes, the price gate and the market
data it reads, Meteora's program, and the transactions, which are on the
explorer. What is not shown is a fill against a real issuer's liquidity.

## Spend governance on EVM chains

[`contracts/Quaestor.sol`](contracts/Quaestor.sol) is the same idea for an agent
that pays for data, pays for inference and trades.

### What the contract enforces

**1 · Purpose-scoped budgets.** Spending is capped per epoch *and* per action
across `DATA` (paid API calls), `INFERENCE` (metered LLM cost) and `EXECUTION`
(trades). "0.005 a day on inference, 0.01 on trades" is two `Policy` structs on-chain,
one `{epochCap, perCallCap}` per category, and inexpressible as a session key. An agent trusted to buy data can still be
barred from trading with it.

**2 · The reason and the payment are one atomic on-chain fact.** Every spend
emits a `Receipt` committing the keccak-256 of the decision record — the agent,
the action, its rationale, the inputs it acted on, the model when one was used,
and a timestamp — in the same transaction as the transfer. The operator
publishes the record; **anyone re-computes the hash in their own browser**. No
trusted validator, no log file someone rotated.

**3 · Stop-authority without spend-authority.** The owner can appoint a
**guardian**: an address the chain permits to do exactly one thing — suspend.
It can never spend, withdraw, resume or change policy, so the kill-switch is
safe to hand to a bot. Ours watches the receipt stream and vetoes burst
spending on its own.

### What the hub adds: risk as a price

Every agent guardrail protects one agent. The hub protects the herd.

**4 · The price is the risk signal.** A route permit costs
`base × (1 + k · distinctReporters(venue, 24h))`. Reporters are counted **per
onboarded tenant, never per key or per agent**, so an operator who spawns a
thousand agents still moves the price exactly once. The permit is sold over x402
in HBAR on Hedera, so the ceiling on it is the buyer's own: the x402 client's
limit per payment, and the `permit_budget_hbar` a caller passes to
`/v1/policy/evaluate`, which the rule `venue_permit_affordable` checks against
the live permit price (default 0.05 HBAR). A venue the herd has reported prices
itself above that ceiling and the agent does not buy. Quaestor blocked nothing;
the trade just stopped being affordable.

*Honest limits:* the permit is not yet paid through the governor, so that
ceiling is the agent's configuration, not an on-chain cap. Paid as
`pay(agentId, INFERENCE, hub, …)` it would revert `PerCallCapExceeded` in
`_authorize`, but `/v1/risk/check` does not accept a governor receipt today. No
shipped agent buys a permit before it routes, and `swap` is not gated on one:
the routes are there for an agent that wants the signal. And one-per-tenant is
sybil-resistant at the tenant boundary, not proof-of-personhood. Binding a
reporter to a verified human is a swap of the `humanId` the gate already
carries — the counting rule does not change.

**5 · Herd immunity.** A tenant whose agent is attacked through a venue reports
it, and every other tenant's permit for that venue moves on the next quote. Run
against the live host with [`scripts/herd-demo.ts`](scripts/herd-demo.ts):

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

**6 · A policy that can only tighten.** `k` is set from `PERMIT_K` when the hub
boots (default 1). Inside the process it can only go up: `tighten()` ignores any
value that is not strictly higher, and nothing can lower it. No automated
harness calls `tighten()` yet, so on a running hub `k` stays at its boot value.
Loosening is a human action that arrives as new configuration, never as a
method call.
`GET /v1/policy/k` reads it; there is deliberately no route to write it down.

### Decisions, sold one request at a time

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
| `GET /v1/policy/evaluate?…&rules=N` | 0.0002 HBAR × rules | Seven rules. Five run against your **real** budget, read from the governor — not from what you claim; one validates the category; one checks the venue's permit price against the HBAR ceiling you set for permits (`permit_budget_hbar`, default 0.05). Two of the governor rules need spend history and refuse rather than guess when the index is stale |

Settlement is native HBAR on `hedera:testnet` through the
[Blocky402](https://blocky402.com) facilitator. `npm run hedera:pay` runs the
whole flow against a real payment and prints each step:

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
writes up the four that cost real time.

### What the chain keeps, and what it does not

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
  { "name": "per_call_cap", "pass": true,  "evaluated": true,  "source": "governor" },
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
`"source": "governor"`), so a stale index alone never makes them refuse; they go
unevaluated only when the governor cannot be read either, or when the request
itself is malformed (unknown category, unparseable amount). `evaluated: false`
is not `pass: false`, and the response says which happened.

It also stops taking the agent's word for its own budget. Pass the old
self-asserted field and you get told what was used instead:

```jsonc
"superseded": { "epoch_left_hbar": "99999", "used_instead": "0.00175",
                "note": "ignored — epoch headroom now comes from the governor,
                         not from the caller" }
```

`npx ts-node scripts/graph-check.ts` prints both sources side by side: they
agree on all seven chain-authoritative fields, and the shape block underneath
has no governor column at all. Agents get the same thing as an MCP tool
(`quaestor_budget`) and a skill,
[`skills/quaestor-budget-history`](skills/quaestor-budget-history/SKILL.md).

**Cato uses it on itself.** Before proposing a swap the house agent asks whether
the size is unusual *for it* — over 3× the largest payment it has ever made and
it stands down without asking the chain. That check is not redundant with the
cap: a sizing step that has been talked into maxing out sits just *inside* the
cap, and the cap cannot tell that apart from a normal day. Only the agent's own
history can, which is why this rule cannot exist without an indexer.

It is also fail-**open**, the opposite of the router's rule, on purpose:
refusing here would strand a live agent on every indexer hiccup to protect
something the governor already protects. Fail-closed is right when you are the
last line and wrong when you are the first of two. And it refuses to consult a
*different* governor's history — agent #1 exists on every chain this contract is
deployed to, with a different treasury and a different past on each, so live
Cato on X Layer logs `different governor, different past, so not consulted` rather than reading
Base Sepolia's numbers and being confidently wrong.

## Where it runs

Nothing in [`Quaestor.sol`](contracts/Quaestor.sol) knows which chain it is on.
Budgets are denominated in the chain's native unit, and the venue sits behind a
one-function interface, `IQuaestorRouter`.

| Chain | Role | Status |
|---|---|---|
| **Solana devnet** | The stock governor, program [`7whSJD…tFEG`](https://explorer.solana.com/address/7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG?cluster=devnet), and the hosted stocks hub that trades through it | live |
| **X Layer testnet** (1952) | Home of the EVM governor `0x7C8772…5921`, the AMM `0x7cf23d…8c12`, qUSD and qBTC. The house agents run here | live |
| **Arc testnet** (5042002) | Dollar-native: USDC is Arc's gas, so `msg.value` caps *are* dollar caps — same contract, no changes. Governor [`0x99D7fc…3b24`](https://testnet.arcscan.app/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24), AMM [`0x2e91d0…2D10`](https://testnet.arcscan.app/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10) | live |
| **Arc mainnet** | The same four contracts. `npm run arc:preflight` verifies the bytecode, the deployer, the cost, and that the governor will land on the *same* address it already holds on Arc testnet and Base Sepolia. Runbook: [`docs/ARC-MAINNET.md`](docs/ARC-MAINNET.md) | ready, not deployed |
| **Base Sepolia** (84532) | Governor [`0x99D7fc…3b24`](https://sepolia.basescan.org/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24) — the same address as Arc, because the same contract from the same nonce lands in the same place. This is the chain the subgraph indexes | live |
| **Ethereum Sepolia** (11155111) | Governor [`0x34317A…0bB3`](https://sepolia.etherscan.io/address/0x34317A98d851c5b0D46E0e491Be09Cb956980bB3) — the attestable source chain. Its `Receipt` events are carried into the budget root below by a proof the Attestcoin precompile checks, not by anything the hub reports | live |
| **Creditcoin CC3 testnet** (102031) | Budget root [`0x2e91d0…2D10`](https://creditcoin-testnet.blockscout.com/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10): a cross-chain cap that only counts spends that arrived with a verified proof. The hub reads it at `GET /v1/budget/1` | live |
| **Hedera testnet** (296) | Settlement rail, not a governor: the four paid x402 routes settle in HBAR through the Blocky402 facilitator | live |
| **Base** | Settlement rail for the paid stock tools, in USDC through Bankr x402 Cloud | live |

## Give it to your agent (MCP)

**The stocks tools need no checkout.** A hosted agent adds the HTTP endpoint and
nothing else:

```jsonc
// Claude Code: claude mcp add --transport http quaestor-stocks https://quaestor-stocks.onrender.com/mcp
{
  "mcpServers": {
    "quaestor-stocks": {
      "type": "http",
      "url": "https://quaestor-stocks.onrender.com/mcp",
      "headers": { "X-API-Key": "<your-agent-key>" }   // omit for the read-only tier
    }
  }
}
```

The key goes in a header, never in the URL and never in a tool argument. The
same tools run over stdio from a checkout with `npm run mcp:stocks`. Before
handing an endpoint to an agent, `npm run mcp:probe` checks it the way one would
arrive: no key gets the reading tools with execute absent, a wrong key is
refused, the right key lists execute under either header, a tool call returns
live evidence, and with `--trade` a 1 USDC trade runs and its retry returns the
same order instead of a second one.

**The EVM treasury, as tools.** Any MCP client — Claude Code, Claude Desktop,
Cursor — gets `quaestor_agent_status`, `quaestor_pay_url` (the full 402 flow:
fetch → pay through the governor → retry), `quaestor_pay`, `quaestor_swap`,
`quaestor_receipts`, `quaestor_budget`, `quaestor_verify_receipt`, and, with a
guardian key, `quaestor_suspend` — deliberately no resume: an agent may halt
itself; only the human owner restarts it.

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
npm test                                               # 332 tests: contracts, services, the stocks lane
npm run stocks:solana:test                             # the 21 program tests; needs the local validator
                                                       # from `npm run stocks:solana:validator` (WSL)

# local chain, full stack
npx hardhat node                                       # terminal 1
npx hardhat run scripts/deploy.ts --network localhost  # deploys, seeds pools, writes app config
npx hardhat run scripts/register-agent.ts --network localhost

npm run services                                       # terminal 2 — oracle, ledger, hub (+ guardian, + lanes)
npm run agent                                          # terminal 3 — Cato
cd app && npm install && npm run dev                   # terminal 4 — http://localhost:4180

# the herd moment, against a running services process. The hub reads TENANT_KEYS
# at startup, so the tenant key goes on the services process (terminal 2):
#   TENANT_KEYS=alpha:correct-horse-battery npm run services
HERD_TENANT_A_KEY=correct-horse-battery npx ts-node scripts/herd-demo.ts

# the stocks hub alone — no EVM keys. It exits unless SOLANA_STOCKS_TAKER and a
# 16+ character SOLANA_STOCK_OPERATOR_TOKEN are set; the devnet lane also needs
# SOLANA_DEVNET_RPC_URL. Agent keys are 24+ characters.
SOLANA_STOCKS_ENABLED=1 SOLANA_STOCKS_CLUSTER=devnet \
STOCKS_MCP_ENABLED=1 STOCKS_MCP_PUBLIC_READS=1 STOCKS_MCP_API_KEY=<your-key> \
  npm run services:stocks                              # http://localhost:8402, MCP at /mcp

# check an MCP endpoint as an agent would reach it; --trade also runs a 1 USDC trade
STOCKS_MCP_API_KEY=<your-key> npm run mcp:probe -- http://localhost:8402/mcp <mint> [--trade]

# buy a quote-check over x402 on Solana; the wallet needs Circle devnet USDC only
SOLANA_AGENT_KEYPAIR=<path-to-keypair.json> npm run intel:pay -- https://quaestor-stocks.onrender.com AAPLx

# push the EVM hub and the app live — there is no deploy on push, so after `git push`:
npm run deploy:render                                  # waits until live
```

Copy [`.env.example`](.env.example) to `.env`. Contract addresses come from
`deployments/<network>.json` after a deploy (`deployments/local.json` for
`localhost`). Networks in [`hardhat.config.ts`](hardhat.config.ts):
`xlayerTestnet`, `xlayer`, `hederaTestnet`, `hederaMainnet`, `arcTestnet`,
`sepolia`, `baseSepolia`, `creditcoinTestnet`, and `arc` once `ARC_RPC` and
`ARC_CHAIN_ID` are set. The local stack uses Hardhat's built-in `localhost`.

**The stocks hub, hosted.** Named agent keys are
`STOCKS_MCP_API_KEYS=name:<key>,name:<key>`, so one can be revoked alone;
`STOCKS_MCP_API_KEY` is the single-key form. A key shorter than 24 characters
is rejected and the endpoint does not mount. The paid tools need
`INTEL_ENABLED=1`, and the Solana rail `X402_SOLANA_ENABLED=1`,
`X402_SOLANA_PAY_TO=<address>` and `X402_SOLANA_CHARGE=intel`; the Bankr rail
needs `INTEL_PROXY_KEY`. A host has no keypair files, so the keypairs come from
the environment as JSON byte arrays — `DEVNET_PAYER_SECRET`,
`DEVNET_POOL_AUTHORITY_SECRET`, and `DEVNET_OPERATOR_SECRET` unless the operator
signs through Dynamic (`DYNAMIC_OPERATOR=1` with `DYNAMIC_ENVIRONMENT_ID`,
`DYNAMIC_AUTH_TOKEN`, `DYNAMIC_WALLET_PASSWORD` and `DYNAMIC_OPERATOR_WALLET`),
in which case that keypair is never read and should not be on the host. The fee
payer should be a dedicated low-value key, never the deployer or the upgrade
authority. The Dynamic SDK needs Linux or macOS and Node 22.
`TRUST_PROXY_HOPS` must be the host's real proxy depth: too few and every caller
shares the proxy's rate-limit bucket, too many and a caller forges
`X-Forwarded-For` to pick their own. Render measured at 3. On Render the hub
builds with `npm ci --include=dev`, starts with
`npx ts-node services/stocks-main.ts` on Node 22 with
`TS_NODE_TRANSPILE_ONLY=1`, and is health-checked at `/healthz`. A push does not
deploy it; that is done from the Render dashboard or API.

## Repository map

| Piece | What it is |
|---|---|
| [`solana/`](solana/) | The `quaestor_stocks` program and its lean Pinocchio build, the test venue, the client, the 21 validator tests, and the scripts that launched the curve and bought from it |
| [`stocks/dbc-launch.ts`](stocks/dbc-launch.ts) · [`stocks/dbc-venue.ts`](stocks/dbc-venue.ts) | A Meteora DBC launch planned around a price that already exists; the curve as a venue: its quotes, its route and its price on the tape |
| [`solana/dynamic-signer.ts`](solana/dynamic-signer.ts) | The operator as a Dynamic two-of-two MPC wallet; loaded only when switched on |
| [`stocks/market-guard.ts`](stocks/market-guard.ts) | The price gate: six refusal codes, fails closed |
| [`stocks/solana-executor.ts`](stocks/solana-executor.ts) | Submits the governed trade; an ambiguous submission is resolved from the on-chain `IntentRecord` and blockhash expiry, not left pending |
| [`stocks/redact.ts`](stocks/redact.ts) | Strips URLs and credentials from any message that reaches a client or a log |
| [`services/stocks-main.ts`](services/stocks-main.ts) | The stocks hub as a process of its own, so a host that runs it holds no EVM keys |
| [`services/mcp-http.ts`](services/mcp-http.ts) · [`mcp/stocks.ts`](mcp/stocks.ts) | MCP over Streamable HTTP with the two tiers; the tools themselves, shared with the stdio server |
| [`services/intel.ts`](services/intel.ts) · [`integrations/bankr-x402/`](integrations/bankr-x402/) | The three paid tools; the Bankr x402 Cloud handlers that sell them on Base |
| [`services/hardening.ts`](services/hardening.ts) | Per-client rate limits behind a counted number of proxy hops, a loopback exemption for the MCP tools' own calls, JSON error handlers |
| [`skills/quaestor-trading/`](skills/quaestor-trading/SKILL.md) | The trading procedure and its safety rules, for any agent that reads skills |
| [`contracts/Quaestor.sol`](contracts/Quaestor.sol) | The EVM governor: agents, treasuries, category budgets, receipts, guardian, kill-switch |
| [`contracts/QuaestorDEX.sol`](contracts/QuaestorDEX.sol) | Constant-product AMM behind `IQuaestorRouter`; the venue is swappable |
| [`sdk/`](sdk/) | Operator client — `pay`, `swap`, decision records, `verifyReceipt`; and the stocks client |
| [`mcp/`](mcp/) | The governed treasury as MCP tools; refuses to run with an owner key |
| [`agent/`](agent/) | **Cato**, the governed DCA agent, and [`selfcheck.ts`](agent/selfcheck.ts): whether a spend is unusual *for itself* |
| [`app/`](app/) | The multichain agent explorer: agents, decisions, routes and x402, networks, the Stocks view, browser-side receipt verification; wallet access isolated to owner management |
| [`services/oracle.ts`](services/oracle.ts) · [`ledger.ts`](services/ledger.ts) · [`guardian.ts`](services/guardian.ts) · [`indexer.ts`](services/indexer.ts) · [`starter.ts`](services/starter.ts) | Paid oracle, decision ledger, watchdog, event indexer, starter faucet |
| [`services/pricing.ts`](services/pricing.ts) · [`permits.ts`](services/permits.ts) | Pure permit arithmetic, tinybar-exact; the one price function, where `k` tightens only |
| [`services/threatfeed.ts`](services/threatfeed.ts) · [`hub.ts`](services/hub.ts) | The add-only feed, reporters counted per tenant; the write path and its two-tier gate |
| [`services/x402hedera.ts`](services/x402hedera.ts) · [`x402lane.ts`](services/x402lane.ts) · [`discovery.ts`](services/discovery.ts) | Pay-per-decision routes on Hedera, Bazaar-declared; a flat-priced x402 route on X Layer; `/.well-known/agent.json` |
| [`subgraph/`](subgraph/) · [`services/graph.ts`](services/graph.ts) | Schema and mappings over `Receipt` / `PolicySet` / `Suspended`; the budget reader: subgraph first, governor as fallback, refuses on a stale index |
| [`skills/quaestor-budget-history/`](skills/quaestor-budget-history/SKILL.md) | How an agent asks what its own spending looks like — and the four traps in doing it |
| [`scripts/herd-demo.ts`](scripts/herd-demo.ts) · [`pay-hedera.ts`](scripts/pay-hedera.ts) · [`arc-preflight.ts`](scripts/arc-preflight.ts) | The herd moment; the paying side of x402; everything that must be true before an Arc mainnet deploy |

Design notes live in [`docs/`](docs/): [`ARCHITECTURE.md`](docs/ARCHITECTURE.md)
and [`ROADMAP.md`](docs/ROADMAP.md) are the reference; the `STOCKS-DAY*.md`
files are a build record, and where they disagree with this page, this page is
current.

## Honest limits

- **The Solana lane is on devnet.** Its instruments are a test mint on a test
  venue and a demo token on Meteora's bonding curve, and its
  price gate reads unsigned sources off-chain. The program, the gate and the
  transactions are real; see the limits in that section.
- **Splitting the operator key changes who can sign, not what a signature can
  do.** See the limit under *Who holds the key that signs*.
- **Inference metering trusts the operator's numbers.** The chain cannot see
  an LLM call. What it enforces: the *reported* spend is capped, monotonic and
  public — a private, deniable overrun becomes a public, attributable one.
- **The threat feed is in-memory today.** It loses state on restart, which is
  fine for one process and wrong for a hub. The durable version is an
  append-only log with network-assigned timestamps; the interface does not
  change.
- **Decision records live on the host's disk, and the host keeps no disk across
  deploys.** Every record published since the last deploy resolves and re-hashes
  in the browser; older ones show *Record not published* with the retention
  date. The commitment on-chain is untouched — a record published later either
  matches the hash or it does not.
- **Tier-2 reporters are tenants, not humans.** Until agents carry a
  proof-of-human, "distinct reporters" means distinct onboarded tenant keys.
  Still one-per-tenant, still not one-per-agent.
- **One event per spend.** Sane above ~$0.01 per spend; true micropayments
  want epoch batching under one Merkle root.
- The decision ledger is an **availability** layer, never a trust layer —
  records verify client-side against the on-chain hash.

## FAQ

**Why not just give the agent a wallet with a small balance?** A small balance
caps the loss and nothing else. It cannot say what the money is for, which
venues are acceptable, or that a swap must deliver what it promised, and the
agent can still send all of it anywhere. An allowance is a policy the agent
cannot edit, enforced where the money is.

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

[MIT](LICENSE)
