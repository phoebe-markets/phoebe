// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Price feed for Polymarket outcome tokens (CTF ERC-1155 position ids).
/// @dev Prices are WAD-scaled USDC per share: 0.42 USDC/share == 0.42e18. Range is [0, 1e18].
interface IPriceOracle {
    function getPrice(uint256 tokenId) external view returns (uint256 priceWad, uint256 updatedAt);
}
