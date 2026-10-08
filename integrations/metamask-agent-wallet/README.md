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

Requires Node 22.18 or later. Tested with `mm` 7.0.0.

The plugin and the `mm` that runs it must share one copy of MetaMask's SDK: the plugin's commands
extend the SDK's `PluginCommand`, and `mm` accepts only its own. So install `mm` in this folder and
run it from here with `npx`:

```bash
git clone https://github.com/N-45div/Quaestor && cd Quaestor/integrations/metamask-agent-wallet
npm ci                                  # @metamask/agent-wallet 7.0.0, with its mm, in this folder
npx mm login && npx mm init
npx mm config set experimentalPlugins true
npx mm config set experimentalAllowUnverifiedInstalls true
npx mm plugins install "file:$PWD" --accept-permissions
```

A global `mm` cannot run the plugin. Without `npm ci` here, it fails with `Cannot find package
'@metamask/agent-wallet'`. With `npm ci` here, there are two copies of the SDK, and it fails
with `window.addEventListener is not a function`.

The built commands (`dist/`, `oclif.manifest.json`) are committed, so installing needs no
build. To rebuild, run `npm ci` in `app/` (for esbuild) and here, then `npm run build`.

## Use

From this folder (`mm` below is `npx mm`):

```bash
mm quaestor quote tTSLA 2                       # price 2 tUSDC of tTSLA on Kuru against Chainlink
mm quaestor register --deposit 20 --per-trade 5 --epoch-cap 10 --epoch day --stocks tTSLA --limit tTSLA=400
#   -> send the owner the link; they sign once, and the governor sends this wallet its gas
mm quaestor status
mm quaestor buy tTSLA 2 --reason "TSLA is under my entry and the governor has room today"
mm quaestor buy tTSLA 6 --reason "over the cap"  # refused: PerTradeCapExceeded, MetaMask not asked
```

## Proven on Monad testnet

All of this was run with a MetaMask **server wallet in Guard Mode**:

- **The agent's key:** the wallet `0xFBE1c661…a97e`, signed in through `mm login`.
- **Its governor:** [`0xb4f3f29F…6771a`](https://testnet.monadscan.com/address/0xb4f3f29F9BC4ceB73c203ADBf8ba1cdaDa26771a).
  - It was opened by the owner on the live register page from the link `mm quaestor register` printed.
  - It holds 20 tUSDC, with 5 per trade and 10 a day, and allows tTSLA only, at up to 400 and
    within 1% of Chainlink.
- **A buy:** `mm quaestor buy tTSLA 2` became
  [`0x06632885…63bf`](https://testnet.monadscan.com/tx/0x06632885b35bf645d4ddeecdffcc6f2f2d1719b4556c26d1963d8933b20c63bf).
  - Guard Mode held it for the owner's email approval, then MetaMask signed and broadcast it.
  - The governor spent exactly 2 tUSDC and received 0.005612617 tTSLA on Kuru.
- **A refusal:** `mm quaestor buy tTSLA 6` came back as `PerTradeCapExceeded` and nothing was
  signed. MetaMask was never asked.

## MetaMask's gateway and Monad testnet

`mm` lists Monad testnet, and its server wallet signs for it. But MetaMask's RPC gateway answers
`Invalid chainId` for 10143, and `mm` reads the chain through that gateway while it prepares a
transaction. So `mm quaestor buy` points the gateway at a loopback server for the length of one
wallet request ([`src/gateway.ts`](src/gateway.ts)):

- The server answers the governor's chain only, using Quaestor's RPCs and their fallbacks.
- Signing, policy and broadcasting stay in MetaMask's wallet service.

Two other quirks of `mm` 7.0.0 are handled here:

- **Quantities:** the executor writes `0x` in front of each quantity itself, so they are passed
  without one.
- **Approvals:** testnets are outside Guard Mode's default allowed chains, so each buy waits for
  one email approval.

Set `QUAESTOR_GATEWAY_LOG=1` to see each read the gateway answers.

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
