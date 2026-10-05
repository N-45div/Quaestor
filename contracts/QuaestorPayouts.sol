// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title QuaestorPayoutGovernor — one business's allowance for an AI operator that pays people
/// @notice Don't give your operator a wallet. Give it an allowance.
///
/// A business funds this contract in USDC and names an operator: the AI agent's key. The agent
/// runs the business's paid work — creators, contributors, vendors — and decides who to pay, how
/// much and when. The contract decides what it may do alone:
///
///   - a payment needs a deal first: payee, amount, deadline and the hash of the agreed terms,
///     with the money set aside (escrowed) when the deal opens;
///   - a deal over the per-deal cap, or a stranger's deal over the new-payee cap, waits for the
///     owner, who approves it or lets it lapse;
///   - the agent may add new payees, but only a few per period, and a payee the owner has not
///     vetted can receive no more than the new-payee cap in a period;
///   - a release names the proof of delivery, and a proof pays once, ever;
///   - releases the agent makes alone stay inside the period cap;
///   - the agent can never pay itself, and only the owner can take money out.
///
/// Every step carries a decision hash: the hash of the agent's reason, which the app re-hashes
/// against the record it published, so the log of why each dollar moved can be checked.
contract QuaestorPayoutGovernor {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    enum DealState {
        None,
        Pending, // over the agent's limits: waits for the owner
        Open, // escrowed; releases may be made against it
        Closed, // fully paid
        Cancelled // cancelled or lapsed; what was escrowed is free again
    }

    struct Payee {
        bool allowed;
        bool vetted; // the owner has vetted this payee: `cap` applies instead of the new-payee cap
        bool blocked; // the owner removed this payee: the operator cannot add them back
        uint128 cap; // most a vetted payee may receive per period; 0 = no per-payee cap
        uint64 epoch; // the period `paidInEpoch` belongs to
        uint128 paidInEpoch;
    }

    struct Deal {
        address payee;
        DealState state;
        bool ownerApproved;
        uint64 expiresAt;
        uint128 amount; // escrowed while open
        uint128 released;
        bytes32 termsHash; // hash of the agreed terms (brief, rate, milestones)
    }

    /// The longest a deal may stay open; a forgotten deal lapses and frees its escrow.
    uint64 public constant MAX_DEAL_LENGTH = 90 days;

    // ---------------------------------------------------------------- state

    address public factory;
    address public owner;
    address public operator;
    address public guardian;
    IERC20 public token;
    uint8 public tokenDecimals;
    bool public suspended;

    uint64 public epochLength; // seconds
    uint128 public perDealCap; // the largest deal the agent may open alone
    uint128 public epochCap; // the most the agent may release alone per period
    uint128 public newPayeeCap; // the most an unvetted payee may receive per period, and per deal alone
    uint32 public newPayeesPerEpoch; // how many payees the agent may add per period

    uint64 public currentEpoch;
    uint128 public paidInEpoch; // released without the owner's approval this period
    uint32 public payeesAddedInEpoch;
    uint256 public committed; // escrowed in open deals

    mapping(address => Payee) public payees;
    mapping(bytes32 => Deal) public deals;
    mapping(bytes32 => bool) public proofUsed;

    uint256 private _lock; // 0 = never initialised, 1 = open, 2 = inside a call

    // --------------------------------------------------------------- events

    event Initialized(address indexed owner, address indexed operator, address token, uint64 epochLength);
    event LimitsSet(uint128 perDealCap, uint128 epochCap, uint128 newPayeeCap, uint32 newPayeesPerEpoch, uint64 epochLength);
    event OperatorChanged(address indexed operator);
    event GuardianChanged(address indexed guardian);
    event SuspendedSet(bool suspended, address indexed by);
    event PayeeSet(address indexed payee, bool allowed, bool vetted, uint128 cap, address indexed by, bytes32 decisionHash);
    event DealOpened(bytes32 indexed dealId, address indexed payee, uint128 amount, uint64 expiresAt, bytes32 termsHash, bool pending, bytes32 decisionHash);
    event DealApproved(bytes32 indexed dealId, uint128 amount);
    event DealCancelled(bytes32 indexed dealId, uint128 unreleased, address indexed by, bytes32 decisionHash);
    event Released(
        bytes32 indexed dealId,
        address indexed payee,
        uint128 amount,
        bytes32 proofHash,
        bytes32 decisionHash,
        uint64 epoch,
        uint128 paidInEpoch
    );
    event Withdrawn(address indexed to, uint256 amount);

    // --------------------------------------------------------------- errors

    error AlreadyInitialized();
    error NotOwner();
    error NotOperator();
    error NotOwnerOrOperator();
    error NotGuardianOrOwner();
    error Suspended();
    error InvalidPolicy();
    error InvalidPayee(address payee);
    error PayeeNotAllowed(address payee);
    error PayeeBlocked(address payee);
    error NewPayeeLimitReached(uint32 limit);
    error InvalidAmount();
    error InvalidDeadline(uint64 expiresAt);
    error DealExists(bytes32 dealId);
    error DealNotPending(bytes32 dealId);
    error DealNotOpen(bytes32 dealId);
    error DealExpired(bytes32 dealId, uint64 expiresAt);
    error DealNotExpired(bytes32 dealId, uint64 expiresAt);
    error OverDeal(uint256 amount, uint256 remaining);
    error InsufficientFreeBalance(uint256 amount, uint256 free);
    error EpochCapExceeded(uint256 paid, uint256 cap);
    error PayeeCapExceeded(address payee, uint256 paid, uint256 cap);
    error ProofAlreadyUsed(bytes32 proofHash);
    error MissingProof();
    error TransferMismatch(uint256 sent, uint256 received, uint256 expected);
    error Reentrancy();

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// Every function that changes state takes this lock, including the token transfer.
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// The implementation behind every clone is never a business's governor.
    constructor() {
        _lock = 2;
    }

    // ---------------------------------------------------------- the factory

    /// @notice Set up a new governor. Called once, by the factory, in the transaction that
    /// creates the clone, so nobody can initialise it first.
    function initialize(
        address owner_,
        address operator_,
        address token_,
        uint64 epochLength_,
        uint128 perDealCap_,
        uint128 epochCap_,
        uint128 newPayeeCap_,
        uint32 newPayeesPerEpoch_
    ) external {
        if (_lock != 0) revert AlreadyInitialized();
        if (owner_ == address(0) || operator_ == address(0) || operator_ == owner_ || token_.code.length == 0) revert InvalidPolicy();
        _lock = 1;
        factory = msg.sender;
        owner = owner_;
        operator = operator_;
        token = IERC20(token_);
        tokenDecimals = _decimalsOf(token_);
        _setLimits(perDealCap_, epochCap_, newPayeeCap_, newPayeesPerEpoch_, epochLength_);
        emit Initialized(owner_, operator_, token_, epochLength_);
    }

    /// @notice The owner's first vetted payees, set in the creating transaction.
    function setupFromFactory(address[] calldata payees_, uint128[] calldata caps) external {
        if (msg.sender != factory || _lock != 1) revert NotOwner();
        if (payees_.length != caps.length) revert InvalidPolicy();
        for (uint256 i; i < payees_.length; i++) _setPayee(payees_[i], true, true, caps[i], bytes32(0));
        factory = address(0); // once only
    }

    // ------------------------------------------------------------ the owner

    function setLimits(uint128 perDealCap_, uint128 epochCap_, uint128 newPayeeCap_, uint32 newPayeesPerEpoch_, uint64 epochLength_)
        external
        onlyOwner
        nonReentrant
    {
        _setLimits(perDealCap_, epochCap_, newPayeeCap_, newPayeesPerEpoch_, epochLength_);
    }

    function setOperator(address operator_) external onlyOwner nonReentrant {
        if (operator_ == address(0) || operator_ == owner) revert InvalidPolicy();
        if (payees[operator_].allowed) revert InvalidPayee(operator_);
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    /// @notice A guardian may suspend the operator, and do nothing else; zero removes it.
    // slither-disable-next-line missing-zero-check
    function setGuardian(address guardian_) external onlyOwner nonReentrant {
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }

    function setSuspended(bool suspended_) external nonReentrant {
        // Anyone the owner trusts can stop the operator; only the owner can start it again.
        if (suspended_) {
            if (msg.sender != owner && msg.sender != guardian) revert NotGuardianOrOwner();
        } else if (msg.sender != owner) {
            revert NotOwner();
        }
        suspended = suspended_;
        emit SuspendedSet(suspended_, msg.sender);
    }

    /// @notice Vet a payee (and set what they may receive per period), or remove one; a payee
    /// the owner removes stays out until the owner allows them again.
    function setPayee(address payee, bool allowed, bool vetted, uint128 cap) external onlyOwner nonReentrant {
        _setPayee(payee, allowed, vetted, cap, bytes32(0));
        payees[payee].blocked = !allowed;
    }

    /// @notice Approve a deal the operator could not open alone; its amount is escrowed now.
    function approveDeal(bytes32 dealId) external onlyOwner nonReentrant {
        Deal storage d = deals[dealId];
        if (d.state != DealState.Pending) revert DealNotPending(dealId);
        if (block.timestamp >= d.expiresAt) revert DealExpired(dealId, d.expiresAt);
        if (!payees[d.payee].allowed) revert PayeeNotAllowed(d.payee);
        uint256 free = freeBalance();
        if (d.amount > free) revert InsufficientFreeBalance(d.amount, free);
        d.state = DealState.Open;
        d.ownerApproved = true;
        committed += d.amount;
        emit DealApproved(dealId, d.amount);
    }

    /// @notice Take out money no open deal has set aside.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidPayee(to);
        uint256 free = freeBalance();
        if (amount == 0 || amount > free) revert InsufficientFreeBalance(amount, free);
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // --------------------------------------------------------- the operator

    /// @notice Add a payee the owner has not vetted: a few per period, each capped at the
    /// new-payee cap until the owner vets them.
    function addPayee(address payee, bytes32 decisionHash) external onlyOperator nonReentrant {
        if (suspended) revert Suspended();
        if (payees[payee].allowed) return;
        if (payees[payee].blocked) revert PayeeBlocked(payee);
        _rollEpoch();
        if (payeesAddedInEpoch >= newPayeesPerEpoch) revert NewPayeeLimitReached(newPayeesPerEpoch);
        payeesAddedInEpoch += 1;
        _setPayee(payee, true, false, 0, decisionHash);
    }

    /// @notice Agree a deal and set its money aside. A deal over the operator's limits waits
    /// for the owner instead, and nothing is escrowed until they approve it.
    function openDeal(bytes32 dealId, address payee, uint128 amount, uint64 expiresAt, bytes32 termsHash, bytes32 decisionHash)
        external
        onlyOperator
        nonReentrant
    {
        if (suspended) revert Suspended();
        if (deals[dealId].state != DealState.None) revert DealExists(dealId);
        Payee storage p = payees[payee];
        if (!p.allowed) revert PayeeNotAllowed(payee);
        if (amount == 0) revert InvalidAmount();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_DEAL_LENGTH) revert InvalidDeadline(expiresAt);

        bool pending = amount > perDealCap || (!p.vetted && amount > newPayeeCap);
        if (!pending) {
            uint256 free = freeBalance();
            if (amount > free) revert InsufficientFreeBalance(amount, free);
            committed += amount;
        }
        deals[dealId] = Deal({
            payee: payee,
            state: pending ? DealState.Pending : DealState.Open,
            ownerApproved: false,
            expiresAt: expiresAt,
            amount: amount,
            released: 0,
            termsHash: termsHash
        });
        emit DealOpened(dealId, payee, amount, expiresAt, termsHash, pending, decisionHash);
    }

    /// @notice Pay a deal's payee against a proof of delivery. The proof pays once, ever.
    function release(bytes32 dealId, uint128 amount, bytes32 proofHash, bytes32 decisionHash) external onlyOperator nonReentrant {
        if (suspended) revert Suspended();
        Deal storage d = deals[dealId];
        if (d.state != DealState.Open) revert DealNotOpen(dealId);
        if (block.timestamp >= d.expiresAt) revert DealExpired(dealId, d.expiresAt);
        if (amount == 0) revert InvalidAmount();
        uint128 remaining = d.amount - d.released;
        if (amount > remaining) revert OverDeal(amount, remaining);
        if (proofHash == bytes32(0)) revert MissingProof();
        if (proofUsed[proofHash]) revert ProofAlreadyUsed(proofHash);
        address payee = d.payee;
        Payee storage p = payees[payee];
        if (!p.allowed) revert PayeeNotAllowed(payee);

        _rollEpoch();
        if (p.epoch != currentEpoch) {
            p.epoch = currentEpoch;
            p.paidInEpoch = 0;
        }
        // What the owner approved, the owner approved; the caps bound what the operator does alone.
        if (!d.ownerApproved) {
            if (paidInEpoch + amount > epochCap) revert EpochCapExceeded(paidInEpoch + amount, epochCap);
            uint256 payeeCap = p.vetted ? p.cap : newPayeeCap;
            if (payeeCap != 0 && p.paidInEpoch + amount > payeeCap) revert PayeeCapExceeded(payee, p.paidInEpoch + amount, payeeCap);
            paidInEpoch += amount;
        }
        p.paidInEpoch += amount;
        proofUsed[proofHash] = true;
        d.released += amount;
        committed -= amount;
        if (d.released == d.amount) d.state = DealState.Closed;

        // Measured, not assumed: exactly `amount` leaves, and exactly `amount` arrives.
        uint256 fromBefore = token.balanceOf(address(this));
        uint256 toBefore = token.balanceOf(payee);
        token.safeTransfer(payee, amount);
        uint256 sent = fromBefore - token.balanceOf(address(this));
        uint256 got = token.balanceOf(payee) - toBefore;
        if (sent != amount || got != amount) revert TransferMismatch(sent, got, amount);

        emit Released(dealId, payee, amount, proofHash, decisionHash, currentEpoch, paidInEpoch);
    }

    // ------------------------------------------------------ either, or anyone

    /// @notice The owner or the operator can cancel a deal; what was escrowed is free again.
    function cancelDeal(bytes32 dealId, bytes32 decisionHash) external nonReentrant {
        if (msg.sender != owner && msg.sender != operator) revert NotOwnerOrOperator();
        _cancel(dealId, decisionHash);
    }

    /// @notice Anyone can lapse a deal past its deadline, freeing its escrow.
    function expire(bytes32 dealId) external nonReentrant {
        Deal storage d = deals[dealId];
        if (block.timestamp < d.expiresAt) revert DealNotExpired(dealId, d.expiresAt);
        _cancel(dealId, bytes32(0));
    }

    // -------------------------------------------------------------- reads

    /// @notice Money no open deal has set aside: what the operator may still commit.
    function freeBalance() public view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal > committed ? bal - committed : 0;
    }

    function dealOf(bytes32 dealId) external view returns (Deal memory) {
        return deals[dealId];
    }

    function payeeOf(address payee) external view returns (Payee memory) {
        return payees[payee];
    }

    // ------------------------------------------------------------ internals

    function _cancel(bytes32 dealId, bytes32 decisionHash) internal {
        Deal storage d = deals[dealId];
        if (d.state != DealState.Open && d.state != DealState.Pending) revert DealNotOpen(dealId);
        uint128 unreleased = d.amount - d.released;
        if (d.state == DealState.Open) committed -= unreleased;
        d.state = DealState.Cancelled;
        emit DealCancelled(dealId, unreleased, msg.sender, decisionHash);
    }

    function _setPayee(address payee, bool allowed, bool vetted, uint128 cap, bytes32 decisionHash) internal {
        // The operator can never be paid, and the governor never pays itself.
        if (payee == address(0) || payee == operator || payee == address(this)) revert InvalidPayee(payee);
        Payee storage p = payees[payee];
        p.allowed = allowed;
        p.vetted = allowed && vetted;
        p.cap = cap;
        emit PayeeSet(payee, allowed, p.vetted, cap, msg.sender, decisionHash);
    }

    function _setLimits(uint128 perDealCap_, uint128 epochCap_, uint128 newPayeeCap_, uint32 newPayeesPerEpoch_, uint64 epochLength_) internal {
        if (epochLength_ == 0 || epochCap_ == 0 || perDealCap_ > epochCap_ || newPayeeCap_ > perDealCap_) revert InvalidPolicy();
        perDealCap = perDealCap_;
        epochCap = epochCap_;
        newPayeeCap = newPayeeCap_;
        newPayeesPerEpoch = newPayeesPerEpoch_;
        epochLength = epochLength_;
        emit LimitsSet(perDealCap_, epochCap_, newPayeeCap_, newPayeesPerEpoch_, epochLength_);
    }

    function _rollEpoch() internal {
        uint64 e = uint64(block.timestamp / epochLength);
        if (e != currentEpoch) {
            currentEpoch = e;
            paidInEpoch = 0;
            payeesAddedInEpoch = 0;
        }
    }

    function _decimalsOf(address token_) internal view returns (uint8) {
        try IERC20Decimals(token_).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 6;
        }
    }
}

/// @title QuaestorPayouts — one payout governor per business
contract QuaestorPayouts {
    using SafeERC20 for IERC20;

    address public immutable implementation;
    address[] public allGovernors;
    mapping(address => address[]) internal _governorsOf;
    mapping(address => address[]) internal _governorsForOperator;

    event GovernorCreated(address indexed governor, address indexed owner, address indexed operator, address token, uint256 deposit);
    event OperatorFunded(address indexed governor, address indexed operator, uint256 amount);

    error GasTransferFailed();

    constructor() {
        implementation = address(new QuaestorPayoutGovernor());
    }

    struct Setup {
        address operator; // the AI operator's key
        address token; // USDC
        uint64 epochLength;
        uint128 perDealCap;
        uint128 epochCap;
        uint128 newPayeeCap;
        uint32 newPayeesPerEpoch;
        address[] payees; // vetted from the start
        uint128[] payeeCaps;
        uint256 deposit; // pulled from the owner; needs an approval to this factory first
    }

    /// @notice Any native coin sent along (USDC on Arc) goes to the operator's key for gas.
    function createGovernor(Setup calldata s) external payable returns (address governor) {
        governor = Clones.clone(implementation);
        allGovernors.push(governor);
        _governorsOf[msg.sender].push(governor);
        _governorsForOperator[s.operator].push(governor);
        emit GovernorCreated(governor, msg.sender, s.operator, s.token, s.deposit);
        QuaestorPayoutGovernor g = QuaestorPayoutGovernor(governor);
        g.initialize(msg.sender, s.operator, s.token, s.epochLength, s.perDealCap, s.epochCap, s.newPayeeCap, s.newPayeesPerEpoch);
        g.setupFromFactory(s.payees, s.payeeCaps);
        if (s.deposit > 0) IERC20(s.token).safeTransferFrom(msg.sender, governor, s.deposit);
        if (msg.value > 0) {
            emit OperatorFunded(governor, s.operator, msg.value);
            // slither-disable-next-line low-level-calls,arbitrary-send-eth
            (bool ok, ) = s.operator.call{value: msg.value}("");
            if (!ok) revert GasTransferFailed();
        }
    }

    function governorsOf(address owner) external view returns (address[] memory) {
        return _governorsOf[owner];
    }

    function governorsForOperator(address operator) external view returns (address[] memory) {
        return _governorsForOperator[operator];
    }

    function governorCount() external view returns (uint256) {
        return allGovernors.length;
    }
}
