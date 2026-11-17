// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {PositionManager} from "../src/PositionManager.sol";

contract FeesTest is Base {
    function test_openFeeGoesToJunior() public {
        pm.setFees(30, 0); // 0.3% of borrowed
        uint256 j0 = pool.trancheAssets(1);
        uint256 bal0 = usdc.balanceOf(trader);
        _open(1_000 * USD, 2_000 * USD);
        assertEq(pool.trancheAssets(1) - j0, 6 * USD);
        assertEq(bal0 - usdc.balanceOf(trader), 1_006 * USD);
        _assertPoolInvariant();
    }

    function test_liquidationFeeGoesToJunior() public {
        pm.setParams(300, 10 minutes);
        pm.setFees(0, 200);
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        (,, uint256 shares,) = pm.positions(id);
        oracle.setPrice(YES, 0.38e18);

        uint256 j0 = pool.trancheAssets(1);
        (uint256 paid, uint256 seized) = pm.liquidate(id, type(uint256).max);

        assertApproxEqAbs(paid, 2_040 * USD, 2, "debt + 2% fee");
        assertApproxEqRel(seized, uint256(2_000 * USD) * 10_500 / 10_000 * 1e18 / 0.38e18, 1e14, "debt * (1 + 3% + 2%)");
        assertApproxEqAbs(pool.trancheAssets(1) - j0, 40 * USD, 2);
        assertEq(pm.claimableShares(trader, YES), shares - seized);
        _assertPoolInvariant();
    }

    function test_liquidationFeeSkippedWhenUnderwater() public {
        pm.setFees(0, 200);
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        oracle.setPrice(YES, 0.1e18);
        uint256 j0 = pool.trancheAssets(1);
        (uint256 paid,) = pm.liquidate(id, type(uint256).max);
        assertLt(paid, 2_000 * USD);
        assertApproxEqAbs(j0 - pool.trancheAssets(1), 2_000 * USD - paid, 2, "only the shortfall, no fee credited");
        _assertPoolInvariant();
    }

    function test_jumpAllowance() public {
        risk.setJumpAllowance(0.1e18);
        // cushion must cover a 10c jump: p=0.5 -> 80%, p=0.25 -> 60%, p=0.1 -> 0
        assertEq(risk.volCapBps(YES, 0.5e18), 8_000);
        assertEq(risk.liqLtvBps(YES, 0.5e18), 8_000);
        assertEq(risk.liqLtvBps(YES, 0.25e18), 6_000);
        assertEq(risk.liqLtvBps(YES, 0.1e18), 0);
    }

    function test_medianFilterIgnoresSingleSpike() public {
        oracle.setMedianFilter(true);
        oracle.setPrice(YES, 0.5e18);
        oracle.setPrice(YES, 0.2e18); // spike
        (uint256 p,) = oracle.getPrice(YES);
        assertEq(p, 0.5e18);
        oracle.setPrice(YES, 0.5e18); // reverts back
        (p,) = oracle.getPrice(YES);
        assertEq(p, 0.5e18);
        oracle.setPrice(YES, 0.2e18);
        oracle.setPrice(YES, 0.2e18); // sustained move gets through on the 2nd push
        (p,) = oracle.getPrice(YES);
        assertEq(p, 0.2e18);
    }

    function test_feeCaps() public {
        vm.expectRevert(bytes("fee"));
        pm.setFees(501, 0);
        vm.expectRevert(bytes("fee"));
        pm.setFees(0, 1_001);
    }
}

contract ClusterTest is Base {
    uint256 constant NO_ID = 2;

    function setUp() public override {
        super.setUp();
        oracle.setPrice(NO_ID, 0.5e18);
        risk.listMarket(
            NO_ID,
            RiskEngineMarketLib.cfg(resolution)
        );
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (YES, NO_ID);
        risk.setCluster(ids, 7);
        risk.setClusterCap(7, 5_000 * USD);
    }

    function test_clusterCapSpansMarkets() public {
        _open(1_000 * USD, 2_000 * USD); // YES: 2k
        vm.prank(trader);
        pm.open(NO_ID, 1_000 * USD, 2_000 * USD, 0); // NO: 2k -> cluster 4k
        vm.prank(trader);
        vm.expectRevert(PositionManager.ClusterCapExceeded.selector);
        pm.open(NO_ID, 1_000 * USD, 2_000 * USD, 0); // would be 6k > 5k
    }

    function test_clusterDebtReleasedOnClose() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        vm.prank(trader);
        pm.close(id, 0);
        assertEq(pm.clusterScaledDebt(7), 0);
    }
}

import {RiskEngine} from "../src/RiskEngine.sol";

library RiskEngineMarketLib {
    function cfg(uint64 resolution) internal pure returns (RiskEngine.Market memory) {
        return RiskEngine.Market({
            listed: true,
            openEnabled: true,
            liqLtvBps: 8_500,
            openBufferBps: 1_000,
            resolutionTime: resolution,
            cutoffDuration: 1 days,
            rampDuration: 3 days,
            borrowCap: 500_000 * 1e6
        });
    }
}
