# Chainlink's stock prices onto Monad, with Chainlink CRE

Quaestor's governors on Monad testnet buy tokenized-stock stand-ins on Kuru's order book. Each
governor's price guard reads a Chainlink-style feed: a fill too far over Chainlink's price is
refused, and so is a price that has gone stale.

Chainlink publishes no stock feeds on Monad. This CRE workflow brings them over:

1. **Trigger.** A cron trigger, every 15 minutes.
2. **Read.** It reads Chainlink's own NVDA, SPY and AAPL feeds on **Arbitrum One** (EVM read,
   finalized block).
3. **Compare.** It reads the mirror of each feed on **Monad testnet** and keeps the stocks whose
   price moved at least 0.3%, or whose source has updated six hours past the mirror's round. Monad
   charges a transaction its whole gas limit, so if nothing moved, nothing is written.
4. **Write.** It sends one signed report through CRE's forwarder to
   [`QuaestorMirrorReceiver`](../../contracts/cre/QuaestorMirrorReceiver.sol).
   - The receiver is the only relayer the three mirrors accept.
   - A Quaestor governor's guard reads those mirrors.

| | Address (Monad testnet) |
|---|---|
| QuaestorMirrorReceiver | [`0xb3A434C305e9fB799118aF0aA4a1b532b56e79B1`](https://testnet.monadscan.com/address/0xb3A434C305e9fB799118aF0aA4a1b532b56e79B1) |
| NVDA / USD mirror | [`0xC43D5C4B67127b5a8226baD23F09b5bA09a8afcf`](https://testnet.monadscan.com/address/0xC43D5C4B67127b5a8226baD23F09b5bA09a8afcf) ← Arbitrum One `0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F` |
| SPY / USD mirror | [`0x565073ee131F46132dF60Df8Eb2738C415c0418c`](https://testnet.monadscan.com/address/0x565073ee131F46132dF60Df8Eb2738C415c0418c) ← Arbitrum One `0x46306F3795342117721D8DEd50fbcF6DF2b3cc10` |
| AAPL / USD mirror | [`0xb540c62d16d33BbA585F6d3BE9c33b07A9e39E2D`](https://testnet.monadscan.com/address/0xb540c62d16d33BbA585F6d3BE9c33b07A9e39E2D) ← Arbitrum One `0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c` |

The first run wrote all three prices in
[`0xb6fcb302…0d0c`](https://testnet.monadscan.com/tx/0xb6fcb302c166ff12e5bb3ef1525940368322cdacac9af8c2f93cb70874d80d0c).

## Who can write a price

The receiver accepts a report only:

- through `forwarder`;
- while it sits on CRE's simulation forwarder, which checks no signatures, from a transaction
  the owner's broadcaster sent;
- once a workflow ID is set (the production `KeystoneForwarder` verifies the DON's signatures and
  passes the workflow ID), from that workflow;
- for stocks the owner listed, at a positive price.

An older round than a mirror holds is dropped, not written backwards. The rules are tested in
[`test/mirror-receiver.test.ts`](../../test/mirror-receiver.test.ts).

**Moving to production** takes two owner calls, once the workflow is deployed:

1. `setForwarder(0xF8344CFd5c43616a4366C34E3EEE75af79a74482, address(0))`, Monad testnet's
   `KeystoneForwarder`.
2. `setWorkflowId(<id>)`.

## Run it

Requires the [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation), a CRE login
and [Bun](https://bun.com) 1.2.21 or later.

```bash
bun install --cwd ./stock-mirror
bun test --cwd ./stock-mirror                     # when a price is written, and when not
cre workflow simulate stock-mirror --target staging-settings --non-interactive --trigger-index 0              # dry run
cre workflow simulate stock-mirror --target staging-settings --non-interactive --trigger-index 0 --broadcast  # writes on Monad testnet
```

`--broadcast` sends the report from `CRE_ETH_PRIVATE_KEY` in `.env` (never committed). That key
must be the receiver's simulation sender and must hold MON. The contracts are deployed by
[`scripts/cre-mirror-monad.ts`](../../scripts/cre-mirror-monad.ts).
