---
name: quaestor-budget-history
description: >
  Query a Quaestor-governed agent's own spend history from The Graph. Use when an agent needs
  to know how much budget it has left, whether a proposed spend is unusual for it, how fast it
  has been spending, or when it was suspended — and when you need to tell "the budget says no"
  apart from "nothing could see the budget".
---

# Quaestor budget history (The Graph)

A Quaestor-governed agent has an on-chain budget: per-call caps, per-epoch caps, and a
guardian that can suspend it. The governor enforces those caps itself — you cannot talk it
out of a refusal. What the governor will *not* tell you is what your spending looks like,
and that is usually the question worth asking before you spend.

This skill is how you ask.

**Live endpoint (Base Sepolia governor `0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24`):**

```
https://api.studio.thegraph.com/query/1758977/quaestor/v0.0.1
```

## Quick Reference

| Entity | What it holds |
| --- | --- |
| `Agent` | owner, operator, guardian, `epochLength`, `registeredAt`, `suspended`, lifetime totals |
| `Policy` | `perCallCap` and `epochCap` per category — the owner's current limits |
| `Receipt` | one authorized spend: amount, payee, `metaHash`, `epoch`, `epochSpentAfter` |
| `EpochSpend` | **the useful one** — per agent, per category, per epoch: `spent`, `receiptCount`, `maxReceipt`, `firstAt`, `lastAt` |
| `Suspension` | each guardian suspension and when (if ever) it was resumed |
| `Protocol` | global counters — lets you tell "nothing indexed" from "nothing happened" |

Category is the Solidity enum `{ DATA: 0, INFERENCE: 1, EXECUTION: 2 }`. Every entity that
carries `category: Int!` also carries `categoryName: String!`, so you never have to remember
that 1 means INFERENCE.

## What is actually here that is not on-chain

Get this right or you will over-claim.

The governor **does not forget its sums.** `spentIn[agentId][category][epoch]` is a persistent
mapping — the total for any epoch you can name stays readable on-chain forever, and
`remainingBudget(agentId, category)` is authoritative right now. If all you need is "how much
is left", call the contract. It is one RPC round trip and it cannot be stale.

What a sum cannot tell you is the **shape** of the spend:

| Question | On-chain? |
| --- | --- |
| How much is left this epoch? | Yes — `remainingBudget` |
| What did I spend in epoch 41? | Yes — `spentIn(agent, category, 41)` |
| What was my **largest single** payment that epoch? | **No** |
| How many payments made up that total? | **No** |
| Did they arrive over an hour or in one second? | **No** |
| **Which** epochs are non-empty at all? | **No** — a mapping has no iterator |

That last row is the quiet one. With a one-hour epoch and an agent registered in June there
are thousands of epoch indices and no way to enumerate the interesting ones without scanning
logs. `EpochSpend` is that scan, already done.

So: **caps and balances → the contract or this subgraph, either is fine. Burst, frequency,
pace, and "which epochs happened" → this subgraph or nothing.**

## The core query

Everything an agent needs about itself, in one round trip:

```graphql
query Budget($agentId: BigInt!, $category: Int!) {
  agents(where: { agentId: $agentId }, first: 1) {
    agentId
    epochLength
    registeredAt
    suspended
  }
  policies(where: { agent_: { agentId: $agentId }, category: $category }, first: 1) {
    epochCap
    perCallCap
  }
  epochSpends(
    first: 1000
    orderBy: id
    orderDirection: asc
    where: { agent_: { agentId: $agentId }, category: $category }
  ) {
    id
    epoch
    spent
    receiptCount
    maxReceipt
    firstAt
    lastAt
  }
  _meta { block { number timestamp } hasIndexingErrors }
}
```

Nested filters (`agent_: { agentId: … }`) work and save you a round trip resolving the
agent's `id`. The `id` is `Bytes` built from the agent id in the mappings — do not try to
reconstruct it by hand, filter on `agentId` instead.

Always ask for `_meta` in the same query as the data. A separate freshness call races the one
it is meant to validate.

## Critical: a failed query is not an HTTP error

A bad API key, a deleted deployment, and a malformed query **all return HTTP 200** with
`data: null` and an `errors` array:

```json
{ "errors": [{ "message": "Store error: subgraph not found" }], "data": null }
```

So `if (res.ok)` reads as success and the next line dereferences undefined. Check `errors`
first, every time:

```ts
const body = await res.json();
if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join("; "));
if (!body.data) throw new Error("no data");
```

## Critical: the default page size is 100

Not 1000. There is no warning when you hit it, and a truncated `epochSpends` list silently
understates `maxReceipt` and hides epochs. Set `first` explicitly, and page with an **id
cursor** rather than `skip` — `skip` tops out at 5000:

```graphql
epochSpends(first: 1000, orderBy: id, orderDirection: asc,
            where: { agent_: { agentId: $agentId }, id_gt: $lastId }) { id … }
```

Feed the last row's `id` back as `$lastId`. Start with `"0x"`. Because the id is
`agent ++ category ++ epoch` as bytes, id order is not epoch order — sort by `epoch` yourself
after collecting the pages.

## Critical: derive the epoch from `_meta`, not from your clock

The governor computes the epoch as:

```
epoch = (block.timestamp - agent.registeredAt) / agent.epochLength
```

Use `_meta.block.timestamp` as `block.timestamp`, **not** `Date.now()`. If your clock has
crossed an epoch boundary the index has not reached yet, wall time names an epoch with no
rows — zero spend and a full budget. That is the most dangerous way to be wrong: it invents
headroom.

## Critical: decide what staleness means before you trust a number

A subgraph that is behind reports a **smaller** spend than the chain holds, which
**overstates** the remaining budget. The failure mode is permissive, so silence is the wrong
default:

```ts
const lag = Math.floor(Date.now() / 1000) - meta.block.timestamp;
if (meta.hasIndexingErrors) throw new Error("indexing errors — do not trust this");
if (lag > 120) throw new Error(`index is ${lag}s behind`);
```

When that throws you have a choice, and it depends on the question:

- **"How much is left?"** — fall back to `remainingBudget()` on the contract. Authoritative,
  never stale. No reason to refuse.
- **"Is this spend unusual for me?"** — there is no fallback. Refuse. Answering anyway means
  answering "no anomaly found" when what happened is "no anomaly could be looked for", and a
  caller cannot tell those apart from the outside.

Quaestor's own router does exactly this: `GET /v1/policy/evaluate` marks each rule
`evaluated: true|false` and denies when any rule could not run, with `denied_because` naming
which. `evaluated: false` is not `pass: false`.

## Worked example: should I make this spend?

```ts
const { agents: [agent], policies: [policy], epochSpends, _meta } = await query(BUDGET, {
  agentId: "1", category: 0,
});

const at = Number(_meta.block.timestamp);
const epoch = Math.floor((at - Number(agent.registeredAt)) / Number(agent.epochLength));
const current = epochSpends.find(e => e.epoch === String(epoch));
const prior   = epochSpends.filter(e => e.epoch !== String(epoch));

const spent     = BigInt(current?.spent ?? 0);
const remaining = BigInt(policy.epochCap) - spent;

// Cheap and authoritative — the contract could answer these too.
if (agent.suspended)                    return "suspended";
if (amount > BigInt(policy.perCallCap)) return "over the per-call cap";
if (amount > remaining)                 return "over what's left this epoch";

// Only answerable here.
const largestEver = prior.reduce((m, e) => BigInt(e.maxReceipt) > m ? BigInt(e.maxReceipt) : m, 0n);
if (largestEver > 0n && amount > largestEver * 3n) {
  return `unusual: 3× larger than anything I have ever paid (${largestEver})`;
}

const heaviestEpoch = prior.reduce((m, e) => BigInt(e.spent) > m ? BigInt(e.spent) : m, 0n);
if (heaviestEpoch > 0n && spent + amount > heaviestEpoch * 3n) {
  return `unusual: this epoch would be 3× my heaviest ever`;
}

return "ok";
```

A brand-new agent has no precedent, so `largestEver` is `0` and the shape checks are skipped.
Say so in the answer. "No history to compare against, the per-call cap is the only bound" is
a different statement from "checked, looks normal", and the difference matters to whoever
reads it.

## Useful one-off queries

**Am I currently suspended, and how often have I been?**

```graphql
{ agents(where: { agentId: "1" }) {
    suspended
    suspensionCount
    suspensions(orderBy: at, orderDirection: desc, first: 5) { by at resumedAt }
} }
```

`resumedAt: null` is an open suspension.

**What did I actually pay for, most recent first?**

```graphql
{ receipts(first: 20, orderBy: timestamp, orderDirection: desc,
           where: { agent_: { agentId: "1" } }) {
    categoryName amount payee metaHash epoch timestamp transactionHash
} }
```

`metaHash` is the keccak256 of the decision record behind the spend. If you kept the record,
re-hash it and compare — that is how a receipt is audited against the reasoning that produced
it, by anyone, without trusting the service that served it.

**Is this subgraph empty, or is this agent just quiet?**

```graphql
{ protocols(first: 1) { agentCount receiptCount totalSpent lastBlock } }
```

Zero receipts protocol-wide means nothing has been indexed. Zero receipts for your agent with
a non-zero protocol count means you genuinely have not spent.

## In this repo

- `services/graph.ts` — the reader, with the contract as fallback and the staleness rules above
- `scripts/graph-check.ts` — prints the subgraph and the governor side by side; the shape
  block at the bottom has no governor column, which is the argument in one screen
- `subgraph/` — schema and mappings, deployed from Subgraph Studio
