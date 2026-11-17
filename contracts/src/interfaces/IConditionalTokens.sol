// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The read side of Gnosis ConditionalTokens used to detect resolution.
interface IConditionalTokens {
    /// @dev Non-zero once the condition's oracle has reported.
    function payoutDenominator(bytes32 conditionId) external view returns (uint256);
    function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256);
}

/// @notice Redeems a resolved binary condition for the pool asset.
/// @dev On Polygon this is Polymarket's CtfCollateralAdapter: the CTF positions are USDC.e-backed, and the adapter
///      pulls the caller's whole YES and NO balance, redeems on the CTF, and wraps the USDC.e into pUSD for the
///      caller. It ignores `collateralToken`, `parentCollectionId` and `indexSets` (kept for CTF ABI compatibility).
interface ICtfRedeemer {
    function redeemPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external;
}
