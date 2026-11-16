// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Stand-in for Gnosis ConditionalTokens outcome positions (ERC-1155, 6 decimals like USDC).
contract MockCTF is ERC1155, Ownable {
    mapping(address => bool) public minters;

    constructor() ERC1155("") Ownable(msg.sender) {}

    function setMinter(address who, bool allowed) external onlyOwner {
        minters[who] = allowed;
    }

    function mint(address to, uint256 id, uint256 amount) external {
        require(minters[msg.sender], "not minter");
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external {
        require(minters[msg.sender], "not minter");
        _burn(from, id, amount);
    }
}
