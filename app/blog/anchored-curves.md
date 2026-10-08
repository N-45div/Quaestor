---
slug: anchored-curves
order: 5
title: A bonding curve for something that already has a price
date: 2026-10-08
summary: Quaestor launches Meteora DBC curves anchored to a stock's real price, watches them against it, and keeps its agents trading the token after the curve graduates into DAMM v2.
---

A bonding curve is a price-discovery machine. Nearly every launch on one starts near zero and lets the crowd find a number, which is the right shape for a token nobody can value. A tokenized stock is the opposite case: its fair value is printed on an exchange all day. A curve that starts at zero does not discover that price. It pays whoever arrives first.

So Quaestor plans Meteora DBC curves differently, and keeps trading the token through its whole life: on the curve, then on the DAMM v2 pool it graduates into.

## Anchored: the whole curve inside a band

`stocks/dbc-launch.ts` plans a curve that lives inside a band around the reference price, read from Quaestor's price gate, never typed in:

- it **opens 300 bps under** the reference and **graduates 300 bps over** it, so there is no run from zero to be first in;
- its depth **peaks at the reference** across DBC's sixteen segments, so trading near fair value moves the price least and each step away costs more;
- its fee **starts at 100 bps and decays to 25 over ten minutes**, so being first costs more, not less;
- the mint is immutable, and all of the graduated pool's liquidity is locked.

The plan is a pure function of its inputs, so an issuer sees exactly what they would sign before anything is signed. With no fresh reference price, there is no launch.

## On mainnet

The same launch is live on Solana mainnet as `QANCHOR`, anchored to AAPL at $334.88 on 21 September 2026, for 0.0266 SOL. Its first five minutes are a small lesson in why the decaying fee exists: nine buys landed in the first minute, five of them in one slot, while the fee was at its high, and three sells took it all back out. The launch kept 11.60 USDC of fees. The pool is back at its opening price, and Quaestor's monitor says so in plain words: it is waiting for buyers, and its gap to the share is the launch's opening discount plus the share's move since, not a price a market set.

## Watched against the share

A curve is anchored on the day it launches, and the share keeps moving. `GET /v1/stocks/curves` tells an issuer whether fair value is still somewhere the curve can reach: `tracking`, `at-opening`, `reference-above-range` (the curve will be bought out at a discount), `reference-below-range` (it is stranded above fair value), or `graduated`. The two out-of-range states are the moment to retire a curve for one around the new price.

## Governed buys, measured

Quaestor's governor is a Solana program that holds an agent's budget. It buys from the curve through a CPI into DBC, with the vault's PDA as DBC's payer and the instrument's position account as the output, so the one signature it lends is the only one the venue needs. Then it measures what arrived. In one test DBC is told to accept anything and its swap succeeds; the governor finds half of what the intent committed to and reverts the whole transaction.

## Graduation, and an agent that follows

When a curve has taken in its threshold, it stops filling and DBC migrates its liquidity into a DAMM v2 pool. A route pinned to the curve breaks at that moment. The governor's does not: its venues are an allowlist of programs that only the owner edits.

On 8 October 2026 the devnet curve graduated. We filled what was left (nobody trades devnet, so the fill was ours, in test USDC), and DBC migrated it into a DAMM v2 pool that opened at exactly the curve's last price, $344.53. The owner allowed DAMM v2 once, with no program upgrade, and the same governor bought on it into the same position account, refused a buy over its cap, and refused a short fill even though DAMM v2's own swap succeeded.

Two details make it hold:

- **The pool is known before it exists.** A DAMM v2 pool's address is derived from the curve's migration config and the two mints, so Quaestor names it on launch day and reports it absent until the migration creates it.
- **Graduation is read, not guessed.** The hub asks DBC for the pool's own migrated flag before it quotes. A buy refused for being too large for what is left on the curve is the curve's answer, never mistaken for a migration.

Every step is a transaction you can open, listed in the [README](https://github.com/N-45div/Quaestor#a-real-venue-meteoras-bonding-curve), and the curves are on the [Stocks view](/#/app/stocks).
