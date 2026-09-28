// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUniswapV3PoolMint {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
}

/// Seeds a real Uniswap v3 pool on a fork, the way an attacker would: it opens
/// a pool at a price it chose and puts in just enough for one trade to fill.
contract UniV3LiquidityHelper {
    address private immutable _owner = msg.sender;
    address private _pool;

    /// Only whoever deployed it may seed: the callback pays out of this
    /// contract's balance, to whichever pool is being seeded.
    function seed(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        require(msg.sender == _owner, "not the owner");
        _pool = pool;
        IUniswapV3PoolMint(pool).mint(address(this), tickLower, tickUpper, liquidity, "");
        _pool = address(0);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        require(msg.sender == _pool, "not the pool being seeded");
        if (amount0Owed > 0) IERC20(IUniswapV3PoolMint(msg.sender).token0()).transfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(IUniswapV3PoolMint(msg.sender).token1()).transfer(msg.sender, amount1Owed);
    }
}
