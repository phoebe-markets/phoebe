// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Stand-in for Gnosis ConditionalTokens outcome positions (ERC-1155, 6 decimals like USDC).
/// It also plays Polymarket's CtfCollateralAdapter for binary conditions registered with `setCondition`:
/// split / merge / redeem against the collateral passed in (the mock USDC), so testnets exercise the same
/// settlement and inventory paths as mainnet. `reportPayouts` stands in for the market's oracle.
contract MockCTF is ERC1155, Ownable {
    using SafeERC20 for IERC20;

    mapping(address => bool) public minters;
    mapping(bytes32 => uint256[2]) public tokensOf; // conditionId => [YES id, NO id]
    mapping(bytes32 => uint256[2]) internal payouts;
    mapping(bytes32 => uint256) public payoutDenominator;

    constructor() ERC1155("") Ownable(msg.sender) {}

    function setMinter(address who, bool allowed) external onlyOwner {
        minters[who] = allowed;
    }

    function mint(address to, uint256 id, uint256 amount) external {
        require(minters[msg.sender], "not minter");
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external {
        require(minters[msg.sender], "not minter");
        _burn(from, id, amount);
    }

    // ------------------------------------------------------------------ conditions

    function setCondition(bytes32 conditionId, uint256 yesId, uint256 noId) external onlyOwner {
        tokensOf[conditionId] = [yesId, noId];
    }

    /// @notice Resolve: e.g. [1, 0] = YES wins, [0, 1] = NO wins, [1, 1] = 50/50.
    function reportPayouts(bytes32 conditionId, uint256[2] calldata nums) external onlyOwner {
        require(payoutDenominator[conditionId] == 0, "resolved");
        require(tokensOf[conditionId][0] != 0, "unknown condition");
        uint256 den = nums[0] + nums[1];
        require(den > 0, "payouts");
        payouts[conditionId] = nums;
        payoutDenominator[conditionId] = den;
    }

    function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256) {
        return payouts[conditionId][index];
    }

    // ------------------------------------------------------------------ adapter-style split / merge / redeem

    function splitPosition(address collateral, bytes32, bytes32 conditionId, uint256[] calldata, uint256 amount)
        external
    {
        uint256[2] memory t = _tokens(conditionId);
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, t[0], amount, "");
        _mint(msg.sender, t[1], amount, "");
    }

    function mergePositions(address collateral, bytes32, bytes32 conditionId, uint256[] calldata, uint256 amount)
        external
    {
        uint256[2] memory t = _tokens(conditionId);
        _burn(msg.sender, t[0], amount);
        _burn(msg.sender, t[1], amount);
        _pay(collateral, msg.sender, amount);
    }

    /// @dev Like the CtfCollateralAdapter: redeems the caller's whole balance of both outcomes.
    function redeemPositions(address collateral, bytes32, bytes32 conditionId, uint256[] calldata) external {
        uint256 den = payoutDenominator[conditionId];
        require(den > 0, "not resolved");
        uint256[2] memory t = _tokens(conditionId);
        uint256 total;
        for (uint256 i; i < 2; ++i) {
            uint256 bal = balanceOf(msg.sender, t[i]);
            if (bal == 0) continue;
            _burn(msg.sender, t[i], bal);
            total += bal * payouts[conditionId][i] / den;
        }
        if (total > 0) _pay(collateral, msg.sender, total);
    }

    function _tokens(bytes32 conditionId) internal view returns (uint256[2] memory t) {
        t = tokensOf[conditionId];
        require(t[0] != 0, "unknown condition");
    }

    /// @dev Pays from split collateral held here; mints the rest (minted outcome tokens have no backing).
    function _pay(address collateral, address to, uint256 amount) internal {
        uint256 held = IERC20(collateral).balanceOf(address(this));
        uint256 fromHeld = held < amount ? held : amount;
        if (fromHeld > 0) IERC20(collateral).safeTransfer(to, fromHeld);
        if (amount > fromHeld) IMintable(collateral).mint(to, amount - fromHeld);
    }
}
