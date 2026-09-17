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

Sixteen cases. The ones worth reading first give the router a route that lies —
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
