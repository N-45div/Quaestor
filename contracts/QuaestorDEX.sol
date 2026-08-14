// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQuaestorRouter} from "./Quaestor.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title QuaestorDEX — a real constant-product AMM on X Layer testnet
/// @notice Native OKB <-> token pools with x*y=k pricing and a 0.3% LP fee.
/// Anyone can add/remove liquidity and swap. Quaestor routes governed
/// EXECUTION spends through `swapExactNativeForTokens`; on X Layer mainnet the
/// governor is pointed at an adapter over the OKX DEX router instead — the
/// IQuaestorRouter interface is the only coupling.
contract QuaestorDEX is IQuaestorRouter {
    struct Pool {
        uint256 reserveNative; // wei of OKB
        uint256 reserveToken;
        uint256 totalShares;
    }

    /// token => pool
    mapping(address => Pool) public pools;
    /// token => provider => LP shares
    mapping(address => mapping(address => uint256)) public sharesOf;

    uint256 private _lock = 1;

    uint256 public constant FEE_NUM = 997; // 0.3% fee
    uint256 public constant FEE_DEN = 1000;
    uint256 public constant MINIMUM_LIQUIDITY = 1e3;

    event LiquidityAdded(
        address indexed token,
        address indexed provider,
        uint256 amountNative,
        uint256 amountToken,
        uint256 shares
    );
    event LiquidityRemoved(
        address indexed token,
        address indexed provider,
        uint256 amountNative,
        uint256 amountToken,
        uint256 shares
    );
    event Swapped(
        address indexed caller,
        address indexed token,
        bool nativeIn,
        uint256 amountIn,
        uint256 amountOut,
        address to
    );

    error Reentrancy();
    error ZeroAmount();
    error ZeroAddress();
    error EmptyPool(address token);
    error PoolAlreadySeeded(address token);
    error InsufficientShares(uint256 requested, uint256 held);
    error SlippageExceeded(uint256 amountOut, uint256 minOut);
    error TransferFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------- liquidity

    /// @notice Seed a new pool or join an existing one. For an existing pool
    /// the token amount actually pulled matches the pool ratio for msg.value;
    /// `maxAmountToken` bounds it.
    function addLiquidity(
        address token,
        uint256 maxAmountToken
    ) external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0 || maxAmountToken == 0) revert ZeroAmount();
        Pool storage pool = pools[token];

        uint256 amountToken;
        if (pool.totalShares == 0) {
            amountToken = maxAmountToken;
            shares = _sqrt(msg.value * amountToken);
            if (shares <= MINIMUM_LIQUIDITY) revert ZeroAmount();
            // permanently locked dust, Uniswap-style, so a pool can't be fully drained
            pool.totalShares = MINIMUM_LIQUIDITY;
            sharesOf[token][address(0)] = MINIMUM_LIQUIDITY;
            shares -= MINIMUM_LIQUIDITY;
        } else {
            amountToken = (msg.value * pool.reserveToken) / pool.reserveNative;
            if (amountToken == 0) revert ZeroAmount();
            if (amountToken > maxAmountToken) {
                revert SlippageExceeded(amountToken, maxAmountToken);
            }
            shares = (msg.value * pool.totalShares) / pool.reserveNative;
            if (shares == 0) revert ZeroAmount();
        }

        pool.reserveNative += msg.value;
        pool.reserveToken += amountToken;
        pool.totalShares += shares;
        sharesOf[token][msg.sender] += shares;

        if (!IERC20(token).transferFrom(msg.sender, address(this), amountToken)) {
            revert TransferFailed();
        }
        emit LiquidityAdded(token, msg.sender, msg.value, amountToken, shares);
    }

    function removeLiquidity(
        address token,
        uint256 shares,
        address payable to
    ) external nonReentrant returns (uint256 amountNative, uint256 amountToken) {
        if (to == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();
        uint256 held = sharesOf[token][msg.sender];
        if (shares > held) revert InsufficientShares(shares, held);

        Pool storage pool = pools[token];
        amountNative = (shares * pool.reserveNative) / pool.totalShares;
        amountToken = (shares * pool.reserveToken) / pool.totalShares;

        sharesOf[token][msg.sender] = held - shares;
        pool.totalShares -= shares;
        pool.reserveNative -= amountNative;
        pool.reserveToken -= amountToken;

        if (!IERC20(token).transfer(to, amountToken)) revert TransferFailed();
        (bool ok, ) = to.call{value: amountNative}("");
        if (!ok) revert TransferFailed();
        emit LiquidityRemoved(token, msg.sender, amountNative, amountToken, shares);
    }

    // ----------------------------------------------------------------- swaps

    /// @inheritdoc IQuaestorRouter
    function swapExactNativeForTokens(
        uint256 minOut,
        address tokenOut,
        address to
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (to == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        Pool storage pool = pools[tokenOut];
        if (pool.reserveNative == 0) revert EmptyPool(tokenOut);

        amountOut = _getAmountOut(msg.value, pool.reserveNative, pool.reserveToken);
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);

        pool.reserveNative += msg.value;
        pool.reserveToken -= amountOut;

        if (!IERC20(tokenOut).transfer(to, amountOut)) revert TransferFailed();
        emit Swapped(msg.sender, tokenOut, true, msg.value, amountOut, to);
    }

    function swapExactTokensForNative(
        address tokenIn,
        uint256 amountIn,
        uint256 minOut,
        address payable to
    ) external nonReentrant returns (uint256 amountOut) {
        if (to == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        Pool storage pool = pools[tokenIn];
        if (pool.reserveNative == 0) revert EmptyPool(tokenIn);

        amountOut = _getAmountOut(amountIn, pool.reserveToken, pool.reserveNative);
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);

        pool.reserveToken += amountIn;
        pool.reserveNative -= amountOut;

        if (!IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn)) {
            revert TransferFailed();
        }
        (bool ok, ) = to.call{value: amountOut}("");
        if (!ok) revert TransferFailed();
        emit Swapped(msg.sender, tokenIn, false, amountIn, amountOut, to);
    }

    // ----------------------------------------------------------------- views

    function getNativeToTokenOut(
        address token,
        uint256 amountIn
    ) external view returns (uint256) {
        Pool storage pool = pools[token];
        if (pool.reserveNative == 0) return 0;
        return _getAmountOut(amountIn, pool.reserveNative, pool.reserveToken);
    }

    function getTokenToNativeOut(
        address token,
        uint256 amountIn
    ) external view returns (uint256) {
        Pool storage pool = pools[token];
        if (pool.reserveNative == 0) return 0;
        return _getAmountOut(amountIn, pool.reserveToken, pool.reserveNative);
    }

    /// @notice Spot price of 1e18 wei of OKB in token units (before fees).
    function spotPrice(address token) external view returns (uint256) {
        Pool storage pool = pools[token];
        if (pool.reserveNative == 0) return 0;
        return (pool.reserveToken * 1e18) / pool.reserveNative;
    }

    // ------------------------------------------------------------- internals

    function _getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * FEE_NUM;
        return (amountInWithFee * reserveOut) / (reserveIn * FEE_DEN + amountInWithFee);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
