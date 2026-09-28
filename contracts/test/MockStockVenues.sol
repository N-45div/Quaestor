// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Test tokens: a 6-decimal dollar (USDG's shape) and an 18-decimal share.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A budget token whose approve(0) is ignored: the governor must notice the
/// allowance it could not take back.
contract StickyAllowanceToken is MockERC20 {
    constructor() MockERC20("Sticky", "STK", 6) {}

    function approve(address spender, uint256 value) public override returns (bool) {
        if (value == 0) return true;
        return super.approve(spender, value);
    }
}

interface IGovernorTrade {
    struct Trade {
        bytes32 intentId;
        address venue;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        bytes32 decisionHash;
        bytes swapData;
    }

    function executeTrade(Trade calldata t) external returns (uint256, uint256);

    function withdraw(address token, uint256 amount, address to) external;
}

/// One venue that can behave like every route the governor must survive.
/// `price` is budget base units per whole share, like the owner's limit.
contract MockStockVenue {
    enum Mode {
        Honest, // pull the budget, pay shares at `price`
        KeepMoney, // pull the budget, deliver nothing
        Short, // deliver half of what the price says
        Redirect, // deliver to `redirectTo` instead of the payer
        KeepChange, // pull the budget, hand `changeBack` of it back
        OverRefund, // pull the budget, hand back more than it took
        OverPull, // try to pull twice what it was lent
        SweepShares, // try to pull the payer's shares as well
        Reenter, // call back into the governor mid-trade
        OtherToken, // deliver a different token than the one bought
        RaidOther // try to pull the budget of another governor
    }

    Mode public mode;
    uint256 public price;
    address public redirectTo;
    uint256 public changeBack;
    address public otherToken;
    address public raidTarget;
    bytes public reentry;

    function setMode(Mode m) external {
        mode = m;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function setRedirect(address to) external {
        redirectTo = to;
    }

    function setChangeBack(uint256 c) external {
        changeBack = c;
    }

    function setOtherToken(address t) external {
        otherToken = t;
    }

    function setRaidTarget(address t) external {
        raidTarget = t;
    }

    function setReentry(bytes calldata data) external {
        reentry = data;
    }

    /// The call the governor makes, with calldata the agent built.
    function buy(address budget, address stock, uint256 amountIn) external {
        address payer = msg.sender;
        Mode m = mode;
        if (m == Mode.OverPull) {
            IERC20(budget).transferFrom(payer, address(this), amountIn * 2);
            return;
        }
        if (m == Mode.RaidOther) {
            IERC20(budget).transferFrom(raidTarget, address(this), amountIn);
            return;
        }
        IERC20(budget).transferFrom(payer, address(this), amountIn);
        if (m == Mode.KeepMoney) return;
        if (m == Mode.Reenter) {
            (bool ok, bytes memory reason) = payer.call(reentry);
            if (!ok) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
            return;
        }
        if (m == Mode.SweepShares) {
            uint256 held = IERC20(stock).balanceOf(payer);
            IERC20(stock).transferFrom(payer, address(this), held);
        }
        if (m == Mode.KeepChange) IERC20(budget).transfer(payer, changeBack);
        if (m == Mode.OverRefund) IERC20(budget).transfer(payer, amountIn + 1);

        uint256 paid = m == Mode.KeepChange ? amountIn - changeBack : amountIn;
        uint256 shares = (paid * 10 ** uint256(ERC20(stock).decimals())) / price;
        if (m == Mode.Short) shares /= 2;
        address to = m == Mode.Redirect ? redirectTo : payer;
        address token = m == Mode.OtherToken ? otherToken : stock;
        MockERC20(token).mint(to, shares);
    }
}

/// A Chainlink AggregatorV3 stand-in whose answer and age the test sets.
contract MockAggregator {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
