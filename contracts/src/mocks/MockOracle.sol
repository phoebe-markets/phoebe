// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Settable oracle. A keeper (or the replay script) pushes prices.
contract MockOracle is IPriceOracle, Ownable {
    struct Px {
        uint128 price;
        uint128 updatedAt;
    }

    mapping(uint256 => Px) internal prices;
    mapping(address => bool) public updaters;

    event PriceUpdated(uint256 indexed tokenId, uint256 priceWad);

    constructor() Ownable(msg.sender) {
        updaters[msg.sender] = true;
    }

    function setUpdater(address who, bool allowed) external onlyOwner {
        updaters[who] = allowed;
    }

    function setPrice(uint256 tokenId, uint256 priceWad) public {
        require(updaters[msg.sender], "not updater");
        require(priceWad <= 1e18, "price > 1");
        prices[tokenId] = Px(uint128(priceWad), uint128(block.timestamp));
        emit PriceUpdated(tokenId, priceWad);
    }

    function setPrices(uint256[] calldata tokenIds, uint256[] calldata pricesWad) external {
        require(tokenIds.length == pricesWad.length, "len");
        for (uint256 i; i < tokenIds.length; ++i) {
            setPrice(tokenIds[i], pricesWad[i]);
        }
    }

    function getPrice(uint256 tokenId) external view returns (uint256, uint256) {
        Px memory p = prices[tokenId];
        return (p.price, p.updatedAt);
    }
}
