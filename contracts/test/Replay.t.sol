// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
        uint256 slipY; // liquidator price impact: slip = Y * sqrt(sold / dailyVolume), Y in bps. 0 = infinite depth
        uint256 capDvBps; // per-market borrow cap as bps of daily volume. 0 = cap at LP size
        bool absorb; // underwater positions go to backstop inventory instead of being fire-sold
        uint256 invHold; // keeper sells each absorbed lot this long after absorbing (0 = hold to resolution)
        uint256 clusterCapBps; // multi-market files: cap on total debt across all markets, bps of LP. 0 = none
        uint256 maxPosDvBps; // per-position borrow cap, bps of the market's daily volume. 0 = none
        uint256 bonusRamp; // Dutch-auction liquidation bonus: bps per hour since flagged. 0 = fixed bonus
        uint256 bonusMax;
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
        uint256 absorbed; // count
        uint256 absorbedDebt; // written off at absorb time
        uint256 recovered; // inventory sale proceeds
        // liquidator memo: (market price, bonus) at the last unprofitable attempt; retry once either changes
        mapping(uint256 => uint256) failedAtPx;
        uint256[] lotToken;
        uint256[] lotShares;
        uint256[] lotAt;
    }

    Config cfg;
    MockUSDC usdc;
    MockCTF ctf;
    KeeperOracle oracle; // what the protocol sees (optionally median-filtered)
    KeeperOracle market; // the true market price: the venue fills here, liquidators value shares here
    MockVenue venue;
    World phoebe;
    World naive;

    // Markets. Market i trades tokens 2i+1 (YES) and 2i+2 (NO), so a single-market file uses tokens 1 and 2.
    uint256 constant NONE = 9_999_999; // "no price at this tick" sentinel in multi-market files
    uint256 n;
    uint256[] resolutionOf;
    uint256[] dvOf; // daily volume, USDC 6dp
    uint256[] lastIdx; // index of each market's final (resolution) tick
    bool[] settledOf; // past its resolution tick: shares redeem at 0/1, no order book needed
    bool[] liveOf; // has had at least one price
    uint256 curIdx;
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
            attentiveBps: vm.envOr("ATTENTIVE", uint256(0)),
            slipY: vm.envOr("SLIP_Y", uint256(0)),
            capDvBps: vm.envOr("CAP_DV", uint256(0)),
            absorb: vm.envOr("ABSORB", false),
            invHold: vm.envOr("INV_HOLD", uint256(0)),
            clusterCapBps: vm.envOr("CLUSTER_CAP", uint256(0)),
            maxPosDvBps: vm.envOr("MAX_POS_DV", uint256(0)),
            bonusRamp: vm.envOr("BONUS_RAMP", uint256(0)),
            bonusMax: vm.envOr("BONUS_MAX", uint256(1_500))
        });
    }

    function _run(string memory name) internal {
        string memory root = vm.projectRoot();
        string memory json = vm.readFile(string.concat(root, "/../sim/data/", name, ".json"));
        uint256[] memory ts = vm.parseJsonUintArray(json, ".t");
        bool multi = vm.keyExistsJson(json, ".n");
        n = multi ? vm.parseJsonUint(json, ".n") : 1;
        uint256[][] memory px = new uint256[][](n);
        for (uint256 m; m < n; ++m) {
            string memory sfx = multi ? vm.toString(m) : "";
            px[m] = vm.parseJsonUintArray(json, string.concat(".p", sfx));
            uint256 res = ts[ts.length - 1] + 14 days;
            if (vm.keyExistsJson(json, string.concat(".resolutionTime", sfx))) {
                res = vm.parseJsonUint(json, string.concat(".resolutionTime", sfx));
            }
            uint256 last;
            uint256 first = type(uint256).max;
            for (uint256 i; i < ts.length; ++i) {
                if (px[m][i] != NONE) {
                    last = i;
                    if (first == type(uint256).max) first = i;
                }
            }
            // a market whose scheduled end is already past at its window start (stale endDate): open-ended
            if (res <= ts[first] + 1 days) res = ts[last] + 14 days;
            resolutionOf.push(res);
            lastIdx.push(last);
            dvOf.push(
                vm.keyExistsJson(json, string.concat(".dailyVolume", sfx))
                    ? vm.parseJsonUint(json, string.concat(".dailyVolume", sfx)) * USD
                    : 0
            );
            settledOf.push(false);
            liveOf.push(false);
        }

        vm.warp(ts[0]);
        _deployShared();
        _deployWorld(phoebe, "phoebe", true);
        if (cfg.runNaive) _deployWorld(naive, "naive", false);

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
        uint256[] memory row = new uint256[](n);
        for (uint256 i; i < ts.length; ++i) {
            for (uint256 m; m < n; ++m) row[m] = px[m][i];
            // external self-call: each tick gets fresh memory (one long call would hit MemoryOOG)
            this.tick(i, ts[i], row, i + 1 == ts.length);
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

    function tick(uint256 idx, uint256 t, uint256[] calldata pxs, bool last) external {
        vm.warp(t);
        curIdx = idx;
        for (uint256 m; m < n; ++m) {
            if (pxs[m] != NONE && !settledOf[m]) {
                _setPx(m, pxs[m]);
                liveOf[m] = true;
            }
        }

        _sweep(phoebe);
        _closeExpired(phoebe);
        if (cfg.absorb) _sellLots(phoebe);
        if (cfg.runNaive) {
            _sweep(naive);
            _closeExpired(naive);
        }

        if (t >= nextOpen && !last) {
            for (uint256 m; m < n; ++m) {
                if (!liveOf[m] || settledOf[m] || idx >= lastIdx[m]) continue;
                uint256 tokenId = yesSide ? 2 * m + 1 : 2 * m + 2;
                _tryOpen(phoebe, tokenId);
                if (cfg.runNaive) _tryOpen(naive, tokenId);
            }
            yesSide = !yesSide;
            nextOpen = t + cfg.openEvery;
        }

        _trackPeak(phoebe);
        if (cfg.runNaive) _trackPeak(naive);

        for (uint256 m; m < n; ++m) {
            if (idx == lastIdx[m]) settledOf[m] = true;
        }

        if (bytes(csvPath).length > 0 && (t >= nextLog || last)) {
            vm.writeLine(csvPath, _row(t, pxs[0] == NONE ? 0 : pxs[0]));
            nextLog = t + 1 hours;
        }
    }

    function _setPx(uint256 m, uint256 p6) internal {
        if (p6 > 1e6) p6 = 1e6; // history occasionally prints 1.005
        uint256 p = p6 * 1e12;
        oracle.setPrice(2 * m + 1, p);
        oracle.setPrice(2 * m + 2, 1e18 - p);
        market.setPrice(2 * m + 1, p);
        market.setPrice(2 * m + 2, 1e18 - p);
    }

    /// Market index of a token, and whether it is at/after its resolution tick.
    function _mkt(uint256 tokenId) internal pure returns (uint256) {
        return (tokenId - 1) / 2;
    }

    function _resolving(uint256 m) internal view returns (bool) {
        return settledOf[m] || curIdx >= lastIdx[m];
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

    function _deployWorld(World storage w, string memory name, bool smart) internal {
        w.name = name;
        w.pool = new LendingPool(usdc);
        w.senior = new TrancheVault(w.pool, 0, "sr", "sr");
        w.junior = new TrancheVault(w.pool, 1, "jr", "jr");
        w.pool.setVaults(address(w.senior), address(w.junior));
        w.risk = new RiskEngine();

        if (!smart || !cfg.bands) {
            w.risk.setBands(RiskEngine.PriceBands({floor: 0, safeLow: 1, safeHigh: 1e18 - 1, ceil: 1e18}));
        }
        if (smart) {
            if (cfg.volK > 0) w.risk.setVolParams(IVolatilityOracle(address(oracle)), cfg.volHorizon, cfg.volK);
            w.risk.setJumpAllowance(cfg.jumpWad);
        }
        uint256[] memory all = new uint256[](2 * n);
        for (uint256 i; i < n; ++i) {
            RiskEngine.Market memory m = RiskEngine.Market({
                listed: true,
                openEnabled: true,
                liqLtvBps: cfg.liqLtv,
                openBufferBps: cfg.openBuffer,
                resolutionTime: smart ? uint64(resolutionOf[i]) : type(uint64).max,
                cutoffDuration: smart ? cfg.cutoffHours * 1 hours : 0,
                rampDuration: smart ? cfg.rampDays * 1 days : 0,
                borrowCap: uint128(
                    cfg.capDvBps > 0 && dvOf[i] > 0 ? Math.min(LP_TOTAL, dvOf[i] * cfg.capDvBps / 10_000) : LP_TOTAL
                )
            });
            w.risk.listMarket(2 * i + 1, m);
            w.risk.listMarket(2 * i + 2, m);
            (all[2 * i], all[2 * i + 1]) = (2 * i + 1, 2 * i + 2);
            if (smart && cfg.maxPosDvBps > 0 && dvOf[i] > 0) {
                uint256[] memory pair = new uint256[](2);
                (pair[0], pair[1]) = (2 * i + 1, 2 * i + 2);
                w.risk.setMaxPositionBorrow(pair, dvOf[i] * cfg.maxPosDvBps / 10_000);
            }
        }
        if (smart && cfg.clusterCapBps > 0) {
            w.risk.setCluster(all, 1);
            w.risk.setClusterCap(1, LP_TOTAL * cfg.clusterCapBps / 10_000);
        }

        w.pm = new PositionManager(usdc, IERC1155(address(ctf)), w.pool, w.risk, oracle, venue);
        w.pm.setParams(smart ? cfg.bonusBps : 500, 1 days);
        if (smart) {
            w.pm.setFees(cfg.openFeeBps, cfg.liqFeeBps);
            w.pm.setAbsorbUnderwater(cfg.absorb);
            if (cfg.bonusRamp > 0) w.pm.setBonusRamp(cfg.bonusRamp, cfg.bonusMax);
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
        uint256 margin = cfg.margin;
        uint256 borrow = margin * target * fill / (10_000 * 10_000 - target * fill);
        // over the per-position cap: the trader shrinks the whole position (same leverage, smaller size)
        uint256 cap = w.risk.maxPositionBorrow(side);
        if (cap > 0 && borrow > cap) {
            margin = margin * cap / borrow;
            borrow = cap;
        }

        try w.pm.open(side, margin, borrow, 0) returns (uint256 id) {
            w.openFees += borrow * w.pm.openFeeBps() / 10_000;
            w.open.push(id);
            w.openedAt.push(block.timestamp);
            w.opened++;
            w.volume += margin + borrow;
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
            PositionManager.Health memory h = w.pm.health(w.open[j]);
            if (!h.liquidatable) continue;
            if (cfg.bonusRamp > 0) w.pm.flag(w.open[j]); // start the auction clock
            if (_liquidateOne(w, w.open[j], h)) _remove(w, j);
        }
    }

    /// @return done Position is gone (liquidated or absorbed).
    function _liquidateOne(World storage w, uint256 id, PositionManager.Health memory h) internal returns (bool) {
        (, uint256 tokenId,,) = w.pm.positions(id);
        (uint256 mkt,) = market.getPrice(tokenId);
        uint256 memo = uint256(keccak256(abi.encode(mkt, w.pm.currentBonusBps(id))));
        if (w.failedAtPx[id] == memo) return false; // unprofitable at this price and bonus last time

        uint256 snap = vm.snapshotState();
        uint256 paid;
        uint256 seized;
        try w.pm.liquidate(id, type(uint256).max) returns (uint256 _paid, uint256 _seized) {
            (paid, seized) = (_paid, _seized);
        } catch {
            // absorb mode: underwater -> backstop inventory (a protocol action, no liquidator economics)
            vm.revertToStateAndDelete(snap);
            (,, uint256 shares,) = w.pm.positions(id);
            w.pm.absorb(id);
            w.lotToken.push(tokenId);
            w.lotShares.push(shares);
            w.lotAt.push(block.timestamp);
            w.absorbed++;
            w.absorbedDebt += h.debt;
            return true;
        }
        // A rational liquidator only acts if the seized shares, sold at the *market* price after impact, cover what it pays.
        uint256 seizedValue = seized * mkt / 1e18;
        if (seizedValue - seizedValue * _slipBps(tokenId, seizedValue) / 10_000 < paid) {
            vm.revertToStateAndDelete(snap);
            w.unprofitableLiqs++;
            w.failedAtPx[id] = memo;
            return false;
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
        return true;
    }

    /// Keeper policy: sell each absorbed lot `invHold` after absorbing it (or at resolution), with price impact.
    function _sellLots(World storage w) internal {
        for (uint256 k = w.lotToken.length; k > 0; --k) {
            uint256 j = k - 1;
            bool due = _resolving(_mkt(w.lotToken[j])) || (cfg.invHold > 0 && block.timestamp >= w.lotAt[j] + cfg.invHold);
            if (!due) continue;
            (uint256 mkt,) = market.getPrice(w.lotToken[j]);
            venue.setSellHaircut(_slipBps(w.lotToken[j], w.lotShares[j] * mkt / 1e18));
            w.recovered += w.pm.sellInventory(w.lotToken[j], w.lotShares[j], 0);
            venue.setSellHaircut(0);
            uint256 l = w.lotToken.length - 1;
            (w.lotToken[j], w.lotShares[j], w.lotAt[j]) = (w.lotToken[l], w.lotShares[l], w.lotAt[l]);
            w.lotToken.pop();
            w.lotShares.pop();
            w.lotAt.pop();
        }
    }

    /// Square-root impact: selling X into a market trading V/day costs Y * sqrt(X / V). Capped at 90%.
    function _slipBps(uint256 tokenId, uint256 x) internal view returns (uint256) {
        uint256 m = _mkt(tokenId);
        if (cfg.slipY == 0 || dvOf[m] == 0 || _resolving(m)) return 0;
        uint256 s = cfg.slipY * Math.sqrt(x * 1e18 / dvOf[m]) / 1e9;
        return s > 9_000 ? 9_000 : s;
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
        return string.concat(_json1(w), _json2(w), _json3(w), "}");
    }

    function _kv(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat(',"', k, '":', vm.toString(v));
    }

    function _json1(World storage w) internal view returns (string memory) {
        return string.concat(
            '{"opened":', vm.toString(w.opened),
            _kv("closed", w.closed),
            _kv("liquidations", w.liquidations),
            _kv("badDebtEvents", w.badDebtEvents),
            _kv("badDebt", w.badDebt),
            _kv("maxSingleBadDebt", w.maxSingleBadDebt)
        );
    }

    function _json2(World storage w) internal view returns (string memory) {
        return string.concat(
            _kv("skipped", w.skipped),
            _kv("volume", w.volume),
            _kv("peakDebt", w.peakDebt),
            _kv("senior", w.pool.trancheAssets(0)),
            _kv("junior", w.pool.trancheAssets(1)),
            _kv("stillOpen", w.open.length)
        );
    }

    function _json3(World storage w) internal view returns (string memory) {
        return string.concat(
            string.concat(
                _kv("solventLiqs", w.solventLiqs),
                _kv("traderPenalty", w.traderPenalty),
                _kv("openFees", w.openFees),
                _kv("unprofitableLiqs", w.unprofitableLiqs)
            ),
            _kv("defensiveCloses", w.defensiveCloses),
            _kv("absorbed", w.absorbed),
            _kv("absorbedDebt", w.absorbedDebt),
            _kv("recovered", w.recovered)
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
