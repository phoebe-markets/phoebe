// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockVenue} from "../src/mocks/MockVenue.sol";
import {KeeperOracle} from "../src/KeeperOracle.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {TrancheVault} from "../src/TrancheVault.sol";
import {RiskEngine} from "../src/RiskEngine.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {IVolatilityOracle} from "../src/interfaces/IVolatilityOracle.sol";

/// @title Deploy
/// @notice Local (Anvil) deployment of the whole protocol with the backtested "full" risk config
///         (sim/RESULTS.md), mock Polymarket (USDC, CTF, venue), funded demo accounts, and seeded LP tranches.
///
///   anvil &
///   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
/// Markets: market i trades tokens 2i+1 (YES) and 2i+2 (NO). Configure with env:
///   MARKET_RESOLUTIONS  comma-separated unix times   (default: one market, now + 30 days)
///   MARKET_PRICES       comma-separated YES prices * 1e6 (default 500000)
///   MARKET_MAX_POSITION comma-separated per-position borrow caps in USD, 0 = unlimited (default 0).
///                       Recommended: ~3% of the market's daily volume (sim/RESULTS.md, round 3).
/// Writes ../deployments/local.json for the keepers and the UI.
contract Deploy is Script {
    // Anvil's default dev accounts (public, test-only keys).
    uint256 constant DEPLOYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant KEEPER_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant SENIOR_LP_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant JUNIOR_LP_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant TRADER_PK = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;

    uint256 constant USD = 1e6;

    struct Deployed {
        MockUSDC usdc;
        MockCTF ctf;
        KeeperOracle oracle;
        MockVenue venue;
        LendingPool pool;
        TrancheVault senior;
        TrancheVault junior;
        RiskEngine risk;
        PositionManager pm;
    }

    function run() external {
        uint256[] memory res = vm.envOr("MARKET_RESOLUTIONS", ",", _one(block.timestamp + 30 days));
        uint256[] memory px = vm.envOr("MARKET_PRICES", ",", _one(500_000));
        require(res.length == px.length, "MARKET_RESOLUTIONS / MARKET_PRICES length");
        uint256[] memory maxPos = vm.envOr("MARKET_MAX_POSITION", ",", new uint256[](res.length));
        require(maxPos.length == res.length, "MARKET_MAX_POSITION length");

        address keeper = vm.addr(KEEPER_PK);
        Deployed memory d;

        vm.startBroadcast(DEPLOYER_PK);
        d.usdc = new MockUSDC();
        d.ctf = new MockCTF();
        d.oracle = new KeeperOracle();
        d.venue = new MockVenue(d.usdc, d.ctf, d.oracle, 50);
        d.ctf.setMinter(address(d.venue), true);
        d.usdc.mint(address(d.venue), 100_000_000 * USD);

        d.pool = new LendingPool(d.usdc);
        d.senior = new TrancheVault(d.pool, 0, "Phoebe Senior", "phSR");
        d.junior = new TrancheVault(d.pool, 1, "Phoebe Junior", "phJR");
        d.pool.setVaults(address(d.senior), address(d.junior));

        d.risk = new RiskEngine();
        d.risk.setVolParams(IVolatilityOracle(address(d.oracle)), 1 days, 20_000); // k = 2
        d.risk.setJumpAllowance(0.1e18);
        d.risk.setGuardian(keeper, true);

        d.pm = new PositionManager(d.usdc, IERC1155(address(d.ctf)), d.pool, d.risk, d.oracle, d.venue);
        d.pm.setParams(300, 1 hours); // 3% starting liquidator bonus; prices older than 1h block opens/liquidations
        d.pm.setBonusRamp(100, 1_500); // Dutch auction: +1%/h once flagged, up to 15%
        d.pm.setFees(30, 200); // 0.3% opening fee, 2% liquidation fee -> junior
        d.pm.setAbsorbUnderwater(true);
        d.pm.setKeeper(keeper, true);
        d.pool.setManager(address(d.pm));

        d.oracle.setUpdater(keeper, true);
        for (uint256 i; i < res.length; ++i) {
            RiskEngine.Market memory m = RiskEngine.Market({
                listed: true,
                openEnabled: true,
                liqLtvBps: 8_500,
                openBufferBps: 1_000,
                resolutionTime: uint64(res[i]),
                cutoffDuration: 1 days,
                rampDuration: 3 days,
                borrowCap: uint128(500_000 * USD)
            });
            d.risk.listMarket(2 * i + 1, m);
            d.risk.listMarket(2 * i + 2, m);
            if (maxPos[i] > 0) {
                uint256[] memory pair = new uint256[](2);
                (pair[0], pair[1]) = (2 * i + 1, 2 * i + 2);
                d.risk.setMaxPositionBorrow(pair, maxPos[i] * USD);
            }
            d.oracle.setPrice(2 * i + 1, px[i] * 1e12);
            d.oracle.setPrice(2 * i + 2, 1e18 - px[i] * 1e12);
        }

        // fund demo accounts
        d.usdc.mint(vm.addr(SENIOR_LP_PK), 800_000 * USD);
        d.usdc.mint(vm.addr(JUNIOR_LP_PK), 200_000 * USD);
        d.usdc.mint(vm.addr(TRADER_PK), 1_000_000 * USD);
        d.usdc.mint(keeper, 1_000_000 * USD); // liquidation capital
        vm.stopBroadcast();

        _lp(SENIOR_LP_PK, d, d.senior, 800_000 * USD);
        _lp(JUNIOR_LP_PK, d, d.junior, 200_000 * USD);

        vm.startBroadcast(TRADER_PK);
        d.usdc.approve(address(d.pm), type(uint256).max);
        vm.stopBroadcast();
        vm.startBroadcast(KEEPER_PK);
        d.usdc.approve(address(d.pm), type(uint256).max);
        vm.stopBroadcast();

        _write(d, res.length, keeper);
    }

    function _lp(uint256 pk, Deployed memory d, TrancheVault v, uint256 amt) internal {
        vm.startBroadcast(pk);
        d.usdc.approve(address(v), amt);
        v.deposit(amt, vm.addr(pk));
        vm.stopBroadcast();
    }

    function _write(Deployed memory d, uint256 nMarkets, address keeper) internal {
        string memory k = "deploy";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "markets", nMarkets);
        vm.serializeAddress(k, "usdc", address(d.usdc));
        vm.serializeAddress(k, "ctf", address(d.ctf));
        vm.serializeAddress(k, "oracle", address(d.oracle));
        vm.serializeAddress(k, "venue", address(d.venue));
        vm.serializeAddress(k, "pool", address(d.pool));
        vm.serializeAddress(k, "senior", address(d.senior));
        vm.serializeAddress(k, "junior", address(d.junior));
        vm.serializeAddress(k, "risk", address(d.risk));
        vm.serializeAddress(k, "keeper", keeper);
        vm.serializeAddress(k, "trader", vm.addr(TRADER_PK));
        string memory out = vm.serializeAddress(k, "positionManager", address(d.pm));
        vm.writeJson(out, string.concat(vm.projectRoot(), "/../deployments/local.json"));
        console.log("deployment written to deployments/local.json");
    }

    function _one(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }
}
