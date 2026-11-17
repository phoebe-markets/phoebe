// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {PositionManager} from "../src/PositionManager.sol";

contract AbsorbTest is Base {
    uint256 id;
    uint256 shares;

    function setUp() public override {
        super.setUp();
        pm.setAbsorbUnderwater(true);
        id = _open(1_000 * USD, 2_000 * USD);
        (,, shares,) = pm.positions(id);
    }

    function test_underwaterCannotBeFireSold() public {
        oracle.setPrice(YES, 0.1e18);
        vm.expectRevert(PositionManager.UseAbsorb.selector);
        pm.liquidate(id, type(uint256).max);
    }

    function test_solventStillLiquidatedNormally() public {
        oracle.setPrice(YES, 0.38e18);
        vm.expectRevert(PositionManager.NotUnderwater.selector);
        pm.absorb(id);
        pm.liquidate(id, type(uint256).max);
    }

    /// Crash to 0.10, absorb, market later resolves YES: the LPs recover more than the debt.
    function test_absorbThenRecover() public {
        oracle.setPrice(YES, 0.1e18);
        uint256 j0 = pool.trancheAssets(1);

        vm.prank(makeAddr("anyone"));
        pm.absorb(id);
        assertApproxEqAbs(j0 - pool.trancheAssets(1), 2_000 * USD, 2, "full debt written off up front");
        assertEq(pm.inventory(YES), shares);
        assertEq(pool.totalDebt(), 0);
        _assertPoolInvariant();

        oracle.setPrice(YES, 1e18); // resolved YES
        pm.sellInventory(YES, shares, 0);
        assertEq(pm.inventory(YES), 0);
        // shares * 0.995 (venue bid at 1.0)
        assertApproxEqRel(pool.trancheAssets(1), j0 - 2_000 * USD + shares * 9_950 / 10_000, 1e12);
        assertGt(pool.trancheAssets(1), j0, "upside went to junior");
        _assertPoolInvariant();
    }

    function test_sellInventoryKeeperGated() public {
        oracle.setPrice(YES, 0.1e18);
        pm.absorb(id);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(PositionManager.NotKeeper.selector);
        pm.sellInventory(YES, shares, 0);
    }

    function test_absorbDisabledByDefaultPathStillWorks() public {
        pm.setAbsorbUnderwater(false);
        oracle.setPrice(YES, 0.1e18);
        vm.expectRevert(PositionManager.UseAbsorb.selector);
        pm.absorb(id);
        pm.liquidate(id, type(uint256).max);
    }
}

contract BonusRampTest is Base {
    uint256 id;

    function setUp() public override {
        super.setUp();
        pm.setParams(300, 1 days);
        pm.setBonusRamp(100, 1_500); // +1%/h, max 15%
        id = _open(1_000 * USD, 2_000 * USD);
    }

    function test_flagOnlyWhenLiquidatable() public {
        pm.flag(id);
        assertEq(pm.liquidatableSince(id), 0);
        oracle.setPrice(YES, 0.38e18);
        pm.flag(id);
        assertEq(pm.liquidatableSince(id), block.timestamp);
    }

    function test_bonusRampsAndCaps() public {
        oracle.setPrice(YES, 0.38e18);
        pm.flag(id);
        assertEq(pm.currentBonusBps(id), 300);
        skip(3 hours);
        assertEq(pm.currentBonusBps(id), 600);
        skip(30 hours);
        assertEq(pm.currentBonusBps(id), 1_500);
    }

    function test_liquidationUsesRampedBonus() public {
        oracle.setPrice(YES, 0.38e18);
        pm.flag(id);
        skip(2 hours);
        oracle.setPrice(YES, 0.38e18); // keep the price fresh
        (uint256 paid, uint256 seized) = pm.liquidate(id, type(uint256).max);
        // 5% bonus after 2h: seized = debt * 1.05 / 0.38
        assertApproxEqRel(seized, paid * 10_500 / 10_000 * 1e18 / 0.38e18, 1e14);
        assertEq(pm.liquidatableSince(id), 0);
    }

    function test_flagResetsWhenHealthyAgain() public {
        oracle.setPrice(YES, 0.38e18);
        pm.flag(id);
        oracle.setPrice(YES, 0.5e18);
        pm.flag(id);
        assertEq(pm.liquidatableSince(id), 0);
        assertEq(pm.currentBonusBps(id), 300);
    }
}
