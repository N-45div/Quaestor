# Quaestor for MetaMask Agent Wallet

An [`mm`](https://docs.metamask.io/agent-wallet/) plugin that lets an agent trade through a
**Quaestor governor** while **MetaMask Agent Wallet holds the agent's key and signs**.

The wallet never holds the money. An owner funds a governor contract, and the governor names
this wallet as its only operator. The governor then spends only:

- on tokens the owner approved,
- through venues the owner approved,
- inside the owner's per-trade and per-epoch caps,
- at or under the owner's limit price, and
- within a set margin of Chainlink's price.

It measures its own balances before and after every swap, rather than trusting the venue. The
wallet holds gas and nothing else.

So every buy passes two independent gates:

| Gate | Where it runs | What it stops |
|---|---|---|
| MetaMask Agent Wallet policy (Guard Mode) | MetaMask's signing service | Threats, unknown recipients, outflow over the 24-hour limit; anything outside policy asks the human |
| Quaestor governor | On-chain, in the transaction itself | Unapproved tokens or venues, spending over the caps, fills over the limit price or Chainlink margin, swaps that return less than the floor |

A hijacked agent, or a prompt-injected one, can still only make trades the owner would have
approved. That holds even if the off-chain layer is bypassed, because the governor checks the
trade on-chain.

## Commands

| Command | Capabilities | What it does |
|---|---|---|
| `mm quaestor whoami` | `wallet-read` | Shows this wallet as an agent: its gas, the governors that name it, and the link its owner signs. |
| `mm quaestor register` | `wallet-read` | Prints the link the owner opens to fund a governor for this wallet, carrying the deposit, caps, tokens and limit prices the agent proposes. |
| `mm quaestor status` | `wallet-read` | Shows the governor's budget, caps, what is left this epoch, approved tokens, limits and Chainlink prices. |
| `mm quaestor quote <token> <amount>` | none | Prices a buy on the governor's venue against Chainlink. Needs no sign-in. |
| `mm quaestor buy <token> <amount> --reason …` | `wallet-read`, `wallet-submit` | Runs every check the governor would make, simulates the trade from this wallet, then hands the governor call to MetaMask to sign. Waits for the receipt and reports what was spent and received. |
| `mm quaestor check` | `wallet-read` | Settles a buy that was sent but not confirmed. It runs before any new buy, so nothing is sent twice. |

`--network` picks the chain. The default is `monad-testnet`, where the governor buys on Kuru's
order book. `robinhood-testnet` and `robinhood` are also supported; there it buys Stock Tokens
on Uniswap.

A refusal comes back as an mm error carrying the governor's own code: `PerTradeCapExceeded`,
`EpochCapExceeded`, `PriceGate`, `OracleStale`, `InstrumentNotAllowed`, `VenueNotAllowed`,
`MinimumOutputNotMet`, `Suspended`, `NoGas` and the rest. MetaMask is never asked to sign a buy
the governor would refuse.

## Install

Requires Node 22.18 or later and `mm` 6.2 or later. Tested on 7.0.0.

```bash
npm install -g @metamask/agent-wallet
mm login && mm init

git clone https://github.com/N-45div/Quaestor && cd Quaestor/integrations/metamask-agent-wallet
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
mm plugins install "file:$PWD" --accept-permissions
```

The built commands (`dist/`, `oclif.manifest.json`) are committed, so installing needs no
build. To rebuild, run `npm ci` in `app/` (for esbuild) and here, then `npm run build`.

## Use

```bash
mm quaestor quote tTSLA 2                       # price 2 tUSDC of tTSLA on Kuru against Chainlink
mm quaestor register --deposit 20 --per-trade 5 --epoch-cap 10 --epoch day --stocks tTSLA --limit tTSLA=400
#   -> send the owner the link; they sign once, and the governor sends this wallet its gas
mm quaestor status
mm quaestor buy tTSLA 2 --reason "TSLA is under my entry and the governor has room today"
mm quaestor buy tTSLA 6 --reason "over the cap"  # refused: PerTradeCapExceeded, MetaMask not asked
```

## How it is built

- The plugin uses the published plugin SDK, `@metamask/agent-wallet/plugin`, and the
  agent-wallet plugin template's packaging: the `oclif-plugin` keyword, an `mm` manifest with
  per-command capabilities, `oclif.manifest.json`, and a peer dependency.
- `minCliVersion` is `>=6.2.0`, not `^6.2.0`, so the plugin also loads on the 7.x CLI.
- Signing goes through `ctx.walletExecutor`, so MetaMask's policy decides every transaction.
- Chain reads go through Quaestor's own RPC, so the plugin works on chains MetaMask's gateway
  doesn't serve. Pass `--rpc` to choose another.
- The checks, quotes and trade encoding are Quaestor's own command line,
  [`cli/quaestor-evm.ts`](../../cli/quaestor-evm.ts). It is bundled into the plugin, so the plugin
  and the command line refuse exactly the same buys. `prepareBuy` returns the governor call, and
  either a key file or MetaMask signs it.
