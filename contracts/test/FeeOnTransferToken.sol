// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockStockVenues.sol";

/// A token that skims 1% of every transfer: what arrives is not what was sent.
contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20("Skim", "SKM", 6) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
