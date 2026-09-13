# Quaestor Stocks — Day 1

Day 1 adds the policy-first core for a Solana stock execution arm. It is
implemented in `stocks/` so the policy can be moved into an Anchor program
without coupling it to HTTP or a particular quote provider.

The governor enforces:

- owner/operator separation;
- an owner-funded USDC vault and owner-only withdrawal;
- an owner-approved instrument mint list;
- per-trade and per-epoch USDC caps;
- pause and resume;
- quote expiry, exact-mint and exact-input checks;
- minimum-output protection at quote and settlement time;
- replay protection by intent ID, including concurrent requests;
- a reservation held across the asynchronous executor call, so epoch caps and
  vault liquidity cannot be oversubscribed;
- immutable intent snapshots, stable field-order hashing and explicit pending
  state for ambiguous executor failures; and
- a receipt that commits the decision hash, observed output and transaction signature.

Jupiter is represented by two boundaries: `validateJupiterQuote` performs the
checks the governor can prove locally, while `JupiterTransactionBuilder` and
`StockChainExecutor` are the integration points for `/quote`, `/build` and a
Solana signer. The current test executor is intentionally injected and does
not represent a live chain fill.

Run the proof with:

```text
npx ts-node scripts/stocks-day1.ts
```

The next implementation step is the Anchor vault and a real Jupiter transaction
adapter. It must make the minimum-output check part of the submitted
transaction, verify the output token-account delta, and return the confirmed
signature before the receipt is committed. If submission times out, the intent
must remain pending until a signature/status lookup reconciles it; it must not
be retried as a new order. `reconcilePending` is the current owner-controlled
adapter boundary for that lookup.
