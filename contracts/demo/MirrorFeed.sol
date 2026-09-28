// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MirrorFeed — a testnet copy of a mainnet Chainlink feed
/// @notice Robinhood Chain's testnet has no Chainlink. This contract speaks
/// Chainlink's AggregatorV3 interface and holds the price its relayer copied
/// from the real feed on Robinhood Chain mainnet, with the time that feed last
/// updated, so a governor's staleness check means what it means on mainnet:
/// if the relayer stops, the price ages and the governor refuses to trade.
/// It is a mirror, and says so in `description()`; it is not an oracle.
contract MirrorFeed {
    address public immutable relayer;
    uint8 public immutable decimals;
    /// The mainnet feed this copies, for anyone who wants to check it.
    address public immutable source;
    string public description;

    uint80 private _round;
    int256 private _answer;
    uint256 private _updatedAt;

    event Mirrored(uint80 indexed round, int256 answer, uint256 sourceUpdatedAt);

    error NotRelayer();
    error Stale(uint256 sourceUpdatedAt, uint256 latest);

    constructor(address relayer_, uint8 decimals_, address source_, string memory description_) {
        relayer = relayer_;
        decimals = decimals_;
        source = source_;
        description = description_;
    }

    /// @notice Copy the mainnet feed's latest answer. An older round than the
    /// one held is refused, so the mirror never moves backwards in time.
    function mirror(int256 answer, uint256 sourceUpdatedAt) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (sourceUpdatedAt < _updatedAt) revert Stale(sourceUpdatedAt, _updatedAt);
        _round += 1;
        _answer = answer;
        _updatedAt = sourceUpdatedAt;
        emit Mirrored(_round, answer, sourceUpdatedAt);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }

    function version() external pure returns (uint256) {
        return 1;
    }
}
