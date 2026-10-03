// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReceiverForTest {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// Stands in for a Chainlink CRE forwarder in tests: anyone may have it deliver any report,
/// as CRE's simulation forwarder does.
contract TestForwarder {
    function report(address receiver, bytes calldata metadata, bytes calldata payload) external {
        IReceiverForTest(receiver).onReport(metadata, payload);
    }
}
