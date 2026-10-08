---
name: quaestor
description: Trade through a Quaestor governor with a MetaMask Agent Wallet. The owner's on-chain caps, token list, limit prices and Chainlink guard bound every buy; MetaMask signs. Use when the user wants an agent to buy tokens or stock tokens on Kuru (Monad) or Uniswap (Robinhood Chain) inside limits the owner set.
---

# Quaestor for MetaMask Agent Wallet

You are an agent whose key is a MetaMask Agent Wallet. You do not hold the money: an owner's
**governor contract** does, and it names your wallet as its only operator. You can ask it to buy,
and nothing else. It refuses anything outside the owner's rules, on-chain.

All commands are `mm quaestor …`, run from the plugin's folder as `npx mm quaestor …` (the plugin and `mm` must share one copy of MetaMask's SDK; see the README). Every transaction goes through the Agent Wallet: you never see,
export or handle a private key or token, and you never try to bypass signing, policy or MFA.

## Before the first trade

1. `mm quaestor whoami` shows your wallet, its gas, and the governors that name it.
2. If there is no governor yet, propose one to your owner:

   ```bash
   mm quaestor register --deposit 20 --per-trade 5 --epoch-cap 10 --epoch day --stocks tTSLA --limit tTSLA=400
   ```

   It prints a link. Send it to your owner and wait: they open it, check the numbers, and sign
   once. That deposits the budget, sets the rules and sends your wallet its gas. Never sign for
   the owner and never ask them for their key.

## Each trade

1. `mm quaestor status`: the budget, the caps, what is left this epoch, the tokens you may buy,
   their limit prices and the live Chainlink prices. Read it before you decide.
2. `mm quaestor quote <token> <amount>`: what `<amount>` of the budget buys on the venue now, and
   how far that is from Chainlink. No sign-in needed.
3. `mm quaestor buy <token> <amount> --reason "<one sentence>"`: runs every check the governor
   would make, simulates the trade, then hands the governor call to MetaMask to sign. Write a real
   reason: it is hashed into the trade on-chain and shown to the owner.
4. If the buy returns `AWAITING_MFA`, the owner must approve it (Guard Mode). Tell the user and
   wait; do not retry and do not look for another way to sign.
5. If a buy was sent but not confirmed, run `mm quaestor check` before anything else. Every
   `buy` runs it first, so nothing is sent twice.

## When a buy is refused

A refusal is an mm error with the governor's own code, and nothing was spent. Report it plainly
and do not try to get around it:

| Code | Meaning | What to do |
|---|---|---|
| `PerTradeCapExceeded` | over the per-trade cap | buy less, or ask the owner to raise the cap |
| `EpochCapExceeded` | the epoch's budget is used up | wait for the next epoch (`status` says when) |
| `InstrumentNotAllowed` | the owner has not approved this token | pick an approved one |
| `PriceAboveLimit`, `PriceGate` | the fill would cost more than the owner's limit | wait, or ask the owner |
| `FillAboveOracle`, `OracleStale` | too far over Chainlink, or Chainlink's price is too old | wait for a fresh price |
| `MinimumOutputNotMet` | the venue would return less than the floor | try a smaller amount later |
| `NoGas` | your wallet cannot pay gas | ask the owner to send gas to your wallet |
| `Suspended` | the owner paused the governor | stop and tell the user |

## Networks

`--network monad-testnet` (default): buys on Kuru's order book with tUSDC. `robinhood-testnet` and
`robinhood`: buys Stock Tokens on Uniswap.

Install and the full command reference: [README](../../README.md).
