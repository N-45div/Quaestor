# Quaestor

**Don't give your AI agent a wallet. Give it an allowance.**

Quaestor is an on-chain spend governor for AI agents, built on
[X Layer](https://web3.okx.com/xlayer). Register an agent, fund its treasury
with OKB, and set hard budgets — per day and per action — across three spend
categories:

| Category | What the agent pays for |
|---|---|
| `DATA` | paid API calls (price feeds, market data) |
| `INFERENCE` | its own LLM calls |
| `EXECUTION` | capped swaps routed through the DEX |

Every payment the agent makes flows *through* the Quaestor contract. Within
budget → it settles instantly and emits a permanent on-chain **receipt**
(payee, amount, and a hash of the decision context behind the spend). Over
budget → the chain itself refuses. Misbehaving agent → the owner hits the
**kill-switch** and it is frozen in one transaction.

**AI spends. AI audits. The chain enforces.**

- A flagship governed trading agent (DCA on the DEX) shows the happy path.
- A watchdog AI reads the receipt stream and flags anomalies in plain English.
- A live dashboard shows per-agent burn-down, receipts, and the kill-switch.

Built for the X Layer **AI Season** hackathon (August 2026).

## Status

🚧 Early scaffold — contracts, tests, agent SDK, and dashboard landing in the
coming days.

## Stack

- Solidity 0.8.24, Hardhat — deployed on X Layer testnet (chain id 195, OKB gas)
- TypeScript SDK + demo agents
- React dashboard (OKX Wallet connect, OKLink receipt links)
