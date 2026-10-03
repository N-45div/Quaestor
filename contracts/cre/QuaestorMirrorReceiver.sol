// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The interface a Chainlink CRE forwarder calls; its ERC-165 id is the one function's selector.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IMirrorFeed {
    function mirror(int256 answer, uint256 sourceUpdatedAt) external;
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title QuaestorMirrorReceiver — a Chainlink CRE workflow writes stock prices onto Monad
/// @notice Chainlink publishes no stock feeds on Monad. A CRE workflow reads Chainlink's own
/// stock feeds on Arbitrum One and delivers a report through CRE's forwarder; this contract is
/// the relayer of each MirrorFeed it lists and copies the report into them. A Quaestor
/// governor's price guard reads those feeds, so a stale or missing report means its agent
/// cannot buy, never that it buys blind.
///
/// Who can deliver a report:
///  - only `forwarder`;
///  - while `simulationSender` is set (CRE's simulation forwarder checks no signature, so
///    anyone could call it), only a transaction that address sent;
///  - while `workflowId` is set (the production forwarder checks the DON's signatures and
///    passes the workflow's ID first in the metadata), only that workflow's reports.
/// A report names stocks by symbol, and only feeds the owner listed here can be written.
contract QuaestorMirrorReceiver is IReceiver {
    address public owner;
    address public forwarder;
    address public simulationSender;
    bytes32 public workflowId;
    mapping(bytes32 => address) public feedOf;

    event OwnerSet(address indexed owner);
    event ForwarderSet(address indexed forwarder, address simulationSender);
    event WorkflowIdSet(bytes32 indexed workflowId);
    event FeedSet(bytes32 indexed symbol, address feed);
    event Relayed(bytes32 indexed symbol, int256 answer, uint256 sourceUpdatedAt);
    /// The feed already holds this round or a newer one; the report's copy is dropped.
    event Skipped(bytes32 indexed symbol, uint256 sourceUpdatedAt, uint256 held);

    error NotOwner();
    error NotForwarder(address sender);
    error NotSimulationSender(address origin);
    error WrongWorkflow(bytes32 got, bytes32 expected);
    error UnknownSymbol(bytes32 symbol);
    error BadAnswer(bytes32 symbol, int256 answer);
    error LengthMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address forwarder_, address simulationSender_) {
        owner = msg.sender;
        forwarder = forwarder_;
        simulationSender = simulationSender_;
        emit OwnerSet(msg.sender);
        emit ForwarderSet(forwarder_, simulationSender_);
    }

    /// @notice A report: (bytes32[] symbols, int256[] answers, uint256[] sourceUpdatedAts),
    /// each answer as the source feed gave it, with the time that feed last updated.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        if (simulationSender != address(0) && tx.origin != simulationSender) revert NotSimulationSender(tx.origin);
        if (workflowId != bytes32(0)) {
            bytes32 got = metadata.length >= 32 ? bytes32(metadata[0:32]) : bytes32(0);
            if (got != workflowId) revert WrongWorkflow(got, workflowId);
        }
        (bytes32[] memory symbols, int256[] memory answers, uint256[] memory updatedAts) =
            abi.decode(report, (bytes32[], int256[], uint256[]));
        if (symbols.length != answers.length || symbols.length != updatedAts.length) revert LengthMismatch();
        for (uint256 i = 0; i < symbols.length; i++) {
            address feed = feedOf[symbols[i]];
            if (feed == address(0)) revert UnknownSymbol(symbols[i]);
            if (answers[i] <= 0) revert BadAnswer(symbols[i], answers[i]);
            (,,, uint256 held,) = IMirrorFeed(feed).latestRoundData();
            if (updatedAts[i] < held) {
                emit Skipped(symbols[i], updatedAts[i], held);
                continue;
            }
            IMirrorFeed(feed).mirror(answers[i], updatedAts[i]);
            emit Relayed(symbols[i], answers[i], updatedAts[i]);
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == 0x01ffc9a7; // IERC165
    }

    /// @notice List a stock's MirrorFeed, whose relayer must be this contract; address(0) unlists it.
    function setFeed(bytes32 symbol, address feed) external onlyOwner {
        feedOf[symbol] = feed;
        emit FeedSet(symbol, feed);
    }

    /// @notice Move from CRE's simulation forwarder to the production one: pass the
    /// KeystoneForwarder and address(0) for the sender, then set the workflow's ID.
    function setForwarder(address forwarder_, address simulationSender_) external onlyOwner {
        forwarder = forwarder_;
        simulationSender = simulationSender_;
        emit ForwarderSet(forwarder_, simulationSender_);
    }

    function setWorkflowId(bytes32 workflowId_) external onlyOwner {
        workflowId = workflowId_;
        emit WorkflowIdSet(workflowId_);
    }

    function setOwner(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnerSet(owner_);
    }
}
