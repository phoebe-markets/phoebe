// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IExecutionVenue} from "./interfaces/IExecutionVenue.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title KeeperVenue
/// @notice Execution venue backed by a market maker's inventory: Path B in NOTES.md. Polymarket's CLOB API won't
///         take orders from a contract maker, so the keeper trades on Polymarket from its own EOA and the protocol
///         trades against the keeper's inventory here, atomically, at prices the PROTOCOL sets:
///
///             ask = oracle price * (1 + spread),  bid = oracle price * (1 - spread),  spread <= MAX_SPREAD_BPS
///
/// The maker only chooses whether to be active and how much inventory to approve. It can't pick prices, so the vault
/// never trades worse than oracle +/- spread. Only allowlisted callers (the PositionManager) may trade, so third
/// parties can't pick off the maker at oracle prices. Inventory and USDC stay in the maker's wallet (pulled via
/// approvals), so the keeper can rebalance on Polymarket without touching this contract.
contract KeeperVenue is IExecutionVenue, Ownable {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_SPREAD_BPS = 300;

    IERC20 public immutable usdc;
    IERC1155 public immutable ctf;
    IPriceOracle public immutable oracle;

    address public maker;
    uint256 public spreadBps = 50;
    uint256 public maxPriceAge = 5 minutes;
    bool public active = true;
    mapping(address => bool) public callers;

    event Bought(address indexed caller, uint256 indexed tokenId, uint256 usdcIn, uint256 sharesOut, uint256 askWad);
    event Sold(address indexed caller, uint256 indexed tokenId, uint256 sharesIn, uint256 usdcOut, uint256 bidWad);
    event MakerSet(address maker);
    event ParamsSet(uint256 spreadBps, uint256 maxPriceAge);
    event ActiveSet(bool active);
    event CallerSet(address caller, bool allowed);

    error NotCaller();
    error NotMaker();
    error Inactive();
    error StalePrice();
    error NoPrice();
    error Slippage();
    error BadParams();

    constructor(IERC20 _usdc, IERC1155 _ctf, IPriceOracle _oracle, address _maker) Ownable(msg.sender) {
        usdc = _usdc;
        ctf = _ctf;
        oracle = _oracle;
        maker = _maker;
        emit MakerSet(_maker);
    }

    // ------------------------------------------------------------------ admin

    function setMaker(address m) external onlyOwner {
        maker = m;
        emit MakerSet(m);
    }

    function setParams(uint256 _spreadBps, uint256 _maxPriceAge) external onlyOwner {
        if (_spreadBps > MAX_SPREAD_BPS || _maxPriceAge == 0) revert BadParams();
        (spreadBps, maxPriceAge) = (_spreadBps, _maxPriceAge);
        emit ParamsSet(_spreadBps, _maxPriceAge);
    }

    function setCaller(address c, bool allowed) external onlyOwner {
        callers[c] = allowed;
        emit CallerSet(c, allowed);
    }

    /// @notice The maker (or owner) can stop quoting, e.g. while rebalancing or if Polymarket is unreachable.
    function setActive(bool on) external {
        if (msg.sender != maker && msg.sender != owner()) revert NotMaker();
        active = on;
        emit ActiveSet(on);
    }

    // ------------------------------------------------------------------ quotes

    function askWad(uint256 tokenId) public view returns (uint256 ask) {
        uint256 p = _price(tokenId);
        ask = p * (BPS + spreadBps) / BPS;
        if (ask > WAD) ask = WAD;
    }

    function bidWad(uint256 tokenId) public view returns (uint256) {
        return _price(tokenId) * (BPS - spreadBps) / BPS;
    }

    function _price(uint256 tokenId) internal view returns (uint256 p) {
        uint256 updatedAt;
        (p, updatedAt) = oracle.getPrice(tokenId);
        if (block.timestamp - updatedAt > maxPriceAge) revert StalePrice();
    }

    // ------------------------------------------------------------------ IExecutionVenue

    function buy(uint256 tokenId, uint256 usdcIn, uint256 minSharesOut) external returns (uint256 sharesOut) {
        _check();
        uint256 ask = askWad(tokenId);
        if (ask == 0) revert NoPrice();
        sharesOut = usdcIn * WAD / ask;
        if (sharesOut < minSharesOut) revert Slippage();
        usdc.safeTransferFrom(msg.sender, maker, usdcIn);
        ctf.safeTransferFrom(maker, msg.sender, tokenId, sharesOut, "");
        emit Bought(msg.sender, tokenId, usdcIn, sharesOut, ask);
    }

    function sell(uint256 tokenId, uint256 shares, uint256 minUsdcOut) external returns (uint256 usdcOut) {
        _check();
        uint256 bid = bidWad(tokenId);
        usdcOut = shares * bid / WAD;
        if (usdcOut < minUsdcOut) revert Slippage();
        ctf.safeTransferFrom(msg.sender, maker, tokenId, shares, "");
        if (usdcOut > 0) usdc.safeTransferFrom(maker, msg.sender, usdcOut);
        emit Sold(msg.sender, tokenId, shares, usdcOut, bid);
    }

    function _check() internal view {
        if (!callers[msg.sender]) revert NotCaller();
        if (!active) revert Inactive();
    }
}
