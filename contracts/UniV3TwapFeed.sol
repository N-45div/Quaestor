// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IUniswapV3PoolOracle {
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function token0() external view returns (address);

    function token1() external view returns (address);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// Uniswap v3's TickMath.getSqrtRatioAtTick (GPL-2.0-or-later), unchanged but for 0.8's explicit unchecked block.
library TickMath {
    int24 internal constant MAX_TICK = 887272;

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= uint256(int256(MAX_TICK)), "T");

            uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}

/// @title UniV3TwapFeed — a Uniswap v3 pool's time-weighted average price, read as an AggregatorV3 feed
/// @notice Where a chain's oracles will not answer a contract (APRO's feeds on HSK Chain refuse any caller not on
/// their list), the pool's own history is a price a contract can read. The answer is the pool's mean price over
/// `window` seconds, in `quote` per whole `base`, with 8 decimals: a price one block cannot move far, worked out on
/// every call. A pool with less history than the window reverts (Uniswap's "OLD"), so a guard that reads it fails
/// closed rather than trading on no price.
contract UniV3TwapFeed {
    uint8 public constant decimals = 8;

    address public immutable pool;
    address public immutable base;
    address public immutable quote;
    uint32 public immutable window;
    string public description;

    bool private immutable _baseIsToken0;
    uint8 private immutable _baseDecimals;
    uint8 private immutable _quoteDecimals;

    error NotInPool(address token);
    error WindowTooShort(uint32 window);

    constructor(address pool_, address base_, uint32 window_, string memory description_) {
        address t0 = IUniswapV3PoolOracle(pool_).token0();
        address t1 = IUniswapV3PoolOracle(pool_).token1();
        if (base_ != t0 && base_ != t1) revert NotInPool(base_);
        if (window_ < 60) revert WindowTooShort(window_);
        pool = pool_;
        base = base_;
        quote = base_ == t0 ? t1 : t0;
        window = window_;
        description = description_;
        _baseIsToken0 = base_ == t0;
        _baseDecimals = IERC20Decimals(base_).decimals();
        _quoteDecimals = IERC20Decimals(quote).decimals();
    }

    /// The mean price over the window. Fresh by construction: `updatedAt` is now, because the average is worked out
    /// from the pool's history on this call.
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        answer = _price();
        return (1, answer, block.timestamp, block.timestamp, 1);
    }

    function latestAnswer() external view returns (int256) {
        return _price();
    }

    function _price() internal view returns (int256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory cumulatives, ) = IUniswapV3PoolOracle(pool).observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        int56 span = int56(uint56(window));
        int24 tick = int24(delta / span);
        // Round towards negative infinity, as Uniswap's OracleLibrary does.
        if (delta < 0 && delta % span != 0) tick--;
        uint256 quoteAmount = _quoteAtTick(tick, 10 ** uint256(_baseDecimals));
        return int256(Math.mulDiv(quoteAmount, 10 ** uint256(decimals), 10 ** uint256(_quoteDecimals)));
    }

    /// Uniswap's OracleLibrary.getQuoteAtTick: what `baseAmount` of base is worth in quote at `tick`.
    function _quoteAtTick(int24 tick, uint256 baseAmount) internal view returns (uint256) {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return _baseIsToken0 ? Math.mulDiv(ratioX192, baseAmount, 1 << 192) : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return _baseIsToken0 ? Math.mulDiv(ratioX128, baseAmount, 1 << 128) : Math.mulDiv(1 << 128, baseAmount, ratioX128);
    }
}
