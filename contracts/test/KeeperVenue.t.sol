// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {Base} from "./Base.t.sol";
import {KeeperVenue} from "../src/KeeperVenue.sol";
import {PositionManager} from "../src/PositionManager.sol";

/// Full protocol on top of KeeperVenue: the maker's wallet holds inventory; the PositionManager trades against it.
contract KeeperVenueTest is Base {
    KeeperVenue kv;
    address maker = makeAddr("maker");

    function setUp() public override {
        super.setUp();
        kv = new KeeperVenue(IERC20(address(usdc)), IERC1155(address(ctf)), oracle, maker);
        kv.setCaller(address(pm), true);
        pm.setVenue(kv);

        // maker inventory: shares (minted here as a stand-in for "bought on Polymarket") and USDC for buybacks
        ctf.setMinter(address(this), true);
        ctf.mint(maker, YES, 100_000e6);
        usdc.mint(maker, 100_000 * USD);
        vm.startPrank(maker);
        ctf.setApprovalForAll(address(kv), true);
        usdc.approve(address(kv), type(uint256).max);
        vm.stopPrank();
    }

    function test_openFillsFromMakerAtOraclePlusSpread() public {
        uint256 makerShares0 = ctf.balanceOf(maker, YES);
        uint256 makerUsd0 = usdc.balanceOf(maker);
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        (,, uint256 shares,) = pm.positions(id);

        // 3000 USDC at ask 0.5 * 1.005
        assertEq(shares, uint256(3_000 * USD) * 1e18 / 0.5025e18);
        assertEq(makerShares0 - ctf.balanceOf(maker, YES), shares, "shares came from the maker");
        assertEq(usdc.balanceOf(maker) - makerUsd0, 3_000 * USD, "maker got paid");
        assertEq(ctf.balanceOf(address(pm), YES), shares);
    }

    function test_closeSellsBackToMakerAtOracleMinusSpread() public {
        uint256 id = _open(1_000 * USD, 2_000 * USD);
        (,, uint256 shares,) = pm.positions(id);
        oracle.setPrice(YES, 0.6e18);
        uint256 makerUsd0 = usdc.balanceOf(maker);

        vm.prank(trader);
        pm.close(id, 0);

        uint256 proceeds = shares * 0.597e18 / 1e18;
        assertEq(makerUsd0 - usdc.balanceOf(maker), proceeds, "maker paid the bid");
        assertEq(ctf.balanceOf(address(pm), YES), 0);
        _assertPoolInvariant();
    }

    function test_onlyAllowlistedCallers() public {
        usdc.mint(address(this), 1_000 * USD);
        usdc.approve(address(kv), type(uint256).max);
        vm.expectRevert(KeeperVenue.NotCaller.selector);
        kv.buy(YES, 1_000 * USD, 0);
    }

    function test_inactiveMakerBlocksOpens() public {
        vm.prank(maker);
        kv.setActive(false);
        vm.prank(trader);
        vm.expectRevert(KeeperVenue.Inactive.selector);
        pm.open(YES, 1_000 * USD, 1_000 * USD, 0);
    }

    function test_stalePriceBlocksFills() public {
        skip(6 minutes); // venue max age 5m (PositionManager allows 10m, so the venue is the binding check)
        vm.prank(trader);
        vm.expectRevert(KeeperVenue.StalePrice.selector);
        pm.open(YES, 1_000 * USD, 1_000 * USD, 0);
    }

    function test_makerWithoutInventoryFailsCleanly() public {
        vm.prank(maker);
        ctf.setApprovalForAll(address(kv), false);
        vm.prank(trader);
        vm.expectRevert(); // ERC1155MissingApprovalForAll: the open reverts as a whole, nothing is borrowed
        pm.open(YES, 1_000 * USD, 2_000 * USD, 0);
        assertEq(pool.totalDebt(), 0);
    }

    function test_spreadIsCapped() public {
        vm.expectRevert(KeeperVenue.BadParams.selector);
        kv.setParams(301, 5 minutes);
        kv.setParams(300, 5 minutes);
        assertEq(kv.askWad(YES), 0.515e18);
        assertEq(kv.bidWad(YES), 0.485e18);
    }

    function test_onlyMakerOrOwnerToggles() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert(KeeperVenue.NotMaker.selector);
        kv.setActive(false);
    }
}
