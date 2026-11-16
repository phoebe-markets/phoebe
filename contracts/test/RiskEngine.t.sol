// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {PositionManager} from "../src/PositionManager.sol";

contract RiskEngineTest is Base {
    function test_priceBands() public view {
        assertEq(risk.priceFactorWad(0.5e18), 1e18);
        assertEq(risk.priceFactorWad(0.15e18), 1e18);
        assertEq(risk.priceFactorWad(0.85e18), 1e18);
        assertEq(risk.priceFactorWad(0.97e18), 0);
        assertEq(risk.priceFactorWad(0.03e18), 0);
        assertEq(risk.priceFactorWad(0.91e18), 0.5e18);
        assertEq(risk.priceFactorWad(0.09e18), 0.5e18);
    }

    function test_ltvShrinksNearOne() public view {
        // p = 0.91 -> factor 0.5 -> liq 42.5%, max 32.5% (~1.5x)
        assertEq(risk.liqLtvBps(YES, 0.91e18), 4_250);
        assertEq(risk.maxLtvBps(YES, 0.91e18), 3_250);
        // p = 0.95 -> factor 1/6 -> liq ~14.2%, max ~4.2%
        assertEq(risk.maxLtvBps(YES, 0.95e18), 416);
    }

    function test_timeRamp() public {
        // ramp starts at resolution - 1d - 3d
        vm.warp(resolution - 4 days);
        assertEq(risk.timeFactorWad(YES), 1e18);
        vm.warp(resolution - 2.5 days); // halfway through the ramp
        assertEq(risk.timeFactorWad(YES), 0.5e18);
        assertEq(risk.liqLtvBps(YES, 0.5e18), 4_250);
        vm.warp(resolution - 1 days);
        assertEq(risk.timeFactorWad(YES), 0);
        assertFalse(risk.isOpenAllowed(YES));
    }

    function test_cannotOpenAfterCutoff() public {
        _skip(29 days, 0.5e18);
        vm.prank(trader);
        vm.expectRevert(PositionManager.OpenNotAllowed.selector);
        pm.open(YES, 1_000 * USD, 0, 0);
    }

    /// A 3x position that is perfectly healthy becomes liquidatable as the ramp tightens, before the 0/1 jump.
    function test_rampForcesDeleverageBeforeResolution() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD); // LTV ~67%
        assertFalse(pm.health(id).liquidatable);

        // 2 days before resolution = 1 day before cutoff -> 1/3 of the ramp left -> liq LTV ~28%
        vm.warp(resolution - 2 days);
        oracle.setPrice(YES, 0.5e18);
        PositionManager.Health memory h = pm.health(id);
        assertLt(h.liqLtvBps, h.ltvBps);
        assertTrue(h.liquidatable);

        uint256 j0 = pool.trancheAssets(1);
        pm.liquidate(id, type(uint256).max);
        assertGe(pool.trancheAssets(1), j0, "no loss: liquidated while still solvent");
    }

    function test_unleveredPositionNeverLiquidatable() public {
        uint256 id = _open(1_000 * USD, 0);
        _skip(29 days + 12 hours, 0.01e18);
        assertFalse(pm.health(id).liquidatable);
    }
}
