# Arc mainnet readiness

**Status: deployment-ready, not deployed — because Arc mainnet does not exist yet.**

Circle opens Arc public mainnet on **16 September 2026**. As of this writing
[docs.arc.io](https://docs.arc.io/arc/references/rpc-endpoints) still says:

> The values on this page apply to the Arc Testnet. Mainnet endpoints and parameters are
> published separately when available.

The ETHOnline deadline is **13 September** — three days *before* Arc mainnet opens. No entry
in this hackathon can deploy to Arc mainnet before submitting. The Arc bounty is written
accordingly: T4/T5 accept **deployed *or deployment-ready*** with a **30 September** window.

This document is the readiness evidence, and the runbook for the day.

## Why the contract needs no changes

Arc's gas token is USDC. Nothing else about it is unusual — it is a standard Ethereum
JSON-RPC chain — and `Quaestor.sol` never names an asset. Budgets are denominated in the
chain's native unit, so on Arc:

```solidity
Policy({ epochCap: 25e18, perCallCap: 5e18 })   // $25 per epoch, $5 per call
```

The caps *are* dollar caps, with no contract change, no oracle, and no stablecoin address to
configure. That is the whole reason Arc is interesting for a spend governor: everywhere else
a "$5 cap" is a price feed away from being wrong.

**Verified, not assumed:** Arc's native unit is **18 decimals**, not USDC's usual 6. Measured
against `rpc.testnet.arc.io` — the deployer's 20 USDC faucet grant reads as
`15718957366562500000` wei, i.e. `formatEther` → `15.718…`. If it were 6-decimal the same
balance would read as 15.7 *trillion*. Every cap, receipt and log line in this repo uses
`parseEther`/`formatEther`, which is correct for Arc.

## The addresses are already known

`CREATE` derives a contract address from the deployer and its nonce alone, and
[`scripts/deploy.ts`](../scripts/deploy.ts) deploys in a fixed order. So the mainnet addresses
are computable today, before the chain exists:

| Contract | Nonce | Address |
|---|---|---|
| `QuaestorDEX` | 0 | `0x2e91d035D622d2ECa36B7836CBcf9651711B2D10` |
| `qUSD` | 1 | `0xF2fa4cF4209C7FC4a42E309CE01a6716b6a51B64` |
| `qBTC` | 2 | `0x7cf23d5D7A49ca4113ed4b72e465b227E7978c12` |
| **`Quaestor`** | **3** | **`0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24`** |

Those are not predictions in the hopeful sense. They are the addresses the **same contracts
already occupy on two live chains** — Arc testnet (5042002) and Base Sepolia (84532) — from
the same deployer at the same nonces:

```
arcTestnet   Quaestor 0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24
baseSepolia  Quaestor 0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24
```

`npm run arc:preflight` checks that parity on every run. The one condition is that the
deployer arrives on Arc mainnet with **nonce 0**; the preflight fails loudly if it does not,
because every address above shifts.

## Cost

Measured against Arc testnet, since mainnet gas is not published:

| Item | USDC |
|---|---|
| Deploy four contracts (~16 kB of bytecode, 42 gwei) | ~0.20 |
| Seed both AMM pools (`SEED_NATIVE_*`) | ~0.08 |
| **Total** | **~0.28** |

Budget $1 and it is comfortable. The preflight recomputes this against whatever RPC it is
given, so the number is checked rather than quoted.

## Do not trust a third-party chain id

Two different mainnet chain ids are circulating on aggregator sites — **5042** and **1243** —
and neither comes from Circle. Getting this wrong is not a soft failure: ethers refuses to
send when the configured chain id disagrees with the node, and a signed transaction carries
the chain id in its replay protection.

[`hardhat.config.ts`](../hardhat.config.ts) therefore reads `ARC_CHAIN_ID` from the
environment and defines the `arc` network **only** when both it and `ARC_RPC` are set. There
is no default to be wrong. The preflight asserts the configured id against `eth_chainId` from
the node itself before anything is deployed.

Take both values from `docs.arc.io` on the day. Nowhere else.

## Runbook — 16 September

```bash
# 1. From docs.arc.io, not an aggregator:
export ARC_RPC=https://…            # published at launch
export ARC_CHAIN_ID=…               # published at launch
export ARC_PRIVATE_KEY=0x…          # a FRESH account, nonce 0

# 2. Every check that can fail, before spending anything:
npm run arc:preflight               # must print "0 fail"

# 3. Deploy:
npm run deploy:arc-mainnet          # writes deployments/arc.json

# 4. Prove the cap is the product, on mainnet, in three facts:
OPERATOR_KEY=0x… npx hardhat run scripts/prove-caps.ts --network arc
```

`prove-caps.ts` is the same script already run on Arc testnet and Base Sepolia. It makes a
spend inside the cap, makes the identical spend one wei over it and decodes the
`PerCallCapExceeded` revert, then shows the budget moved by exactly the amount spent. On Arc
every figure it prints is dollars.

## After the deploy

- [ ] `deployments/arc.json` committed
- [ ] `prove-caps` transaction hashes in the README chain table
- [ ] Dashboard config points at Arc mainnet
- [ ] Submission's live-demo link updated, if the ETHGlobal form still allows edits
- [ ] `ARC_PRIVATE_KEY` rotated out of any shared environment

## What is already live on Arc testnet

Not a plan — a deployment, since 8 September:

| Contract | Address |
|---|---|
| Quaestor | [`0x99D7fc…3b24`](https://testnet.arcscan.app/address/0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24) |
| QuaestorDEX | [`0x2e91d0…2D10`](https://testnet.arcscan.app/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10) |
| qUSD | `0xF2fa4c…1B64` |
| qBTC | `0x7cf23d…8c12` |

The mainnet deploy is the same four contracts, the same script, and a different RPC. That is
the claim this document exists to make checkable.
