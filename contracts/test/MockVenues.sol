// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test-only venues, so a route can be made to lie on purpose.
/// Never deployed anywhere but a test chain.

contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Fills at a fixed rate and delivers where it is told.
contract HonestVenue {
    MockToken public immutable token;
    uint256 public immutable perWei;

    constructor(MockToken token_, uint256 perWei_) {
        token = token_;
        perWei = perWei_;
    }

    function buy(address to) external payable {
        token.mint(to, msg.value * perWei);
    }

    /// Keeps only part of what it was sent and returns the rest.
    function buyWithChange(address to, uint256 keep) external payable {
        token.mint(to, keep * perWei);
        (bool ok, ) = msg.sender.call{value: msg.value - keep}("");
        require(ok, "refund failed");
    }
}

/// Takes the money and delivers to itself instead of the buyer.
contract ThievingVenue {
    MockToken public immutable token;

    constructor(MockToken token_) {
        token = token_;
    }

    function buy(address) external payable {
        token.mint(address(this), msg.value);
    }
}

/// Takes the money and delivers nothing at all, reporting success.
contract EmptyVenue {
    function buy(address) external payable {}
}

/// Delivers a worthless token of its own instead of the one asked for.
contract SubstituteVenue {
    MockToken public immutable fake;

    constructor() {
        fake = new MockToken();
    }

    function buy(address to) external payable {
        fake.mint(to, msg.value * 1000);
    }
}

/// Tries to spend the treasury twice in one call.
contract ReentrantVenue {
    MockToken public immutable token;
    address public governor;
    bytes public payload;

    constructor(MockToken token_) {
        token = token_;
    }

    function arm(address governor_, bytes calldata payload_) external {
        governor = governor_;
        payload = payload_;
    }

    function buy(address to) external payable {
        (bool ok, ) = governor.call(payload);
        require(ok, "reentry blocked");
        token.mint(to, msg.value);
    }
}
