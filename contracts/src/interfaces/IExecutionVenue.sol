// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Where the PositionManager buys and sells outcome tokens.
/// @dev Implementations: MockVenue (dev), and later either a Polymarket CLOB adapter (POLY_1271 maker)
///      or a keeper/solver adapter. See NOTES.md. Both calls are synchronous from the caller's view:
///      `buy` pulls `usdcIn` from msg.sender and sends >= minSharesOut shares of `tokenId` to msg.sender.
interface IExecutionVenue {
    function buy(uint256 tokenId, uint256 usdcIn, uint256 minSharesOut) external returns (uint256 sharesOut);

    /// @dev Pulls `shares` of `tokenId` from msg.sender (ERC-1155 approval) and sends >= minUsdcOut USDC.
    function sell(uint256 tokenId, uint256 shares, uint256 minUsdcOut) external returns (uint256 usdcOut);
}
