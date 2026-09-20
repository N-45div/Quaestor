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

A program's rent is its size, and the Anchor build is 329,136 bytes: about 2.29
SOL to put on mainnet. Almost none of that is this program's logic. It is the
framework, the standard library and the token crates underneath it.

[`programs/quaestor-stocks-lite`](programs/quaestor-stocks-lite/src/lib.rs) is
the same governor written against [Pinocchio](https://github.com/anza-xyz/pinocchio),
with no framework, no allocator and no standard library:

| Build | Size | Rent |
|---|---|---|
| Anchor (`programs/quaestor-stocks`) | 329,136 bytes | 2.2920 SOL |
| Anchor, every compiler size setting on | 292,832 bytes | 2.04 SOL |
| Lean (`programs/quaestor-stocks-lite`) | 43,560 bytes | 0.3044 SOL |

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
lie on purpose. The public devnet endpoint throttles too hard to deploy or trade
through; set `SOLANA_DEVNET_RPC_URL` to a keyed one.

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

It is never deployed anywhere but a test validator.
