---
slug: fuzzing
order: 4
title: A million calls from a hostile venue
date: 2026-10-07
summary: How we fuzzed Quaestor's governor with Echidna: the fuzzer plays the agent, the venue does whatever it is told, and eight properties must hold. 1,000,093 calls broke none of them.
---

Quaestor's governor makes one promise: whatever the agent asks for and whatever the venue does, the owner's limits hold. Unit tests check the cases we thought of. To find the cases we didn't, we gave the agent's job to a fuzzer and made the venue an adversary.

## The setup

The harness is `contracts/fuzz/GovernorEchidna.sol`. It deploys a real governor from the real factory (`QuaestorStocks.sol`, compiled the way it is deployed: solc 0.8.24, via IR, 800 optimizer runs) with a mock budget token, a mock stock and a mock Chainlink feed.

The **fuzzer is the agent**. It calls the governor with any amount, any floor, any token and any intent id. It also moves Chainlink's price and lets up to a week pass between calls, so trades land across many epochs and the price goes stale.

The **venue is hostile**. Every swap gets a mode from the fuzzer:

- pay honestly;
- pull the budget twice;
- hand back more budget than it took;
- send the shares to someone else;
- reach for the governor's shares, which it never approved;
- call back into the governor mid-trade;
- keep the approval it was given.

## The eight properties

After every call, these must hold:

1. Never spends more than the agent asked.
2. Never over the per-trade cap.
3. Never over the epoch cap.
4. Never under the floor the agent asked for.
5. Never over the owner's limit price.
6. Never past the Chainlink margin.
7. No approval left standing after a trade.
8. Every dollar and every share accounted for.

## The result

```
echidna_never_past_the_chainlink_margin: passing
echidna_never_over_the_owners_limit: passing
echidna_every_dollar_accounted_for: passing
echidna_never_under_the_floor: passing
echidna_never_over_the_per_trade_cap: passing
echidna_never_over_the_epoch_cap: passing
echidna_no_approval_left_standing: passing
echidna_never_spends_more_than_asked: passing
Unique instructions: 11406
Seed: 1757847389704924685
Total calls: 1000093
```

That is Echidna 2.3.3, on 30 September 2026. The coverage report shows the successful trade path and every refusal in `executeTrade` reached, so the properties held because each bad case was refused, not because it was never tried. The governor's code has not changed since, and the same contract is deployed on Monad testnet.

## How it holds

Three design choices do most of the work:

- **Measure, don't trust.** The governor reads its own balances before and after the venue call. A venue that pulls twice, under-delivers or sends the shares elsewhere leaves a measurable difference, and the trade reverts.
- **Approve exactly, then revoke.** The venue is approved for the trade's amount only, and the approval is cleared afterwards, so nothing is left for a later call to use.
- **Lock everything.** The trade path and the owner's setters share one lock. A venue that calls back into the governor mid-trade finds it locked.

## Run it yourself

```
echidna contracts/fuzz/GovernorEchidna.sol --contract GovernorEchidna --config echidna.yaml
```

`echidna.yaml` sets the compiler flags, a week of time between calls, and a test limit of one million calls. Fuzzing is not an audit, and the contracts are unaudited. It is the best evidence we have that a hostile venue cannot get a dollar out of a governor that the owner did not agree to spend.
