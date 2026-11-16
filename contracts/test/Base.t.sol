// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockOracle} from "../src/mocks/MockOracle.sol";
import {MockVenue} from "../src/mocks/MockVenue.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {TrancheVault} from "../src/TrancheVault.sol";
import {RiskEngine} from "../src/RiskEngine.sol";
import {PositionManager} from "../src/PositionManager.sol";

contract Base is Test, ERC1155Holder {
    uint256 constant USD = 1e6;
    uint256 constant YES = 1;

    MockUSDC usdc;
    MockCTF ctf;
    MockOracle oracle;
    MockVenue venue;
    LendingPool pool;
    TrancheVault senior;
    TrancheVault junior;
    RiskEngine risk;
    PositionManager pm;

    address lpSenior = makeAddr("lpSenior");
    address lpJunior = makeAddr("lpJunior");
    address trader = makeAddr("trader");
    address liquidator; // this test contract (it's an ERC1155 receiver)

    uint64 resolution;

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        liquidator = address(this);

        usdc = new MockUSDC();
        ctf = new MockCTF();
        oracle = new MockOracle();
        venue = new MockVenue(usdc, ctf, oracle, 50); // 0.5% half-spread
        ctf.setMinter(address(venue), true);
        usdc.mint(address(venue), 10_000_000 * USD);

        pool = new LendingPool(usdc);
        senior = new TrancheVault(pool, 0, "Phoebe Senior", "phSR");
        junior = new TrancheVault(pool, 1, "Phoebe Junior", "phJR");
        pool.setVaults(address(senior), address(junior));

        risk = new RiskEngine();
        resolution = uint64(block.timestamp + 30 days);
        risk.listMarket(
            YES,
            RiskEngine.Market({
                listed: true,
                openEnabled: true,
                liqLtvBps: 8_500,
                openBufferBps: 1_000,
                resolutionTime: resolution,
                cutoffDuration: 1 days,
                rampDuration: 3 days,
                borrowCap: 500_000 * uint128(USD)
            })
        );

        pm = new PositionManager(usdc, IERC1155(address(ctf)), pool, risk, oracle, venue);
        pool.setManager(address(pm));

        oracle.setPrice(YES, 0.5e18);

        _deposit(lpSenior, senior, 800_000 * USD);
        _deposit(lpJunior, junior, 200_000 * USD);

        usdc.mint(trader, 100_000 * USD);
        vm.prank(trader);
        usdc.approve(address(pm), type(uint256).max);

        usdc.mint(liquidator, 1_000_000 * USD);
        usdc.approve(address(pm), type(uint256).max);
    }

    function _deposit(address who, TrancheVault v, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(v), amt);
        v.deposit(amt, who);
        vm.stopPrank();
    }

    function _open(uint256 margin, uint256 borrow) internal returns (uint256 id) {
        vm.prank(trader);
        id = pm.open(YES, margin, borrow, 0);
    }

    /// Advance time and refresh the oracle so prices aren't stale.
    function _skip(uint256 dt, uint256 price) internal {
        skip(dt);
        oracle.setPrice(YES, price);
    }

    function _assertPoolInvariant() internal view {
        uint256 lhs = pool.trancheAssets(0) + pool.trancheAssets(1);
        uint256 rhs = pool.cash() + pool.totalDebt();
        assertApproxEqAbs(lhs, rhs, 10, "S + J == cash + debt");
    }
}
