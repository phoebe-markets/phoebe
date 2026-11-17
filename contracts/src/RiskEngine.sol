// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IVolatilityOracle} from "./interfaces/IVolatilityOracle.sol";

/// @title RiskEngine
/// @notice Per-market whitelist plus LTV limits that shrink as price nears 0 or 1 and as resolution nears.
///
///   liqLtv(p, t, s) = min( market.liqLtvBps * priceFactor(p) * timeFactor(t),  volCap(p, s) )
///   maxLtv(p, t, s) = liqLtv(p, t, s) - market.openBufferBps            (floored at 0)
///
/// priceFactor: 1 inside [safeLow, safeHigh], falls linearly to 0 at `floor` / `ceil`.
///   Near 1 the upside is tiny and the only big move is a jump to 0. Near 0 the share is a lottery ticket.
/// timeFactor:  1 until `rampDuration` before the cutoff, then falls linearly to 0 at
///   `resolutionTime - cutoffDuration`. At 0, every open position becomes liquidatable, so nothing
///   leveraged reaches resolution (the 0/1 jump).
/// volCap:      1 - (k * sigma(H) + J) / p, where sigma(H) is the oracle's realized 1-sigma absolute move over the horizon
///   H (default 1 day), J is a fixed jump allowance, and p is this token's price. A position at the liquidation LTV then still has
///   collateral cushion for a k-sigma move (default k = 2). Calm markets: the cap doesn't bind. Turbulent
///   markets: leverage falls, and existing positions get liquidated while still solvent, before the jump.
///
/// Leverage = 1 / (1 - LTV). E.g. LTV 75% -> 4x.
contract RiskEngine is Ownable {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    struct Market {
        bool listed;
        bool openEnabled; // new positions allowed (guardian can switch off on breaking news / early resolution)
        uint16 liqLtvBps; // base liquidation LTV
        uint16 openBufferBps; // max-open LTV sits this far below the liquidation LTV
        uint64 resolutionTime; // expected end date
        uint32 cutoffDuration; // leverage fully off this long before resolutionTime
        uint32 rampDuration; // linear ramp-down length before the cutoff
        uint128 borrowCap; // max outstanding debt (USDC, 6 dp) against this market
    }

    struct PriceBands {
        uint64 floor; // WAD
        uint64 safeLow;
        uint64 safeHigh;
        uint64 ceil;
    }

    mapping(uint256 => Market) public markets;
    /// @notice Correlated markets (e.g. all outcomes of one event, or one geopolitical theme) share a cluster and a
    ///         cluster-wide borrow cap, so one news event can't hit more than a bounded slice of the pool.
    mapping(uint256 => uint32) public clusterOf; // tokenId => cluster (0 = none)
    mapping(uint32 => uint256) public clusterCap; // USDC
    /// @notice Max borrow per position (USDC, 0 = unlimited). Size positions so a liquidation stays profitable after
    ///         price impact: in thin books, liquidators won't take positions that are big relative to daily volume.
    mapping(uint256 => uint256) public maxPositionBorrow;
    PriceBands public bands;
    mapping(address => bool) public guardians;

    /// @notice Unset => no volatility cap.
    IVolatilityOracle public volOracle;
    uint32 public volHorizon = 1 days;
    uint32 public volKBps = 20_000; // k = 2.0
    /// @notice Absolute price jump (WAD) the liquidation cushion must always absorb, on top of k*sigma.
    ///         Covers jumps out of calm markets that realized vol can't see. 0 = off.
    uint64 public jumpWad;

    event MarketListed(uint256 indexed tokenId, Market config);
    event MarketOpenEnabled(uint256 indexed tokenId, bool enabled);
    event BandsSet(PriceBands bands);
    event VolParamsSet(address oracle, uint32 horizon, uint32 kBps);
    event JumpAllowanceSet(uint64 jumpWad);
    event ClusterSet(uint256 indexed tokenId, uint32 indexed cluster);
    event ClusterCapSet(uint32 indexed cluster, uint256 cap);
    event MaxPositionBorrowSet(uint256 indexed tokenId, uint256 amount);

    error BadConfig();
    error NotGuardian();

    constructor() Ownable(msg.sender) {
        bands = PriceBands({floor: 0.03e18, safeLow: 0.15e18, safeHigh: 0.85e18, ceil: 0.97e18});
        guardians[msg.sender] = true;
    }

    // ------------------------------------------------------------------ admin

    function listMarket(uint256 tokenId, Market calldata m) external onlyOwner {
        if (m.liqLtvBps >= BPS || m.openBufferBps > m.liqLtvBps || m.resolutionTime <= block.timestamp) {
            revert BadConfig();
        }
        Market memory mm = m;
        mm.listed = true;
        markets[tokenId] = mm;
        emit MarketListed(tokenId, mm);
    }

    function setBands(PriceBands calldata b) external onlyOwner {
        if (!(b.floor < b.safeLow && b.safeLow <= b.safeHigh && b.safeHigh < b.ceil && b.ceil <= WAD)) {
            revert BadConfig();
        }
        bands = b;
        emit BandsSet(b);
    }

    function setVolParams(IVolatilityOracle oracle, uint32 horizon, uint32 kBps) external onlyOwner {
        if (horizon == 0) revert BadConfig();
        (volOracle, volHorizon, volKBps) = (oracle, horizon, kBps);
        emit VolParamsSet(address(oracle), horizon, kBps);
    }

    function setCluster(uint256[] calldata tokenIds, uint32 cluster) external onlyOwner {
        for (uint256 i; i < tokenIds.length; ++i) {
            clusterOf[tokenIds[i]] = cluster;
            emit ClusterSet(tokenIds[i], cluster);
        }
    }

    function setMaxPositionBorrow(uint256[] calldata tokenIds, uint256 amount) external onlyOwner {
        for (uint256 i; i < tokenIds.length; ++i) {
            maxPositionBorrow[tokenIds[i]] = amount;
            emit MaxPositionBorrowSet(tokenIds[i], amount);
        }
    }

    function setClusterCap(uint32 cluster, uint256 cap) external onlyOwner {
        clusterCap[cluster] = cap;
        emit ClusterCapSet(cluster, cap);
    }

    function setJumpAllowance(uint64 _jumpWad) external onlyOwner {
        if (_jumpWad > WAD) revert BadConfig();
        jumpWad = _jumpWad;
        emit JumpAllowanceSet(_jumpWad);
    }

    function setGuardian(address who, bool allowed) external onlyOwner {
        guardians[who] = allowed;
    }

    /// @notice Kill-switch for new positions on one market. Existing positions are unaffected.
    function setOpenEnabled(uint256 tokenId, bool enabled) external {
        if (!guardians[msg.sender]) revert NotGuardian();
        markets[tokenId].openEnabled = enabled;
        emit MarketOpenEnabled(tokenId, enabled);
    }

    // ------------------------------------------------------------------ views

    function isOpenAllowed(uint256 tokenId) public view returns (bool) {
        Market memory m = markets[tokenId];
        return m.listed && m.openEnabled && timeFactorWad(tokenId) > 0;
    }

    function borrowCap(uint256 tokenId) external view returns (uint256) {
        return markets[tokenId].borrowCap;
    }

    function priceFactorWad(uint256 priceWad) public view returns (uint256) {
        PriceBands memory b = bands;
        if (priceWad <= b.floor || priceWad >= b.ceil) return 0;
        if (priceWad < b.safeLow) return (priceWad - b.floor) * WAD / (b.safeLow - b.floor);
        if (priceWad > b.safeHigh) return (b.ceil - priceWad) * WAD / (b.ceil - b.safeHigh);
        return WAD;
    }

    function timeFactorWad(uint256 tokenId) public view returns (uint256) {
        Market memory m = markets[tokenId];
        if (!m.listed) return 0;
        uint256 cutoff = m.resolutionTime > m.cutoffDuration ? m.resolutionTime - m.cutoffDuration : 0;
        if (block.timestamp >= cutoff) return 0;
        uint256 left = cutoff - block.timestamp;
        if (left >= m.rampDuration) return WAD;
        return left * WAD / m.rampDuration;
    }

    /// @return Cap on liquidation LTV (bps): the cushion (1 - LTV) must cover (k*sigma + jump) / price.
    ///         BPS (no cap) if neither a vol oracle nor a jump allowance is set.
    function volCapBps(uint256 tokenId, uint256 priceWad) public view returns (uint256) {
        uint256 absMove = jumpWad; // WAD
        if (address(volOracle) != address(0)) absMove += volOracle.sigmaWad(tokenId, volHorizon) * volKBps / BPS;
        if (absMove == 0) return BPS;
        if (priceWad == 0) return 0;
        uint256 move = absMove * BPS / priceWad; // relative move, bps
        return move >= BPS ? 0 : BPS - move;
    }

    /// @return LTV in bps above which a position can be liquidated.
    function liqLtvBps(uint256 tokenId, uint256 priceWad) public view returns (uint256) {
        Market memory m = markets[tokenId];
        if (!m.listed) return 0;
        uint256 base = uint256(m.liqLtvBps) * priceFactorWad(priceWad) / WAD * timeFactorWad(tokenId) / WAD;
        uint256 cap = volCapBps(tokenId, priceWad);
        return base < cap ? base : cap;
    }

    /// @return Max LTV in bps a position may be opened at (or leveraged up to).
    function maxLtvBps(uint256 tokenId, uint256 priceWad) public view returns (uint256) {
        uint256 liq = liqLtvBps(tokenId, priceWad);
        uint256 buf = markets[tokenId].openBufferBps;
        return liq > buf ? liq - buf : 0;
    }
}
