// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {QuaestorStocks, QuaestorStockGovernor} from "../QuaestorStocks.sol";
import {MockERC20, MockAggregator} from "../test/MockStockVenues.sol";

/// A venue that does whatever the fuzzer tells it: pay honestly, overcharge,
/// pull twice, send the shares elsewhere, hand budget back, try the governor
/// again from inside the call, or reach for the governor's shares.
contract HostileVenue {
    MockERC20 public immutable stock;

    constructor(MockERC20 stock_) {
        stock = stock_;
    }

    function swap(IERC20 budget, uint8 mode, uint256 pull, uint256 give, address elsewhere, bytes calldata again) external {
        address gov = msg.sender;
        mode = mode % 8;
        if (mode == 1) {
            // Pull twice: once for the trade, once more.
            budget.transferFrom(gov, address(this), pull);
            budget.transferFrom(gov, address(this), pull);
        } else if (mode == 3) {
            // Hand budget back, more than it took.
            budget.transferFrom(gov, address(this), pull);
            budget.transfer(gov, pull + 1);
        } else if (mode == 5) {
            // Reach for the governor's shares; it never approves them.
            stock.transferFrom(gov, address(this), give);
        } else {
            budget.transferFrom(gov, address(this), pull);
        }
        if (mode == 2) {
            stock.mint(elsewhere, give); // the shares go to someone else
        } else if (mode == 4) {
            // Back into the governor while it holds the lock.
            (bool ok, ) = gov.call(again);
            ok; // either way the trade goes on
            stock.mint(gov, give);
        } else if (mode == 6) {
            // Keep the approval alive: ask for it to be raised.
            (bool ok, ) = address(budget).call(abi.encodeWithSignature("approve(address,uint256)", address(this), type(uint256).max));
            ok;
            stock.mint(gov, give);
        } else {
            stock.mint(gov, give);
        }
    }

    /// The venue keeps its takings where the fuzzer can see them go back out.
    function sweep(IERC20 budget, address to) external {
        budget.transfer(to, budget.balanceOf(address(this)));
    }
}

/// The owner opens the governor and never touches it again, so every change the
/// fuzzer sees comes from the agent's trades.
contract FuzzOwner {
    function open(QuaestorStocks factory, MockERC20 budget, QuaestorStocks.Setup calldata s) external returns (address) {
        budget.mint(address(this), s.deposit);
        budget.approve(address(factory), s.deposit);
        return factory.createGovernor(s);
    }
}

/// Echidna properties for QuaestorStockGovernor. This contract is the agent: it
/// is the governor's operator and calls executeTrade with whatever the fuzzer
/// chooses, through a venue that does whatever the fuzzer chooses. Whatever
/// happens, the properties below must hold.
///
///   echidna contracts/fuzz/GovernorEchidna.sol --contract GovernorEchidna --config echidna.yaml
contract GovernorEchidna {
    uint128 internal constant PER_TRADE = 5e6; // 5 dollars (6 decimals)
    uint128 internal constant EPOCH_CAP = 20e6;
    uint64 internal constant EPOCH = 1 days;
    uint128 internal constant MAX_PRICE = 400e6; // the owner's limit: $400 a share
    uint256 internal constant DEPOSIT = 1_000e6;
    uint16 internal constant MARGIN_BPS = 150;

    MockERC20 internal immutable budget;
    MockERC20 internal immutable stock;
    MockAggregator internal immutable feed;
    HostileVenue internal immutable venue;
    QuaestorStockGovernor internal immutable gov;

    // What the agent has seen settle, measured on its own.
    uint256 internal totalSpent;
    uint256 internal totalReceived;
    uint256 internal lastEpoch;
    uint256 internal spentThisEpoch;
    bytes32 internal nonce;

    // A property that failed, with the trade that broke it.
    bool internal overspent;
    bool internal overCap;
    bool internal overEpoch;
    bool internal underFloor;
    bool internal overLimit;
    bool internal overOracle;

    constructor() {
        budget = new MockERC20("USDG", "USDG", 6);
        stock = new MockERC20("Tesla", "TSLA", 18);
        feed = new MockAggregator(8);
        feed.set(350e8, block.timestamp);
        venue = new HostileVenue(stock);
        QuaestorStocks factory = new QuaestorStocks();

        address[] memory venues = new address[](1);
        venues[0] = address(venue);
        bytes16[] memory labels = new bytes16[](1);
        labels[0] = bytes16("hostile");
        address[] memory tokens = new address[](1);
        tokens[0] = address(stock);
        uint128[] memory maxPrices = new uint128[](1);
        maxPrices[0] = MAX_PRICE;
        QuaestorStockGovernor.GuardSetup[] memory guards = new QuaestorStockGovernor.GuardSetup[](1);
        guards[0] = QuaestorStockGovernor.GuardSetup({token: address(stock), feed: address(feed), maxDeviationBps: MARGIN_BPS, maxStaleness: 3 days});

        QuaestorStocks.Setup memory s = QuaestorStocks.Setup({
            operator: address(this),
            budgetToken: address(budget),
            epochLength: EPOCH,
            perTradeCap: PER_TRADE,
            epochCap: EPOCH_CAP,
            venues: venues,
            labels: labels,
            tokens: tokens,
            maxPrices: maxPrices,
            guards: guards,
            deposit: DEPOSIT
        });
        gov = QuaestorStockGovernor(new FuzzOwner().open(factory, budget, s));
    }

    // ------------------------------------------------------------ actions

    /// The agent asks for a trade; the venue does as the fuzzer says.
    function trade(uint256 amountIn, uint256 minOut, uint8 mode, uint256 pull, uint256 give, bool reuseIntent) external {
        amountIn = 1 + (amountIn % (PER_TRADE * 2)); // up to twice the cap
        minOut = 1 + (minOut % 1e17);
        pull = pull % (PER_TRADE * 3);
        give = give % 1e17;
        if (!reuseIntent) nonce = keccak256(abi.encode(nonce, block.timestamp, amountIn));
        bytes memory again = abi.encodeCall(QuaestorStockGovernor.withdraw, (address(budget), 1, address(venue)));
        bytes memory swapData = abi.encodeCall(HostileVenue.swap, (IERC20(address(budget)), mode, pull, give, address(0xBEEF), again));

        uint256 budgetBefore = budget.balanceOf(address(gov));
        uint256 stockBefore = stock.balanceOf(address(gov));
        try gov.executeTrade(QuaestorStockGovernor.Trade({
            intentId: nonce,
            venue: address(venue),
            tokenOut: address(stock),
            amountIn: amountIn,
            minOut: minOut,
            decisionHash: bytes32(0),
            swapData: swapData
        })) returns (uint256, uint256) {
            uint256 budgetAfter = budget.balanceOf(address(gov));
            uint256 stockAfter = stock.balanceOf(address(gov));
            if (budgetAfter > budgetBefore) { overspent = true; return; }
            uint256 spent = budgetBefore - budgetAfter;
            uint256 received = stockAfter >= stockBefore ? stockAfter - stockBefore : 0;
            if (stockAfter < stockBefore) underFloor = true;
            if (spent > amountIn) overspent = true;
            if (spent > PER_TRADE) overCap = true;
            if (received < minOut) underFloor = true;
            if (spent * 1e18 > received * MAX_PRICE) overLimit = true;
            (, int256 answer, , , ) = feed.latestRoundData();
            // fill * 10^8 * 10000 <= answer * 10^6 * (10000 + margin), both per whole share
            if (spent * 1e18 * 1e8 * 10_000 > received * uint256(answer) * 1e6 * (10_000 + MARGIN_BPS)) overOracle = true;
            uint256 epoch = block.timestamp / EPOCH;
            if (epoch != lastEpoch) { lastEpoch = epoch; spentThisEpoch = 0; }
            spentThisEpoch += spent;
            if (spentThisEpoch > EPOCH_CAP) overEpoch = true;
            totalSpent += spent;
            totalReceived += received;
        } catch {}
    }

    /// Chainlink moves, and updates.
    function oracle(uint256 price) external {
        feed.set(int256(100e8 + (price % 900e8)), block.timestamp);
    }

    /// The venue spends what it took.
    function venueSweeps() external {
        venue.sweep(IERC20(address(budget)), address(0xCAFE));
    }

    // --------------------------------------------------------- properties

    function echidna_never_spends_more_than_asked() external view returns (bool) { return !overspent; }

    function echidna_never_over_the_per_trade_cap() external view returns (bool) { return !overCap; }

    function echidna_never_over_the_epoch_cap() external view returns (bool) {
        return !overEpoch && gov.spentInEpoch() <= EPOCH_CAP;
    }

    function echidna_never_under_the_floor() external view returns (bool) { return !underFloor; }

    function echidna_never_over_the_owners_limit() external view returns (bool) { return !overLimit; }

    function echidna_never_past_the_chainlink_margin() external view returns (bool) { return !overOracle; }

    function echidna_no_approval_left_standing() external view returns (bool) {
        return budget.allowance(address(gov), address(venue)) == 0 && stock.allowance(address(gov), address(venue)) == 0;
    }

    /// Every dollar that left is a dollar a settled trade spent; every share stayed.
    function echidna_every_dollar_accounted_for() external view returns (bool) {
        return budget.balanceOf(address(gov)) + totalSpent == DEPOSIT && stock.balanceOf(address(gov)) == totalReceived;
    }
}
