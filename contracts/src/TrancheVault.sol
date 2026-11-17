// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LendingPool} from "./LendingPool.sol";

/// @title TrancheVault
/// @notice ERC-4626 share token for one LendingPool tranche (senior or junior). It holds no USDC itself:
///         deposits go straight to the pool, and totalAssets is the tranche's accounting balance there.
contract TrancheVault is ERC4626 {
    using SafeERC20 for IERC20;

    LendingPool public immutable pool;
    uint8 public immutable tranche;

    constructor(LendingPool _pool, uint8 _tranche, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(_pool.usdc())
    {
        pool = _pool;
        tranche = _tranche;
    }

    function totalAssets() public view override returns (uint256) {
        return pool.trancheAssets(tranche);
    }

    function maxDeposit(address) public view override returns (uint256) {
        return pool.maxDepositable(tranche);
    }

    function maxMint(address) public view override returns (uint256) {
        uint256 a = pool.maxDepositable(tranche);
        return a == type(uint256).max ? a : convertToShares(a);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), pool.maxWithdrawable(tranche));
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner), convertToShares(pool.maxWithdrawable(tranche)));
    }

    /// @dev Virtual-share offset to blunt first-depositor inflation attacks.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        IERC20(asset()).safeTransferFrom(caller, address(pool), assets);
        pool.onDeposit(tranche, assets);
        _mint(receiver, shares);
        emit Deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (caller != owner) _spendAllowance(owner, caller, shares);
        _burn(owner, shares);
        pool.onWithdraw(tranche, assets, receiver);
        emit Withdraw(caller, receiver, owner, assets, shares);
    }
}
