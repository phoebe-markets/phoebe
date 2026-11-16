// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {RiskEngine} from "../src/RiskEngine.sol";

contract PositionTest is Base {
    function test_open3x() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        (address owner, uint256 tokenId, uint256 shares,) = pm.positions(id);
        assertEq(owner, trader);
        assertEq(tokenId, YES);
        // 3000 USDC at ask 0.5025
        assertApproxEqRel(shares, 5_970.149 * 1e6, 1e14);
        assertEq(ctf.balanceOf(address(pm), YES), shares);

        PositionManager.Health memory h = pm.health(id);
        assertApproxEqAbs(h.debt, 2_000 * USD, 1);
        assertEq(h.maxLtvBps, 7_500);
        assertEq(h.liqLtvBps, 8_500);
        assertFalse(h.liquidatable);
        _assertPoolInvariant();
    }

    function test_open_revertsAboveMaxLtv() public {
        vm.prank(trader);
        vm.expectRevert(PositionManager.LtvTooHigh.selector);
        pm.open(YES, 1_000 * USD, 4_000 * USD, 0); // 5x -> LTV ~80%
    }

    function test_open_revertsWhenUnlisted() public {
        vm.prank(trader);
        vm.expectRevert(PositionManager.OpenNotAllowed.selector);
        pm.open(42, 1_000 * USD, 0, 0);
    }

    function test_open_revertsWhenGuardianDisables() public {
        risk.setOpenEnabled(YES, false);
        vm.prank(trader);
        vm.expectRevert(PositionManager.OpenNotAllowed.selector);
        pm.open(YES, 1_000 * USD, 1_000 * USD, 0);
    }

    function test_open_revertsOnStalePrice() public {
        skip(11 minutes);
        vm.prank(trader);
        vm.expectRevert(PositionManager.StalePrice.selector);
        pm.open(YES, 1_000 * USD, 1_000 * USD, 0);
    }

    function test_borrowCap() public {
        usdc.mint(trader, 1_000_000 * USD);
        vm.prank(trader);
        vm.expectRevert(PositionManager.BorrowCapExceeded.selector);
        pm.open(YES, 300_000 * USD, 600_000 * USD, 0);
    }

    function test_closeWithProfit() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        _skip(1 days, 0.6e18);

        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        pm.close(id, 0);
        uint256 got = usdc.balanceOf(trader) - before;

        // shares * 0.597 bid - 2000 debt - ~1 day interest
        assertGt(got, 1_560 * USD);
        assertLt(got, 1_565 * USD);
        assertEq(pool.totalDebt(), 0);
        (address owner,,,) = pm.positions(id);
        assertEq(owner, address(0));
        _assertPoolInvariant();
    }

    function test_close_onlyOwner() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        vm.expectRevert(PositionManager.NotOwner.selector);
        pm.close(id, 0);
    }

    function test_close_revertsWhenUnderwater() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        oracle.setPrice(YES, 0.3e18);
        vm.prank(trader);
        vm.expectRevert(PositionManager.Underwater.selector);
        pm.close(id, 0);
    }

    function test_addMarginDeleverages() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        usdc.mint(trader, 1); // rounding dust
        vm.prank(trader);
        pm.addMargin(id, 500 * USD);
        assertApproxEqAbs(pm.health(id).debt, 1_500 * USD, 2);
        _assertPoolInvariant();
    }
}

contract LiquidationTest is Base {
    uint256 id;
    uint256 shares;

    function setUp() public override {
        super.setUp();
        id = _open(1_000 * USD, 2_000 * USD);
        (,, shares,) = pm.positions(id);
    }

    function test_notLiquidatableAboveThreshold() public {
        oracle.setPrice(YES, 0.4e18); // LTV ~83.7% < 85%
        vm.expectRevert(PositionManager.Healthy.selector);
        pm.liquidate(id, type(uint256).max);
    }

    function test_liquidateHealthyCollateral_noLoss() public {
        oracle.setPrice(YES, 0.38e18); // LTV ~88%
        uint256 juniorBefore = pool.trancheAssets(1);

        (uint256 paid, uint256 seized) = pm.liquidate(id, type(uint256).max);

        assertApproxEqAbs(paid, 2_000 * USD, 1);
        // debt * 1.05 / 0.38
        assertApproxEqRel(seized, 5_526.315 * 1e6, 1e14);
        assertEq(ctf.balanceOf(liquidator, YES), seized);
        assertEq(pm.claimableShares(trader, YES), shares - seized);
        assertEq(pool.trancheAssets(1), juniorBefore, "no junior loss");
        assertEq(pool.totalDebt(), 0);

        vm.prank(trader);
        pm.claimShares(YES);
        assertEq(ctf.balanceOf(trader, YES), shares - seized);
        _assertPoolInvariant();
    }

    /// Breaking news: 0.50 -> 0.10 within one block. No liquidation threshold can catch this.
    function test_gapJump_badDebtHitsJuniorOnly() public {
        oracle.setPrice(YES, 0.1e18);
        uint256 s0 = pool.trancheAssets(0);
        uint256 j0 = pool.trancheAssets(1);

        (uint256 paid, uint256 seized) = pm.liquidate(id, type(uint256).max);

        assertEq(seized, shares);
        uint256 value = shares * 0.1e18 / 1e18;
        assertApproxEqAbs(paid, value * 10_000 / 10_500, 1);
        uint256 loss = 2_000 * USD - paid;
        assertApproxEqAbs(j0 - pool.trancheAssets(1), loss, 2, "junior eats it");
        assertEq(pool.trancheAssets(0), s0, "senior untouched");
        _assertPoolInvariant();
    }

    function test_resolvedToZero_fullWriteOff() public {
        oracle.setPrice(YES, 0);
        uint256 j0 = pool.trancheAssets(1);
        (uint256 paid,) = pm.liquidate(id, type(uint256).max);
        assertEq(paid, 0);
        assertApproxEqAbs(j0 - pool.trancheAssets(1), 2_000 * USD, 2);
        _assertPoolInvariant();
    }

    function test_stalePriceBlocksLiquidation() public {
        oracle.setPrice(YES, 0.2e18);
        skip(11 minutes);
        vm.expectRevert(PositionManager.Healthy.selector);
        pm.liquidate(id, type(uint256).max);
    }

    function test_maxPayGuard() public {
        oracle.setPrice(YES, 0.38e18);
        vm.expectRevert("maxPay");
        pm.liquidate(id, 100 * USD);
    }
}

contract TrancheTest is Base {
    function test_lossBeyondJuniorHitsSenior() public {
        pool.setTrancheParams(6_000, 0); // disable coverage so junior can be tiny
        vm.startPrank(lpJunior);
        junior.withdraw(199_000 * USD, lpJunior, lpJunior); // junior: 1,000
        vm.stopPrank();

        uint256 id = _open(1_000 * USD, 2_000 * USD);
        oracle.setPrice(YES, 0);
        uint256 s0 = pool.trancheAssets(0);
        pm.liquidate(id, type(uint256).max);

        assertEq(pool.trancheAssets(1), 0, "junior wiped");
        assertApproxEqAbs(s0 - pool.trancheAssets(0), 1_000 * USD, 2, "senior takes the rest");
        _assertPoolInvariant();
    }

    function test_coverageBlocksBorrow() public {
        // junior 200k @ 20% coverage => max debt 1M. Pool cash is 1M too; raise the cap to isolate coverage.
        _deposit(lpSenior, senior, 1_000_000 * USD);
        risk.listMarket(YES, _market(2_000_000 * uint128(USD)));
        usdc.mint(trader, 1_000_000 * USD);
        vm.prank(trader);
        vm.expectRevert(LendingPool.JuniorCoverage.selector);
        pm.open(YES, 500_000 * USD, 1_000_001 * USD, 0);
        assertEq(pool.borrowCapacity(), 1_000_000 * USD);
    }

    function test_coverageBlocksJuniorExit() public {
        _open(50_000 * USD, 100_000 * USD); // debt 100k => junior must keep 20k
        assertApproxEqAbs(pool.maxWithdrawable(1), 180_000 * USD, 1);
        vm.prank(lpJunior);
        vm.expectRevert();
        junior.withdraw(180_001 * USD, lpJunior, lpJunior);
    }

    function test_juniorEarnsBoostedYield() public {
        _open(100_000 * USD, 200_000 * USD); // 20% utilization
        _skip(365 days / 12, 0.5e18);
        pool.accrue();

        uint256 sGain = pool.trancheAssets(0) - 800_000 * USD;
        uint256 jGain = pool.trancheAssets(1) - 200_000 * USD;
        assertGt(jGain * 1e6 / 200_000, sGain * 1e6 / 800_000 * 2, "junior APR > 2x senior APR");
        _assertPoolInvariant();

        // share price moved up
        assertGt(junior.convertToAssets(1e12), senior.convertToAssets(1e12));
    }

    function _market(uint128 cap) internal view returns (RiskEngine.Market memory m) {
        m = RiskEngine.Market({
            listed: true,
            openEnabled: true,
            liqLtvBps: 8_500,
            openBufferBps: 1_000,
            resolutionTime: resolution,
            cutoffDuration: 1 days,
            rampDuration: 3 days,
            borrowCap: cap
        });
    }
}
