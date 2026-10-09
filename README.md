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
- **Agents that pay people for work.** [Quaestor Operator](operator/README.md) is
  a growth agent on Arc: it pays real people per post, video, article or pull
  request that promotes a project, after checking the work is real, theirs and
  disclosed as paid, from a USDC budget in a payout governor.

![License: MIT](https://img.shields.io/badge/license-MIT-d4a843)
![Tests](https://img.shields.io/badge/tests-524%20passing-199e70)

**Monad Metropolis entry:** [the governor on Kuru's order book](#on-monad-kurus-order-book) ·
[what was built during the hackathon](#built-during-monad-metropolis-1-september-to-13-october-2026) ·
[try it on Monad testnet](https://quaestor-app.onrender.com/#/app/evm/monad-testnet)

**Tameion entry (Canteen × Circle, on Arc):** [Quaestor Operator](operator/README.md) ·
[open it](https://quaestor-app.onrender.com/#/app/operator)

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

# The house agent's governed spends on Base mainnet, newest first: purpose,
# amount, payee, and the hash of the reason committed with each one.
curl -s https://quaestor-hub.onrender.com/v1/explorer/base/receipts

# The reason behind one of them. It hashes to the metaHash the chain committed,
# and the x-record-source header says where the host found it.
curl -si https://quaestor-hub.onrender.com/decisions/0x23b389d6393cf96f96a283a3feadd1a24b272aead881ec5a0934bc2c18003059
```

Both hosts are free instances and sleep when idle; the first call may take a
minute to wake one. The house agent wakes every hour and trades real ETH
inside small caps: 0.0002 ETH a trade and 0.0006 ETH a day, which is room for
about eight of its swaps. When a day's budget is spent the governor refuses the
next one. That refusal is the product, not an outage.

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
  route: the vault gave up no more than `amountIn`, the position gained at
  least `minOutput`, and, if the owner set a limit price for the token, the
  vault paid no more than that per token. If not, the whole transaction reverts.

Each position is owned by a PDA derived from its own mint, and that authority is
never lent to a router, so a route holding the vault's signature still cannot
sell a position the agent already has. The operator has no withdrawal
instruction: `withdraw_usdc` is the owner's, and so are the caps, both
allowlists and the operator itself. Inside a trade the program does not read
the route, so it does not decide where the USDC goes; what it bounds is how much
can leave (at most `amountIn`, inside the caps) and what must arrive (at least
`minOutput`). Whether `minOutput` is a fair price is the price gate's job, below.
An agent never composes a route: it has quote, preview and execute, and the hub
builds the trade. 33 tests run against
the program on a local validator
([`solana/tests/governor.test.ts`](solana/tests/governor.test.ts)), and the
reasoning is in [`solana/README.md`](solana/README.md).

The same program also exists as a lean build
([`solana/programs/quaestor-stocks-lite`](solana/programs/quaestor-stocks-lite/src/lib.rs)):
a Pinocchio port that keeps Anchor's wire format byte for byte, so the client
and all 33 tests run against it unchanged. It is 52,440 bytes against 369,160,
which is 0.27 SOL of refundable rent to deploy instead of 1.88. It is built and tested, not
deployed.

### The owner's limit price

`minOutput` is an argument the agent signs. Against a buggy venue it holds;
against an agent that has been talked into buying badly it holds nothing: that
agent sets its floor to one base unit and routes through a pool its attacker
priced, and every check above passes. So the owner can set, per token, the most
the vault may pay for one whole token (`set_price_limit`). The program checks it
after the swap, on what it measured: USDC out times 10^decimals must not exceed
tokens in times the limit, or the trade reverts with `PriceAboveLimit`. The
agent cannot set or lift it. The limit is eight bytes appended to the token's
approval, which grows the first time one is set, so `execute_trade` takes the
same accounts as before and an approval without a limit trades as it always
did. Registering from the page sets one on the curve's token (370 USDC by
default, against a curve that sells between about 324 and 345), and the owner
changes it from the agent's page.

On devnet, September 23, 2026:

| | |
|---|---|
| A hijacked agent: floor of one base unit, 1 USDC into a pool that hands back 0.00000001 dAAPLx. The pool's swap succeeds, every cap passes, and the house governor's 400 USDC limit reverts it. Anyone can send this one from the Solana overview | [`2NEwM28F…`](https://explorer.solana.com/tx/2NEwM28F5qHJh5r1HWHXp5cLdxaUo8PREookncMdJLDmCR5c6JBuK1oJ6w6Hv3bvgytoqjo8qtWsQWZPgktrmMrD?cluster=devnet) `PriceAboveLimit` |
| A governor opened from the page with a 370 limit in the same signature | [`3n2CLt7s…`](https://explorer.solana.com/tx/3n2CLt7sMdgQnRy3VnLmJAYqcrCawcDdXsEbJpaN8cKmBsqo1nV4KVbk3TEPktutRdH3yMMn9LsjmqvskStxgjXr?cluster=devnet) |
| The owner lowers it to 300; the agent's 1 USDC buy on the curve (about 325 a token) is refused by the chain's simulation with `PriceAboveLimit`, and nothing is sent | none, by design |
| The owner puts it back to 370; the same buy settles, 0.003073 qAAPLdemo for 1 USDC | [`3nHsnhFW…`](https://explorer.solana.com/tx/3nHsnhFWG9gHF4z7t67XhPjvmXTKfbgcUjAQBYWCsV4seu74PeqZQ2bTSarBFr7mLdiaf8byxNVbaJBcA9p9v77e?cluster=devnet) |

What still bounds a hijacked agent without a limit is the caps: a floor it
chose protects no one from it. And the epoch cap is a fixed window, so across
the boundary between two epochs up to twice the cap can be spent in a few
seconds.

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
`MULTIPLIER_CHANGE`, `PRICE_DISLOCATION` or `QUOTE_OFF_MARKET`. It fails closed:
no data refuses, stale data refuses, disagreement refuses. The premium band
widens outside regular US hours, and because xStocks are Token-2022
scaled-UI-amount mints, the multiplier is applied before a raw amount is priced.
When the issuer schedules a new multiplier (a dividend or a split), nothing
trades from 15 minutes before it takes effect to 15 minutes after, the pause
[xStocks asks venues for](https://docs.xstocks.fi/developers/multipliers). The
moment comes from the same Jupiter response as the multiplier, and a mint with
no change scheduled is never refused for want of one.

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
the moment to retire it for one around the new price. A pool nobody has moved
off its opening price reads `at-opening`, not `tracking`: its gap to the share is
the launch's own opening discount plus the share's move since, and no market set
it. The same route watches the mainnet pool, read-only, with the fees it has
earned and who traded it: nine buys landed in its first minute, five of them in
one slot, and three sells took it all back out within five minutes, leaving the
pool at its opening price and 11.60 USDC of fees with the launch. The launch
plan, the costs and the CPI's measured depth and compute are in
[`solana/README.md`](solana/README.md).

**It graduates, and the governor follows.** A curve is a launch. Once it has
taken in its threshold it stops filling and DBC migrates its liquidity into a
Meteora DAMM v2 pool, and a route pinned to the curve breaks at that moment.
The governor's does not: its venues are an allowlist of programs that only the
owner edits, so the token keeps its mint, the governor keeps its position
account and caps, and only the venue changes. Where the curve will graduate is
known on the day it launches, because a DAMM v2 pool's address is derived from
the curve's migration config and the two mints
([`stocks/damm-venue.ts`](stocks/damm-venue.ts)). The hub asks DBC whether the
curve has migrated, from the pool's own flag, and quotes, routes and prices the
token on the curve before and on the pool after
([`stocks/curve-lifecycle.ts`](stocks/curve-lifecycle.ts)); a buy refused for
being too large is never mistaken for graduation. On 8 Oct 2026 the devnet curve
graduated:

| Step | Transaction |
|---|---|
| Before: the governor buys 2 USDC of the curve | [`4KHJdfbL…`](https://explorer.solana.com/tx/4KHJdfbLGDKfH7MbvoPYR1kpqZyzCaRLEMCvcFGDBJnTjqp7pRpn1AneWnaa3Nr9XsFcm8JHAKV52YihyUSAB4ct?cluster=devnet) |
| The rest of the curve is bought: 50,816.34 test USDC with fees, through DBC's partial-fill swap | [`4pkFdUuL…`](https://explorer.solana.com/tx/4pkFdUuLx6oBFYnxVDQ65nzE6t5EiWQPqFA6dyLgpu3BWeTKQPZ69BsZNe5zTZnugLyTgNKsf2DrbEbyx7j1gEuH?cluster=devnet) |
| DBC migrates it into DAMM v2 pool [`5cjRrMdh…`](https://explorer.solana.com/address/5cjRrMdhjtwULU7KpzDzMfpxxE5osx5CXaj3dVvWnKUV?cluster=devnet), which opens at the curve's last price, $344.5271 | [`4UD58zPa…`](https://explorer.solana.com/tx/4UD58zPaeLfsG9a5yxGAHbWZ62C97QMJxS5sZQDnoSbvh1PLWG7fq2dimFMWqZ9WMR5Yvq34SJptRC13YiWejWYq?cluster=devnet) |
| The owner allows DAMM v2 as a venue, once; no program upgrade | [`66eMsMQN…`](https://explorer.solana.com/tx/66eMsMQNxm9t2yoUUz3o52PWihvKpSoxVLE4vvr2nRWVVvBCs148zNbjBQTegLsfNtL7LiP1nMpevbeaZS43SBR9?cluster=devnet) |
| After: the governor buys 2 USDC on DAMM v2, into the same position account | [`2GyksX3c…`](https://explorer.solana.com/tx/2GyksX3cgaWmkY67J3maKT6SKTZhpLwXCP1YxW2WV6M9iQvQvKxPNcpF4NURkcNj6Cmkg8zhJ5KT2rzwVQZwc1in?cluster=devnet) |
| 6 USDC against a 5 USDC cap: `PerTradeCapExceeded`, before DAMM v2 is called | [`3ao1SVmj…`](https://explorer.solana.com/tx/3ao1SVmjdf1BpDbDGBdxewwKuzyPmPBnyM63Rp3NhKtTXEmHcZKoycV3j4kzGeedE11cgid7Tm1TGsuzztCRp2ks?cluster=devnet) |
| DAMM v2 told to accept anything and its swap succeeds; the governor measures half the floor and reverts: `MinimumOutputNotMet` | [`Wsck2Rh8…`](https://explorer.solana.com/tx/Wsck2Rh8ivSi6rKB3xBBosxhZTYTR8AwAoUKoPLtpneFRHnv5aeuZ5D3YBqwL31cPEQYaxJCLHRZcQgqJTAkQ9t?cluster=devnet) |
| The same refusal sent by the hosted hub's public button, routed by the hub to DAMM v2 | [`2j1g3jo3…`](https://explorer.solana.com/tx/2j1g3jo35BT7RYpQJixVQDB7XetBkj9zdJeQ9pkbvfvhXsyiUE5xtxgeuCjBkRcE3bgSGNPwN95NQcZi6jNoicWi?cluster=devnet) |

`solana/scripts/dbc-graduate.ts` fills and migrates a curve, and
`solana/scripts/damm-governed.ts` trades the graduated pool. Nobody trades
devnet, so the fill was ours, in devnet's test USDC. A governor registered from
the app now allows DAMM v2 alongside DBC, so graduation does not strand it, and
the agent command quotes and buys on whichever venue the token trades on now.

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
tighter than the one this deployment runs — recomputed from the configured cap
each time, so an owner who raises the chain's cap back up is not stuck behind
the tightest reading the hub ever saw. Until the first read lands, trades refuse
with `CHAIN_STATE_UNAVAILABLE`: not a claim that the vault is empty, which would
be a different and false statement about the agent's money, but the true one,
that this hub cannot yet say what is left.

`GET /v1/stocks/trades` is then the program's own record of every settled trade,
one account per intent, which a replay cannot add to.
`GET /v1/stocks/intents/:intentId` finds one by the id its agent used. An order
id is only this process's name for a trade, so after a restart it is gone, and
the 404 says where to look instead of implying the trade never happened.

*Honest limit:* the chain holds what happened, not why. The decision record's
hash is on chain; its text goes to the decision ledger when the trade settles,
and the ledger keeps what it is given only since it last started, because its
host has no disk across deploys. A record published before that is gone from
the ledger, and a trade's page says so rather than inventing the difference.
The hash still binds any copy that turns up.

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

- The Solana explorer, every governor and trade on the program:
  https://quaestor-app.onrender.com/#/app/sol
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
| Agent key, as `X-API-Key: <key>` or `Authorization: Bearer <key>` | The same nine, plus `quaestor_stock_execute` |

A key that is presented and wrong is refused outright rather than downgraded to
the public tier, so a typo is visible to the one person who made it. Retrying an
intent returns the same order, never a second trade. The procedure — quote,
preview, execute, and how to read a refusal — is a skill,
[`skills/quaestor-trading`](skills/quaestor-trading/SKILL.md), in the one format
Bankr's agent, xAI's Grok bot, Claude Code and Codex all read. Tell the agent:

```
install the skill at https://gitlab.com/ndivij2004/quaestor/-/tree/main/skills/quaestor-trading
```

### A governor of your own

The hosted hub trades from one governor. Any wallet can open another: the
program lets every wallet create exactly one, at an address its key decides.
The Solana side of the explorer, https://quaestor-app.onrender.com/#/app/sol,
reads every governor and every settled trade straight from the program's
accounts on devnet, with no indexer between the page and the chain. Its reads
go through the stocks hub's read-only devnet relay, `POST /v1/solana/devnet`,
which answers from a keyed endpoint and keeps what every viewer reads alike for
five seconds; when the relay does not answer, the page reads the public endpoint
as before. A wallet's transaction always goes straight to the public endpoint.

1. **The agent makes a key.** It runs one file, which needs Node 18 and
   nothing else:

   ```bash
   curl -fsSLO https://gitlab.com/ndivij2004/quaestor/-/raw/cli-v9/cli/dist/quaestor-sol.mjs
   curl -fsSLO https://gitlab.com/ndivij2004/quaestor/-/raw/cli-v9/cli/dist/quaestor-sol.mjs.sha256
   sha256sum -c quaestor-sol.mjs.sha256        # macOS: shasum -a 256 -c quaestor-sol.mjs.sha256
   node quaestor-sol.mjs keygen
   node quaestor-sol.mjs register --deposit 50 --per-trade 5 --epoch-cap 25 --epoch day
   ```

   `register` checks the numbers and prints a link that carries them and the
   agent's address.
2. **The owner opens the link and signs once.** The page takes any Solana
   wallet (Phantom, Solflare, Backpack), has a faucet button for 100 test USDC
   and some SOL, and opens the governor in one transaction: create it with the
   agent's key as operator and the owner's caps, allow the Meteora curve and
   its token, open the account bought tokens land in, and deposit. Solana runs
   the five as a unit. The agent cannot take this step for itself, and that is
   the point: whoever registers owns the vault and sets the caps.
3. **The agent trades inside the caps.** `status`, then `quote` (the curve's
   quote and the price gate's verdict on it), then `buy --dry-run` (the chain
   simulates the real transaction), then `buy`. A buy is signed and recorded
   before it is sent, so a dropped connection answers `UNCONFIRMED`, `check`
   settles it, and a second buy is refused until it has. A refusal comes back
   as the program's own error name, with what it means. The procedure and its
   safety rules are a skill, [`skills/quaestor-solana`](skills/quaestor-solana/SKILL.md).
4. **The owner stays in charge from the agent's page:** change the caps,
   suspend and resume, deposit and withdraw, take bought tokens out to their
   own wallet, or replace the agent's key. Each
   is one transaction the program checks the owner signed.

Every settled trade has a page: what the program recorded, the token and venue
from the transaction that wrote it, and the decision record, fetched from the
ledger and hashed in the browser against the hash the program stored. For a
trade the command made, the page also re-derives the intent hash from the
record and the trade's governor, token, amount and floor. The command keeps a
copy of every record it commits, and a copy pasted into the page is checked the
same way: the hash decides, not the page.

Run on devnet, September 22, 2026:

| | |
|---|---|
| A governor opened from the page with one signature | [`bsjonZvm…`](https://quaestor-app.onrender.com/#/app/sol/agents/bsjonZvm3wkFnHbxUXqTyrb5xo9VBeuU5V21i89wJ2t) |
| Its agent's command buys 1 USDC of `qAAPLdemo`: 0.003073 arrive against a floor of 0.003042, and the page re-hashes the record and the intent | [trade page](https://quaestor-app.onrender.com/#/app/sol/trades/7NmNEDMrgcsX9b37sDfshX1zau5Me1KnLBmAR7CACgZi) · [`4x3ZbuXu…`](https://explorer.solana.com/tx/4x3ZbuXuqG91eB15ndEfcp9Ref5YsUCLeADvEaJkH4eVbVkVdMFc4iQDjV8uD11oymtCFqPUAzhs8HaPgJ7EemD9?cluster=devnet) |
| The same command asks for more than the per-trade cap; the chain's simulation answers `PerTradeCapExceeded` and nothing is sent | none, by design |
| Eight owner changes from that page: caps, suspend, resume, deposit, withdraw, the agent key and back, the caps restored | on the governor's history |

*Honest limit:* the price gate runs off chain. The command holds itself to it,
and the program does not: an agent running its own code with its key could buy
what the gate refuses, inside the caps and at a floor it chose, and no dearer
per token than the owner's limit price where one is set. Bought tokens stay in
the governor's position account until the owner takes them out; the agent's key
cannot move them, and the program has no instruction that sells them yet. They
do keep their issuer's powers: a real xStocks or PreStocks token can be frozen,
and a PreStocks permanent delegate can move it, whatever the governor says. And
it is devnet: test USDC, and a demo token with no claim on anything.

### Paid tools

What is sold today is the gate's judgement, one call at a time, to agents that
trade somewhere else (the rest of the model is under *Business model*):

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

## Tokenized stocks on Robinhood Chain

The same governor, for Robinhood's Stock Tokens. Robinhood Chain is an Arbitrum
Orbit chain built around them: AAPL, NVDA, TSLA, SPY and about 190 more are
ERC-20s there, Paxos's USDG is the dollar, Uniswap is the exchange, and
Chainlink publishes a price feed per stock. An agent buys them with its
owner's USDG, and a contract of the owner's decides what it may pay.

`contracts/QuaestorStocks.sol` is a factory. Each agent gets its own governor,
a minimal clone that holds that owner's USDG and every share the agent buys,
so no agent's route can ever reach another agent's money. The agent's key can
call one function, `executeTrade`, which:

- refuses a trade over the per-trade or per-epoch cap, on a stock or venue the
  owner did not approve, or under an intent id that already traded;
- approves the venue (Uniswap's SwapRouter02) for exactly the trade's amount,
  calls it with the agent's calldata unread, and takes the approval back;
- measures its own balances and reverts if the budget fell by more than
  authorised, the shares rose by less than the agent's floor, or any share left;
- checks the fill's price per share against the owner's limit price, and
  against Chainlink's price for the share with a margin the owner sets, failing
  closed on a stale or missing price.

The floor is the agent's own number, so a hijacked agent sets it to one wei.
The limit price and the Chainlink check are the owner's, and they are checked
on what arrived, whatever the agent was told.

The owner signs once for all of it: the governor, its caps, its stocks and
limit prices, its Chainlink checks, the deposit, and the agent key's gas (the
USDG approval is a second signature). Nothing else in the contract sells a
share; the owner takes shares or USDG out whenever they like, suspended or not.

**Proof against the real contracts.** `FORK_ROBINHOOD=1 npx hardhat test
test/quaestor-stocks-robinhood-fork.test.ts` forks Robinhood Chain mainnet and
uses real USDG, the real AAPL Stock Token, Uniswap's SwapRouter02 and QuoterV2,
and Chainlink's AAPL feed:

| Case | What happens |
|---|---|
| An honest 5 USDG buy | fills exactly what QuoterV2 promised; the governor holds the AAPL; the approval is back to zero |
| A real route that sends the shares elsewhere | `MinimumOutputNotMet` |
| A hijacked agent: floor one wei, through the approved router, into an AAPL pool its attacker opened on the real Uniswap factory at $1M a share | Uniswap's swap succeeds; `PriceAboveLimit` reverts it |
| The same, with no limit price set | `FillAboveOracle`: Chainlink's $340 catches it |

`test/quaestor-stocks.test.ts` has 53 more cases against mock venues, including
the hazards only an ERC-20 approval has: a venue that pulls twice, an allowance
left behind, and a route reaching into another agent's governor. Slither's
findings on the contract are the design (the balance reads around the venue
call are the measurement) or fixed.

**Fuzzed with Echidna.** `contracts/fuzz/GovernorEchidna.sol` makes the fuzzer the
agent and hands it a venue that does whatever it is told: pay honestly, pull
twice, overcharge, send the shares elsewhere, hand budget back, re-enter the
governor, or reach for its shares, with Chainlink's price moving and days
passing between calls. Eight properties must hold whatever happens: never more
spent than asked, never over the per-trade or epoch cap, never under the floor,
over the owner's limit or past the Chainlink margin, no approval left standing,
and every dollar and share accounted for. A campaign of 1,000,093 calls broke
none, and its coverage report shows every refusal in `executeTrade` and the
settled path all reached. `echidna contracts/fuzz/GovernorEchidna.sol --contract
GovernorEchidna --config echidna.yaml` (Echidna 2.3.3, compiled via IR like the
deployment).

**The agent's command** is `cli/dist/quaestor-evm.mjs`, one file like the
Solana one: `keygen`, `register` (the link the owner signs), `status`, `quote`
(Uniswap's best tier against Chainlink's price) and `buy`, which refuses what
the governor would refuse before it signs anything. The skill is
`skills/quaestor-evm/SKILL.md`. The app's Robinhood Chain tab lists every
governor and trade, opens a governor from the agent's link, and has three
buttons that send the house governor a trade it must refuse, on chain.

### Live on Robinhood Chain's testnet

Mainnet is where the fork proof runs; the live governor runs on Robinhood
Chain's testnet (46630). There Robinhood's faucet hands out the Stock Tokens
(TSLA, AMZN, PLTR, AMD) and Paxos's faucet hands out Paxos's own testnet USDG,
100 a wallet a day. The rest of mainnet's stack is brought along:

| Piece | Testnet address | On mainnet it is |
|---|---|---|
| Governor factory ([verified](https://explorer.testnet.chain.robinhood.com/address/0x2B295A9DeAf3f91bCE7223294883fD55016D8580)) | `0x2B295A9DeAf3f91bCE7223294883fD55016D8580` | the same contract |
| **USDG**, Paxos's own testnet Global Dollar ([Paxos's docs](https://docs.paxos.com/guides/stablecoin/usdg/testnet), [faucet](https://faucet.paxos.com/?network=robinhood)) | `0x7E955252E15c84f5768B83c41a71F9eba181802F` | Paxos's USDG `0x5fc5360D…1d168` |
| tUSDG, a 6-decimal test dollar anyone can mint, for trying it without a faucet | `0xF2fa4cF4209C7FC4a42E309CE01a6716b6a51B64` | Paxos's USDG |
| Uniswap v3 factory, SwapRouter02, QuoterV2, deployed from Uniswap's published bytecode (`vendor/uniswap`) | `0x99D7fcf0…3b24`, `0x7D428Ea2…3A81`, `0x7C8772fb…5921` | Uniswap's own deployment |
| A USDG pool for TSLA and AMZN, and a tUSDG pool per stock, 0.3% | TSLA/USDG `0x67817C72…3Cd5`, AMZN/USDG `0xcEd30770…c33c` | the real pools |
| A MirrorFeed per stock: Chainlink's interface, holding what the hub copies from Chainlink's mainnet feed every ten minutes | TSLA `0xA8371e91…71e1`, AMZN `0x9EeFFDE0…b213`, PLTR `0x81f96777…9284`, AMD `0x0566d5D0…7544` | Chainlink's feeds |

Nobody arbitrages a testnet pool, so left alone each one drifts off its feed
and an honest buy is refused as too far over Chainlink's price (TSLA's had
drifted 3.35% by the morning after launch). The hub runs a keeper,
`services/pool-keeper.ts`, that does what arbitrage does on mainnet: every five
minutes, a pool more than 0.2% off its feed gets one swap through Uniswap's own
router with the feed's price as the swap's price limit, so Uniswap stops it
exactly there. Its first pass brought all four pools to within a basis point.

Each governor holds one dollar, chosen by its owner when it is opened: the
register page offers USDG or tUSDG, and the agent command reads the governor's
own dollar, so the same agent key buys through whichever pools match it.

Trades there, from the agent command:

| | |
|---|---|
| A new Claude Code agent set itself up from the skill, its owner opened a **USDG** governor on the register page, and the agent bought: 2 USDG → 0.005559 TSLA at $359.80, 0.61% over Chainlink | [`0xfcc97246…ebbf`](https://explorer.testnet.chain.robinhood.com/tx/0xfcc972468d21ba4aee01633afe753e5c17eb1ffeea822d9e17ba1379aa0eebbf) |
| 5 tUSDG → 0.013496 TSLA at $370.47, 0.37% over Chainlink | [`0xd8eac680…068e`](https://explorer.testnet.chain.robinhood.com/tx/0xd8eac6803ea7573deea5b89fefefbe177d4fcc0c7693085039cfabbb7c58068e) |
| 1 tUSDG → 0.002788 TSLA at $358.73, after the keeper's first pass | [`0x29bc0dba…fc17`](https://explorer.testnet.chain.robinhood.com/tx/0x29bc0dbae778c2262dbca6b6fe922228bec6eb8eedc3f37e887a280a438cfc17) |

The house governor `0xfBf777DC66A408526906955eBf62970d978fa841` takes the
refusal buttons' trades. The attacker's TSLA pool at the 0.01% tier asks about
$1M a share; the hijacked buy through it is refused `PriceAboveLimit` against
the owner's $406.

### On Monad: Kuru's order book

The same contract runs on Monad's testnet (10143), with Kuru's central limit
order book as the venue instead of Uniswap: the governor approves Kuru's router
for the trade's amount, calls `anyToAnySwap`, and measures what arrived, as it
does on Robinhood Chain.

Kuru's own testnet market delivers native MON in lots of 200, which a governor
holding ERC-20s cannot use, so Quaestor opened a Kuru market of its own through
Kuru's permissionless `deployProxy`: tETH/tUSDC, both test tokens anyone can
mint. The hub's market maker (`services/kuru-maker.ts`) keeps asks on it a few
basis points over Chainlink's real ETH/USD feed on Monad testnet, re-quoting in
one `batchUpdate` when the price moves 0.25%, because Monad charges a
transaction its whole gas limit. The same Chainlink feed is each governor's
price guard. Trade history is read from Envio HyperSync, since Monad's public
RPC answers `eth_getLogs` 100 blocks at a time.

| Piece | Address |
|---|---|
| Governor factory, a full match on Sourcify | [`0x2e91d035D622d2ECa36B7836CBcf9651711B2D10`](https://testnet.monadscan.com/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10) |
| Kuru tETH/tUSDC market | `0xf923eE198091D33630442a757060850363596773` |
| The attacker's Kuru market, one ask at $400,000 | `0x9B321861F186d1e94F97fdfE61D8C6652c3E6c09` |
| House governor (refusal buttons) | `0xBaEFcC4C57eeE6769fA37C3205b07ea2D1a22466` |
| A trade: 2 tUSDC → 0.000754 tETH at $2,652.79 | [`0x3a068082…d34b`](https://testnet.monadscan.com/tx/0x3a068082ada35637a03c9684d6cf7b4c23e543872783c0a35b6b6e9d89e9d34b) |

The agent command takes `--network monad-testnet` and `--usdc`; everything
else is the same.

#### Each partner's piece, and where to see it

| Partner | What it does in Quaestor on Monad | Proof |
|---|---|---|
| Kuru | The venue: the governor calls Kuru's Router for exactly the trade's amount on five markets Quaestor opened (tETH, tTSLA, tNVDA, tSPY, tAAPL), and measures what arrived | [the Monad page](https://quaestor-app.onrender.com/#/app/evm/monad-testnet): a $400,000 ask refused, `PriceAboveLimit` |
| Chainlink CRE | `integrations/chainlink-cre/stock-mirror` writes NVDA, SPY and AAPL from Arbitrum One to Monad through `QuaestorMirrorReceiver`, then starts the house agent over Confidential HTTP with its secret in the CRE vault | write [`0x25ecece7…7ec1`](https://testnet.monadscan.com/tx/0x25ecece738c453eb1a9e60bd92c27eb5e1b0344fd96798c21142c488d69f7ec1); receiver and mirrors verified on Monad's Sourcify |
| Kimi | `kimi-k2.6` decides the house agent's trades (`services/monad-agent.ts`): portfolio, Kuru quotes beside Chainlink, at most one buy a run; its reason is hashed on-chain | the agent panel on the Monad page |
| Dynamic | The house agent's key is a two-of-two MPC server wallet, `0xc813451F…43fF8`, wrapped as an ethers signer (`sdk/dynamic-evm-signer.ts`); it is the governor's operator and can only buy | CRE-started buy [`0x1e1d6f10…07aa`](https://testnet.monadscan.com/tx/0x1e1d6f1029f4dda07855b20d2efd94c43c32869e96207dd5cc2fb2fd8f7a07aa), 2 bps under Chainlink |
| Alchemy | `services/monad-tape.ts` follows Alchemy's `monadLogs` stream and shows each governed fill at Proposed, Voted and Finalized | [`0x6d6747d6…8ea6`](https://testnet.monadscan.com/tx/0x6d6747d6e54e78982e246f1dc1e59f3a79454c9e25e8bdc03b489d91b5f58ea6): final 465 ms after it was proposed |
| Envio | `integrations/envio-indexer`, a HyperIndex indexer of governors, trades, policy changes and CRE price writes; the app reads it live | [hosted GraphQL](https://indexer.dev.hyperindex.xyz/3983430/v1/graphql) |
| MetaMask Agent Wallet | `integrations/metamask-agent-wallet`, an `mm quaestor` plugin: the governor's checks before MetaMask signs, Guard Mode approval on top | buy [`0x06632885…63bf`](https://testnet.monadscan.com/tx/0x06632885b35bf645d4ddeecdffcc6f2f2d1719b4556c26d1963d8933b20c63bf); a 6 tUSDC buy over a 5 tUSDC cap is refused before MetaMask is asked |
| Aurora | The app's "Fund from any chain" panel: Aurora Intents brings USDC or ETH from Base, Arbitrum, Ethereum or Solana to a governor on Monad | NEAR Intents has Monad paused since 3 Oct 2026; the panel reads Aurora's incident feed and says so rather than open a deposit it cannot complete |

## Business model

Who pays, and for what. Nothing is charged on devnet.

| Line | Who pays | Price | Where it stands |
|---|---|---|---|
| Governed trades | the owner, per settled trade | 10 bps of the trade, taken by the program inside `execute_trade` | mainnet; not built |
| Platform share | an agent platform that gives its users governors and adds its own fee on top | Quaestor keeps 20% of that fee | mainnet; not built |
| Hosted agent key | an owner whose agent's key Quaestor holds in MPC and runs through the price gate | $0.01 a trade | the hosted hub does it on devnet, free |
| Curve launches | traders on an anchored curve Quaestor launches, as the curve's partner | every trading fee but Meteora's protocol cut | **earning on mainnet**: QANCHOR paid 11.60 USDC in its first five minutes; Meteora took 2.43 |
| Price verdicts | agents trading anywhere, per call over x402 | $0.001 to $0.005 | **live**: Bankr x402 Cloud (Base USDC) and PayAI (Solana) |

Why these numbers (prices checked on September 23, 2026): 10 bps is Jupiter's
own base fee (5 to 10 bps), beside 85 bps on Phantom's swaps, 87.5 on
MetaMask's, 75 to 95 on Axiom and about 100 on Telegram trading bots. Jupiter
keeps 20% of an integrator's fee, the split used for platforms. Wallet policy
engines are bundled or priced per signature (Coinbase's server wallets $0.005 an
operation, Privy and Turnkey about $0.01) and none checks what a trade returned;
$0.01 is that market's price for a key someone else holds.

The nearest product is Coinbase for Agents, which added US equities and x402
on September 22, 2026: custodial brokerage orders at zero commission, with
spend limits and per-action approvals set in the Coinbase account, and sandboxed
accounts for equities "coming soon". Its own agent guide says "a prompt budget
is not a server-enforced session or daily limit". Quaestor is the other shape:
the owner keeps custody, the stocks are tokens on Solana that trade around the
clock, and the limits are a program's that anyone can read and anyone can try.

The cost that matters on mainnet is the `IntentRecord`: each trade leaves 185
bytes, about 0.0022 SOL of rent, which the agent pays and nothing reclaims yet.
On a $5 trade that is about 5%, so the lean program's next step keeps recent
intents in a ring inside the governor instead of an account per trade.

Quaestor never holds a user's money: the program holds the vault and only the
owner withdraws. A hosted key can only trade, inside the owner's caps and limit
prices.

## Spend governance on EVM chains

### On Base mainnet, through the real Uniswap

[`QuaestorV2`](contracts/QuaestorV2.sol) is live on Base at
[`0x2e91d035D622d2ECa36B7836CBcf9651711B2D10`](https://basescan.org/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10),
and it works the way the Solana program does rather than the way the first
contract did. That one took a single router, fixed at construction, behind one
function signature: Uniswap does not have that function, so every venue would
have needed its own adapter written and trusted. This one never reads the route.
The owner allowlists the venue and the instrument; the operator hands over
calldata the contract does not parse; and what bounds the trade is measured on
the way out, how much left the treasury and how much reached the owner.

| | Transaction |
|---|---|
| 0.0002 ETH bought 0.545027 USDC through Uniswap's `SwapRouter02`, inside the caps | [0x7e32e090…](https://basescan.org/tx/0x7e32e09003d17a043c886dc5487d7babebc2ecb9bdfb9683cc73ccefda7dc1a3) |
| One wei over the per-trade cap: `PerCallCapExceeded`, before any money moves | [0x3ebff338…](https://basescan.org/tx/0x3ebff338dcf059fe209833ae9fe1d958bf423764d11bc6e1d7baa4066a78aadf) |
| The same trade through a contract the owner never allowed: `VenueNotAllowed` | [0x62f2b21f…](https://basescan.org/tx/0x62f2b21f2409ccd63dbbaa8b589bc70ef218b3b83518fc5454632d06fd5793a5) |
| Uniswap told to pay a stranger, and it does: `MinimumOutputNotMet` | [0x85b5f7a3…](https://basescan.org/tx/0x85b5f7a31f2a509b86910a956d767216634d7cd8612b48c4f1f1bc45199611ac) |

The last row is the one to open. Uniswap's swap succeeds inside that
transaction and the stranger would have been paid; the governor reads the
owner's USDC balance, finds it unmoved, and reverts the whole thing. The venue
being satisfied is not the test. Sixteen tests run the same cases against mock
venues that steal, underfill, substitute a token of their own, return change or
try to re-enter, and six more run against Uniswap itself on a fork of Base
mainnet (`FORK_BASE=1 npx hardhat test test/quaestor-v2-base-fork.test.ts`).

### Cato, hosted, on Base mainnet

The house agent runs on the hosted hub against that governor, once an hour. It
pays the hub's oracle for a signal (a `DATA` spend), and the oracle serves it
only against the receipt. The signal is Uniswap's own quote for 0.01 ETH, scaled
to one. Cato then buys USDC with ETH through Uniswap (an `EXECUTION` spend).
Both go through the governor. The USDC lands in the owner's wallet, because the
governor measures the owner's balance and nobody else's.

| | Transaction |
|---|---|
| Cato pays for a signal: 0.000002 ETH, `DATA` | [0x0e891ed4…](https://basescan.org/tx/0x0e891ed4dc3b3830fefd648db30318e05005fb8323cfefbe5fd77eddb5bd17de) |
| Cato buys 0.20408 USDC with 0.000075 ETH, floor 0.202039 | [0x3c24d35f…](https://basescan.org/tx/0x3c24d35fb9acc221aa9b21dc27f8d5a46535b6c7c8773c7b0acbe87dc6af4687) |
| The same loop from the hosted hub, after a redeploy | [0x6d106a6f…](https://basescan.org/tx/0x6d106a6fe5d35d292e36dc5e3c059cacd624e46cc1770692207aa7e9b0c398ef) · [its record](https://quaestor-app.onrender.com/#/app/decisions/0x23b389d6393cf96f96a283a3feadd1a24b272aead881ec5a0934bc2c18003059?chain=base) |

**The reason is on chain too.** Once a spend settles, and never before, Cato
publishes the decision record itself to
[`QuaestorLog`](contracts/QuaestorLog.sol) at
[`0x1219c6…F961`](https://basescan.org/address/0x1219c62A56771CdCE7bb1f6e6a5ac05701DDF961):
an append-only event log with no owner and no storage, about 63,000 gas for a
1 KB record. A refused spend publishes nothing. Before anything is published, a
guard refuses a record that looks like it carries a credential. The hub's
ledger answers from memory, then its disk, then the
[subgraph](subgraph/), then the chain's own logs, and it checks every answer
against the hash before serving it. On 21 Sep 2026 a redeploy wiped the hosted
hub. The records from before it came back from the subgraph
(`x-record-source: subgraph`) and re-hashed in the browser.

**The key on the host can only trade.** The agent's operator is a key of its
own ([`setOperator`](https://basescan.org/tx/0x444700f8e539ef62258c3978052656f4e4d1a24cc962b24b3cd37fd88a105956)),
funded with a little ETH for gas. It can make governed spends inside the caps
and nothing else. The owner key withdraws and rewrites the caps, and it never
leaves the owner's machine.

*Honest limits:* budgets here are in ETH, so the caps on Base are ETH caps, not
dollar caps. On a chain whose gas token is a stablecoin the same contract gives
dollar caps for free. Doing it on Base needs treasuries held in USDC, which
this contract does not yet do. Nothing here is audited, which is why the caps
are small: 0.0002 ETH a trade, 0.0006 ETH a day. The hosted Cato reads and
writes through a keyed RPC endpoint: `mainnet.base.org` rate-limits per IP, and
a free instance shares its IP. Its log reads go to a public endpoint in
2,000-block pages, because a free Alchemy key serves only 10.

### Bring your own agent

Any agent that can run a command can trade under a governor of its own, and
the owner never hands anyone a key. Three steps:

1. **The agent makes its key.** It fetches one file, which needs only Node 18,
   and runs `keygen`. The key stays in a file only the agent reads; the command
   prints the address and a link for the owner.

   ```bash
   curl -fsSLO https://gitlab.com/ndivij2004/quaestor/-/raw/cli-v1/cli/dist/quaestor.mjs
   curl -fsSLO https://gitlab.com/ndivij2004/quaestor/-/raw/cli-v1/cli/dist/quaestor.mjs.sha256
   sha256sum -c quaestor.mjs.sha256            # macOS: shasum -a 256 -c quaestor.mjs.sha256
   node quaestor.mjs keygen
   node quaestor.mjs register --name "my dca agent" --deposit 0.001 --execution 0.0006/0.0002
   ```

   `register` prints a link with the name, deposit and caps the agent agreed
   with its user already filled in. The agent cannot register itself: whoever
   registers owns the treasury and sets the caps, and an agent that did both
   would be bounded by nothing.

2. **The owner signs it** at that link,
   [`#/app/agents/new`](https://quaestor-app.onrender.com/#/app/agents/new?chain=base),
   from their own wallet, whichever they use (the page finds every installed
   wallet over EIP-6963): a deposit, three caps, and Uniswap and USDC allowed.
   A wallet that can batch calls atomically (EIP-5792) signs it all once;
   any other signs once per step.
   The defaults start where Cato runs: 0.001 ETH in, 0.0002 ETH a trade. The
   page checks every amount before the first prompt, asks the owner to confirm
   an operator that came in a link, and if setup stops after the deposit it
   finishes the missing steps instead of registering a second agent.
3. **The agent trades,** following the skill,
   [`skills/quaestor-base`](skills/quaestor-base/SKILL.md):

   ```bash
   node quaestor.mjs status --agent 7
   node quaestor.mjs buy --agent 7 --eth 0.0001 --reason "why this trade" --dry-run
   ```

`buy` quotes every Uniswap v3 fee tier and routes through the one that pays
most, so a thin or planted pool cannot set the price. The floor is that quote
less the slippage (1% by default, never more than 5%), and never below a floor
the user approved (`--min-out`). It asks the chain whether the trade would
settle without sending it, then swaps with the owner as the recipient and
publishes the reason to `QuaestorLog`. A refusal costs no gas, comes back as
the governor's reason in plain words, and exits 2.

A spend is signed, and its hash recorded, before it is sent. If the connection
drops, the command answers `UNCONFIRMED` with the hash instead of an error, and
sends no other spend until `check` has settled that one: mined, dropped, or
the same signed bytes sent again, which cannot spend twice. `pay` covers data
and inference; that money goes to whatever address the agent names, so it is
bounded only by those two categories' caps, and it refuses the governor, the
log and the agent's own key as payees.

The whole path was run on a fork of Base mainnet:

| | Result |
|---|---|
| Registration through the page | six transactions, all settled |
| From a `register` link, with a wallet that batches | one signature, six calls, the link's numbers on chain |
| A batching wallet that stopped after two calls | caught from the chain, finished into one agent |
| The fourth prompt rejected mid-setup | one agent, finished with the three missing steps |
| A deposit of `1,000`, an unconfirmed link | refused before any prompt |
| `buy` 0.0001 ETH | 0.273246 USDC to the owner through the 0.01% pool, record on `QuaestorLog` |
| A second 0.0002 after the day's budget | `EpochCapExceeded`, nothing sent |
| A token the owner never allowed | `InstrumentNotAllowed` |
| A floor above the market (`--min-out 5`) | `PriceMoved` |
| A spend the node refused, then `check` | the same signed buy sent again, settled, record published |
| A misspelt `--dryrun`, a reason holding the key, `pay` to the governor | refused before anything was signed |

Rebuild the file with `npm run build:cli`.


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
deployed to, with a different treasury and a different past on each. So
Cato on X Layer logged `different governor, different past, so not consulted` rather than reading
Base Sepolia's numbers and being confidently wrong. On Base mainnet the
subgraph indexes Cato's own governor, and the check reads it.

## Where it runs

Nothing in [`Quaestor.sol`](contracts/Quaestor.sol) knows which chain it is on.
Budgets are denominated in the chain's native unit, and the venue sits behind a
one-function interface, `IQuaestorRouter`.

| Chain | Role | Status |
|---|---|---|
| **Base mainnet** (8453) | `QuaestorV2` [`0x2e91d0…2D10`](https://basescan.org/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10) and `QuaestorLog` [`0x1219c6…F961`](https://basescan.org/address/0x1219c62A56771CdCE7bb1f6e6a5ac05701DDF961). Cato trades here hourly through Uniswap v3, and this is the chain the subgraph indexes | live |
| **Solana mainnet** | The Meteora launch curve, pool [`5cbDfF…mz4N`](https://explorer.solana.com/address/5cbDfFRGsAUUMGM5XJsKgkzZUJeLuD7H2QtkjkBXmz4N). The curve only: the stock governor stays on devnet | live |
| **Solana devnet** | The stock governor, program [`7whSJD…tFEG`](https://explorer.solana.com/address/7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG?cluster=devnet), and the hosted stocks hub that trades through it | live |
| **X Layer testnet** (1952) | Home of the EVM governor `0x7C8772…5921`, the AMM `0x7cf23d…8c12`, qUSD and qBTC. The house agents ran here until 21 Sep 2026, when Cato moved to Base mainnet | live |
| **Arc testnet** (5042002) | Dollar-native: USDC is Arc's gas, so `msg.value` caps *are* dollar caps — same contract, no changes. Governor [`0x99D7fc…3b24`](https://testnet.arcscan.app/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24), AMM [`0x2e91d0…2D10`](https://testnet.arcscan.app/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10) | live |
| **Arc mainnet** | The same four contracts. `npm run arc:preflight` verifies the bytecode, the deployer, the cost, and that the governor will land on the *same* address it already holds on Arc testnet and Base Sepolia. Runbook: [`docs/ARC-MAINNET.md`](docs/ARC-MAINNET.md) | ready, not deployed |
| **Base Sepolia** (84532) | Governor [`0x99D7fc…3b24`](https://sepolia.basescan.org/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24) — the same address as Arc, because the same contract from the same nonce lands in the same place. The subgraph indexed it until v0.2.0 moved to Base mainnet | live |
| **Ethereum Sepolia** (11155111) | Governor [`0x34317A…0bB3`](https://sepolia.etherscan.io/address/0x34317A98d851c5b0D46E0e491Be09Cb956980bB3) — the attestable source chain. Its `Receipt` events are carried into the budget root below by a proof the Attestcoin precompile checks, not by anything the hub reports | live |
| **Creditcoin CC3 testnet** (102031) | Budget root [`0x2e91d0…2D10`](https://creditcoin-testnet.blockscout.com/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10): a cross-chain cap that only counts spends that arrived with a verified proof. The hub reads it at `GET /v1/budget/1` | live |
| **Hedera testnet** (296) | Settlement rail, not a governor: the four paid x402 routes settle in HBAR through the Blocky402 facilitator | live |
| **Base** | Settlement rail for the paid stock tools, in USDC through Bankr x402 Cloud | live |
| **Robinhood Chain testnet** (46630) | The Stock Token governor, factory [`0x2B295A…8580`](https://explorer.testnet.chain.robinhood.com/address/0x2B295A9DeAf3f91bCE7223294883fD55016D8580), buying the faucet's TSLA, AMZN, PLTR and AMD with Paxos's testnet USDG or tUSDG on Uniswap v3 | live |
| **Robinhood Chain mainnet** (4663) | The factory [`0x2e91d0…2D10`](https://robinhoodchain.blockscout.com/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10), source verified on Sourcify, and the governor it clones `0xf05aE2…ecC7`; proven on a fork against real USDG, the AAPL Stock Token, Uniswap and Chainlink | factory live |
| **Monad testnet** (10143) | The same governor on Kuru's order book, factory [`0x2e91d0…2D10`](https://testnet.monadscan.com/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10) | live |

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
npm test                                               # 524 tests: contracts, services, the stocks lane
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
# SOLANA_DEVNET_RPC_URL. Agent keys are 24+ characters. SOLANA_DEVNET_RPC_URL also
# serves the explorer's devnet reads at /v1/solana/devnet, within
# SOLANA_DEVNET_RELAY_CREDITS_PER_DAY (default 20,000); SOLANA_DEVNET_RELAY=0 turns it off.
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
`sepolia`, `baseSepolia`, `base`, `creditcoinTestnet`, and `arc` once `ARC_RPC` and
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
| [`solana/`](solana/) | The `quaestor_stocks` program and its lean Pinocchio build, the test venue, the client, the 33 validator tests, and the scripts that launched the curve and bought from it |
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
| [`cli/quaestor.ts`](cli/quaestor.ts) · [`cli/dist/quaestor.mjs`](cli/dist/quaestor.mjs) · [`skills/quaestor-base/`](skills/quaestor-base/SKILL.md) | The one command an outside agent runs on Base, its one-file build, and the procedure it follows |
| [`cli/quaestor-sol.ts`](cli/quaestor-sol.ts) · [`cli/dist/quaestor-sol.mjs`](cli/dist/quaestor-sol.mjs) · [`skills/quaestor-solana/`](skills/quaestor-solana/SKILL.md) | The same for a governor of its own on Solana devnet: keygen, register link, quote, gated buy, check |
| [`app/src/views/solana/`](app/src/views/solana/) · [`services/faucet.ts`](services/faucet.ts) | The Solana explorer: governors, trades and their re-hashed records, registration in one signature, owner controls; the devnet faucet its register page uses |
| [`contracts/Quaestor.sol`](contracts/Quaestor.sol) | The EVM governor: agents, treasuries, category budgets, receipts, guardian, kill-switch |
| [`contracts/QuaestorDEX.sol`](contracts/QuaestorDEX.sol) | Constant-product AMM behind `IQuaestorRouter`; the venue is swappable |
| [`sdk/`](sdk/) | Operator client — `pay`, `swap`, `swapThrough`, decision records, `verifyReceipt` (in `sdk/evm.ts`); the Uniswap route builder; and the stocks client |
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
- **The Robinhood Chain and Monad lanes trade on testnets.** On Robinhood Chain
  mainnet the factory is deployed and verified, and the fork proof runs against
  mainnet's real contracts, but no governor there has traded yet. On its testnet the
  price guard reads MirrorFeeds the hub writes from Chainlink's mainnet feeds,
  not Chainlink's own network, and the pools sit at those prices because the
  hub's keeper puts them there. The USDG pools hold 30 USDG each, all a faucet
  gives in a few days, so a 5-dollar buy fills about 1% over Chainlink. On Monad the Chainlink feed is Chainlink's own,
  but the market, its tokens and the only maker quoting it are Quaestor's. The
  governor's checks are the same everywhere; what the testnets lack is an
  independent market for them to check against.
- **A hijacked agent is bounded by the owner's numbers, not by its own floor.**
  The floor is an argument the agent signs. What bounds an agent that has been
  talked into buying badly is the caps and, where the owner set one, the limit
  price. The epoch cap is a fixed window, so up to twice it can be spent across
  the boundary between two epochs.
- **Splitting the operator key changes who can sign, not what a signature can
  do.** See the limit under *Who holds the key that signs*.
- **Inference metering trusts the operator's numbers.** The chain cannot see
  an LLM call. What it enforces: the *reported* spend is capped, monotonic and
  public — a private, deniable overrun becomes a public, attributable one.
- **The threat feed is in-memory today.** It loses state on restart, which is
  fine for one process and wrong for a hub. The durable version is an
  append-only log with network-assigned timestamps; the interface does not
  change.
- **On Base the decision records are on chain; elsewhere they live on the
  host's disk.** On Base every settled spend's record is published to
  `QuaestorLog`, so it outlives any host. On the testnets the host keeps no disk
  across deploys: a record published before the last deploy shows *Record not
  published* with the retention date. The commitment on-chain is untouched
  either way. A record published later either matches the hash or it does not.
  On Solana devnet the hub and the agent command both publish to that ledger,
  and the command also keeps its own copy, which a trade's page checks against
  the hash when the ledger no longer has it.
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

## How it was built

### Before Monad Metropolis (14 to 24 August 2026)

The repository began on 14 Aug 2026, and 21 commits predate the hackathon's start on 1 Sep 2026.
They built the first EVM spend governor and its tooling, for X Layer:

- `contracts/Quaestor.sol`, the first spend governor, with its test DEX and faucet tokens
- the agent SDK, the receipt-settled oracle service and the guardian watchdog
- the first MCP server, the x402 lane, and the app's shell and landing page

None of it is what the Monad entry runs.

### Built during Monad Metropolis (1 September to 13 October 2026)

- **The Stock Token governor**, `contracts/QuaestorStocks.sol`, written on 28 Sep 2026, with its
  53 unit tests, 5 tests against a fork of a live mainnet, and the Echidna properties in
  `contracts/fuzz/`.
- **Everything on Monad**, from 28 Sep 2026 onward:
  - the deployment, and the Kuru venue path in the governor's SDK
  - the five Kuru markets and the market maker
  - the Chainlink CRE workflow and its receiver (`integrations/chainlink-cre`, `contracts/cre`),
    and its Confidential HTTP start of the house agent
  - the house agent: Kimi deciding, a Dynamic MPC wallet signing (`services/monad-agent.ts`,
    `sdk/dynamic-evm-signer.ts`)
  - the live tape from Alchemy's `monadLogs` (`services/monad-tape.ts`)
  - the Envio HyperIndex indexer (`integrations/envio-indexer`) and the HyperSync trade history
  - the Aurora Intents funding panel
  - the MetaMask Agent Wallet plugin (`integrations/metamask-agent-wallet`)
  - the agent CLI and skill, the RPC fallbacks, and the Monad pages of the app
- Also written in this window but not part of the Monad entry: the Solana stocks program, the
  `QuaestorV2` governor on Base, and Quaestor Operator on Arc.

`git log --since=2026-09-01` lists every step.

### AI coding tools

Quaestor was built with Claude Code (Anthropic) as a coding assistant.

## License

[MIT](LICENSE)
