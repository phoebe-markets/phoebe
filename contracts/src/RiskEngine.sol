// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title RiskEngine
/// @notice Per-market whitelist plus LTV limits that shrink as price nears 0 or 1 and as resolution nears.
///
///   liqLtv(p, t) = market.liqLtvBps * priceFactor(p) * timeFactor(t)
///   maxLtv(p, t) = liqLtv(p, t) - market.openBufferBps            (floored at 0)
///
/// priceFactor: 1 inside [safeLow, safeHigh], falls linearly to 0 at `floor` / `ceil`.
///   Near 1 the upside is tiny and the only big move is a jump to 0. Near 0 the share is a lottery ticket.
/// timeFactor:  1 until `rampDuration` before the cutoff, then falls linearly to 0 at
///   `resolutionTime - cutoffDuration`. At 0, every open position becomes liquidatable, so nothing
///   leveraged reaches resolution (the 0/1 jump).
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
    PriceBands public bands;
    mapping(address => bool) public guardians;

    event MarketListed(uint256 indexed tokenId, Market config);
    event MarketOpenEnabled(uint256 indexed tokenId, bool enabled);
    event BandsSet(PriceBands bands);

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

    /// @return LTV in bps above which a position can be liquidated.
    function liqLtvBps(uint256 tokenId, uint256 priceWad) public view returns (uint256) {
        Market memory m = markets[tokenId];
        if (!m.listed) return 0;
        return uint256(m.liqLtvBps) * priceFactorWad(priceWad) / WAD * timeFactorWad(tokenId) / WAD;
    }

    /// @return Max LTV in bps a position may be opened at (or leveraged up to).
    function maxLtvBps(uint256 tokenId, uint256 priceWad) public view returns (uint256) {
        uint256 liq = liqLtvBps(tokenId, priceWad);
        uint256 buf = markets[tokenId].openBufferBps;
        return liq > buf ? liq - buf : 0;
    }
}
