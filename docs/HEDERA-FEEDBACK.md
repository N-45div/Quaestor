# Hedera x402 — developer feedback

Findings from taking a service from zero to a settled `hedera:testnet` payment through the
Blocky402 facilitator with `@x402/*@2.25.0` and `@x402/hedera`. Each cost real time; each is
reproducible. Written for the Hedera and x402 teams.

## 1. `new x402Client({ … })` silently ignores its argument

The constructor signature is `constructor(paymentRequirementsSelector?: SelectPaymentRequirements)` —
a *function*. Passing the documented-looking config object compiles, runs, and is discarded:

```ts
// ignored, no error, no warning — spend controls stay at their defaults
const client = new x402Client({ spendControls: { allowedAssets: [...] } });
```

The failure surfaces later as an unrelated-sounding rejection, so the natural next step is to
edit the spend-control values that were never read. Correct forms are `x402Client.fromConfig(config)`
or `new x402Client().setSpendControls(controls)`.

**Suggestion:** have the constructor throw when handed a non-function, naming `fromConfig`.

## 2. Pricing a route in native HBAR is rejected client-side by default

`spendControls` allows only assets `findDefaultAsset` recognises. On Hedera that is USDC, so a
route priced in native HBAR (`asset: "0.0.0"`) is refused **before signing**:

> All payment requirements were rejected by spendControls: only default assets or entries in
> spendControls.allowedAssets are allowed.

HBAR is the chain's own currency and the obvious first thing to price in, so every Hedera x402
client hits this. The fix is an explicit opt-in:

```ts
new x402Client().setSpendControls({
  allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: "20000000" }],
})
```

**Suggestion:** treat native HBAR as a default asset on `hedera:*`, or name it in the error text.
(The control itself is good and we kept it on rather than passing `spendControls: false` — an agent
refusing to pay in a token it was not told about is the right default.)

## 3. `payer == payTo` fails as a bare 402 with an empty body

Pointing `payTo` at the same account that pays produces a zero net transfer. The retry returns
`402` with `{}` — no `PAYMENT-RESPONSE`, no error, nothing in the resource server's log. It is
indistinguishable from a signing failure, a facilitator outage, or a stale process.

**Suggestion:** reject `payer == payTo` at verify with a named reason.

## 4. `AccountCreateTransaction` is missing from the `@x402/hedera` re-export

`@x402/hedera` helpfully re-exports `Client`, `Hbar`, `PrivateKey`, `TransferTransaction`,
`TokenAssociateTransaction` and others *specifically* so consumers avoid a second SDK copy — the
duplicate-install failure (`t.startsWith is not a function`) is well known. But creating the
second account you need for §3 requires `AccountCreateTransaction`, which is not in the list, so
you must import from `@hiero-ledger/sdk` directly and hope the tree has exactly one copy.

**Suggestion:** add `AccountCreateTransaction` (and `AccountDeleteTransaction`) to the re-export.

## What worked well

- The facilitator paying gas is a genuinely different model: our agent holds no gas budget, only
  a price. The settled transfer shows the fee charged to `0.0.7162784`, not the payer.
- `portal.hedera.com` → ECDSA account → funded, in under two minutes, with the Account ID and the
  EVM address shown side by side. The portal's warning that ED25519 "may not be compatible with
  smart contract ecosystem tools" is the right nudge at the right moment.
- Mirror node REST is excellent for verification — resolves by account id *or* EVM address, and
  the transfer list makes a settlement self-evidently correct.

## Reproduce

```
npm run hedera:preflight     # nine checks, names the failure
npm run hedera:pay           # 402 -> sign -> settle, prints the HashScan link
```
