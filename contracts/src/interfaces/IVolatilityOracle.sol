// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVolatilityOracle {
    /// @return One-sigma absolute price move over `horizon` seconds, WAD (0.1e18 == 10 cents).
    function sigmaWad(uint256 tokenId, uint256 horizon) external view returns (uint256);
}
