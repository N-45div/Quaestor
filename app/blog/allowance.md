---
slug: allowance
order: 1
title: Don't give your agent a wallet. Give it an allowance.
date: 2026-10-07
summary: A wallet key is all or nothing. Quaestor puts an AI agent's budget in a contract that enforces the owner's limits on every trade, so a hijacked agent can only do what its owner already agreed to.
---

AI agents are being handed wallets to trade. That is a strange thing to do with a key, because a key is all or nothing. Whoever holds it can spend everything behind it, at any price, on anything.

An agent holds its key in a context window, and context windows are easy to steer. A poisoned web page, a quote from a thin order book, or one wrong step in a long chain of reasoning is enough. Then the agent spends what it holds, and it does so with complete confidence.

This has already happened. In November 2024 an agent called Freysa, whose one job was to guard a prize pool, was talked into sending all of it by a single cleverly framed message. In March 2025 an attacker who reached AIXBT's dashboard had the agent send about 55 ETH. Neither agent was broken in the usual sense. Each did what the words in front of it said, and nothing stood between those words and the money.

## Limits in the wrong place

The usual answer is to write limits down: "never spend more than $50 a day" in the prompt, or a policy server that sits beside the agent and checks its requests. Both live in the wrong place.

- **A prompt is a suggestion.** The limit is a sentence in the context window, and the next sentence can override it.
- **A server beside the agent shares its fate.** It is one more thing to compromise. It also only sees what the agent asked for, never what the trade actually returned.

What you want is a limit the agent cannot reach.

## The governor

Quaestor moves the limits on-chain. The owner opens a **governor** in one transaction. The governor is a contract that holds the agent's budget and enforces the owner's rules:

- a cap per trade, and a cap per day;
- the tokens the agent may buy, and the venues it may use;
- a limit price for each token, the most the owner will pay;
- a Chainlink guard: how far over Chainlink's price a fill may be, and how old that price may be.

The agent's key can do exactly one thing: ask the governor to buy. It cannot withdraw, transfer, approve a spender or change a rule. Those belong to the owner.

When the agent asks, the governor checks every rule, approves the venue for exactly the trade's amount, and makes the trade. Then it measures what arrived from its own balances, never from what the venue reports. Finally it revokes the approval and records a hash of the agent's stated reason. If anything is off, the whole trade reverts: over a cap, an unapproved token, a fill above the owner's limit, too far over Chainlink, or less arriving than promised.

So a hijacked agent can lose at most what the owner already agreed it could spend, at prices the owner agreed. What it buys stays in the governor, where only the owner can take it out.

## Measured, not trusted

The detail that matters most is the measurement. A venue can claim anything. A malicious order book can hold one ask at $400,000 and fill a careless buyer at that price, and every pre-trade check passes: the amount is under the cap, and the venue is on the list.

Quaestor's governor does not ask the venue what happened. It reads what left its budget and what arrived, divides one by the other, and compares the result with the owner's limit and with Chainlink. On Monad testnet anyone can try this from the [app](https://quaestor-app.onrender.com/#/app/evm/monad-testnet): one button sends a hijacked agent's buy into a $400,000 ask. Kuru's trade goes through, the governor measures the fill, and the whole transaction reverts with `PriceAboveLimit`. The budget does not move.

## Why on-chain, and why Monad

Every rule runs on every trade, inside the transaction. That is only practical when blocks are fast and transactions are cheap, because agents re-check prices and trade often, in small amounts. On Monad a governed trade settles in a block that is final in under a second. On our most recent fill, Alchemy's stream saw it go from proposed to final in 465 ms.

## What it is not

Quaestor is not a wallet and not a custodian. The owner's funds sit in the owner's governor, and nobody else can move them out. It is not an audit either. The contracts are unaudited, and on Monad everything runs on testnet with test stand-ins for stocks, priced from real Chainlink data. It has been tested hard: 53 unit tests, 5 tests against a fork of a live mainnet, and an [Echidna campaign](/blogs/fuzzing/) of 1,000,093 calls from a hostile venue that never broke one of the governor's eight safety properties.

## The short version

Don't give your agent a wallet. Give it an allowance: a budget in a contract, with rules the agent can read but cannot change. Let the agent decide, and let the contract decide whether that decision is allowed.

Next: [how Quaestor runs on Monad, end to end](/blogs/on-monad/), and [how the house agent uses Kimi](/blogs/kimi/).
