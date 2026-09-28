# Uniswap v3, as Uniswap published it

Compiled artifacts copied unmodified from npm, for deploying Uniswap v3 where
Uniswap has not (Robinhood Chain's testnet). They are Uniswap's own bytecode, so
pools created by this factory have the canonical init code hash that
SwapRouter02 and QuoterV2 compute pool addresses with.

| File | Package | Path in the package | Licence |
|---|---|---|---|
| UniswapV3Factory.json | @uniswap/v3-core@1.0.1 | artifacts/contracts/UniswapV3Factory.sol/ | BUSL-1.1, since converted to GPL-2.0-or-later |
| QuoterV2.json | @uniswap/v3-periphery@1.4.4 | artifacts/contracts/lens/QuoterV2.sol/ | GPL-2.0-or-later |
| SwapRouter02.json | @uniswap/swap-router-contracts@1.3.1 | artifacts/contracts/SwapRouter02.sol/ | GPL-2.0-or-later |

Fetched from unpkg.com on 28 Sep 2026. Used only by scripts/stocks-robinhood-testnet.ts.
