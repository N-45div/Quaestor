// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title QuaestorStockGovernor — one agent's allowance for tokenized stocks
/// @notice Don't give your trading agent a wallet. Give it an allowance.
///
/// This is the Solana program (`solana/programs/quaestor-stocks`) on an EVM
/// chain, for Robinhood Chain's Stock Tokens. Each agent gets its own governor:
/// a contract that holds the owner's stablecoin budget and every share the
/// agent buys, so no agent's route can ever reach another agent's money.
///
/// The agent's key can do one thing, `executeTrade`. The contract never parses
/// the route. It approves the venue for exactly the amount the trade may cost,
/// calls it with the agent's calldata, takes the approval back, and then
/// measures its own balances:
///
///   - the budget may have fallen by no more than was authorised,
///   - the shares must have risen by at least the agent's own floor,
///   - and, because a hijacked agent sets that floor itself, the fill must
///     cost no more per share than the owner's limit price.
///
/// A route that keeps the money, sends the shares elsewhere, delivers less, or
/// fills at a price the owner never agreed to reverts the whole transaction.
contract QuaestorStockGovernor {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    struct Instrument {
        bool allowed;
        uint8 decimals; // read from the token when it is approved
        uint128 maxPrice; // budget base units per whole share; 0 = no limit
    }

    /// What the agent asks for. Everything but the venue's calldata is checked
    /// here; the calldata is passed through unread.
    struct Trade {
        bytes32 intentId; // one execution per id, ever
        address venue; // an owner-approved router
        address tokenOut; // an owner-approved Stock Token
        uint256 amountIn; // the most this trade may cost, in budget base units
        uint256 minOut; // the agent's own floor, in share base units
        bytes32 decisionHash; // hash of the agent's reason, re-hashed by the app
        bytes swapData; // the venue's own calldata
    }

    // ---------------------------------------------------------------- state

    address public factory;
    address public owner;
    address public operator;
    address public guardian;
    IERC20 public budgetToken;
    bool public suspended;

    uint64 public epochLength; // seconds
    uint128 public perTradeCap; // budget base units
    uint128 public epochCap; // budget base units
    uint64 public currentEpoch;
    uint128 public spentInEpoch;

    mapping(address => bool) public venueAllowed;
    mapping(address => bytes16) public venueLabel;
    mapping(address => Instrument) public instruments;
    mapping(bytes32 => bool) public intentExecuted;

    uint256 private _lock; // 0 = never initialised, 1 = open, 2 = inside a call
    bool private _setUp;

    // --------------------------------------------------------------- events

    event Initialized(address indexed owner, address indexed operator, address budgetToken, uint64 epochLength);
    event PolicySet(uint128 perTradeCap, uint128 epochCap, uint64 epochLength);
    event OperatorChanged(address indexed operator);
    event GuardianChanged(address indexed guardian);
    event SuspendedSet(bool suspended, address indexed by);
    event VenueSet(address indexed venue, bool allowed, bytes16 label);
    event InstrumentSet(address indexed token, bool allowed, uint8 decimals);
    event PriceLimitSet(address indexed token, uint128 maxPrice);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event TradeExecuted(
        bytes32 indexed intentId,
        address indexed venue,
        address indexed tokenOut,
        uint256 spent,
        uint256 received,
        bytes32 decisionHash,
        uint64 epoch,
        uint128 spentInEpoch
    );

    // --------------------------------------------------------------- errors

    error AlreadyInitialized();
    error NotOwner();
    error NotOperator();
    error NotGuardianOrOwner();
    error Suspended();
    error InvalidPolicy();
    error InvalidAmount();
    error InvalidMinimumOutput();
    error PerTradeCapExceeded(uint256 amount, uint256 cap);
    error EpochCapExceeded(uint256 spent, uint256 cap);
    error InsufficientBudget(uint256 amount, uint256 balance);
    error IntentAlreadyExecuted(bytes32 intentId);
    error VenueNotAllowed(address venue);
    error InvalidVenue(address venue);
    error InstrumentNotAllowed(address token);
    error InvalidInstrument(address token);
    error InvalidRecipient();
    error VenueCallFailed(bytes reason);
    error VaultBalanceIncreased(uint256 before, uint256 afterCall);
    error RouteOverspent(uint256 spent, uint256 authorized);
    error StockBalanceDecreased(uint256 before, uint256 afterCall);
    error MinimumOutputNotMet(uint256 received, uint256 minimum);
    error PriceAboveLimit(uint256 spent, uint256 received, uint256 maxPrice);
    error AllowanceLeftBehind(uint256 allowance);
    error Reentrancy();

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// The implementation behind every clone is never an agent's governor.
    constructor() {
        _lock = 2;
    }

    // ---------------------------------------------------------- the factory

    /// @notice Set up a new governor. Called once, by the factory, in the same
    /// transaction that creates the clone, so nobody can initialise it first.
    function initialize(
        address owner_,
        address operator_,
        address budgetToken_,
        uint64 epochLength_,
        uint128 perTradeCap_,
        uint128 epochCap_
    ) external {
        if (_lock != 0) revert AlreadyInitialized();
        if (owner_ == address(0) || operator_ == address(0) || budgetToken_.code.length == 0) revert InvalidPolicy();
        if (operator_ == owner_) revert InvalidPolicy();
        _lock = 1;
        factory = msg.sender;
        owner = owner_;
        operator = operator_;
        budgetToken = IERC20(budgetToken_);
        _setPolicy(perTradeCap_, epochCap_, epochLength_);
        emit Initialized(owner_, operator_, budgetToken_, epochLength_);
    }

    /// @notice The factory approves the owner's first venues and instruments in
    /// the creating transaction, so the owner signs once. After that only the
    /// owner can change either list.
    function setupFromFactory(
        address[] calldata venues,
        bytes16[] calldata labels,
        address[] calldata tokens,
        uint128[] calldata maxPrices
    ) external {
        if (msg.sender != factory || _lock != 1 || _setUp) revert NotOwner();
        _setUp = true;
        if (venues.length != labels.length || tokens.length != maxPrices.length) revert InvalidPolicy();
        for (uint256 i; i < tokens.length; i++) _setInstrument(tokens[i], true, maxPrices[i]);
        for (uint256 i; i < venues.length; i++) _setVenue(venues[i], true, labels[i]);
    }

    // ------------------------------------------------------------ the owner

    function setPolicy(uint128 perTradeCap_, uint128 epochCap_, uint64 epochLength_) external onlyOwner {
        _setPolicy(perTradeCap_, epochCap_, epochLength_);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0) || operator_ == owner) revert InvalidPolicy();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    /// @notice A guardian may suspend the agent, and do nothing else.
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }

    function setSuspended(bool suspended_) external {
        // Anyone the owner trusts can stop the agent; only the owner can start it again.
        if (suspended_) {
            if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner();
        } else if (msg.sender != owner) {
            revert NotOwner();
        }
        suspended = suspended_;
        emit SuspendedSet(suspended_, msg.sender);
    }

    /// @notice Allow, or stop allowing, a router the budget may be lent to.
    function setVenue(address venue, bool allowed, bytes16 label) external onlyOwner {
        _setVenue(venue, allowed, label);
    }

    /// @notice Allow, or stop allowing, a Stock Token the agent may buy, with
    /// the most the owner will pay for one whole share (0 = no limit).
    function setInstrument(address token, bool allowed, uint128 maxPrice) external onlyOwner {
        _setInstrument(token, allowed, maxPrice);
    }

    /// @notice The owner's limit price for one approved Stock Token.
    function setPriceLimit(address token, uint128 maxPrice) external onlyOwner {
        if (!instruments[token].allowed) revert InstrumentNotAllowed(token);
        instruments[token].maxPrice = maxPrice;
        emit PriceLimitSet(token, maxPrice);
    }

    /// @notice Take out the budget, or shares the agent bought. Works while the
    /// agent is suspended and for a token since revoked: the owner's money is
    /// never trapped by the owner's own settings.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    // --------------------------------------------------------- the operator

    /// @notice Buy an approved Stock Token through an approved venue, inside
    /// the owner's limits. Everything above the venue call is a request;
    /// everything below it is what actually happened, read back from balances.
    function executeTrade(Trade calldata t) external nonReentrant returns (uint256 spent, uint256 received) {
        if (msg.sender != operator) revert NotOperator();
        if (suspended) revert Suspended();
        if (t.amountIn == 0) revert InvalidAmount();
        if (t.minOut == 0) revert InvalidMinimumOutput();
        if (intentExecuted[t.intentId]) revert IntentAlreadyExecuted(t.intentId);
        if (!venueAllowed[t.venue]) revert VenueNotAllowed(t.venue);
        Instrument memory inst = instruments[t.tokenOut];
        if (!inst.allowed) revert InstrumentNotAllowed(t.tokenOut);
        if (t.amountIn > perTradeCap) revert PerTradeCapExceeded(t.amountIn, perTradeCap);

        // Roll the epoch before the cap check, so a trade is measured against
        // the window it actually lands in.
        uint64 epoch = uint64(block.timestamp / epochLength);
        uint128 spentSoFar = epoch == currentEpoch ? spentInEpoch : 0;
        if (spentSoFar + t.amountIn > epochCap) revert EpochCapExceeded(spentSoFar + t.amountIn, epochCap);

        IERC20 budget = budgetToken;
        IERC20 stock = IERC20(t.tokenOut);
        uint256 budgetBefore = budget.balanceOf(address(this));
        if (budgetBefore < t.amountIn) revert InsufficientBudget(t.amountIn, budgetBefore);
        uint256 stockBefore = stock.balanceOf(address(this));

        // The venue is lent exactly what this trade may cost, and nothing is
        // ever approved on a share: a route cannot sell what the agent holds.
        budget.forceApprove(t.venue, t.amountIn);
        (bool ok, bytes memory reason) = t.venue.call(t.swapData);
        if (!ok) revert VenueCallFailed(reason);
        budget.forceApprove(t.venue, 0);
        // A token that ignored the reset would leave the venue a standing claim
        // on the budget, and every balance below would still look right.
        uint256 left = budget.allowance(address(this), t.venue);
        if (left != 0) revert AllowanceLeftBehind(left);

        uint256 budgetAfter = budget.balanceOf(address(this));
        uint256 stockAfter = stock.balanceOf(address(this));
        if (budgetAfter > budgetBefore) revert VaultBalanceIncreased(budgetBefore, budgetAfter);
        spent = budgetBefore - budgetAfter;
        if (spent > t.amountIn) revert RouteOverspent(spent, t.amountIn);

        // Measured as a net movement, so a route that took shares out and put
        // fewer back is a revert, not a purchase that quietly cost a position.
        if (stockAfter < stockBefore) revert StockBalanceDecreased(stockBefore, stockAfter);
        received = stockAfter - stockBefore;
        if (received < t.minOut) revert MinimumOutputNotMet(received, t.minOut);

        // The floor above is the agent's own, so it cannot stop an agent that
        // was talked into overpaying: it sets the floor to one base unit and
        // routes through a pool its attacker priced. The owner's limit price
        // can, and it is checked on what was measured, whatever was promised.
        if (inst.maxPrice != 0 && spent * (10 ** uint256(inst.decimals)) > received * uint256(inst.maxPrice)) {
            revert PriceAboveLimit(spent, received, inst.maxPrice);
        }

        // Charge the epoch what the route took, not what it was allowed to take.
        uint128 spentAfter = spentSoFar + uint128(spent);
        currentEpoch = epoch;
        spentInEpoch = spentAfter;
        intentExecuted[t.intentId] = true;
        emit TradeExecuted(t.intentId, t.venue, t.tokenOut, spent, received, t.decisionHash, epoch, spentAfter);
    }

    // ---------------------------------------------------------------- views

    /// @notice What the agent may still spend this epoch: the smaller of what
    /// the cap leaves and what the budget holds.
    function remainingBudget() external view returns (uint256) {
        uint64 epoch = uint64(block.timestamp / epochLength);
        uint256 spentNow = epoch == currentEpoch ? spentInEpoch : 0;
        uint256 capLeft = spentNow >= epochCap ? 0 : epochCap - spentNow;
        uint256 bal = budgetToken.balanceOf(address(this));
        return capLeft < bal ? capLeft : bal;
    }

    // ------------------------------------------------------------- internals

    function _setPolicy(uint128 perTradeCap_, uint128 epochCap_, uint64 epochLength_) internal {
        if (perTradeCap_ == 0 || epochCap_ < perTradeCap_ || epochLength_ == 0) revert InvalidPolicy();
        // A new epoch length would re-number the windows; start counting afresh.
        if (epochLength_ != epochLength) {
            currentEpoch = uint64(block.timestamp / epochLength_);
            spentInEpoch = 0;
        }
        perTradeCap = perTradeCap_;
        epochCap = epochCap_;
        epochLength = epochLength_;
        emit PolicySet(perTradeCap_, epochCap_, epochLength_);
    }

    /// A venue is lent the budget, so it must be a contract, and never one whose
    /// calldata could move tokens directly: the budget token, an approved share,
    /// or this governor itself.
    function _setVenue(address venue, bool allowed, bytes16 label) internal {
        if (allowed) {
            if (venue.code.length == 0 || venue == address(this) || venue == address(budgetToken) || venue == factory) {
                revert InvalidVenue(venue);
            }
            if (instruments[venue].allowed) revert InvalidVenue(venue);
        }
        venueAllowed[venue] = allowed;
        venueLabel[venue] = allowed ? label : bytes16(0);
        emit VenueSet(venue, allowed, label);
    }

    function _setInstrument(address token, bool allowed, uint128 maxPrice) internal {
        if (allowed) {
            if (token.code.length == 0 || token == address(this) || token == address(budgetToken) || venueAllowed[token]) {
                revert InvalidInstrument(token);
            }
            (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
            if (!ok || data.length < 32) revert InvalidInstrument(token);
            uint256 dec = abi.decode(data, (uint256));
            if (dec > 36) revert InvalidInstrument(token);
            instruments[token] = Instrument({allowed: true, decimals: uint8(dec), maxPrice: maxPrice});
            emit InstrumentSet(token, true, uint8(dec));
            emit PriceLimitSet(token, maxPrice);
        } else {
            // The limit goes with the approval: a token approved again later
            // starts with no limit until the owner sets one.
            delete instruments[token];
            emit InstrumentSet(token, false, 0);
        }
    }
}

/// @title QuaestorStocks — the factory that gives each agent its own governor
/// @notice The owner signs once: a governor, its caps, its venues, its Stock
/// Tokens with their limit prices, and the first deposit.
contract QuaestorStocks {
    using SafeERC20 for IERC20;

    address public immutable implementation;
    address[] public allGovernors;
    mapping(address => address[]) internal _governorsOf;

    event GovernorCreated(address indexed governor, address indexed owner, address indexed operator, address budgetToken, uint256 deposit);

    constructor() {
        implementation = address(new QuaestorStockGovernor());
    }

    struct Setup {
        address operator; // the agent's key
        address budgetToken; // USDG on Robinhood Chain
        uint64 epochLength;
        uint128 perTradeCap;
        uint128 epochCap;
        address[] venues;
        bytes16[] labels;
        address[] tokens;
        uint128[] maxPrices;
        uint256 deposit; // pulled from the owner; needs an approval to this factory first
    }

    function createGovernor(Setup calldata s) external returns (address governor) {
        governor = Clones.clone(implementation);
        QuaestorStockGovernor g = QuaestorStockGovernor(governor);
        g.initialize(msg.sender, s.operator, s.budgetToken, s.epochLength, s.perTradeCap, s.epochCap);
        g.setupFromFactory(s.venues, s.labels, s.tokens, s.maxPrices);
        if (s.deposit > 0) IERC20(s.budgetToken).safeTransferFrom(msg.sender, governor, s.deposit);
        allGovernors.push(governor);
        _governorsOf[msg.sender].push(governor);
        emit GovernorCreated(governor, msg.sender, s.operator, s.budgetToken, s.deposit);
    }

    function governorsOf(address owner) external view returns (address[] memory) {
        return _governorsOf[owner];
    }

    function governorCount() external view returns (uint256) {
        return allGovernors.length;
    }
}
