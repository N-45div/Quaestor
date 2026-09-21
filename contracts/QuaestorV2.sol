// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @title QuaestorV2 — the spend governor, with a venue it does not have to trust
/// @notice Don't give your AI agent a wallet; give it an allowance.
///
/// The first Quaestor took one router, fixed at construction, behind one
/// function signature. That is fine for a demo venue and useless against a real
/// exchange: Uniswap does not have that function, and every new venue would
/// need its own adapter contract deployed and trusted.
///
/// This one works the way the Solana program does, which had the same problem
/// and solved it better. It never parses the route. The operator hands it a
/// target and the bytes to call it with, and the contract:
///
///   1. checks the target is on the owner's venue allowlist,
///   2. checks the token being bought is on the owner's instrument allowlist,
///   3. charges the agent's budget for the spend,
///   4. reads the owner's balance of that token, calls the venue, reads it again,
///   5. reverts the whole transaction unless the treasury gave up no more than
///      was authorised and the owner received at least the promised minimum.
///
/// So a venue is never trusted to be honest, only allowed to be tried. A route
/// that keeps the money, sends the tokens elsewhere, or quietly delivers less
/// than it promised fails on the way out, and the spend never happened.
///
/// Budgets here are denominated in the chain's native unit. On a chain whose gas
/// token is a dollar stablecoin that makes caps dollar caps with no oracle; on
/// Base it makes them ETH caps, and a dollar cap there needs treasuries held in
/// USDC, which this contract does not yet do.
contract QuaestorV2 {
    // ---------------------------------------------------------------- types

    enum Category {
        DATA, // paid API calls (price feeds, market data)
        INFERENCE, // the agent's own LLM calls
        EXECUTION // swaps routed through an approved venue
    }

    struct Policy {
        uint128 epochCap; // max spend per epoch, in wei
        uint128 perCallCap; // max spend per single action, in wei
    }

    struct AgentInfo {
        address owner; // human principal: sets policy, holds the kill-switch
        address operator; // the agent's hot key: can only spend through here
        bool suspended;
        uint40 registeredAt;
        uint32 epochLength; // seconds per budget epoch
        string metadataURI;
    }

    // ---------------------------------------------------------------- state

    uint256 public nextAgentId = 1;

    mapping(uint256 => AgentInfo) public agents;
    /// agentId => a guardian that may suspend, and do nothing else
    mapping(uint256 => address) public guardianOf;
    /// agentId => treasury balance in wei
    mapping(uint256 => uint256) public balanceOf;
    mapping(uint256 => mapping(Category => Policy)) internal _policies;
    mapping(uint256 => mapping(Category => mapping(uint256 => uint256))) public spentIn;

    /// agentId => venue => allowed. The owner's, and only the owner's.
    mapping(uint256 => mapping(address => bool)) public venueAllowed;
    /// agentId => token => allowed. What the agent may end up holding.
    mapping(uint256 => mapping(address => bool)) public instrumentAllowed;

    uint256 private _entered;

    // --------------------------------------------------------------- events

    event AgentRegistered(uint256 indexed agentId, address indexed owner, address indexed operator, uint32 epochLength, string metadataURI);
    event PolicySet(uint256 indexed agentId, Category indexed category, uint128 epochCap, uint128 perCallCap);
    event OperatorChanged(uint256 indexed agentId, address indexed operator);
    event GuardianChanged(uint256 indexed agentId, address indexed guardian);
    event Suspended(uint256 indexed agentId, address indexed by);
    event Resumed(uint256 indexed agentId);
    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event VenueAllowed(uint256 indexed agentId, address indexed venue, bool allowed);
    event InstrumentAllowed(uint256 indexed agentId, address indexed token, bool allowed);
    event Receipt(uint256 indexed agentId, Category indexed category, address indexed payee, uint256 amount, bytes32 metaHash, uint256 epoch, uint256 epochSpentAfter);
    event SwapExecuted(uint256 indexed agentId, address indexed venue, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    // --------------------------------------------------------------- errors

    error NotOwner();
    error NotOperator();
    error NotGuardianOrOwner();
    error UnknownAgent();
    error AgentIsSuspended();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidEpochLength();
    error PerCallCapExceeded(uint256 amount, uint256 cap);
    error EpochCapExceeded(uint256 spent, uint256 cap);
    error InsufficientTreasury(uint256 amount, uint256 balance);
    error VenueNotAllowed(address venue);
    error InstrumentNotAllowed(address token);
    error VenueCallFailed(bytes reason);
    error RouteOverspent(uint256 spent, uint256 authorized);
    error MinimumOutputNotMet(uint256 received, uint256 minimum);
    error Reentrancy();

    // ------------------------------------------------------------ modifiers

    modifier exists(uint256 agentId) {
        if (agents[agentId].owner == address(0)) revert UnknownAgent();
        _;
    }

    modifier onlyOwner(uint256 agentId) {
        if (msg.sender != agents[agentId].owner) revert NotOwner();
        _;
    }

    modifier onlyOperator(uint256 agentId) {
        if (msg.sender != agents[agentId].operator) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @notice Take back change from a venue, and nothing else.
    /// @dev Only while a call is in flight. Outside one there is no agent to
    /// credit ether to, so accepting it would leave money here owned by nobody.
    receive() external payable {
        if (_entered != 1) revert ZeroAddress();
    }

    // ------------------------------------------------------------ the owner

    function registerAgent(
        address operator,
        uint32 epochLength,
        string calldata metadataURI
    ) external payable returns (uint256 agentId) {
        if (operator == address(0)) revert ZeroAddress();
        if (epochLength == 0) revert InvalidEpochLength();
        agentId = nextAgentId++;
        agents[agentId] = AgentInfo({
            owner: msg.sender,
            operator: operator,
            suspended: false,
            registeredAt: uint40(block.timestamp),
            epochLength: epochLength,
            metadataURI: metadataURI
        });
        if (msg.value > 0) {
            balanceOf[agentId] = msg.value;
            emit Deposited(agentId, msg.sender, msg.value);
        }
        emit AgentRegistered(agentId, msg.sender, operator, epochLength, metadataURI);
    }

    function setPolicy(
        uint256 agentId,
        Category category,
        uint128 epochCap,
        uint128 perCallCap
    ) external exists(agentId) onlyOwner(agentId) {
        _policies[agentId][category] = Policy({epochCap: epochCap, perCallCap: perCallCap});
        emit PolicySet(agentId, category, epochCap, perCallCap);
    }

    function setOperator(uint256 agentId, address operator) external exists(agentId) onlyOwner(agentId) {
        if (operator == address(0)) revert ZeroAddress();
        agents[agentId].operator = operator;
        emit OperatorChanged(agentId, operator);
    }

    function setGuardian(uint256 agentId, address guardian) external exists(agentId) onlyOwner(agentId) {
        guardianOf[agentId] = guardian;
        emit GuardianChanged(agentId, guardian);
    }

    /// @notice Allow, or stop allowing, a venue this agent's funds may be sent to.
    /// @dev Only the owner. The operator picks between venues; it cannot add one.
    function setVenue(uint256 agentId, address venue, bool allowed) external exists(agentId) onlyOwner(agentId) {
        if (venue == address(0)) revert ZeroAddress();
        venueAllowed[agentId][venue] = allowed;
        emit VenueAllowed(agentId, venue, allowed);
    }

    /// @notice Allow, or stop allowing, a token this agent may buy.
    /// @dev Without this a route could satisfy the output check by delivering a
    /// worthless token it controls, which measuring alone cannot tell apart.
    function setInstrument(uint256 agentId, address token, bool allowed) external exists(agentId) onlyOwner(agentId) {
        if (token == address(0)) revert ZeroAddress();
        instrumentAllowed[agentId][token] = allowed;
        emit InstrumentAllowed(agentId, token, allowed);
    }

    function deposit(uint256 agentId) external payable exists(agentId) {
        if (msg.value == 0) revert ZeroAmount();
        balanceOf[agentId] += msg.value;
        emit Deposited(agentId, msg.sender, msg.value);
    }

    function withdraw(uint256 agentId, uint256 amount, address payable to) external exists(agentId) onlyOwner(agentId) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[agentId];
        if (amount > bal) revert InsufficientTreasury(amount, bal);
        balanceOf[agentId] = bal - amount;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert VenueCallFailed("");
        emit Withdrawn(agentId, to, amount);
    }

    function suspend(uint256 agentId) external exists(agentId) {
        if (msg.sender != agents[agentId].owner && msg.sender != guardianOf[agentId]) revert NotGuardianOrOwner();
        agents[agentId].suspended = true;
        emit Suspended(agentId, msg.sender);
    }

    function resume(uint256 agentId) external exists(agentId) onlyOwner(agentId) {
        agents[agentId].suspended = false;
        emit Resumed(agentId);
    }

    // --------------------------------------------------------- the operator

    /// @notice Pay for a service out of a non-execution budget.
    function pay(
        uint256 agentId,
        Category category,
        address payable payee,
        uint256 amount,
        bytes32 metaHash
    ) external exists(agentId) onlyOperator(agentId) nonReentrant {
        if (category == Category.EXECUTION) revert InstrumentNotAllowed(address(0));
        if (payee == address(0)) revert ZeroAddress();
        uint256 epochSpentAfter = _authorize(agentId, category, amount);
        (bool ok, ) = payee.call{value: amount}("");
        if (!ok) revert VenueCallFailed("");
        emit Receipt(agentId, category, payee, amount, metaHash, currentEpoch(agentId), epochSpentAfter);
    }

    /// @notice Buy `tokenOut` through `venue`, inside the EXECUTION budget.
    ///
    /// @param swapData the venue's own calldata, built by the caller. This
    ///        contract never reads it: what bounds the trade is how much may
    ///        leave and what must arrive, both measured here, not what the
    ///        bytes claim. The output must reach the agent's owner, whoever the
    ///        calldata names, or the measurement below fails.
    function swap(
        uint256 agentId,
        address venue,
        bytes calldata swapData,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes32 metaHash
    ) external exists(agentId) onlyOperator(agentId) nonReentrant returns (uint256 amountOut) {
        if (!venueAllowed[agentId][venue]) revert VenueNotAllowed(venue);
        if (!instrumentAllowed[agentId][tokenOut]) revert InstrumentNotAllowed(tokenOut);
        if (minOut == 0) revert ZeroAmount();

        address owner = agents[agentId].owner;
        uint256 epochSpentAfter = _authorize(agentId, Category.EXECUTION, amountIn);

        uint256 tokensBefore = IERC20(tokenOut).balanceOf(owner);
        uint256 ethBefore = address(this).balance;

        (bool ok, bytes memory reason) = venue.call{value: amountIn}(swapData);
        if (!ok) revert VenueCallFailed(reason);

        // What actually left. A venue that returns change is charged for what
        // it kept, not for what it was handed; one that took more than it was
        // authorised to reverts, whatever it reports.
        uint256 ethAfter = address(this).balance;
        uint256 spent = ethBefore > ethAfter ? ethBefore - ethAfter : 0;
        if (spent > amountIn) revert RouteOverspent(spent, amountIn);

        amountOut = IERC20(tokenOut).balanceOf(owner) - tokensBefore;
        if (amountOut < minOut) revert MinimumOutputNotMet(amountOut, minOut);

        if (spent < amountIn) {
            uint256 change = amountIn - spent;
            balanceOf[agentId] += change;
            uint256 epoch = currentEpoch(agentId);
            spentIn[agentId][Category.EXECUTION][epoch] -= change;
            epochSpentAfter -= change;
        }

        emit Receipt(agentId, Category.EXECUTION, venue, spent, metaHash, currentEpoch(agentId), epochSpentAfter);
        emit SwapExecuted(agentId, venue, tokenOut, spent, amountOut);
    }

    // ---------------------------------------------------------------- views

    function policyOf(uint256 agentId, Category category) external view returns (uint128 epochCap, uint128 perCallCap) {
        Policy storage p = _policies[agentId][category];
        return (p.epochCap, p.perCallCap);
    }

    function currentEpoch(uint256 agentId) public view returns (uint256) {
        AgentInfo storage info = agents[agentId];
        if (info.owner == address(0)) revert UnknownAgent();
        return (block.timestamp - info.registeredAt) / info.epochLength;
    }

    function remainingBudget(uint256 agentId, Category category) external view returns (uint256) {
        Policy storage p = _policies[agentId][category];
        uint256 spent = spentIn[agentId][category][currentEpoch(agentId)];
        uint256 left = spent >= p.epochCap ? 0 : p.epochCap - spent;
        uint256 bal = balanceOf[agentId];
        return left < bal ? left : bal;
    }

    // ------------------------------------------------------------- internals

    function _authorize(
        uint256 agentId,
        Category category,
        uint256 amount
    ) internal returns (uint256 epochSpentAfter) {
        if (amount == 0) revert ZeroAmount();

        AgentInfo storage info = agents[agentId];
        if (info.suspended) revert AgentIsSuspended();

        Policy storage p = _policies[agentId][category];
        if (amount > p.perCallCap) revert PerCallCapExceeded(amount, p.perCallCap);

        uint256 epoch = (block.timestamp - info.registeredAt) / info.epochLength;
        uint256 spent = spentIn[agentId][category][epoch] + amount;
        if (spent > p.epochCap) revert EpochCapExceeded(spent, p.epochCap);

        uint256 bal = balanceOf[agentId];
        if (amount > bal) revert InsufficientTreasury(amount, bal);

        spentIn[agentId][category][epoch] = spent;
        balanceOf[agentId] = bal - amount;
        return spent;
    }
}
