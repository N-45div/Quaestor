# Quaestor Stocks — Solana programs

The governor that actually enforces the policy. `stocks/` (TypeScript) models the
same rules so an agent can preview a decision before paying for one; this is
where the rules bind.

## Why the program re-checks what the router promised

Off-chain, a governor can only check what a quote *claims*. Jupiter returns two
different numbers — `outAmount`, the fill it expects, and
`otherAmountThreshold`, the floor it enforces — and a route may land anywhere
between them. A quote is a promise about the future; it is not the outcome.

So `execute_trade` does not parse the route at all. It reads both token accounts
before the swap CPI, reads them again after, and requires:

| Postcondition | Error |
|---|---|
| the vault gave up no more USDC than the owner authorised | `RouteOverspent` |
| the destination gained at least the intent's minimum | `MinimumOutputNotMet` |
| the destination did not *lose* tokens | `StockBalanceDecreased` |
| the vault did not gain input tokens | `VaultBalanceIncreased` |

Both are measured from the accounts themselves, so they hold whatever the called
program does. The epoch is then charged what the route **actually** spent, not
what it was allowed to spend — an under-spending route must not consume budget
it never used. If either check fails the whole transaction reverts, so there is
no state where the budget was debited for a fill that never honoured its floor.

This is the on-chain answer to a bug found in the TypeScript layer on 17 Sep: a
route whose guaranteed floor sat below the intent's minimum was authorised, and
the shortfall was only *recorded* after the money moved.

## Scoped authority — a route cannot reach the agent's other positions

Postconditions guard the accounts a trade *names*: the vault it spends from and
the instrument it buys. They cannot, on their own, see a route that does exactly
what it was asked and, in the same instruction, sells off a *different* position
the agent holds — both named accounts move exactly as authorised. That hole was
real (a test proved it against an earlier build on 18 Sep) and is closed.

The defence is not another check but the shape of authority. Each position
account is owned by a PDA derived from its own mint
(`[POSITION_SEED, governor, mint]`), and that authority is never lent to a
router — a bought stock is credited, never spent, during a trade. The one
signature `execute_trade` lends is the vault authority, which owns only the USDC
vault. So a route can be handed the vault's signature and still cannot spend any
position: not the one being bought, and not any other. The signature that
touches AAPLx can only ever touch AAPLx.

## Authority

Three roles, as in the EVM governor this project started as:

- **owner** — funds the vault, sets caps, approves instruments, picks the router,
  suspends, withdraws
- **operator** — may only call `execute_trade`, and only inside the caps
- **router** — the one program the vault's signature may reach

The approved-instrument allowlist is a PDA per mint: the trading path proves
approval by deriving an address, so the number of instruments an owner may
approve is not bounded by what fits in one account.

Replay protection is the `IntentRecord` PDA. Its address comes from the intent
id, so a second execution of the same intent fails at account creation, before
any CPI runs.

## The one borrowed signature

To spend, the vault authority has to sign the swap, and it is a PDA — it cannot
sign the transaction the operator submits. `execute_trade` therefore promotes
exactly that one account to a signer in the instruction it composes, and passes
its seeds to `invoke_signed`. Every other account keeps the flags the outer
transaction gave it, so a route cannot borrow a signature the caller never
granted.

That authority also owns the share account, so what it is lent, it is lent for
both. This is safe only because of what runs after the call: the checks that cap
what may leave the vault also require the destination's balance to move the
right way. A route that buys nothing and sweeps the position instead fails on a
negative delta.

## Toolchain

Anchor does not run on native Windows; this builds under WSL.

```bash
# once
wsl bash -lc 'curl -sSfL https://release.anza.xyz/stable/install | sh'
wsl bash -lc 'rustup default stable'

# every time
wsl bash solana/build.sh          # both programs -> SBF
wsl bash solana/build.sh --ids    # just print program ids
```

Built against Solana CLI 4.2.2 (Agave) and Anchor 1.2.0. The Rust target
directory is kept on the Linux filesystem rather than under `/mnt/c`, where the
9p bridge makes builds several times slower.

`Cargo.lock` is committed: a program is a deployed binary, so its dependency
graph has to be reproducible.

## Tests

The program is exercised against a real validator, not a mock. Both `.so` files
are loaded at genesis at their declared ids, since the governor pins its router
by address and a stub deployed to a different id could not be reached.

```bash
wsl bash solana/tests/validator.sh   # terminal one
npm run stocks:solana:test           # terminal two
```

Twenty-one cases. The ones worth reading first give the router a route that lies —
one that delivers a lamport under the floor, one that spends more input than it
was authorised, one that takes the money and delivers nothing, one that sweeps
the position — and require the chain to throw the whole transaction away. Each
asserts the vault balance afterwards, because a refusal that still cost money
would be no refusal.

There is no Anchor CLI in the loop. Instruction data is built from Anchor's own
wire convention — an eight-byte `sha256("global:<name>")` ahead of borsh
arguments — so the suite needs a validator and two binaries and nothing else.
Each test builds its own governor: several change policy or suspend the agent,
and a suite whose ninth case passes only because its third ran first is testing
its own ordering.

## The lean build

A program's rent is its size, and the Anchor build is 329,136 bytes: about 1.67
SOL to put on mainnet. Almost none of that is this program's logic. It is the
framework, the standard library and the token crates underneath it.

[`programs/quaestor-stocks-lite`](programs/quaestor-stocks-lite/src/lib.rs) is
the same governor written against [Pinocchio](https://github.com/anza-xyz/pinocchio),
with no framework, no allocator and no standard library:

| Build | Size | Rent |
|---|---|---|
| Anchor (`programs/quaestor-stocks`) | 329,136 bytes | 1.6729 SOL |
| Anchor, every compiler size setting on | 292,832 bytes | 1.49 SOL |
| Lean (`programs/quaestor-stocks-lite`) | 43,560 bytes | 0.2222 SOL |

Rent is 5,080 lamports a byte on devnet and mainnet alike, asked of both RPCs
on 21 Sep 2026 rather than taken from documentation, which still says 6,960.
The lean figure is also measured: a devnet deploy locked 0.2232 SOL, its
upload buffer's lamports moving into the program rather than being needed
twice, and closing the program returned all but 0.0011 SOL of fees. Rent is a
deposit, not a price. An upload that is interrupted leaves that deposit in an
orphan buffer until `solana program close --buffers` brings it back.

It is a port, not a redesign, and it is not trusted for resembling the other.
The wire format is Anchor's, byte for byte: the same eight-byte instruction,
account and event discriminators, the same borsh layouts, the same PDA seeds,
the same account order, and the same `Error Code: <Name>.` line in the log. So
the client in [`client.ts`](client.ts) and the validator suite above run against
either binary unchanged, and the suite is the evidence that they enforce the
same policy, the position-theft cases included:

```bash
wsl bash solana/build-lite.sh --test   # builds it, prints size and rent, runs all 21 cases against it
```

Where the size went, in the order it was found: a first straight port was 80,728
bytes; routing every CPI through one function and every account write through
another, 74,840; `opt-level = "s"` instead of `"z"`, which is measurably smaller
on SBF, 53,960; then removing every read that could panic. A slice index that
might be out of range compiles to a panic with a formatted message, and that one
message keeps all of `core::fmt` in the binary, so reads go through a cursor and
fixed-layout blocks that return an error instead: 43,560, with 136 bytes of
`core` left. A refusal is also a better outcome than an abort.

What is not smaller is what it checks. Overflow checks stay on, every refusal
the Anchor build makes is made here under the same name, and the one `unsafe`
read is a byte-for-byte copy into structs made only of bytes, with their sizes
pinned at compile time.

It has not been deployed. Devnet still runs the Anchor build.

## On devnet

Both programs are deployed to Solana devnet at the ids above.

| Program | Id |
|---|---|
| `quaestor_stocks` | [`7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG`](https://explorer.solana.com/address/7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG?cluster=devnet) |
| `router_stub` | [`3RTVgJ1jXnUZTkaQwvgZiy98vfFqHxHr9Ey8CXyX9imS`](https://explorer.solana.com/address/3RTVgJ1jXnUZTkaQwvgZiy98vfFqHxHr9Ey8CXyX9imS?cluster=devnet) |

`npm run stocks:solana:devnet` sets up a governor, funds its vault, and sends one
honest trade and three routes that lie. The refusals are real transactions that
land and revert, so each carries the governor's own error in its logs:

| Route | Outcome | Transaction |
|---|---|---|
| honours its floor | settled | [4Pmka1En…](https://explorer.solana.com/tx/4Pmka1EnD6x5iHfhWJ8LS8kgVdE9RwGSovoFUSBP6RmE9qw3Vy9xUZDRnmSgjqmartcje18wkmoSsLRoVxK7v2dF?cluster=devnet) |
| one lamport under the floor | `MinimumOutputNotMet` | [5aYwhB1V…](https://explorer.solana.com/tx/5aYwhB1VDeSJPSmtDD5z67bvDknY5tZnA8jR28ii18c7fsaREZFWsY3oi9PLT35igQFWNPxMxxQ7ae7kBd3p6BRs?cluster=devnet) |
| takes 140 USDC of an authorised 100 | `RouteOverspent` | [63vBYfTm…](https://explorer.solana.com/tx/63vBYfTmdEdPEe5mprike7iEomNpb9FNSn88Uk4Rxy3UzbtrCDAd2rHqgZGbjEiihZEtBDqxQdNhiiyc57zeD9Gn?cluster=devnet) |
| buys nothing, takes shares back | `StockBalanceDecreased` | [3BTXBRoo…](https://explorer.solana.com/tx/3BTXBRooQpY8VEmikzzykdX6CJXkdU4cGuXE6m7hZRDgXD8suQmPjtnpNKbxXeGxFCfEp2MxoT9sG4hoz9L22zZr?cluster=devnet) |

The vault went from 1,000 to 900 USDC: only the honest trade moved money, and
the script asserts that rather than printing it. Addresses and signatures are in
[`deployments/solana-devnet.json`](../deployments/solana-devnet.json).

Devnet has no xStocks or Jupiter liquidity for them, so the instrument is a
Token-2022 test mint and the venue is the stub — which is how a route is made to
lie on purpose. The venue that is real is the next section. The public devnet endpoint throttles too hard to deploy or trade
through; set `SOLANA_DEVNET_RPC_URL` to a keyed one.

## A real venue: a Meteora bonding curve

The stub is how a route is made to lie. It is not how a route is made to be
real: it fills at whatever it is told, and this process signs its pool side. So
devnet carries a second venue that needs neither, Meteora's Dynamic Bonding
Curve, [`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`](https://explorer.solana.com/address/dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN?cluster=devnet),
the same program at the same address as on mainnet.

**The launch.** A bonding curve is a price-discovery machine, and nearly every
launch on one starts near zero and pays whoever arrives first. A tokenized stock
is the opposite case: its fair value is printed on an exchange all day.
[`stocks/dbc-launch.ts`](../stocks/dbc-launch.ts) plans a curve that lives
entirely inside a band around a reference price: it opens 300 bps under it,
graduates 300 bps over it, and puts its depth in the middle across DBC's sixteen
segments, so trading near fair value moves the price least and each step away
costs more. The fee starts at 100 bps and decays to 25 over ten minutes, so
being first costs more, not less. The mint is immutable, and all of the
graduated pool's liquidity is locked. The plan is a pure function of its inputs;
`--plan` prints it and stops.

The reference is not typed in. `solana/scripts/dbc-devnet.ts` reads it from the
hub's price gate, and with no fresh price it refuses to launch: a curve anchored
to a guess is not anchored. It launched one against AAPL at $334.49, and wrote
down what each step cost:

| Step | Cost | Transaction |
|---|---|---|
| `create_config` | 0.005984 SOL | [4TiGokNB…](https://explorer.solana.com/tx/4TiGokNBHp8UDKJUbn1xpi1Xwkgu1YmRr3q4wGLJMcCkLZqwwG3aDpbenCJXZ1wsubKqQHeT8odFWRScbXrYmPuy?cluster=devnet) |
| `create_pool` (mint, metadata, vaults) | 0.020592 SOL | [2PmsQFH3…](https://explorer.solana.com/tx/2PmsQFH3kVeengG1K1H124pQLtGC6S5cmnKedCdkXhsvWzdXTNpyKc9SUtzjAxyGPNLEQfmCZWhh43rt3YgQmAwX?cluster=devnet) |
| **a whole launch** | **0.026576 SOL** | |

Rent is the same on every cluster, so that is what the same launch costs on
mainnet.

**On mainnet.** The same launch, with the same script (`--cluster mainnet`), is
live on Solana mainnet: pool
[`5cbDfFRGsAUUMGM5XJsKgkzZUJeLuD7H2QtkjkBXmz4N`](https://explorer.solana.com/address/5cbDfFRGsAUUMGM5XJsKgkzZUJeLuD7H2QtkjkBXmz4N),
mint [`2PMn7R1veKBxybb4AsS983h81mTT9Us5jNhhsuDdn2LL`](https://explorer.solana.com/address/2PMn7R1veKBxybb4AsS983h81mTT9Us5jNhhsuDdn2LL),
anchored to AAPL at $334.88 on 21 Sep 2026, 300 bps either side, graduating
after 5,096 USDC. It cost 0.026596 SOL
([config](https://explorer.solana.com/tx/4r7PtgGZ5d8AgFdzAZprJxkmD3jSi6VV5RE1PL24j2xuhsimVPWLtzv8wYDAN8yEKjjfkNqnTmQ3NcrU1H2YMUGj),
[pool](https://explorer.solana.com/tx/QpyjrTgFd6AELBhJpChkU2yRTsefCioPPmYdpdPuayvVK3QC1C2g3SvRoVyr31ci3ZVJCe9QdJs2bJAefwJmzBL)),
which is the devnet figure plus the priority fee mainnet needs to land. Its
exact parameters were rehearsed on devnet first (`--rehearse-mainnet`), and the
two new accounts' keys are saved before anything is sent, so a failure between
the two transactions resumes from the chain instead of paying for a second
config. The mint has no mint authority and no freeze authority.

The mainnet token is named `QANCHOR`, "Quaestor Anchored Curve (demo)", and no
company's ticker appears in it: real people can buy a mainnet token with real
money, and a disclaimer in the metadata does not undo a name that reads like a
share. What is on mainnet is the launch. The governor is on devnet, so the
governed buy below is a devnet transaction, and nothing here claims otherwise.

**The governed buy.** `solana/scripts/dbc-governed.ts` has the owner do the
three things only the owner can, once: allow the DBC program as a venue, allow
the curve's mint as an instrument, and open the position account its
per-instrument authority owns. Then the operator buys. DBC's swap is built from
the program's own interface with the vault's PDA as its `payer`, the vault as
its input and the position as its output, so the one signature the governor
lends is the only one the venue needs:

| Trade | Outcome | Transaction |
|---|---|---|
| 2 USDC for 0.006134 tokens, floor 0.006103 | settled | [NbBAPSLW…](https://explorer.solana.com/tx/NbBAPSLWdesMw5FXzBdo6ckpCqtSgS1NxgotbqMY3Jn9AEkGw7REp5oewUhZwZRvGVN7E1zWrKuL5yzb1NVMkcE?cluster=devnet) |
| 501 USDC against a 500 USDC per-trade cap | `PerTradeCapExceeded`, before the venue is called | [3VUUnGgT…](https://explorer.solana.com/tx/3VUUnGgTXXLAYrHjrAbCjByXnu963ELKp4XwAG6jUTpNusDWgz5m4Ah3p8GA5ypLfQD4WpmBrTL7i5nVNqPgspT4?cluster=devnet) |
| DBC told to accept anything, the governor told to expect double | `MinimumOutputNotMet` | [66UqTivo…](https://explorer.solana.com/tx/66UqTivorx2k4SD25d7DXrSTRsks83rdzEvBNKincxKCsSZPvpRH56pqDUBPEdCbKmJmLWFqCuNoSAZm6AUiwtKm?cluster=devnet) |

The last row is the one worth opening. DBC's swap *succeeds* inside it, because
DBC was given a floor of zero and met it. The governor then measures the
position, finds half of what the intent committed to, and reverts the whole
transaction. The venue being satisfied is not the test. `--refusals` also
asserts that neither balance moved.

Read off the settled transaction rather than estimated: the deepest call is
level 3 of the runtime's 4 (governor, DBC, then the token program or DBC's own
event call), the whole trade costs 65,578 compute units, inside the default
budget with no compute-budget instruction, and its 22 accounts fit a legacy
transaction with no lookup table.

**In the hub.** The curve's token is a second instrument on the devnet lane,
through the venue `meteora-dbc` ([`stocks/dbc-venue.ts`](../stocks/dbc-venue.ts)).
Quotes come from the curve's own state and fee schedule, as a guaranteed floor.
The pool's price goes on the tape as the token's own market while AAPL's stays
the reference, so the gate judges this instrument on both sides under a policy
of its own, `anchored-curve`: the pool may sit as far from the share as its
launch band plus an allowance for the share moving after the anchor, and no
further. A quote that names no venue goes to the curve, because that is where
this instrument fills. A curve ends: once it graduates to DAMM v2 it stops
filling, and the venue answers `NO_ROUTE` rather than quoting something no route
could settle.

**Watching it.** A curve is anchored on the day it launches, and the share keeps
moving while the curve's range does not. So what an issuer needs from a monitor
is whether fair value is still somewhere the curve can reach.
`GET /v1/stocks/curves` answers that: the plan it launched with, the pool's
price and how far it has to run, the share's price now, and one of five states.
`tracking` means the share is inside the range and buyers have moved the pool
off its opening price. `at-opening` means the share is inside the range but the
pool has climbed less than 1% of it: almost nothing has been bought, so its gap
to the share is the launch's opening discount plus the share's move since, not a
price a market set, and calling that `tracking` would credit a market that has
not traded. `reference-above-range` means
everything left on the curve is cheap, so it will be bought out and graduate at
a discount. `reference-below-range` means everything on it is dear, so it is
stranded above fair value. `graduated` means it is finished. The two
out-of-range states are when an issuer would retire the curve for one around the
new price. The share's price comes from the gate's fresh reference sources only,
and with none the monitor reports the numbers it has and claims no state at all.
It reads what the hub's 20-second price tick last saw rather than the chain, so
a public route costs the RPC nothing per request. The Stocks view draws it as
the pool and the share on the curve's own range. The state is a label for the
issuer and nothing more: the `anchored-curve` gate judges the pool's premium and
never reads it.

**Watching mainnet.** The hub watches the mainnet launch too, and only watches
it: nothing trades it or holds a key for it
([`stocks/dbc-watch.ts`](../stocks/dbc-watch.ts)). Every five minutes it reads the
pool account for its price, how far it has to run and the fee counters DBC keeps
on it. When those counters have moved, and at most every half hour, it reads the
pool's new transactions and tells a buy from a sell by what each did to the
pool's two vaults, whichever program routed it. `GET /v1/stocks/curves` returns
both curves, each with its `cluster`, and the mainnet one carries `fees` and
`activity`. For QANCHOR it shows the pool opening at 08:08:33 UTC on 21 Sep, the
first buy 24 seconds later, nine buys in the first minute (five in one slot)
while the fee was at its launch high, and three sells taking everything back out
within five minutes. Fourteen trades put 901.75 USDC in and took 887.72 out; the
difference is the 11.60 USDC of trading fees the launch earned, Meteora's 2.43,
and 0.003 left in a curve that is back at its opening price. The RPC is
`SOLANA_MAINNET_RPC_URL`, else the devnet RPC's mainnet twin (Helius serves both
under one key), else the public endpoint. At rest that is twelve account reads
an hour.

What this is not: the token is a devnet demo with no claim on anything, and
nothing arbitrages it against the share, so it is anchored to AAPL's price and
does not track it. That gap is exactly what the gate's premium check measures.

## router-stub

A local-validator stand-in for an aggregator. The governor pins which program
its vault may call, so a validator with no Jupiter deployed could not exercise
the CPI path — which is exactly where the postconditions live. The stub takes
the input and output amounts as arguments instead of deriving them from
liquidity, so a test can build precisely the route it needs: one that takes the
money and delivers nothing, one that overspends, one that behaves.

Its second route, `sweep`, buys nothing and moves shares the other way. That is
the abuse the borrowed signature makes possible, so it is the one the stub has
to be able to attempt.

It runs on a test validator and on devnet, and nowhere a real trade could reach it.
