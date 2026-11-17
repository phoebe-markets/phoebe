// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockVenue} from "../src/mocks/MockVenue.sol";
import {KeeperVenue} from "../src/KeeperVenue.sol";
import {IExecutionVenue} from "../src/interfaces/IExecutionVenue.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KeeperOracle} from "../src/KeeperOracle.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {TrancheVault} from "../src/TrancheVault.sol";
import {RiskEngine} from "../src/RiskEngine.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {IVolatilityOracle} from "../src/interfaces/IVolatilityOracle.sol";
import {ICtfRedeemer} from "../src/interfaces/IConditionalTokens.sol";

/// @title Deploy
/// @notice Local (Anvil) deployment of the whole protocol with the backtested "full" risk config
///         (sim/RESULTS.md), mock Polymarket (USDC, CTF, venue), funded demo accounts, and seeded LP tranches.
///
///   anvil &
///   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
/// Markets (mock deployments): market i trades tokens 2i+1 (YES) and 2i+2 (NO). Configure with env:
///   MARKET_RESOLUTIONS  comma-separated unix times   (default: one market, now + 30 days)
///   MARKET_PRICES       comma-separated YES prices * 1e6 (default 500000)
///   MARKET_NAMES        comma-separated display names (default "market-0", ...)
///   MARKET_MAX_POSITION comma-separated per-position borrow caps in USD, 0 = unlimited (default 0).
///                       Recommended: ~3% of the market's daily volume (sim/RESULTS.md, round 3).
/// Writes ../deployments/<DEPLOYMENT>.json for the keepers and the UI.
///
/// Networks (env):
///   DEPLOYMENT     output name (default "local")
///   DEPLOYER_PK    deployer key (default: Anvil #0). On a testnet the deployer also seeds both LP tranches.
///   KEEPER_ADDR    keeper / oracle updater / market maker (default: Anvil #1)
///   VENUE          "mock" (fills at oracle +/- spread from a float; replay demos) or "keeper" (KeeperVenue: fills
///                  from the keeper's inventory, the Path B design; testnet). Default "mock".
///   POLY_TOKEN_IDS comma-separated Polymarket YES token ids per market (recorded for the keeper's live feed)
///   LP_SEED_USD    LP seed on testnets (default 1,000,000 mock USDC; 80% senior / 20% junior)
/// On chain 31337 the Anvil demo accounts (trader, LPs, keeper) are funded and approved as before.
///
/// Polygon mainnet (NETWORK=polygon; demo/polygon.sh sets this up from deployments/polygon-markets.env):
///   real Polymarket contracts, no mocks, no minting, no LP seed. Market i trades Polymarket's own token ids.
///   POLY_COLLATERAL     pool asset: USDC.e, the CTF's own collateral (positions redeem on the CTF directly)
///   POLY_CTF            ConditionalTokens (also the redeemer)
///   POLY_TOKEN_IDS / POLY_NO_TOKEN_IDS / CONDITION_IDS   per market
///   SENIOR_CAP_USD / JUNIOR_CAP_USD (default 200 / 100), MARKET_MAX_POSITION (default 30 each),
///   MAX_POSITION_SIZE_USD margin + borrow per position, all markets (default 40; the hedger sizes orders off it),
///   MARKET_BORROW_CAP_USD (default 100), VENUE_SPREAD_BPS (default 150)
///   Launch guards: KeeperVenue max price age 10 min, PositionManager 15 min,
///   the keeper is a guardian everywhere (it can pause; only the deployer/owner un-pauses).
/// Mock deployments (local, Amoy) also get a condition per market, so settlement can be rehearsed with
/// MockCTF.reportPayouts.
contract Deploy is Script {
    // Anvil's default dev accounts (public, test-only keys).
    uint256 constant DEPLOYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant KEEPER_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant SENIOR_LP_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant JUNIOR_LP_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant TRADER_PK = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;

    uint256 constant USD = 1e6;

    struct Deployed {
        IERC20 usdc;
        IERC1155 ctf;
        KeeperOracle oracle;
        IExecutionVenue venue;
        LendingPool pool;
        TrancheVault senior;
        TrancheVault junior;
        RiskEngine risk;
        PositionManager pm;
    }

    struct Markets {
        uint256[] res;
        uint256[] px;
        uint256[] maxPos;
        uint256[] yes;
        uint256[] no;
        bytes32[] cond;
        uint256 maxSize; // USDC, 0 = none
    }

    function run() external {
        Markets memory mk;
        mk.res = vm.envOr("MARKET_RESOLUTIONS", ",", _one(block.timestamp + 30 days));
        mk.px = vm.envOr("MARKET_PRICES", ",", _one(500_000));
        require(mk.res.length == mk.px.length, "MARKET_RESOLUTIONS / MARKET_PRICES length");
        mk.maxPos = vm.envOr("MARKET_MAX_POSITION", ",", new uint256[](mk.res.length));
        require(mk.maxPos.length == mk.res.length, "MARKET_MAX_POSITION length");

        uint256 deployerPk = vm.envOr("DEPLOYER_PK", DEPLOYER_PK);
        address keeper = vm.envOr("KEEPER_ADDR", vm.addr(KEEPER_PK));
        bool keeperVenue = keccak256(bytes(vm.envOr("VENUE", string("mock")))) == keccak256("keeper");
        bool local = block.chainid == 31337;
        bool mainnet = keccak256(bytes(vm.envOr("NETWORK", string("")))) == keccak256("polygon");
        if (mainnet) {
            require(block.chainid == 137, "NETWORK=polygon but not chain 137");
            require(keeperVenue, "mainnet needs VENUE=keeper");
            require(vm.envOr("KEEPER_ADDR", address(0)) != address(0), "set KEEPER_ADDR");
        }
        Deployed memory d;

        // Token ids and conditions: market i = (mk.yes[i], mk.no[i], mk.cond[i])
        mk.yes = new uint256[](mk.res.length);
        mk.no = new uint256[](mk.res.length);
        mk.cond = new bytes32[](mk.res.length);
        if (mainnet) {
            mk.yes = vm.envUint("POLY_TOKEN_IDS", ",");
            mk.no = vm.envUint("POLY_NO_TOKEN_IDS", ",");
            mk.cond = vm.envBytes32("CONDITION_IDS", ",");
            require(mk.yes.length == mk.res.length && mk.no.length == mk.res.length && mk.cond.length == mk.res.length, "market lists");
        } else {
            for (uint256 i; i < mk.res.length; ++i) {
                (mk.yes[i], mk.no[i]) = (2 * i + 1, 2 * i + 2);
                mk.cond[i] = keccak256(abi.encodePacked("phoebe-mock-market-", vm.toString(i)));
            }
        }

        vm.startBroadcast(deployerPk);
        MockCTF mockCtf;
        MockUSDC mockUsdc;
        if (mainnet) {
            d.usdc = IERC20(vm.envAddress("POLY_COLLATERAL"));
            d.ctf = IERC1155(vm.envAddress("POLY_CTF"));
        } else {
            mockUsdc = new MockUSDC();
            mockCtf = new MockCTF();
            (d.usdc, d.ctf) = (IERC20(address(mockUsdc)), IERC1155(address(mockCtf)));
            for (uint256 i; i < mk.res.length; ++i) mockCtf.setCondition(mk.cond[i], mk.yes[i], mk.no[i]);
        }
        d.oracle = new KeeperOracle();
        if (keeperVenue) {
            KeeperVenue kv = new KeeperVenue(d.usdc, d.ctf, d.oracle, keeper);
            if (mainnet) {
                kv.setParams(vm.envOr("VENUE_SPREAD_BPS", uint256(150)), 10 minutes);
            } else {
                kv.setParams(50, 1 hours); // 0.5% spread; the keeper's live heartbeat (55 min) keeps prices fresher than this
                // testnet stand-in for "the keeper buys shares on Polymarket": it may mint mock outcome tokens
                mockCtf.setMinter(keeper, true);
            }
            d.venue = kv;
        } else {
            MockVenue mv = new MockVenue(d.usdc, mockCtf, d.oracle, 50);
            d.venue = mv;
            mockCtf.setMinter(address(mv), true);
            mockUsdc.mint(address(mv), 100_000_000 * USD);
        }

        d.pool = new LendingPool(d.usdc);
        d.senior = new TrancheVault(d.pool, 0, "Phoebe Senior", "phSR");
        d.junior = new TrancheVault(d.pool, 1, "Phoebe Junior", "phJR");
        d.pool.setVaults(address(d.senior), address(d.junior));

        d.risk = new RiskEngine();
        d.risk.setVolParams(IVolatilityOracle(address(d.oracle)), 1 days, 20_000); // k = 2
        d.risk.setJumpAllowance(0.1e18);
        d.risk.setGuardian(keeper, true);

        d.pm = new PositionManager(d.usdc, d.ctf, d.pool, d.risk, d.oracle, d.venue);
        // 3% starting liquidator bonus; stale prices block opens/liquidations (1h on testnets, 15 min on mainnet)
        d.pm.setParams(300, mainnet ? 15 minutes : 1 hours);
        d.pm.setBonusRamp(100, 1_500); // Dutch auction: +1%/h once flagged, up to 15%
        d.pm.setFees(30, 200); // 0.3% opening fee, 2% liquidation fee -> junior
        d.pm.setAbsorbUnderwater(true);
        d.pm.setKeeper(keeper, true);
        d.pool.setManager(address(d.pm));
        if (keeperVenue) KeeperVenue(address(d.venue)).setCaller(address(d.pm), true);
        d.pm.setRedeemer(ICtfRedeemer(mainnet ? vm.envAddress("POLY_CTF") : address(mockCtf)));
        d.pm.setGuardian(keeper, true);
        d.pool.setGuardian(keeper, true);
        if (mainnet) {
            d.pool.setDepositCaps(vm.envOr("SENIOR_CAP_USD", uint256(200)) * USD, vm.envOr("JUNIOR_CAP_USD", uint256(100)) * USD);
        }

        d.oracle.setUpdater(keeper, true);
        uint256 borrowCap = (mainnet ? vm.envOr("MARKET_BORROW_CAP_USD", uint256(100)) : 500_000) * USD;
        if (mainnet && bytes(vm.envOr("MARKET_MAX_POSITION", string(""))).length == 0) {
            for (uint256 i; i < mk.maxPos.length; ++i) mk.maxPos[i] = 30;
        }
        if (mainnet) mk.maxSize = vm.envOr("MAX_POSITION_SIZE_USD", uint256(40)) * USD;
        _listMarkets(d, mk, borrowCap);

        if (mainnet) {
            // nothing to mint or seed: LPs, the maker's inventory and liquidation capital are real money
            vm.stopBroadcast();
        } else if (local) {
            mockUsdc.mint(keeper, 1_000_000 * USD); // liquidation capital + (keeper venue) buyback float
            // Anvil demo accounts
            mockUsdc.mint(vm.addr(SENIOR_LP_PK), 800_000 * USD);
            mockUsdc.mint(vm.addr(JUNIOR_LP_PK), 200_000 * USD);
            mockUsdc.mint(vm.addr(TRADER_PK), 1_000_000 * USD);
            vm.stopBroadcast();

            _lp(SENIOR_LP_PK, d, d.senior, 800_000 * USD);
            _lp(JUNIOR_LP_PK, d, d.junior, 200_000 * USD);

            vm.startBroadcast(TRADER_PK);
            d.usdc.approve(address(d.pm), type(uint256).max);
            vm.stopBroadcast();
            vm.startBroadcast(KEEPER_PK);
            d.usdc.approve(address(d.pm), type(uint256).max);
            vm.stopBroadcast();
        } else {
            // testnet: the deployer seeds both tranches; the keeper sets its own approvals at startup
            mockUsdc.mint(keeper, 1_000_000 * USD); // liquidation capital + (keeper venue) buyback float
            uint256 seed = vm.envOr("LP_SEED_USD", uint256(1_000_000)) * USD;
            address me = vm.addr(deployerPk);
            mockUsdc.mint(me, seed);
            d.usdc.approve(address(d.senior), seed);
            d.usdc.approve(address(d.junior), seed);
            d.senior.deposit(seed * 8 / 10, me);
            d.junior.deposit(seed - seed * 8 / 10, me);
            vm.stopBroadcast();
        }

        _write(d, mk, keeper, keeperVenue, mainnet);
    }

    function _listMarkets(Deployed memory d, Markets memory mk, uint256 borrowCap) internal {
        for (uint256 i; i < mk.res.length; ++i) {
            RiskEngine.Market memory m = RiskEngine.Market({
                listed: true,
                openEnabled: true,
                liqLtvBps: 8_500,
                openBufferBps: 1_000,
                resolutionTime: uint64(mk.res[i]),
                cutoffDuration: 1 days,
                rampDuration: 3 days,
                borrowCap: uint128(borrowCap)
            });
            d.risk.listMarket(mk.yes[i], m);
            d.risk.listMarket(mk.no[i], m);
            if (mk.maxPos[i] > 0) {
                uint256[] memory pair = new uint256[](2);
                (pair[0], pair[1]) = (mk.yes[i], mk.no[i]);
                d.risk.setMaxPositionBorrow(pair, mk.maxPos[i] * USD);
            }
            if (mk.maxSize > 0) {
                uint256[] memory pair = new uint256[](2);
                (pair[0], pair[1]) = (mk.yes[i], mk.no[i]);
                d.risk.setMaxPositionSize(pair, mk.maxSize);
            }
            d.oracle.setComplement(mk.no[i], mk.yes[i]); // NO = 1 - YES: one stored feed per market
            d.oracle.setPrice(mk.yes[i], mk.px[i] * 1e12);
            d.pm.setCondition(mk.yes[i], mk.no[i], mk.cond[i]);
        }
    }

    function _lp(uint256 pk, Deployed memory d, TrancheVault v, uint256 amt) internal {
        vm.startBroadcast(pk);
        d.usdc.approve(address(v), amt);
        v.deposit(amt, vm.addr(pk));
        vm.stopBroadcast();
    }

    function _write(Deployed memory d, Markets memory mk, address keeper, bool keeperVenue, bool mainnet) internal {
        uint256[] memory res = mk.res;
        string[] memory names = new string[](res.length);
        for (uint256 i; i < res.length; ++i) names[i] = string.concat("market-", vm.toString(i));
        names = vm.envOr("MARKET_NAMES", ",", names);
        require(names.length == res.length, "MARKET_NAMES length");
        string[] memory tokenIds = new string[](2 * res.length);
        for (uint256 i; i < res.length; ++i) {
            (tokenIds[2 * i], tokenIds[2 * i + 1]) = (vm.toString(mk.yes[i]), vm.toString(mk.no[i]));
        }

        string memory k = "deploy";
        string memory name = vm.envOr("DEPLOYMENT", string("local"));
        // token ids as decimal strings: Polymarket's are 256-bit, beyond JSON number precision in JS
        vm.serializeString(k, "tokenIds", tokenIds);
        vm.serializeBytes32(k, "conditionIds", mk.cond);
        vm.serializeBool(k, "mockCtf", !mainnet);
        vm.serializeString(k, "marketSlugs", vm.envOr("MARKET_SLUGS", ",", new string[](0)));
        vm.serializeString(k, "venueType", keeperVenue ? "keeper" : "mock");
        vm.serializeBool(k, "complementNo", true);
        vm.serializeString(k, "polyTokenIds", vm.envOr("POLY_TOKEN_IDS", ",", new string[](0)));
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "markets", res.length);
        vm.serializeString(k, "names", names);
        vm.serializeUint(k, "resolutionTimes", res);
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
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", name, ".json");
        vm.writeJson(out, path);
        console.log("deployment written to", path);
    }

    function _one(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }
}
