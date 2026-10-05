// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Stands in for CCTP V2's TokenMessenger: takes the burn amount and records what it was told.
/// `short` makes it take one unit less than asked, as a broken or hostile messenger might.
contract MockTokenMessengerV2 {
    struct Burn {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    Burn public last;
    bool public short;

    function setShort(bool s) external {
        short = s;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        IERC20(burnToken).transferFrom(msg.sender, address(this), short ? amount - 1 : amount);
        last = Burn(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, hookData);
    }
}
