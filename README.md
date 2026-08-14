# Quaestor

**Give your AI agent a wallet it cannot empty — chain-enforced budgets by
purpose, a receipt for every decision, and a watchdog that can stop it but
never spend it.**

On X Layer, agents can already pay. Quaestor makes them **answerable**.

Built for the X Layer **AI Season** hackathon · EVM contracts on X Layer
testnet (chain id 1952) · budgets denominated in OKB · 23 passing tests.

**Live app:** https://quaestor-app.onrender.com ·
**Demo agent:** [`agent/`](agent/)

**X Layer testnet (chain id 1952):**

| Contract | Address |
|---|---|
| Quaestor | [`0x7C8772fbdF1A1d9Ded219E51D3147d7C04475921`](https://www.oklink.com/xlayer-test/address/0x7C8772fbdF1A1d9Ded219E51D3147d7C04475921) |
| QuaestorDEX | [`0x7cf23d5D7A49ca4113ed4b72e465b227E7978c12`](https://www.oklink.com/xlayer-test/address/0x7cf23d5D7A49ca4113ed4b72e465b227E7978c12) |
| qUSD | [`0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24`](https://www.oklink.com/xlayer-test/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24) |
| qBTC | [`0x34317A98d851c5b0D46E0e491Be09Cb956980bB3`](https://www.oklink.com/xlayer-test/address/0x34317A98d851c5b0D46E0e491Be09Cb956980bB3) |

---

## The problem

Give an autonomous agent your wallet and it can spend everything; give it
nothing and it is useless. Config-file limits don't close the gap — the agent
can read its own config, and so can whoever compromises it. The failure mode
is no longer hypothetical: runaway multi-agent loops have produced
[$47,000 surprise bills](https://www.trustgateai.io/blog/token-bill-runaway-agents),
and in May 2026 a prompt-injected agent
[drained ~$175k](https://www.cryptotimes.io/2026/05/04/xais-grok-ai-loses-175k-in-crypto-heist-via-clever-prompt-injection-then-gets-it-all-back/)
through a transfer its allowlists happily permitted.

Session keys and agent wallets cap **how much, to whom**. None of them answer
the questions that actually matter afterwards: **what was the money for, and
what was the agent thinking?**

## What Quaestor adds

Three properties you won't find together anywhere else — each one enforced by
the contract, not by our code:

1. **Purpose-scoped budgets.** Spending is capped per epoch *and* per action
   across a taxonomy — `DATA` (paid API calls), `INFERENCE` (metered LLM
   cost), `EXECUTION` (DEX trades). "0.05 OKB/day on inference, 0.5 on
   trades" is not expressible as a session key or a spend permission; here it
   is one struct. An agent trusted to buy data can still be barred from
   trading with it.

2. **The reason and the payment are one atomic on-chain fact.** Every spend
   emits a `Receipt` committing `keccak256` of the decision record — prompt,
   signal, rationale — in the same transaction as the transfer. The operator
   publishes the record; **anyone re-computes the hash in their browser**. No
   trusted validator, no facilitator API call, no log file someone rotated.

3. **Stop-authority without spend-authority.** An owner can appoint a
   **guardian** — an address the chain permits to do exactly one thing:
   suspend. It can never spend, withdraw, resume, or change policy. That
   makes it safe to hand the kill-switch to an automated watchdog, an
   auditor, or a compliance bot. Ours watches the receipt stream and vetoes
   burst-spending agents on its own.

Around them: a real constant-product DEX for governed trades, a paid oracle
that settles over HTTP 402 with on-chain receipts instead of API keys, a
deterministic (not LLM-judging-LLM) watchdog, and a dashboard where every
number is read live from the chain.

## How it works

```
                     owner (your wallet)                guardian (watchdog key)
                        │  register / fund / caps           │  suspend ONLY
                        ▼                                   ▼
   agent ──operator──▶ Quaestor.sol ──────────────▶ Receipt(agentId, category,
   loop      key       per-epoch + per-action        amount, keccak256(decision),
    │                  caps per category             epochSpentAfter)
    │ pay(DATA)  ──▶ oracle: HTTP 402 → signal            │
    │ pay(INFERENCE) ─▶ metered LLM cost                  ▼
    │ swap(EXECUTION) ─▶ QuaestorDEX (x·y=k)         decision ledger
    └─ publishes decision JSON ─────────────▶  browser re-hashes & verifies ✓
```

| Piece | What it is |
|---|---|
| [`contracts/Quaestor.sol`](contracts/Quaestor.sol) | The governor: agents, treasuries, category budgets, receipts, guardian, kill-switch |
| [`contracts/QuaestorDEX.sol`](contracts/QuaestorDEX.sol) | Real AMM (0.3% fee, open liquidity) — mainnet swaps route to the OKX DEX router via the same one-function interface |
| [`contracts/TestToken.sol`](contracts/TestToken.sol) | qUSD / qBTC with a rate-limited public faucet |
| [`sdk/`](sdk/) | TypeScript operator client: `pay`, `swap`, decision records, ledger publishing; `verifyReceipt` for the service side |
| [`services/`](services/) | Paid oracle (402 → receipt → signal), decision ledger, guardian watchdog — one Render-deployable process |
| [`agent/`](agent/) | Cato, the example governed DCA agent (LLM-sized buys, every cost through the governor) |
| [`app/`](app/) | Landing + live dashboard: register (one-click operator keygen), fund, caps editor, burn-down meters, receipt verification, kill-switch |

## The 90-second story

1. Register an agent in the dashboard — it generates a disposable operator
   key in your browser and hands you a ready-to-run `.env`.
2. The agent pays the oracle **on-chain** for a signal (HTTP 402 → receipt →
   response), meters its LLM call, and swaps within caps. Three receipts.
3. Click any receipt: the decision record is fetched and **keccak-verified
   in your browser** — "this is what the agent was thinking."
4. Crank the agent's loop: the watchdog flags the burst, and the guardian —
   which cannot move a single wei — suspends it on-chain, alone.
5. You resume it when *you* decide. Or withdraw the treasury. Your money was
   never lockable by anyone else.

## Run it locally

```bash
npm install && npx hardhat test                 # 23 tests
npx hardhat node                                # terminal 1
npx hardhat run scripts/deploy.ts --network localhost   # deploys + seeds pools + writes app config
npx hardhat run scripts/register-agent.ts --network localhost

# terminal 2 — oracle + ledger (+ guardian if GUARDIAN_KEY is set)
QUAESTOR_ADDRESS=... DEX_ADDRESS=... QUSD_ADDRESS=... \
ORACLE_COLLECTOR_ADDRESS=... npm run services

# terminal 3 — the governed agent
OPERATOR_KEY=... AGENT_ID=1 QUAESTOR_ADDRESS=... DEX_ADDRESS=... \
QUSD_ADDRESS=... DECISION_LEDGER_URL=http://localhost:8402 npm run agent

# terminal 4 — the app
cd app && npm install && npm run dev            # http://localhost:4180
```

X Layer testnet: fund a deployer from the
[faucet](https://web3.okx.com/xlayer/faucet), set `PRIVATE_KEY` in `.env`,
then `npm run deploy:xlayer-testnet`.

## Honest limits & roadmap

- **Inference metering trusts the operator's numbers.** The chain cannot see
  an LLM call; what it enforces is that *reported* spend is capped,
  monotonic, and public — a private overrun becomes a public, attributable
  one. Oracle-verified metering is future work.
- **Receipt gas.** ~one event per spend; on X Layer that is a fraction of a
  cent, sane for spends above ~$0.01. For true micropayments the plan is
  epoch batching: commit a Merkle root of N decision records per epoch.
- **Mainnet routing.** The governor talks to any router through one
  function; the mainnet deployment points it at the OKX DEX router instead
  of our AMM. Planned alongside ERC-8004 identity binding, so marketplace
  agents can carry a verifiable "budget-governed" badge.
- The decision ledger is an availability layer, never a trust layer — records
  verify client-side against the on-chain hash.

## FAQ — the hard questions

**Why not just session keys / spending-limit modules?**
They're good, and they compose with this — hold the operator key inside one.
But they cap *amount × recipient × time*. They cannot express purpose, they
attach no reason to any spend, and the principal who edits the policy is the
same one who controls the funds, so you can't safely delegate the stop
button. Quaestor is a policy object, not a signer restriction.

**Why put spend metering on-chain at all?**
Because the audit needs to outlive the operator. A dashboard shows *you* your
agent's spending; a receipt stream shows *everyone else* — the counterparty
agent, the auditor, the insurer. In an agent marketplace, that asymmetry is
the product.

**Isn't the guardian just a multisig?**
No — a multisig shares full authority. The guardian holds a strictly smaller
right: suspend and nothing else, enforced in the contract. That's why it's
safe to give the key to a bot.

**What if the operator never publishes a decision record?**
The hash still binds them: any record produced later must match it exactly,
and an unpublished record is itself visible — the dashboard shows exactly
which receipts the operator hasn't opened.

**Who is this for?**
Anyone funding an agent they don't fully trust — which is everyone funding an
agent. 98% of FinOps teams now manage AI spend, up from 63% a year ago.
The first users are the agents already on X Layer's own marketplace.

## Hackathon compliance

- ✅ AI in the product: governed LLM-sized trading agent + AI-metered spend
- ✅ Deployed on X Layer testnet during the hackathon (chain id 1952)
- ➡️ Mainnet launch after the hackathon (OKX DEX router adapter)
- Dedicated X account + submission post: see the project's X profile
