// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IVolatilityOracle} from "./interfaces/IVolatilityOracle.sol";

/// @title KeeperOracle
/// @notice Authorized keepers push outcome-token prices (e.g. a Polymarket CLOB midpoint/TWAP). On every
///         push the oracle updates a time-weighted EWMA of realized variance, so the RiskEngine can cut
///         leverage when a market turns turbulent.
///
/// Variance is tracked as a rate (price^2 per second), which makes it independent of how often keepers push:
///
///     var' = (var * tau + dp^2) / (tau + dt)
///
/// This is an EWMA with weight dt / (tau + dt) on the newest observation dp^2 / dt. `tau` (default 3 days)
/// sets how long a shock is remembered. sigma over a horizon H = sqrt(var * H).
///
/// Manipulation note: a keeper pushing noisy prices can only *raise* vol, which lowers leverage (the safe
/// direction). Smoothing prices to hide vol is a keeper-trust problem, the same as the price itself.
contract KeeperOracle is IPriceOracle, IVolatilityOracle, Ownable {
    struct Feed {
        uint128 price; // WAD, latest raw push
        uint64 updatedAt;
        uint256 varRate; // WAD^2 per second (dp in WAD, squared => 1e36 scale)
        uint128 prev1; // previous two raw pushes, for the median filter
        uint128 prev2;
    }

    mapping(uint256 => Feed) internal feeds;
    /// @notice NO token => its YES token. A complement feed isn't stored: price = 1 - price(YES), same timestamp and
    ///         the same sigma (both sides move by the same absolute amount). Halves the gas per keeper push.
    mapping(uint256 => uint256) public complementOf;
    mapping(address => bool) public updaters;
    uint256 public tau = 3 days;
    /// @notice If set, getPrice returns the median of the last 3 pushes. A one-push spike (bad print, thin book)
    ///         can't trigger liquidations, at the cost of reacting one push later to real moves.
    bool public medianFilter;

    event PriceUpdated(uint256 indexed tokenId, uint256 priceWad, uint256 sigma1dWad);
    event ComplementSet(uint256 indexed noTokenId, uint256 indexed yesTokenId);

    error IsComplement();

    constructor() Ownable(msg.sender) {
        updaters[msg.sender] = true;
    }

    function setUpdater(address who, bool allowed) external onlyOwner {
        updaters[who] = allowed;
    }

    function setMedianFilter(bool on) external onlyOwner {
        medianFilter = on;
    }

    function setTau(uint256 _tau) external onlyOwner {
        require(_tau > 0, "tau");
        tau = _tau;
    }

    /// @notice Derive `noTokenId`'s price from `yesTokenId` (0 unsets).
    function setComplement(uint256 noTokenId, uint256 yesTokenId) external onlyOwner {
        require(complementOf[yesTokenId] == 0 && noTokenId != yesTokenId, "chain");
        complementOf[noTokenId] = yesTokenId;
        emit ComplementSet(noTokenId, yesTokenId);
    }

    function setPrice(uint256 tokenId, uint256 priceWad) public {
        require(updaters[msg.sender], "not updater");
        if (complementOf[tokenId] != 0) revert IsComplement();
        require(priceWad <= 1e18, "price > 1");
        Feed storage f = feeds[tokenId];
        if (f.updatedAt != 0) {
            uint256 dt = block.timestamp - f.updatedAt;
            uint256 dp = priceWad > f.price ? priceWad - f.price : f.price - priceWad;
            f.varRate = (f.varRate * tau + dp * dp) / (tau + dt);
            f.prev2 = f.prev1;
            f.prev1 = f.price;
        } else {
            f.prev1 = f.prev2 = uint128(priceWad);
        }
        f.price = uint128(priceWad);
        f.updatedAt = uint64(block.timestamp);
        emit PriceUpdated(tokenId, priceWad, Math.sqrt(f.varRate * 1 days));
    }

    function setPrices(uint256[] calldata tokenIds, uint256[] calldata pricesWad) external {
        require(tokenIds.length == pricesWad.length, "len");
        for (uint256 i; i < tokenIds.length; ++i) {
            setPrice(tokenIds[i], pricesWad[i]);
        }
    }

    function getPrice(uint256 tokenId) external view returns (uint256, uint256) {
        uint256 yes = complementOf[tokenId];
        if (yes != 0) {
            (uint256 p, uint256 t) = this.getPrice(yes);
            return (1e18 - p, t);
        }
        Feed memory f = feeds[tokenId];
        if (!medianFilter) return (f.price, f.updatedAt);
        return (_median(f.price, f.prev1, f.prev2), f.updatedAt);
    }

    function _median(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        if (b > c) b = c;
        return a > b ? a : b;
    }

    function sigmaWad(uint256 tokenId, uint256 horizon) external view returns (uint256) {
        uint256 yes = complementOf[tokenId];
        return Math.sqrt(feeds[yes != 0 ? yes : tokenId].varRate * horizon);
    }
}
