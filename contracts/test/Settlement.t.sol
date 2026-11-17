// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {ICtfRedeemer} from "../src/interfaces/IConditionalTokens.sol";

contract SettlementTest is Base {
    uint256 constant NO = 2;
    bytes32 constant COND = keccak256("market-1");

    function setUp() public override {
        super.setUp();
        ctf.setCondition(COND, YES, NO);
        pm.setCondition(YES, NO, COND);
        pm.setRedeemer(ICtfRedeemer(address(ctf))); // MockCTF plays the CtfCollateralAdapter
    }

    function _resolve(uint256 yes, uint256 no) internal {
        ctf.reportPayouts(COND, [yes, no]);
    }

    function test_yesWins_traderPaidOut() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        (,, uint256 shares,) = pm.positions(id);
        uint256 debt = pm.debtOf(id);
        uint256 t0 = usdc.balanceOf(trader);

        _resolve(1, 0);
        assertTrue(pm.isResolved(YES));
        pm.redeem(COND);
        assertEq(pm.payoutWad(YES), 1e18);
        assertEq(pm.payoutWad(NO), 0);

        pm.settle(id);
        assertEq(usdc.balanceOf(trader) - t0, shares - debt, "trader gets shares at $1 minus debt");
        assertEq(pool.totalDebt(), 0);
        assertLe(usdc.balanceOf(address(pm)), 1, "nothing stranded");
        _assertPoolInvariant();
    }

    function test_noWins_debtWrittenOffJuniorFirst() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        uint256 debt = pm.debtOf(id);
        uint256 j0 = pool.trancheAssets(1);
        uint256 s0 = pool.trancheAssets(0);
        uint256 t0 = usdc.balanceOf(trader);

        _resolve(0, 1);
        pm.redeem(COND);
        pm.settle(id);

        assertEq(usdc.balanceOf(trader), t0, "trader gets nothing");
        assertApproxEqAbs(j0 - pool.trancheAssets(1), debt, 2, "junior eats the loss");
        assertEq(pool.trancheAssets(0), s0, "senior untouched");
        assertEq(pool.totalDebt(), 0);
        _assertPoolInvariant();
    }

    function test_fiftyFifty_twoPositions_noOverdraw() public {
        uint256 a = _open(1_000 * USD, 1_000 * USD);
        uint256 b = _open(333 * USD + 7, 500 * USD + 3); // odd amounts to exercise rounding
        _resolve(1, 1);
        pm.redeem(COND);
        assertEq(pm.payoutWad(YES), 0.5e18);
        pm.settle(a);
        pm.settle(b);
        assertEq(pool.totalDebt(), 0);
        _assertPoolInvariant();
    }

    function test_tradingStopsAtResolution() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        _resolve(1, 0);

        vm.prank(trader);
        vm.expectRevert(PositionManager.MarketResolved.selector);
        pm.close(id, 0);

        vm.expectRevert(PositionManager.MarketResolved.selector);
        pm.liquidate(id, type(uint256).max);

        vm.prank(trader);
        vm.expectRevert(PositionManager.MarketResolved.selector);
        pm.open(YES, 100 * USD, 0, 0);
    }

    function test_redeemAndSettleOrdering() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);

        vm.expectRevert(PositionManager.NotResolved.selector);
        pm.redeem(COND);
        vm.expectRevert(PositionManager.NotRedeemed.selector);
        pm.settle(id);

        _resolve(1, 0);
        vm.expectRevert(PositionManager.NotRedeemed.selector);
        pm.settle(id);

        pm.redeem(COND);
        vm.expectRevert(PositionManager.AlreadyRedeemed.selector);
        pm.redeem(COND);

        vm.expectRevert(PositionManager.NoCondition.selector);
        pm.redeem(keccak256("unknown"));
    }

    function test_absorbedInventoryRedeemsToJunior() public {
        pm.setAbsorbUnderwater(true);
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        (,, uint256 shares,) = pm.positions(id);

        _skip(10 minutes, 0.3e18); // value ~1.79k < debt 2k: underwater
        pm.absorb(id);
        assertEq(pm.inventory(YES), shares);
        uint256 j0 = pool.trancheAssets(1);

        _resolve(1, 0);
        pm.redeem(COND);
        assertEq(pm.inventory(YES), 0);
        assertApproxEqAbs(pool.trancheAssets(1) - j0, shares, 1, "inventory paid out at $1 to junior");
        _assertPoolInvariant();
    }

    function test_unclaimedLeftoversPaidInPoolAsset() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        _skip(10 minutes, 0.37e18); // LTV ~90%: liquidatable but solvent: leftovers go to the trader as claimable shares
        pm.liquidate(id, type(uint256).max);
        uint256 left = pm.claimableShares(trader, YES);
        assertGt(left, 0);

        _resolve(1, 0);
        pm.redeem(COND);
        uint256 t0 = usdc.balanceOf(trader);
        vm.prank(trader);
        pm.claimShares(YES);
        assertEq(usdc.balanceOf(trader) - t0, left, "leftover shares paid at $1");
        assertEq(ctf.balanceOf(trader, YES), 0);
    }
}

contract PauseTest is Base {
    address guardian = makeAddr("guardian");

    function setUp() public override {
        super.setUp();
        pm.setGuardian(guardian, true);
    }

    function test_pauseBlocksOpenOnly() public {
        uint256 id = _open(1_000 * USD, 1_000 * USD);
        vm.prank(guardian);
        pm.setPaused(true);

        vm.prank(trader);
        vm.expectRevert(PositionManager.IsPaused.selector);
        pm.open(YES, 100 * USD, 0, 0);

        vm.prank(trader);
        pm.close(id, 0); // exits always work
    }

    function test_onlyOwnerUnpauses() public {
        vm.prank(guardian);
        pm.setPaused(true);
        vm.prank(guardian);
        vm.expectRevert(PositionManager.NotGuardian.selector);
        pm.setPaused(false);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(PositionManager.NotGuardian.selector);
        pm.setPaused(true);
        pm.setPaused(false);
        assertFalse(pm.paused());
    }
}

contract DepositCapTest is Base {
    function test_capLimitsDeposits() public {
        pool.setDepositCaps(810_000 * USD, type(uint256).max); // senior holds 800k
        assertEq(senior.maxDeposit(lpSenior), 10_000 * USD);
        _deposit(lpSenior, senior, 10_000 * USD);
        assertEq(senior.maxDeposit(lpSenior), 0);
        usdc.mint(lpSenior, 1);
        vm.startPrank(lpSenior);
        usdc.approve(address(senior), 1);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit
        senior.deposit(1, lpSenior);
        vm.stopPrank();
    }

    function test_pauseStopsDepositsNotWithdrawals() public {
        address g = makeAddr("guardian");
        pool.setGuardian(g, true);
        vm.prank(g);
        pool.setDepositsPaused(true);
        assertEq(junior.maxDeposit(lpJunior), 0);
        vm.prank(lpJunior);
        junior.withdraw(1_000 * USD, lpJunior, lpJunior);
        vm.prank(g);
        vm.expectRevert(LendingPool.NotGuardian.selector);
        pool.setDepositsPaused(false);
    }
}
