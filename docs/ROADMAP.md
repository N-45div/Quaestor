# Roadmap

Work that is decided but deliberately not being built yet. Nothing here is in
scope for Stocklana (deadline 25 Sep 2026); this is what comes after it.

---

## 0. One governor design, on every chain where tokenized assets trade

**Decided 18 Sep 2026.**

The Solana program and the EVM contract enforce the same idea, but only the
Solana one enforces it properly. `contracts/Quaestor.sol` has three limits the
Solana program has since removed:

| `Quaestor.sol` | The Solana program | Port |
|---|---|---|
| `immutable router` — one venue for the life of the contract | `ApprovedRouter` allowlist; the owner adds venues and the operator picks per trade | venue allowlist |
| native coin only (`swapExactNativeForTokens{value: amountIn}`) | stablecoin budgets | ERC-20 budgets |
| takes the router's returned `amountOut` as the outcome | reads the token accounts before and after, and reverts on overspend, underdelivery or a swept position | **balance postconditions** |

The third row is the one that matters. A router that misreports `amountOut` is
the case a governor exists to catch, and the current contract takes its word.

`QuaestorV2.sol` ports the Solana design. Because the guarantee comes from
measuring accounts rather than from trusting a venue, it is chain-agnostic by
construction — adding a chain adds a deployment, not a re-audit. Targets, all
EVM and so each just another row in the existing network picker:

- **Robinhood Chain** — an Arbitrum Orbit L2 built around Stock Tokens, with
  Uniswap as its primary AMM and USDG as its native stablecoin. The closest match
  there is to what the Solana side already does.
- **Arbitrum** (One / Sepolia).
- **Monad**.

Its test suite should mirror the Solana one case for case — a lying router, an
overspend, an underdelivery, a sweep, a replay — so the two implementations are
held to the same claims.

---

## 1. Settle x402 through PayAI on Solana, not HBAR on Hedera

**Decided 18 Sep 2026.**

Quaestor's paid endpoints — venue permits, threat lookups, policy evaluation —
are priced and settled in HBAR through a Hedera facilitator. The trading side is
now Solana. Running the money on one chain and the product on another is a split
worth closing, and closing it towards Solana rather than towards Hedera.

[PayAI](https://payai.network/) is the reason it is worth doing rather than
merely tidy: it is an x402 facilitator that is Solana-first and handles the large
majority of real x402 settlement on Solana. The protocol does not change — this
is still HTTP 402 with a stablecoin — only the facilitator and the settlement
asset do. We already speak x402 (`@x402/core`, `@x402/express`, `@x402/fetch`),
so this is a rail swap, not a rewrite.

What it touches:

| Area | Today | After |
|---|---|---|
| `services/x402hedera.ts` | Hedera lane, Blocky402 facilitator | a PayAI lane beside it |
| `services/main.ts` | `X402_HEDERA_ENABLED`, `PERMIT_BASE_HBAR` | a PayAI facilitator + USDC pricing |
| pricing | HBAR amounts throughout | USDC base units |
| `app/src/views/` | `Landing`, `RoutesView`, `ExplorerOverview`, `NetworksView` all quote HBAR | quote USDC, name PayAI |
| deps | `@x402/hedera` | a Solana facilitator client |

Add the new lane before removing the old one. The Hedera work is part of the
ETHOnline record in `CONTINUITY.md`, and a rail that has settled real payments
should be retired deliberately rather than deleted to make a diff smaller.

Open question to answer first: whether PayAI's facilitator can price a call in
USDC and settle to a governed vault address, or whether settlement has to land
in a normal wallet and be swept. That decides whether the spend governor can
police its own income the way it polices its spending.

---

## 2. Solana in the network picker

**Decided 18 Sep 2026.**

The explorer's network switcher offers X Layer, Arc, Base and Ethereum Sepolia.
Solana belongs there, and today it cannot simply be added as a fifth row.

The picker is EVM-shaped down to its types. `CHAINS` in `app/src/lib/config.ts`
maps each key to a `config.<key>.json` whose `AppConfig` carries `chainId`,
`rpcUrl` and a `contracts` record of `0x…` addresses; `state.tsx` builds a viem
client per chain and the whole store is remounted on `<StoreProvider key={chain}>`.
A Solana entry has no `chainId`, no `0x` contracts and no viem client — it has a
program id, PDAs and an RPC that answers a different protocol.

So this is a split by chain *family*, not another row:

- `AppConfig` becomes a union — an EVM deployment or a Solana one — discriminated
  on family, and views read through an accessor rather than reaching for
  `cfg.contracts.Quaestor`.
- The store splits: the viem reader stays for EVM, a `@solana/web3.js` reader
  joins it for the governor PDAs, and each view declares which it needs. The
  Stocks views already sidestep this by talking to the hub over plain HTTP
  (`app/src/lib/stocks.ts`), which is the pattern to keep — a view that needs no
  wallet should not wait on one.
- The picker groups by family instead of listing testnets flat.

Worth doing once there is a deployed Solana program for it to point at. Before
that it would be a switcher with nothing behind it.

---

## 3. Agentic surface on Solana

**Sketch, not yet a plan.**

The EVM side has an agent registry, decision records and receipts on chain. The
Solana side has a governor with intent records and settled-trade events but no
equivalent explorer surface. Once (1) and (2) land, the Decisions and Agents
views should read Solana intent records the same way they read EVM receipts, so
one explorer covers both and a decision hash resolves wherever it was made.
