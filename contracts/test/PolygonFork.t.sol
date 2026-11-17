// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import {KeeperOracle} from "../src/KeeperOracle.sol";
import {KeeperVenue} from "../src/KeeperVenue.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {TrancheVault} from "../src/TrancheVault.sol";
import {RiskEngine} from "../src/RiskEngine.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {ICtfRedeemer} from "../src/interfaces/IConditionalTokens.sol";

interface IRamp {
    function wrap(address asset, address to, uint256 amount) external;
    function unwrap(address asset, address to, uint256 amount) external;
}

interface ICTF {
    function splitPosition(address collateral, bytes32 parent, bytes32 conditionId, uint256[] calldata, uint256 amount)
        external;
    function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external;
    function payoutDenominator(bytes32 conditionId) external view returns (uint256);
}

/// @notice The whole protocol against Polymarket's real contracts on a Polygon fork: USDC.e (the CTF's own
///         collateral) as the pool asset, real CTF outcome tokens as collateral (stocked by splitting USDC.e on the
///         CTF, as the mainnet maker does), KeeperVenue fills, liquidation, absorb, and settlement by redeeming on
///         the CTF directly after resolving the real condition (pranking its UMA CTF adapter oracle).
///
///   POLYGON_RPC=https://polygon.drpc.org forge test --mc PolygonFork -vv   (needs an archive-capable RPC)
contract PolygonForkTest is Test, ERC1155Holder {
    // Polymarket on Polygon (ctf-exchange-v2 README; checked by keeper/src/polygon-facts.ts)
    IERC20 constant PUSD = IERC20(0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB);
    IERC20 constant USDCE = IERC20(0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174);
    IERC1155 constant CTF = IERC1155(0x4D97DCd97eC945f40cF65F87097ACe5EA0476045);
    address constant ONRAMP = 0x93070a847efEf7F70739046A929D47a521F5B8ee;
    address constant OFFRAMP = 0x2957922Eb93258b93368531d39fAcCA3B4dC5854;

    // "Will Anthropic's valuation hit (HIGH) $1.75T by December 31?" (deployments/polygon-markets.env)
    bytes32 constant COND = 0xc68fea7daba83292fdd7bb704f26d38c4f678cbc2ff69c4175d47c55e74b4321;
    bytes32 constant QUESTION = 0xd8cf3c86a1342940b484f68fec077e8426b128469f180ac0773d5c70656b10a3;
    address constant UMA_ORACLE = 0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7; // conditionId = keccak(oracle, question, 2)
    uint256 constant YES = 15764762514977439830369109742355894144447754077019561451046436564012758072460;
    uint256 constant NO = 68824290388674385176467771482523926661374466006709550624998958447771606894467;

    uint256 constant USD = 1e6;

    KeeperOracle oracle;
    KeeperVenue venue;
    LendingPool pool;
    TrancheVault senior;
    TrancheVault junior;
    RiskEngine risk;
    PositionManager pm;

    address maker = makeAddr("maker");
    address trader = makeAddr("trader");
    address lp = makeAddr("lp");

    function setUp() public {
        string memory rpc = vm.envOr("POLYGON_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        require(ICTF(address(CTF)).payoutDenominator(COND) == 0, "market already resolved; pick another");

        oracle = new KeeperOracle();
        oracle.setComplement(NO, YES);
        venue = new KeeperVenue(USDCE, CTF, oracle, maker);
        venue.setParams(150, 10 minutes);

        pool = new LendingPool(USDCE);
        senior = new TrancheVault(pool, 0, "Phoebe Senior", "phSR");
        junior = new TrancheVault(pool, 1, "Phoebe Junior", "phJR");
        pool.setVaults(address(senior), address(junior));
        pool.setDepositCaps(200 * USD, 100 * USD);

        risk = new RiskEngine();
        RiskEngine.Market memory m = RiskEngine.Market({
            listed: true,
            openEnabled: true,
            liqLtvBps: 8_500,
            openBufferBps: 1_000,
            resolutionTime: uint64(block.timestamp + 60 days),
            cutoffDuration: 1 days,
            rampDuration: 3 days,
            borrowCap: uint128(100 * USD)
        });
        risk.listMarket(YES, m);
        risk.listMarket(NO, m);

        pm = new PositionManager(USDCE, CTF, pool, risk, oracle, venue);
        pm.setParams(300, 15 minutes);
        pm.setAbsorbUnderwater(true);
        pm.setCondition(YES, NO, COND);
        pm.setRedeemer(ICtfRedeemer(address(CTF)));
        pool.setManager(address(pm));
        venue.setCaller(address(pm), true);

        oracle.setPrice(YES, 0.45e18);

        // LPs (at the caps), trader, liquidator (this contract)
        _usdce(lp, 300 * USD);
        vm.startPrank(lp);
        USDCE.approve(address(senior), type(uint256).max);
        USDCE.approve(address(junior), type(uint256).max);
        senior.deposit(200 * USD, lp);
        junior.deposit(100 * USD, lp);
        vm.stopPrank();
        _usdce(trader, 200 * USD);
        vm.prank(trader);
        USDCE.approve(address(pm), type(uint256).max);
        _usdce(address(this), 200 * USD);
        USDCE.approve(address(pm), type(uint256).max);

        // Maker: split 300 USDC.e into 300 YES + 300 NO on the CTF, keep 200 USDC.e for buybacks
        deal(address(USDCE), maker, 500 * USD);
        vm.startPrank(maker);
        USDCE.approve(address(CTF), 300 * USD);
        uint256[] memory partition = new uint256[](2);
        (partition[0], partition[1]) = (1, 2);
        ICTF(address(CTF)).splitPosition(address(USDCE), bytes32(0), COND, partition, 300 * USD);
        USDCE.approve(address(venue), type(uint256).max);
        CTF.setApprovalForAll(address(venue), true);
        vm.stopPrank();
        assertEq(CTF.balanceOf(maker, YES), 300 * USD, "split gave YES");
        assertEq(CTF.balanceOf(maker, NO), 300 * USD, "split gave NO");
    }

    function _usdce(address to, uint256 amt) internal {
        deal(address(USDCE), to, USDCE.balanceOf(to) + amt);
    }

    function _assertPoolInvariant() internal view {
        assertApproxEqAbs(pool.trancheAssets(0) + pool.trancheAssets(1), pool.cash() + pool.totalDebt(), 10, "S + J == cash + debt");
    }

    function test_openCloseWithRealOutcomeTokens() public {
        uint256 t0 = USDCE.balanceOf(trader);
        vm.prank(trader);
        uint256 id = pm.open(YES, 20 * USD, 20 * USD, 0); // 2x
        (,, uint256 shares,) = pm.positions(id);
        assertEq(CTF.balanceOf(address(pm), YES), shares, "PM holds real YES shares");

        skip(60);
        oracle.setPrice(YES, 0.5e18); // +5c
        vm.prank(trader);
        pm.close(id, 0);
        assertEq(CTF.balanceOf(address(pm), YES), 0);
        assertGt(USDCE.balanceOf(trader), t0, "profitable after +5c at 2x, net of spread and fee");
        assertEq(pool.totalDebt(), 0);
        _assertPoolInvariant();
    }

    function test_liquidationPaysOutRealShares() public {
        vm.prank(trader);
        uint256 id = pm.open(YES, 15 * USD, 25 * USD, 0);
        skip(30);
        oracle.setPrice(YES, 0.3e18);
        assertTrue(pm.health(id).liquidatable);
        pm.liquidate(id, type(uint256).max);
        assertGt(CTF.balanceOf(address(this), YES), 0, "liquidator received real YES shares");
        _assertPoolInvariant();
    }

    function test_settlementRedeemsOnCtf() public {
        // one live position and one absorbed into inventory
        vm.prank(trader);
        uint256 live = pm.open(YES, 30 * USD, 20 * USD, 0);
        vm.prank(trader);
        uint256 sunk = pm.open(YES, 10 * USD, 15 * USD, 0);
        skip(30);
        oracle.setPrice(YES, 0.12e18);
        pm.absorb(sunk);
        (,, uint256 liveShares,) = pm.positions(live);
        uint256 inv = pm.inventory(YES);
        assertGt(inv, 0);

        // resolve the real condition YES, as its UMA CTF adapter would
        uint256[] memory payouts = new uint256[](2);
        payouts[0] = 1;
        vm.prank(UMA_ORACLE);
        ICTF(address(CTF)).reportPayouts(QUESTION, payouts);

        uint256 j0 = pool.trancheAssets(1);
        uint256 t0 = USDCE.balanceOf(trader);
        uint256 debt = pm.debtOf(live);
        pm.redeem(COND);
        assertEq(CTF.balanceOf(address(pm), YES), 0, "CTF redeemed everything");
        assertApproxEqAbs(pool.trancheAssets(1) - j0, inv, 1, "inventory paid to junior at $1");

        pm.settle(live);
        assertEq(USDCE.balanceOf(trader) - t0, liveShares - debt, "trader paid shares at $1 minus debt");
        assertLe(USDCE.balanceOf(address(pm)), 2, "no USDC.e stranded in the manager");
        assertEq(pool.totalDebt(), 0);
        _assertPoolInvariant();
    }

    function test_depositCapHolds() public {
        assertEq(senior.maxDeposit(lp), 0);
        _usdce(lp, 1 * USD);
        vm.prank(lp);
        vm.expectRevert();
        senior.deposit(1 * USD, lp);
    }

    /// The maker's CLOB float: venue proceeds arrive in USDC.e, Polymarket's exchange settles in pUSD. The ramps
    /// convert 1:1 both ways.
    function test_makerRampsUsdceAndPusd() public {
        vm.startPrank(maker);
        USDCE.approve(ONRAMP, 50 * USD);
        IRamp(ONRAMP).wrap(address(USDCE), maker, 50 * USD);
        assertEq(PUSD.balanceOf(maker), 50 * USD);
        PUSD.approve(OFFRAMP, 20 * USD);
        IRamp(OFFRAMP).unwrap(address(USDCE), maker, 20 * USD);
        vm.stopPrank();
        assertEq(PUSD.balanceOf(maker), 30 * USD);
        assertEq(USDCE.balanceOf(maker), 170 * USD);
    }
}
