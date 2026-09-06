// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @title QuaestorAttested — the cross-chain budget root
/// @notice Every Quaestor governor enforces a budget on its own chain. None of them can see
///         the others. This contract, on Creditcoin, can: it consumes *attested* `Receipt`
///         events from every registered governor — proven through the Attestcoin BlockProver
///         precompile, not reported by a relayer — and keeps one global tally per agent group.
///         When the sum across chains exceeds the group's global cap, the group is marked
///         breached. The hub stops selling that group's route permits, and its guardians
///         suspend the spoke agents. Only a human clears a breach.
///
///         A second action attests `Suspended` events: a suspension on any chain becomes an
///         unforgeable entry in the herd's threat feed.
///
/// @dev    Extends ASCBase (verify → dedupe by queryId → `_processAndEmitEvent`). All decoding
///         is EvmV1Decoder, all functions of which are internal in v0.2.1 — no library linking.
contract QuaestorAttested is ASCBase {
    // ---------------------------------------------------------------- types

    enum Action {
        SpendAttested, // 0: a Receipt on a registered governor
        SuspensionAttested // 1: a Suspended on a registered governor
    }

    struct Group {
        uint256 cap; // global cap per epoch, in the spoke chains' native wei (owner's choice of unit)
        uint32 epochLength; // seconds
        uint40 since; // epoch zero
        bool breached;
        uint256 epochIndex; // index of the epoch `spentInEpoch` refers to
        uint256 spentInEpoch;
        uint256 attestedSpends; // lifetime count of receipts credited
    }

    // ------------------------------------------------------------ constants

    /// keccak256("Receipt(uint256,uint8,address,uint256,bytes32,uint256,uint256)")
    bytes32 public constant RECEIPT_SIGNATURE =
        0xc5bdad821c6fa2c062aebb06ab98a4ea824e5423ff3fd2683971effedcf7ddcd;
    /// keccak256("Suspended(uint256,address)")
    bytes32 public constant SUSPENDED_SIGNATURE =
        0xb4b6c7aa41c1649a19455c4a20a4725638f523e0d151d364110ec868106f223b;

    // ---------------------------------------------------------------- state

    address public owner;

    /// Registered governors: emitter address => chainKey it lives on (0 = not registered).
    /// Logs from any other address are rejected, so nobody can deploy a look-alike that
    /// emits a Receipt and prove it here.
    mapping(address => uint64) public chainKeyOf;

    /// keccak256(emitter, agentId) => groupId (0 = not linked)
    mapping(bytes32 => uint256) public groupOf;

    mapping(uint256 => Group) public groups;

    /// keccak256(emitter, agentId) => attested suspensions
    mapping(bytes32 => uint256) public suspensionsOf;

    // --------------------------------------------------------------- events

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SourceRegistered(uint64 indexed chainKey, address indexed emitter);
    event AgentLinked(uint256 indexed groupId, address indexed emitter, uint256 indexed agentId);
    event GlobalCapSet(uint256 indexed groupId, uint256 cap, uint32 epochLength);
    event SpendAttested(
        uint256 indexed groupId,
        address indexed emitter,
        uint256 indexed agentId,
        uint8 category,
        uint256 amount,
        bytes32 metaHash,
        bytes32 queryId,
        uint256 spentInEpoch
    );
    event GlobalCapBreached(uint256 indexed groupId, uint256 spentInEpoch, uint256 cap);
    event BreachCleared(uint256 indexed groupId, address by);
    event SuspensionAttested(
        address indexed emitter,
        uint256 indexed agentId,
        address by,
        bytes32 queryId,
        uint256 total
    );

    // --------------------------------------------------------------- errors

    error NotOwner();
    error ZeroAddress();
    error InvalidAction(uint8 action);
    error UnsupportedTransactionType(uint8 txType);
    error TransactionFailed();
    error NoMatchingLogs();
    error UnregisteredGovernor(address emitter);
    error AgentNotLinked(address emitter, uint256 agentId);
    error MalformedLog();
    error BadCap();
    error LengthMismatch();

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------- construction

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------- admin

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Trust a governor deployment on a source chain.
    function registerSource(uint64 chainKey, address emitter) external onlyOwner {
        if (emitter == address(0)) revert ZeroAddress();
        if (chainKey == 0) revert BadCap();
        chainKeyOf[emitter] = chainKey;
        emit SourceRegistered(chainKey, emitter);
    }

    /// @notice Put a (governor, agentId) pair into a group. A group is "one budget, many chains".
    function linkAgent(uint256 groupId, address emitter, uint256 agentId) external onlyOwner {
        if (groupId == 0) revert BadCap();
        if (chainKeyOf[emitter] == 0) revert UnregisteredGovernor(emitter);
        groupOf[_agentKey(emitter, agentId)] = groupId;
        emit AgentLinked(groupId, emitter, agentId);
    }

    /// @notice Set (or reset) a group's global cap. Resetting the epoch length restarts the clock.
    function setGlobalCap(uint256 groupId, uint256 cap, uint32 epochLength) external onlyOwner {
        if (groupId == 0 || cap == 0 || epochLength == 0) revert BadCap();
        Group storage g = groups[groupId];
        if (g.since == 0 || g.epochLength != epochLength) {
            g.since = uint40(block.timestamp);
            g.epochIndex = 0;
            g.spentInEpoch = 0;
        }
        g.cap = cap;
        g.epochLength = epochLength;
        emit GlobalCapSet(groupId, cap, epochLength);
    }

    /// @notice Only a human loosens. Nothing in this contract clears a breach on its own.
    function clearBreach(uint256 groupId) external onlyOwner {
        groups[groupId].breached = false;
        emit BreachCleared(groupId, msg.sender);
    }

    // ---------------------------------------------------------------- batch

    /// @notice N transactions that share one continuity proof — the precompile's batch form.
    struct Batch {
        uint64 chainKey;
        uint64[] heights;
        bytes[] encodedTransactions;
        bytes32[] merkleRoots;
        INativeQueryVerifier.MerkleProofEntry[][] siblings;
        bytes32 lowerEndpointDigest;
        bytes32[] continuityRoots;
    }

    /// @notice Verify a batch once, dedupe each transaction, process each.
    ///         Mirrors ASCBase.execute for the batch verifier.
    function executeBatch(uint8 action, Batch calldata b) external returns (bool success) {
        uint256 n = b.heights.length;
        if (n == 0 || b.encodedTransactions.length != n || b.merkleRoots.length != n || b.siblings.length != n) {
            revert LengthMismatch();
        }

        bytes32[] memory queryIds = _batchQueryIds(b);
        require(_verifyBatch(b), "Proof of inclusion verification failed");

        for (uint256 i; i < n; ++i) {
            processedQueries[queryIds[i]] = true;
            _processAndEmitEvent(action, queryIds[i], b.encodedTransactions[i]);
        }
        return true;
    }

    function _batchQueryIds(Batch calldata b) internal view returns (bytes32[] memory queryIds) {
        uint256 n = b.heights.length;
        queryIds = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            queryIds[i] = _computeQueryId(b.chainKey, b.heights[i], b.merkleRoots[i], b.siblings[i]);
            require(!processedQueries[queryIds[i]], "Query already processed");
        }
    }

    function _verifyBatch(Batch calldata b) internal returns (bool) {
        uint256 n = b.heights.length;
        INativeQueryVerifier.MerkleProof[] memory proofs = new INativeQueryVerifier.MerkleProof[](n);
        for (uint256 i; i < n; ++i) {
            proofs[i] = INativeQueryVerifier.MerkleProof({root: b.merkleRoots[i], siblings: b.siblings[i]});
        }
        return VERIFIER.verifyAndEmit(
            b.chainKey,
            b.heights,
            b.encodedTransactions,
            proofs,
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: b.lowerEndpointDigest, roots: b.continuityRoots})
        );
    }

    // ---------------------------------------------------------------- views

    function currentEpoch(uint256 groupId) public view returns (uint256) {
        Group storage g = groups[groupId];
        if (g.since == 0) return 0;
        return (block.timestamp - g.since) / g.epochLength;
    }

    /// @notice Spent in the current epoch, across every linked chain.
    function globalSpent(uint256 groupId) public view returns (uint256) {
        Group storage g = groups[groupId];
        return currentEpoch(groupId) == g.epochIndex ? g.spentInEpoch : 0;
    }

    function globalRemaining(uint256 groupId) external view returns (uint256) {
        Group storage g = groups[groupId];
        uint256 spent = globalSpent(groupId);
        return g.cap > spent ? g.cap - spent : 0;
    }

    function isBreached(uint256 groupId) external view returns (bool) {
        return groups[groupId].breached;
    }

    // ------------------------------------------------------------- internals

    function _processAndEmitEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction)
        internal
        override
    {
        EvmV1Decoder.ReceiptFields memory receipt = _validReceipt(encodedTransaction);

        if (action == uint8(Action.SpendAttested)) {
            EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, RECEIPT_SIGNATURE);
            if (logs.length == 0) revert NoMatchingLogs();
            for (uint256 i; i < logs.length; ++i) _creditSpend(logs[i], queryId);
        } else if (action == uint8(Action.SuspensionAttested)) {
            EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, SUSPENDED_SIGNATURE);
            if (logs.length == 0) revert NoMatchingLogs();
            for (uint256 i; i < logs.length; ++i) _noteSuspension(logs[i], queryId);
        } else {
            revert InvalidAction(action);
        }
    }

    function _validReceipt(bytes memory encodedTransaction)
        internal
        pure
        returns (EvmV1Decoder.ReceiptFields memory receipt)
    {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert UnsupportedTransactionType(txType);
        receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionFailed();
    }

    /// @dev Receipt(uint256 indexed agentId, uint8 indexed category, address payee, uint256 amount,
    ///      bytes32 metaHash, uint256 epoch, uint256 epochSpentAfter)
    function _creditSpend(EvmV1Decoder.LogEntry memory log, bytes32 queryId) internal {
        address emitter = log.address_;
        if (chainKeyOf[emitter] == 0) revert UnregisteredGovernor(emitter);
        if (log.topics.length != 3 || log.data.length != 5 * 32) revert MalformedLog();

        uint256 agentId = uint256(log.topics[1]);
        uint8 category = uint8(uint256(log.topics[2]));
        (, uint256 amount, bytes32 metaHash, , ) =
            abi.decode(log.data, (address, uint256, bytes32, uint256, uint256));

        uint256 groupId = groupOf[_agentKey(emitter, agentId)];
        if (groupId == 0) revert AgentNotLinked(emitter, agentId);

        Group storage g = groups[groupId];
        uint256 epoch = currentEpoch(groupId);
        if (epoch != g.epochIndex) {
            g.epochIndex = epoch;
            g.spentInEpoch = 0;
        }
        g.spentInEpoch += amount;
        g.attestedSpends += 1;

        emit SpendAttested(groupId, emitter, agentId, category, amount, metaHash, queryId, g.spentInEpoch);

        if (g.cap != 0 && g.spentInEpoch > g.cap && !g.breached) {
            g.breached = true;
            emit GlobalCapBreached(groupId, g.spentInEpoch, g.cap);
        }
    }

    /// @dev Suspended(uint256 indexed agentId, address by)
    function _noteSuspension(EvmV1Decoder.LogEntry memory log, bytes32 queryId) internal {
        address emitter = log.address_;
        if (chainKeyOf[emitter] == 0) revert UnregisteredGovernor(emitter);
        if (log.topics.length != 2 || log.data.length != 32) revert MalformedLog();
        uint256 agentId = uint256(log.topics[1]);
        address by = abi.decode(log.data, (address));
        bytes32 key = _agentKey(emitter, agentId);
        uint256 total = ++suspensionsOf[key];
        emit SuspensionAttested(emitter, agentId, by, queryId, total);
    }

    function _agentKey(address emitter, uint256 agentId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(emitter, agentId));
    }
}
