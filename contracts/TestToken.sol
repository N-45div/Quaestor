// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TestToken — faucet-enabled ERC20 for X Layer testnet
/// @notice Real ERC20 with a rate-limited public faucet so any testnet user
/// can get tokens, trade them on QuaestorDEX, or provide liquidity.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    address public immutable deployer;
    uint256 public immutable faucetAmount;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public lastFaucetAt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event FaucetDrip(address indexed to, uint256 amount);

    error FaucetCooldown(uint256 nextAvailableAt);
    error NotDeployer();

    constructor(string memory name_, string memory symbol_, uint256 faucetAmount_) {
        name = name_;
        symbol = symbol_;
        deployer = msg.sender;
        faucetAmount = faucetAmount_;
    }

    /// @notice Anyone can claim `faucetAmount` once per hour.
    function faucet() external {
        uint256 next = lastFaucetAt[msg.sender] + FAUCET_COOLDOWN;
        if (block.timestamp < next && lastFaucetAt[msg.sender] != 0) {
            revert FaucetCooldown(next);
        }
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
        emit FaucetDrip(msg.sender, faucetAmount);
    }

    /// @notice Deployer-only bulk mint, used once to seed initial DEX liquidity.
    function mint(address to, uint256 amount) external {
        if (msg.sender != deployer) revert NotDeployer();
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
