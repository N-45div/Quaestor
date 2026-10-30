// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// An 18-decimal token a holder can burn, as WIF can on Robinhood Chain.
contract MockBurnableERC20 is ERC20Burnable {
    constructor() ERC20("World is Flat (test)", "WIF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A token whose `burn` succeeds but only parks the tokens at a dead address, so the total supply
/// never falls: a governor that burns must notice.
contract ParkingBurnToken is ERC20 {
    constructor() ERC20("Parks instead of burning", "PARK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 value) external {
        _transfer(msg.sender, address(0xdEaD), value);
    }
}
