// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal router interface Quaestor uses to execute governed swaps.
/// On X Layer testnet this is a mock; on mainnet it adapts to the OKX DEX router.
interface IQuaestorRouter {
    function swapExactNativeForTokens(
        uint256 minOut,
        address tokenOut,
        address to
    ) external payable returns (uint256 amountOut);
}

/// @title Quaestor — the on-chain spend governor for AI agents
/// @notice Don't give your AI agent a wallet; give it an allowance.
///
/// An agent owner registers an agent, funds its treasury with native OKB, and
/// sets hard budgets per spend category. The agent's operator key can then pay
/// for services (DATA / INFERENCE) or execute swaps (EXECUTION) only through
/// this contract. Every spend within budget settles instantly and emits a
/// permanent Receipt carrying a hash of the decision context. Overspend
/// reverts at the chain level. The owner can freeze the agent in one tx.
contract Quaestor {
    // ---------------------------------------------------------------- types

    enum Category {
        DATA, // paid API calls (price feeds, market data)
        INFERENCE, // the agent's own LLM calls
        EXECUTION // swaps routed through the DEX
    }

    struct Policy {
        uint128 epochCap; // max spend per epoch, in wei of OKB
        uint128 perCallCap; // max spend per single action, in wei of OKB
    }

    struct AgentInfo {
        address owner; // human principal: sets policy, holds kill-switch
        address operator; // the agent's hot key: can only spend via Quaestor
        bool suspended;
        uint40 registeredAt;
        uint32 epochLength; // seconds per budget epoch (e.g. 1 day)
        string metadataURI; // agent name / manifest
    }

    // ---------------------------------------------------------------- state

    IQuaestorRouter public immutable router;

    uint256 public nextAgentId = 1;

    mapping(uint256 => AgentInfo) public agents;
    /// agentId => optional guardian: may suspend (and nothing else) — gives an
    /// automated watchdog teeth without ever holding custody
    mapping(uint256 => address) public guardianOf;
    /// agentId => treasury balance in wei of OKB
    mapping(uint256 => uint256) public balanceOf;
    /// agentId => category => policy
    mapping(uint256 => mapping(Category => Policy)) internal _policies;
    /// agentId => category => epoch index => spent in that epoch
    mapping(uint256 => mapping(Category => mapping(uint256 => uint256)))
        public spentIn;

    uint256 private _lock = 1;

    // --------------------------------------------------------------- events

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        address operator,
        uint32 epochLength,
        string metadataURI
    );
    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event PolicySet(
        uint256 indexed agentId,
        Category indexed category,
        uint128 epochCap,
        uint128 perCallCap
    );
    event OperatorSet(uint256 indexed agentId, address operator);
    event GuardianSet(uint256 indexed agentId, address guardian);
    event Suspended(uint256 indexed agentId, address by);
    event Resumed(uint256 indexed agentId);

    /// @notice One receipt per authorized spend. `metaHash` is the keccak256
    /// of the off-chain decision record (prompt hash, tool, model, rationale).
    event Receipt(
        uint256 indexed agentId,
        Category indexed category,
        address payee,
        uint256 amount,
        bytes32 metaHash,
        uint256 epoch,
        uint256 epochSpentAfter
    );
    event SwapExecuted(
        uint256 indexed agentId,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    // --------------------------------------------------------------- errors

    error UnknownAgent();
    error NotOwner();
    error NotOwnerOrGuardian();
    error NotOperator();
    error AgentIsSuspended();
    error InvalidCategory();
    error ZeroAmount();
    error ZeroAddress();
    error PerCallCapExceeded(uint256 amount, uint256 cap);
    error EpochCapExceeded(uint256 wouldBeSpent, uint256 cap);
    error InsufficientTreasury(uint256 amount, uint256 balance);
    error TransferFailed();
    error Reentrancy();

    // ------------------------------------------------------------ modifiers

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

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

    // ---------------------------------------------------------- construction

    constructor(IQuaestorRouter router_) {
        router = router_;
    }

    // ------------------------------------------------------- agent lifecycle

    /// @notice Register an agent, optionally funding its treasury with msg.value.
    function registerAgent(
        address operator,
        uint32 epochLength,
        string calldata metadataURI,
        Policy calldata dataPolicy,
        Policy calldata inferencePolicy,
        Policy calldata executionPolicy
    ) external payable returns (uint256 agentId) {
        if (operator == address(0)) revert ZeroAddress();
        if (epochLength == 0) revert ZeroAmount();

        agentId = nextAgentId++;
        agents[agentId] = AgentInfo({
            owner: msg.sender,
            operator: operator,
            suspended: false,
            registeredAt: uint40(block.timestamp),
            epochLength: epochLength,
            metadataURI: metadataURI
        });
        _policies[agentId][Category.DATA] = dataPolicy;
        _policies[agentId][Category.INFERENCE] = inferencePolicy;
        _policies[agentId][Category.EXECUTION] = executionPolicy;

        emit AgentRegistered(agentId, msg.sender, operator, epochLength, metadataURI);
        emit PolicySet(agentId, Category.DATA, dataPolicy.epochCap, dataPolicy.perCallCap);
        emit PolicySet(
            agentId,
            Category.INFERENCE,
            inferencePolicy.epochCap,
            inferencePolicy.perCallCap
        );
        emit PolicySet(
            agentId,
            Category.EXECUTION,
            executionPolicy.epochCap,
            executionPolicy.perCallCap
        );

        if (msg.value > 0) {
            balanceOf[agentId] = msg.value;
            emit Deposited(agentId, msg.sender, msg.value);
        }
    }

    /// @notice Anyone may fund an agent's treasury.
    function deposit(uint256 agentId) external payable exists(agentId) {
        if (msg.value == 0) revert ZeroAmount();
        balanceOf[agentId] += msg.value;
        emit Deposited(agentId, msg.sender, msg.value);
    }

    function withdraw(
        uint256 agentId,
        uint256 amount,
        address to
    ) external exists(agentId) onlyOwner(agentId) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[agentId];
        if (amount > bal) revert InsufficientTreasury(amount, bal);
        balanceOf[agentId] = bal - amount;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(agentId, to, amount);
    }

    function setPolicy(
        uint256 agentId,
        Category category,
        Policy calldata policy
    ) external exists(agentId) onlyOwner(agentId) {
        _policies[agentId][category] = policy;
        emit PolicySet(agentId, category, policy.epochCap, policy.perCallCap);
    }

    function setOperator(
        uint256 agentId,
        address operator
    ) external exists(agentId) onlyOwner(agentId) {
        if (operator == address(0)) revert ZeroAddress();
        agents[agentId].operator = operator;
        emit OperatorSet(agentId, operator);
    }

    /// @notice Appoint (or clear, with address(0)) a guardian. A guardian can
    /// ONLY suspend — never spend, withdraw, resume, or change policy.
    function setGuardian(
        uint256 agentId,
        address guardian
    ) external exists(agentId) onlyOwner(agentId) {
        guardianOf[agentId] = guardian;
        emit GuardianSet(agentId, guardian);
    }

    /// @notice Kill-switch: freezes all spending for the agent in one tx.
    /// Callable by the owner or the appointed guardian.
    function suspend(uint256 agentId) external exists(agentId) {
        if (msg.sender != agents[agentId].owner && msg.sender != guardianOf[agentId]) {
            revert NotOwnerOrGuardian();
        }
        agents[agentId].suspended = true;
        emit Suspended(agentId, msg.sender);
    }

    function resume(uint256 agentId) external exists(agentId) onlyOwner(agentId) {
        agents[agentId].suspended = false;
        emit Resumed(agentId);
    }

    // -------------------------------------------------------------- spending

    /// @notice Pay a service provider for DATA or INFERENCE, within budget.
    /// @param metaHash keccak256 of the off-chain decision record for this spend.
    function pay(
        uint256 agentId,
        Category category,
        address payable payee,
        uint256 amount,
        bytes32 metaHash
    ) external exists(agentId) onlyOperator(agentId) nonReentrant {
        if (category == Category.EXECUTION) revert InvalidCategory();
        if (payee == address(0)) revert ZeroAddress();

        uint256 epochSpentAfter = _authorize(agentId, category, amount);

        (bool ok, ) = payee.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Receipt(
            agentId,
            category,
            payee,
            amount,
            metaHash,
            currentEpoch(agentId),
            epochSpentAfter
        );
    }

    /// @notice Execute a governed swap (EXECUTION budget) via the router.
    /// Output tokens are delivered to the agent's owner.
    function swap(
        uint256 agentId,
        uint256 amountIn,
        uint256 minOut,
        address tokenOut,
        bytes32 metaHash
    )
        external
        exists(agentId)
        onlyOperator(agentId)
        nonReentrant
        returns (uint256 amountOut)
    {
        uint256 epochSpentAfter = _authorize(agentId, Category.EXECUTION, amountIn);

        AgentInfo storage info = agents[agentId];
        amountOut = router.swapExactNativeForTokens{value: amountIn}(
            minOut,
            tokenOut,
            info.owner
        );

        emit Receipt(
            agentId,
            Category.EXECUTION,
            address(router),
            amountIn,
            metaHash,
            currentEpoch(agentId),
            epochSpentAfter
        );
        emit SwapExecuted(agentId, tokenOut, amountIn, amountOut);
    }

    // ---------------------------------------------------------------- views

    function policyOf(
        uint256 agentId,
        Category category
    ) external view returns (Policy memory) {
        return _policies[agentId][category];
    }

    /// @notice Epoch index for an agent; budgets reset every epochLength seconds.
    function currentEpoch(uint256 agentId) public view returns (uint256) {
        AgentInfo storage info = agents[agentId];
        return (block.timestamp - info.registeredAt) / info.epochLength;
    }

    /// @notice Remaining budget for a category in the current epoch,
    /// additionally bounded by the treasury balance.
    function remainingBudget(
        uint256 agentId,
        Category category
    ) external view returns (uint256) {
        Policy storage p = _policies[agentId][category];
        uint256 spent = spentIn[agentId][category][currentEpoch(agentId)];
        uint256 left = p.epochCap > spent ? p.epochCap - spent : 0;
        uint256 bal = balanceOf[agentId];
        return left < bal ? left : bal;
    }

    // ------------------------------------------------------------- internals

    /// @dev Checks suspension, caps, and treasury; records the spend.
    /// Returns the category's epoch spend after this action.
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
