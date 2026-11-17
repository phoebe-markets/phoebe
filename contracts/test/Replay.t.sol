// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {KeeperOracle} from "../src/KeeperOracle.sol";
import {MockVenue} from "../src/mocks/MockVenue.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {TrancheVault} from "../src/TrancheVault.sol";
import {RiskEngine} from "../src/RiskEngine.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {IVolatilityOracle} from "../src/interfaces/IVolatilityOracle.sol";

/// @title Replay
/// @notice Replays a real Polymarket price history through two copies of the protocol:
///   - "phoebe": price bands + time ramp + volatility cap + junior/senior tranches with coverage
///   - "naive":  same base LTVs, but flat (no bands, no ramp, no vol cap) and a single undivided LP pool
/// The same synthetic traders run in both: every OPEN_EVERY one opens at TARGET% of the max LTV allowed at
/// that moment, alternating YES / NO, and tries to close after HOLD. A liquidator bot sweeps every tick.
///
///   REPLAY=biden-nominee forge test --mc Replay -vv              # console report + sim/out/<name>.csv
///   REPLAY=batch/<slug> SUMMARY=<tag>/<slug>.json forge test ...   # JSON summary only (used by sim/backtest.sh)
///
/// Skipped unless REPLAY is set. All knobs are env vars (see `_loadConfig`).
contract Replay is Test, ERC1155Holder {
    uint256 constant USD = 1e6;
    uint256 constant YES = 1;
    uint256 constant NO = 2;
    uint256 constant LP_TOTAL = 1_000_000 * USD;

    struct Config {
        uint256 margin;
        uint256 openEvery;
        uint256 hold;
        uint256 targetBps; // fraction of max LTV traders use
        uint16 liqLtv;
        uint16 openBuffer;
        uint32 volK;
        uint32 volHorizon;
        uint32 rampDays;
        uint32 cutoffHours;
        uint256 bonusBps;
        uint256 coverageBps;
        uint256 juniorShareBps;
        bool bands;
        bool runNaive;
        uint64 jumpWad;
        bool median;
        uint256 openFeeBps;
        uint256 liqFeeBps;
        uint256 baseRate; // WAD/yr
        uint256 slope1;
        uint256 attentiveBps; // 0 = lazy traders. Else: close voluntarily once LTV >= this fraction of liq LTV
    }

    struct World {
        string name;
        LendingPool pool;
        TrancheVault senior;
        TrancheVault junior;
        RiskEngine risk;
        PositionManager pm;
        uint256[] open;
        uint256[] openedAt;
        uint256 opened;
        uint256 closed;
        uint256 liquidations;
        uint256 badDebtEvents;
        uint256 badDebt;
        uint256 maxSingleBadDebt;
        uint256 skipped;
        uint256 volume;
        uint256 peakDebt;
        uint256 solventLiqs; // liquidated with no bad debt
        uint256 traderPenalty; // value of shares seized minus USDC paid (bonus + fee), USDC
        uint256 openFees;
        uint256 unprofitableLiqs; // liquidatable, but no rational liquidator would act (lagging oracle)
        uint256 defensiveCloses; // attentive traders bailing out before liquidation
    }

    Config cfg;
    MockUSDC usdc;
    MockCTF ctf;
    KeeperOracle oracle; // what the protocol sees (optionally median-filtered)
    KeeperOracle market; // the true market price: the venue fills here, liquidators value shares here
    MockVenue venue;
    World phoebe;
    World naive;

    uint256 nextOpen;
    uint256 nextLog;
    bool yesSide;
    string csvPath;

    function test_replay() external {
        string memory name = vm.envOr("REPLAY", string(""));
        if (bytes(name).length == 0) vm.skip(true);
        _loadConfig();
        _run(name);
    }

    function _loadConfig() internal {
        cfg = Config({
            margin: vm.envOr("MARGIN_USD", uint256(5_000)) * USD,
            openEvery: vm.envOr("OPEN_EVERY", uint256(2 hours)),
            hold: vm.envOr("HOLD", uint256(3 days)),
            targetBps: vm.envOr("TARGET", uint256(9_000)),
            liqLtv: uint16(vm.envOr("LIQ_LTV", uint256(8_500))),
            openBuffer: uint16(vm.envOr("OPEN_BUFFER", uint256(1_000))),
            volK: uint32(vm.envOr("VOL_K", uint256(20_000))),
            volHorizon: uint32(vm.envOr("VOL_HORIZON", uint256(1 days))),
            rampDays: uint32(vm.envOr("RAMP_DAYS", uint256(3))),
            cutoffHours: uint32(vm.envOr("CUTOFF_HOURS", uint256(24))),
            bonusBps: vm.envOr("BONUS", uint256(500)),
            coverageBps: vm.envOr("COVERAGE", uint256(2_000)),
            juniorShareBps: vm.envOr("JUNIOR_SHARE", uint256(2_000)),
            bands: vm.envOr("BANDS", true),
            runNaive: vm.envOr("NAIVE", true),
            jumpWad: uint64(vm.envOr("JUMP_BPS", uint256(0)) * 1e14),
            median: vm.envOr("MEDIAN", false),
            openFeeBps: vm.envOr("OPEN_FEE", uint256(0)),
            liqFeeBps: vm.envOr("LIQ_FEE", uint256(0)),
            baseRate: vm.envOr("BASE_RATE_BPS", uint256(500)) * 1e14,
            slope1: vm.envOr("SLOPE1_BPS", uint256(1_500)) * 1e14,
            attentiveBps: vm.envOr("ATTENTIVE", uint256(0))
        });
    }

    function _run(string memory name) internal {
        string memory root = vm.projectRoot();
        string memory json = vm.readFile(string.concat(root, "/../sim/data/", name, ".json"));
        uint256[] memory ts = vm.parseJsonUintArray(json, ".t");
        uint256[] memory px = vm.parseJsonUintArray(json, ".p");
        uint256 resolution = ts[ts.length - 1] + 14 days;
        if (vm.keyExistsJson(json, ".resolutionTime")) resolution = vm.parseJsonUint(json, ".resolutionTime");
        // a market whose scheduled end is already past at the window start (stale endDate): treat as open-ended
        if (resolution <= ts[0] + 1 days) resolution = ts[ts.length - 1] + 14 days;

        vm.warp(ts[0]);
        _deployShared();
        _setPx(px[0]);

        _deployWorld(phoebe, "phoebe", true, uint64(resolution));
        if (cfg.runNaive) _deployWorld(naive, "naive", false, uint64(resolution));

        string memory summary = vm.envOr("SUMMARY", string(""));
        if (bytes(summary).length == 0) {
            csvPath = string.concat(root, "/../sim/out/", name, ".csv");
            vm.writeFile(
                csvPath,
                "t,price,phoebe_senior,phoebe_junior,phoebe_debt,phoebe_bad_debt,phoebe_open,naive_lp,naive_debt,naive_bad_debt,naive_open\n"
            );
        }

        nextOpen = ts[0];
        nextLog = ts[0];
        yesSide = true;
        for (uint256 i; i < ts.length; ++i) {
            // external self-call: each tick gets fresh memory (one long call would hit MemoryOOG)
            this.tick(ts[i], px[i], i + 1 == ts.length);
        }

        if (bytes(summary).length == 0) {
            _report(phoebe);
            if (cfg.runNaive) _report(naive);
            console.log("timeline:", csvPath);
        } else {
            string memory out = string.concat(
                '{"market":"', name, '","phoebe":', _json(phoebe), ',"naive":', cfg.runNaive ? _json(naive) : "null", "}"
            );
            vm.writeFile(string.concat(root, "/../sim/out/", summary), out);
        }
    }

    function tick(uint256 t, uint256 p6, bool last) external {
        vm.warp(t);
        _setPx(p6);

        _sweep(phoebe);
        _closeExpired(phoebe);
        if (cfg.runNaive) {
            _sweep(naive);
            _closeExpired(naive);
        }

        if (t >= nextOpen && !last) {
            uint256 side = yesSide ? YES : NO;
            _tryOpen(phoebe, side);
            if (cfg.runNaive) _tryOpen(naive, side);
            yesSide = !yesSide;
            nextOpen = t + cfg.openEvery;
        }

        _trackPeak(phoebe);
        if (cfg.runNaive) _trackPeak(naive);

        if (bytes(csvPath).length > 0 && (t >= nextLog || last)) {
            vm.writeLine(csvPath, _row(t, p6));
            nextLog = t + 1 hours;
        }
    }

    function _setPx(uint256 p6) internal {
        if (p6 > 1e6) p6 = 1e6; // history occasionally prints 1.005
        uint256 p = p6 * 1e12;
        oracle.setPrice(YES, p);
        oracle.setPrice(NO, 1e18 - p);
        market.setPrice(YES, p);
        market.setPrice(NO, 1e18 - p);
    }

    // ------------------------------------------------------------------ setup

    function _deployShared() internal {
        usdc = new MockUSDC();
        ctf = new MockCTF();
        oracle = new KeeperOracle();
        oracle.setMedianFilter(cfg.median);
        market = new KeeperOracle();
        venue = new MockVenue(usdc, ctf, market, 50);
        ctf.setMinter(address(venue), true);
        usdc.mint(address(venue), 1_000_000_000 * USD);
        usdc.mint(address(this), 1_000_000_000 * USD);
    }

    function _deployWorld(World storage w, string memory name, bool smart, uint64 resolution) internal {
        w.name = name;
        w.pool = new LendingPool(usdc);
        w.senior = new TrancheVault(w.pool, 0, "sr", "sr");
        w.junior = new TrancheVault(w.pool, 1, "jr", "jr");
        w.pool.setVaults(address(w.senior), address(w.junior));
        w.risk = new RiskEngine();

        RiskEngine.Market memory m = RiskEngine.Market({
            listed: true,
            openEnabled: true,
            liqLtvBps: cfg.liqLtv,
            openBufferBps: cfg.openBuffer,
            resolutionTime: resolution,
            cutoffDuration: cfg.cutoffHours * 1 hours,
            rampDuration: cfg.rampDays * 1 days,
            borrowCap: uint128(LP_TOTAL)
        });
        if (!smart || !cfg.bands) {
            w.risk.setBands(RiskEngine.PriceBands({floor: 0, safeLow: 1, safeHigh: 1e18 - 1, ceil: 1e18}));
        }
        if (!smart) {
            m.cutoffDuration = 0;
            m.rampDuration = 0;
            m.resolutionTime = type(uint64).max;
        } else {
            if (cfg.volK > 0) w.risk.setVolParams(IVolatilityOracle(address(oracle)), cfg.volHorizon, cfg.volK);
            w.risk.setJumpAllowance(cfg.jumpWad);
        }
        w.risk.listMarket(YES, m);
        w.risk.listMarket(NO, m);

        w.pm = new PositionManager(usdc, IERC1155(address(ctf)), w.pool, w.risk, oracle, venue);
        w.pm.setParams(smart ? cfg.bonusBps : 500, 1 days);
        if (smart) {
            w.pm.setFees(cfg.openFeeBps, cfg.liqFeeBps);
            w.pool.setRateParams(cfg.baseRate, cfg.slope1, 0.8e18, 1.5e18);
        }
        w.pool.setManager(address(w.pm));

        usdc.approve(address(w.pm), type(uint256).max);
        usdc.approve(address(w.senior), type(uint256).max);
        usdc.approve(address(w.junior), type(uint256).max);

        if (smart) {
            w.pool.setTrancheParams(6_000, cfg.coverageBps);
            uint256 jr = LP_TOTAL * cfg.juniorShareBps / 10_000;
            w.senior.deposit(LP_TOTAL - jr, address(this));
            if (jr > 0) w.junior.deposit(jr, address(this));
        } else {
            w.pool.setTrancheParams(10_000, 0);
            w.senior.deposit(LP_TOTAL, address(this));
        }
    }

    // ------------------------------------------------------------------ trader + keeper behaviour

    function _tryOpen(World storage w, uint256 side) internal {
        (uint256 price,) = oracle.getPrice(side);
        uint256 maxLtv = w.risk.maxLtvBps(side, price);
        if (!w.risk.isOpenAllowed(side) || maxLtv == 0) {
            w.skipped++;
            return;
        }
        // LTV = B / ((M + B) * fill), fill ~= 1 - spread  =>  B = M * L * f / (1 - L * f)
        uint256 target = maxLtv * cfg.targetBps / 10_000;
        uint256 fill = 9_950;
        uint256 borrow = cfg.margin * target * fill / (10_000 * 10_000 - target * fill);

        try w.pm.open(side, cfg.margin, borrow, 0) returns (uint256 id) {
            w.openFees += borrow * w.pm.openFeeBps() / 10_000;
            w.open.push(id);
            w.openedAt.push(block.timestamp);
            w.opened++;
            w.volume += cfg.margin + borrow;
        } catch {
            w.skipped++;
        }
    }

    function _closeExpired(World storage w) internal {
        for (uint256 k = w.open.length; k > 0; --k) {
            uint256 j = k - 1;
            bool expired = block.timestamp >= w.openedAt[j] + cfg.hold;
            bool defensive;
            if (!expired && cfg.attentiveBps > 0) {
                PositionManager.Health memory h = w.pm.health(w.open[j]);
                defensive = h.ltvBps * 10_000 >= h.liqLtvBps * cfg.attentiveBps;
            }
            if (!expired && !defensive) continue;
            try w.pm.close(w.open[j], 0) {
                w.closed++;
                if (defensive) w.defensiveCloses++;
                _remove(w, j);
            } catch {} // underwater: the liquidator will get it
        }
    }

    function _sweep(World storage w) internal {
        for (uint256 k = w.open.length; k > 0; --k) {
            uint256 j = k - 1;
            uint256 id = w.open[j];
            PositionManager.Health memory h = w.pm.health(id);
            if (!h.liquidatable) continue;
            // A rational liquidator only acts if the seized shares are worth what it pays at the *market* price.
            (, uint256 tokenId,,) = w.pm.positions(id);
            (uint256 mkt,) = market.getPrice(tokenId);
            uint256 snap = vm.snapshotState();
            (uint256 paid, uint256 seized) = w.pm.liquidate(id, type(uint256).max);
            uint256 seizedValue = seized * mkt / 1e18;
            if (seizedValue < paid) {
                vm.revertToState(snap);
                w.unprofitableLiqs++;
                continue;
            }
            vm.deleteStateSnapshot(snap);
            w.liquidations++;
            if (seizedValue > paid) w.traderPenalty += seizedValue - paid;
            if (paid >= h.debt) w.solventLiqs++;
            if (paid < h.debt) {
                uint256 bd = h.debt - paid;
                w.badDebtEvents++;
                w.badDebt += bd;
                if (bd > w.maxSingleBadDebt) w.maxSingleBadDebt = bd;
            }
            _remove(w, j);
        }
    }

    function _trackPeak(World storage w) internal {
        uint256 d = w.pool.totalDebt();
        if (d > w.peakDebt) w.peakDebt = d;
    }

    function _remove(World storage w, uint256 j) internal {
        uint256 last = w.open.length - 1;
        w.open[j] = w.open[last];
        w.openedAt[j] = w.openedAt[last];
        w.open.pop();
        w.openedAt.pop();
    }

    // ------------------------------------------------------------------ output

    function _json(World storage w) internal view returns (string memory) {
        string memory a = string.concat(
            '{"opened":', vm.toString(w.opened),
            ',"closed":', vm.toString(w.closed),
            ',"liquidations":', vm.toString(w.liquidations),
            ',"badDebtEvents":', vm.toString(w.badDebtEvents),
            ',"badDebt":', vm.toString(w.badDebt),
            ',"maxSingleBadDebt":', vm.toString(w.maxSingleBadDebt)
        );
        return string.concat(
            a,
            ',"skipped":', vm.toString(w.skipped),
            ',"volume":', vm.toString(w.volume),
            ',"peakDebt":', vm.toString(w.peakDebt),
            ',"senior":', vm.toString(w.pool.trancheAssets(0)),
            ',"junior":', vm.toString(w.pool.trancheAssets(1)),
            ',"stillOpen":', vm.toString(w.open.length),
            ',"solventLiqs":', vm.toString(w.solventLiqs),
            ',"traderPenalty":', vm.toString(w.traderPenalty),
            ',"openFees":', vm.toString(w.openFees),
            ',"unprofitableLiqs":', vm.toString(w.unprofitableLiqs),
            ',"defensiveCloses":', vm.toString(w.defensiveCloses), "}"
        );
    }

    function _row(uint256 t, uint256 p6) internal view returns (string memory) {
        string memory a = string.concat(
            vm.toString(t), ",", _fmt6(p6), ",",
            _fmt6(phoebe.pool.trancheAssets(0)), ",", _fmt6(phoebe.pool.trancheAssets(1)), ",",
            _fmt6(phoebe.pool.totalDebt()), ",", _fmt6(phoebe.badDebt), ",", vm.toString(phoebe.open.length)
        );
        if (!cfg.runNaive) return string.concat(a, ",,,,");
        return string.concat(
            a, ",",
            _fmt6(naive.pool.trancheAssets(0) + naive.pool.trancheAssets(1)), ",",
            _fmt6(naive.pool.totalDebt()), ",", _fmt6(naive.badDebt), ",", vm.toString(naive.open.length)
        );
    }

    function _report(World storage w) internal view {
        uint256 s = w.pool.trancheAssets(0);
        uint256 j = w.pool.trancheAssets(1);
        console.log("==========", w.name);
        console.log("positions opened / closed / liquidated:", w.opened, w.closed, w.liquidations);
        console.log("opens skipped (risk engine / coverage):", w.skipped);
        console.log("still open at end:", w.open.length);
        console.log("notional traded (USD):", w.volume / USD);
        console.log("peak debt (USD):", w.peakDebt / USD);
        console.log("liquidations with bad debt:", w.badDebtEvents);
        console.log("bad debt (USD):", w.badDebt / USD);
        console.log("senior assets (USD):", s / USD);
        console.log("junior assets (USD):", j / USD);
        uint256 total = s + j;
        if (total >= LP_TOTAL) console.log("LP net PnL (USD): +", (total - LP_TOTAL) / USD);
        else console.log("LP net PnL (USD): -", (LP_TOTAL - total) / USD);
    }

    function _fmt6(uint256 x) internal pure returns (string memory) {
        uint256 frac = x % 1e6;
        string memory f = vm.toString(frac);
        while (bytes(f).length < 6) f = string.concat("0", f);
        return string.concat(vm.toString(x / 1e6), ".", f);
    }
}
