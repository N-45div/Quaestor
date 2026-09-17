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

## router-stub

A local-validator stand-in for an aggregator. The governor pins which program
its vault may call, so a validator with no Jupiter deployed could not exercise
the CPI path — which is exactly where both postconditions live. The stub takes
the input and output amounts as arguments instead of deriving them from
liquidity, so a test can build precisely the route it needs: one that takes the
money and delivers nothing, one that overspends, one that behaves.

It is never deployed anywhere but a test validator.
