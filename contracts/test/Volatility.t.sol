// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {IVolatilityOracle} from "../src/interfaces/IVolatilityOracle.sol";

contract VolatilityTest is Base {
    function setUp() public override {
        super.setUp();
        risk.setVolParams(IVolatilityOracle(address(oracle)), 1 days, 20_000);
    }

    function test_calmMarket_noCap() public {
        for (uint256 i; i < 50; ++i) _skip(10 minutes, 0.5e18);
        assertEq(oracle.sigmaWad(YES, 1 days), 0);
        assertEq(risk.volCapBps(YES, 0.5e18), 10_000);
        assertEq(risk.liqLtvBps(YES, 0.5e18), 8_500);
    }

    function test_ewmaMath() public {
        _skip(10 minutes, 0.6e18); // dp = 0.1 after 600s, tau = 3d
        // var = 0.01 / (259200 + 600); sigma_1d = 0.1 * sqrt(86400 / 259800) ~= 0.05767
        assertApproxEqRel(oracle.sigmaWad(YES, 1 days), 0.05767e18, 1e15);
        // cap = 1 - 2 * 0.05767 / 0.6 ~= 80.78%
        assertApproxEqAbs(risk.volCapBps(YES, 0.6e18), 8_078, 2);
        assertApproxEqAbs(risk.liqLtvBps(YES, 0.6e18), 8_078, 2);
    }

    /// Sparse keeper pushes must not hide a jump: a 10c move registers even if it arrives after an hour's gap.
    function test_sparsePushStillRegistersJump() public {
        _skip(1 hours, 0.6e18);
        assertGt(oracle.sigmaWad(YES, 1 days), 0.05e18);
    }

    function test_turbulenceBlocksHighLeverage() public {
        _chop(1 days);
        vm.prank(trader);
        vm.expectRevert(PositionManager.LtvTooHigh.selector);
        pm.open(YES, 1_000 * USD, 2_000 * USD, 0); // 3x is fine in a calm market (see PositionTest.test_open3x)
    }

    /// The point of the volatility factor: a choppy market (price never falls far enough to make the position
    /// underwater) pushes the liquidation LTV below the position's LTV, so it is liquidated while solvent,
    /// before any jump can create bad debt.
    function test_turbulenceDeleveragesWhileSolvent() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD); // LTV ~67%
        assertFalse(pm.health(id).liquidatable);

        _chop(1 days);
        oracle.setPrice(YES, 0.5e18);
        PositionManager.Health memory h = pm.health(id);
        assertLt(h.liqLtvBps, h.ltvBps, "vol pulled the liquidation line below the position");
        assertTrue(h.liquidatable);

        uint256 j0 = pool.trancheAssets(1);
        pm.liquidate(id, type(uint256).max);
        assertGe(pool.trancheAssets(1), j0, "no LP loss");
        _assertPoolInvariant();
    }

    function test_noVolOracle_noCap() public {
        risk.setVolParams(IVolatilityOracle(address(0)), 1 days, 20_000);
        _chop(1 days);
        assertEq(risk.volCapBps(YES, 0.5e18), 10_000);
    }

    /// 0.50 <-> 0.44 every 10 minutes.
    function _chop(uint256 duration) internal {
        for (uint256 t; t < duration; t += 10 minutes) {
            _skip(10 minutes, (t / 10 minutes) % 2 == 0 ? 0.44e18 : 0.5e18);
        }
    }
}
