# Quaestor

**Give your AI agent a wallet it cannot empty — chain-enforced budgets by
purpose, a receipt for every decision, and a watchdog that can stop it but
never spend it.**

On X Layer, agents can already pay. Quaestor makes them **answerable**.

![License: MIT](https://img.shields.io/badge/license-MIT-d4a843) ![Tests](https://img.shields.io/badge/tests-23%20passing-199e70) ![Chain](https://img.shields.io/badge/X%20Layer%20testnet-1952-3987e5)

**Live app:** https://quaestor-app.onrender.com · Built for the X Layer
**AI Season** hackathon, August 2026.

```bash
# See a real governed spend on X Layer testnet in 20 seconds — no wallet, no faucet:
curl -s https://quaestor-services.onrender.com/api/demo/spend
# → the demo agent pays the oracle through the governor and returns the
#   receipt, the committed decision hash, the OKLink proof link, and its
#   remaining on-chain budget. Drain the budget and the chain says no.
```

| Contract (X Layer testnet) | Address |
|---|---|
| Quaestor — the governor | [`0x7C8772…5921`](https://www.oklink.com/xlayer-test/address/0x7C8772fbdF1A1d9Ded219E51D3147d7C04475921) |
| QuaestorDEX — the AMM | [`0x7cf23d…8c12`](https://www.oklink.com/xlayer-test/address/0x7cf23d5D7A49ca4113ed4b72e465b227E7978c12) |
| qUSD (faucet token) | [`0x99D7fc…3b24`](https://www.oklink.com/xlayer-test/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24) |
| qBTC (faucet token) | [`0x34317A…0bB3`](https://www.oklink.com/xlayer-test/address/0x34317A98d851c5b0D46E0e491Be09Cb956980bB3) |

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
the questions that matter afterwards: **what was the money for, and what was
the agent thinking?**

## What Quaestor adds

Three properties, each enforced by the contract rather than by our code:

**1 · Purpose-scoped budgets.** Spending is capped per epoch *and* per action
across a taxonomy — `DATA` (paid API calls), `INFERENCE` (metered LLM cost),
`EXECUTION` (DEX trades). "0.005 OKB a day on inference, 0.01 on trades" is
one struct here and inexpressible as a session key or spend permission. An
agent trusted to buy data can still be barred from trading with it.

**2 · The reason and the payment are one atomic on-chain fact.** Every spend
emits a `Receipt` committing the keccak-256 of the decision record — prompt,
signal, rationale — in the same transaction as the transfer. The operator
publishes the record; **anyone re-computes the hash in their own browser**.
No trusted validator, no facilitator API, no log file someone rotated.

**3 · Stop-authority without spend-authority.** The owner can appoint a
**guardian**: an address the chain permits to do exactly one thing — suspend.
It can never spend, withdraw, resume, or change policy, which makes it safe
to hand the kill-switch to an automated watchdog, an auditor, or a compliance
bot. Ours watches the receipt stream and vetoes burst-spending agents on its
own — it did so, unprompted, during testing.

Around that core: a real constant-product AMM for governed trades, a paid
oracle that settles over HTTP 402 with on-chain receipts instead of API keys,
a deterministic watchdog (deliberately not an LLM judging an LLM), and a
dashboard where every number is read live from the chain.

## How it works

```
                 owner (your wallet)                guardian (watchdog key)
                    │  register / fund / caps           │  suspend ONLY
                    ▼                                   ▼
agent ──operator──▶ Quaestor.sol ─────────────▶ Receipt(agentId, category,
loop      key       per-epoch + per-action       amount, keccak256(decision),
 │                  caps per category            epochSpentAfter)
 │ pay(DATA) ───────▶ oracle: HTTP 402 → signal        │
 │ pay(INFERENCE) ──▶ metered LLM cost                 ▼
 │ swap(EXECUTION) ─▶ QuaestorDEX (x·y=k)        decision ledger
 └─ publishes decision JSON ────────▶ browser re-hashes & verifies ✓
```

| Piece | What it is |
|---|---|
| [`contracts/Quaestor.sol`](contracts/Quaestor.sol) | The governor: agents, treasuries, category budgets, receipts, guardian, kill-switch |
| [`contracts/QuaestorDEX.sol`](contracts/QuaestorDEX.sol) | Real AMM — 0.3% fee, open liquidity; the governor talks to it through one function, so mainnet swaps route to the OKX DEX router behind the same interface |
| [`contracts/TestToken.sol`](contracts/TestToken.sol) | qUSD / qBTC with a rate-limited public `faucet()` |
| [`sdk/`](sdk/) | TypeScript operator client — `pay`, `swap`, decision records, ledger publishing — plus `verifyReceipt` for services that accept on-chain settlement |
| [`services/`](services/) | One deployable process: paid oracle, decision ledger, guardian watchdog, example agent |
| [`agent/`](agent/) | **Cato**, the governed DCA agent: buys its signals on-chain, meters its LLM calls, trades within caps |
| [`app/`](app/) | Landing + dashboard: one-click operator keygen, funding, caps editor, live burn-down, receipt verification, kill-switch |

## The 90-second story

1. **Register** an agent — the dashboard generates a disposable operator key
   in your browser and hands you a ready-to-run `.env`.
2. Cato pays the oracle **on-chain** for a signal (402 → receipt → response),
   meters its LLM call, and swaps within caps. Three receipts.
3. **Click any receipt** — the decision record is fetched and keccak-verified
   in your browser: *this is what the agent was thinking.*
4. Crank the loop and the watchdog flags the burst; the **guardian** — which
   cannot move a single wei — suspends the agent on-chain, alone.
5. **Resume** when you decide. Or **withdraw** the treasury. It was never
   lockable by anyone but you.

## Run it

```bash
npm install
npx hardhat test                                       # 23 tests

# local chain, full stack
npx hardhat node                                       # terminal 1
npx hardhat run scripts/deploy.ts --network localhost  # deploys, seeds pools, writes app config
npx hardhat run scripts/register-agent.ts --network localhost

npm run services                                       # terminal 2 — oracle + ledger (+ guardian)
npm run agent                                          # terminal 3 — Cato
cd app && npm install && npm run dev                   # terminal 4 — http://localhost:4180
```

Copy [`.env.example`](.env.example) to `.env` and fill what each process
needs — contract addresses come from `deployments/<network>.json` after a
deploy. For X Layer testnet: fund a deployer from the
[faucet](https://web3.okx.com/xlayer/faucet), set `PRIVATE_KEY`, then
`npm run deploy:xlayer-testnet`. Ops helpers:
[`scripts/register-agent.ts`](scripts/register-agent.ts),
[`scripts/set-guardian.ts`](scripts/set-guardian.ts).

## Honest limits & roadmap

- **Inference metering trusts the operator's numbers.** The chain cannot see
  an LLM call. What it enforces: the *reported* spend is capped, monotonic,
  and public — a private, deniable overrun becomes a public, attributable
  one. Oracle-verified metering is future work.
- **One event per spend.** Fractions of a cent on X Layer — sane above
  ~$0.01 per spend. For true micropayments the plan is epoch batching: one
  Merkle root over N decision records.
- **Mainnet routing.** Planned: the OKX DEX router behind the existing
  one-function interface, plus ERC-8004 identity binding so marketplace
  agents can carry a verifiable "budget-governed" badge.
- The decision ledger is an **availability** layer, never a trust layer —
  records verify client-side against the on-chain hash.

## FAQ — the hard questions

**Why not just session keys or spending-limit modules?**
They're good, and they compose with this — hold the operator key inside one.
But they cap *amount × recipient × time*. They can't express purpose, they
attach no reason to any spend, and the principal who edits the policy also
controls the funds, so the stop button can't be safely delegated. Quaestor is
a policy object, not a signer restriction.

**Why put spend metering on-chain at all?**
Because the audit must outlive the operator. A FinOps dashboard shows *you*
your agent's spending; a receipt stream shows *everyone else* — the
counterparty agent, the auditor, the insurer. In an agent marketplace, that
asymmetry is the product.

**Isn't the guardian just a multisig?**
No. A multisig shares full authority. The guardian holds a strictly smaller
right — suspend, nothing else — enforced in the contract. That's why it's
safe to give the key to a bot.

**What if the operator never publishes a decision record?**
The hash still binds them: any record produced later must match it byte for
byte, and unpublished records are themselves visible — the dashboard shows
exactly which receipts were never opened.

**Who is this for?**
Anyone funding an agent they don't fully trust — which is everyone funding an
agent. The first users are the agents already on X Layer's own marketplace.

## Hackathon compliance

- ✅ AI in the product: LLM-sized trading agent + on-chain-metered AI spend +
  hash-committed, verifiable AI decisions
- ✅ Deployed on X Layer **testnet** during the hackathon (chain id 1952)
- ➡️ Mainnet launch next: OKX DEX router adapter behind the same interface

## License

[MIT](LICENSE) © 2026 Divij N
