// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IExecutionVenue} from "../interfaces/IExecutionVenue.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {MockCTF} from "./MockCTF.sol";

/// @notice Fills at oracle price +/- a spread. Mints shares on buy, burns on sell, pays from its USDC float.
contract MockVenue is IExecutionVenue {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    MockCTF public immutable ctf;
    IPriceOracle public immutable oracle;
    uint256 public immutable spreadBps;
    /// @notice Extra haircut on sells, settable by anyone (mock only), used by the replay to model price impact.
    uint256 public sellHaircutBps;

    constructor(IERC20 _usdc, MockCTF _ctf, IPriceOracle _oracle, uint256 _spreadBps) {
        usdc = _usdc;
        ctf = _ctf;
        oracle = _oracle;
        spreadBps = _spreadBps;
    }

    function buy(uint256 tokenId, uint256 usdcIn, uint256 minSharesOut) external returns (uint256 sharesOut) {
        (uint256 price,) = oracle.getPrice(tokenId);
        uint256 ask = price * (10_000 + spreadBps) / 10_000;
        if (ask > 1e18) ask = 1e18;
        require(ask > 0, "no ask");
        sharesOut = usdcIn * 1e18 / ask;
        require(sharesOut >= minSharesOut, "slippage");
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        ctf.mint(msg.sender, tokenId, sharesOut);
    }

    function setSellHaircut(uint256 bps) external {
        require(bps <= 10_000, "bps");
        sellHaircutBps = bps;
    }

    function sell(uint256 tokenId, uint256 shares, uint256 minUsdcOut) external returns (uint256 usdcOut) {
        (uint256 price,) = oracle.getPrice(tokenId);
        uint256 bid = price * (10_000 - spreadBps) / 10_000 * (10_000 - sellHaircutBps) / 10_000;
        usdcOut = shares * bid / 1e18;
        require(usdcOut >= minUsdcOut, "slippage");
        ctf.burn(msg.sender, tokenId, shares);
        usdc.safeTransfer(msg.sender, usdcOut);
    }
}
