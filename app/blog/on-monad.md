---
slug: on-monad
order: 3
title: How Quaestor runs on Monad, end to end
date: 2026-10-07
summary: Kuru fills the trades, Chainlink CRE brings the stock prices, Kimi decides, Dynamic signs, Alchemy streams the fills, Envio indexes them, MetaMask and Aurora bring agents and money in. One trade, traced through all of it.
---

Quaestor's governor is one contract. Running it as a product on Monad took eight other pieces, each doing one job. This post traces a single trade through all of them, with a transaction or a link for each claim.

## The trade

On 7 October 2026 Quaestor's house agent bought 2 tUSDC of tNVDA on Kuru, 2 basis points under Chainlink's price. It took five steps:

1. Chainlink CRE wrote fresh stock prices to Monad and started the agent.
2. Kimi chose the trade.
3. A Dynamic MPC wallet signed it.
4. The governor checked and measured it on Kuru.
5. Alchemy and Envio showed it to the world.

## Kuru: the venue

Kuru is a central limit order book on Monad. The governor trades through Kuru's Router: it approves the router for exactly the trade's amount, calls `anyToAnySwap`, and measures what arrived.

Kuru's own testnet market settles in native MON in lots of 200, which a governor holding ERC-20 tokens cannot use. So Quaestor opened five markets of its own through Kuru's permissionless `deployProxy`: tETH, and test stand-ins for Tesla, NVIDIA, the S&P 500 ETF and Apple, each against tUSDC. A maker on Quaestor's hub (`services/kuru-maker.ts`) quotes each book in layers a few basis points around Chainlink. It re-quotes in a single `batchUpdate` when the price moves 0.25%, because Monad charges a transaction its whole gas limit.

The point of a governor shows up when a book lies. An attacker's market with one ask at $400,000 is live on testnet too. Send a buy into it from the app and the governor refuses it on-chain with `PriceAboveLimit`.

## Chainlink CRE: prices, and the start of the run

Chainlink publishes no stock prices on Monad, and the governor refuses to trade without a fresh one. The CRE workflow (`integrations/chainlink-cre/stock-mirror`) does four things:

1. **Reads** Chainlink's NVDA, SPY and AAPL feeds on Arbitrum One.
2. **Compares** them with mirror feeds on Monad, and marks a stock due when it moved 30 bps or a 6-hour heartbeat passed.
3. **Writes** the due prices as one signed report through `QuaestorMirrorReceiver`, the only writer the mirrors accept.
4. **Starts** the agent over Confidential HTTP, with the agent's secret held in the CRE vault rather than in code.

That run wrote [`0x25ecece7…7ec1`](https://testnet.monadscan.com/tx/0x25ecece738c453eb1a9e60bd92c27eb5e1b0344fd96798c21142c488d69f7ec1) and logged `started the agent: 202`. The receiver and its three mirrors are verified on Monad's Sourcify.

## Kimi: the decision

Kimi (`kimi-k2.6`) reads the governor's portfolio and live Kuru quotes beside Chainlink, applies the owner's written mandate, and buys at most one stock. It chose tNVDA: "held at zero and its Kuru fill is within 2 bps of Chainlink, the tightest spread among the least-held positions." That sentence is hashed into the trade on-chain. [More on Kimi](/blogs/kimi/).

## Dynamic: the signature

The agent's key is a Dynamic EVM MPC server wallet: two shares, one on Quaestor's hub and one with Dynamic, so no single machine holds the whole key. `sdk/dynamic-evm-signer.ts` wraps it as an ethers signer that renews its session, signs through the MPC ceremony, and checks that every signed transaction recovers to the wallet's own address. That wallet, `0xc813451F…43fF8`, is the governor's operator, and the only thing it can do is ask to buy.

## The governor: the check

The governor checked the owner's caps (3 tUSDC a trade, 10 a day), the token list and the limit price. It bought on Kuru, measured 0.00833368 tNVDA arriving for 2 tUSDC, and compared that with the CRE-written Chainlink price. Then it settled: [`0x1e1d6f10…07aa`](https://quaestor-app.onrender.com/#/app/evm/monad-testnet/trades/0x1e1d6f1029f4dda07855b20d2efd94c43c32869e96207dd5cc2fb2fd8f7a07aa).

## Alchemy: the moment it lands

The hub subscribes to Alchemy's `monadLogs` WebSocket with Monad's commit states. Each governed fill therefore arrives three times, as its block is Proposed, Voted and Finalized, and the app shows it at each stage. The tape keeps only events from governors the factory created, since anyone can emit an event with the same name. On the latest fill, proposed to final took 465 ms.

## Envio: the record

An Envio HyperIndex indexer (`integrations/envio-indexer`, [hosted GraphQL](https://indexer.dev.hyperindex.xyz/3983430/v1/graphql)) uses `contractRegister` to pick up every governor the factory creates. It indexes their trades, rule changes and every CRE price write. The app reads it live: each agent's governors, trades and spend, and how fresh each Chainlink price is, flagged once it is stale enough that buys would be refused. Trade lists come from Envio HyperSync, because Monad's public RPC serves `eth_getLogs` 100 blocks at a time.

## MetaMask and Aurora: agents and money from outside

Not every agent is ours. The **MetaMask Agent Wallet** plugin (`mm quaestor`) lets a MetaMask agent wallet trade through a governor. It runs every check the governor would make before MetaMask is asked to sign, and Guard Mode's approval sits on top. Its [buy](https://testnet.monadscan.com/tx/0x06632885b35bf645d4ddeecdffcc6f2f2d1719b4556c26d1963d8933b20c63bf) went through Guard Mode's email approval, and a buy over the cap was refused before MetaMask was asked.

Owners can fund a governor from Base, Arbitrum, Ethereum or Solana through **Aurora Intents**, because a governor's budget is simply its balance. NEAR Intents has Monad paused today. The app reads Aurora's incident feed and says so, rather than opening a deposit it cannot complete.

## See it

Everything above is on the [Monad page](https://quaestor-app.onrender.com/#/app/evm/monad-testnet). You can send a hijacked agent's trade and watch it refuse, read the house agent's runs, and follow the live tape and the Envio panel. The code is at [github.com/N-45div/Quaestor](https://github.com/N-45div/Quaestor).
