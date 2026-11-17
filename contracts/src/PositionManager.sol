// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LendingPool} from "./LendingPool.sol";
import {RiskEngine} from "./RiskEngine.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IExecutionVenue} from "./interfaces/IExecutionVenue.sol";

/// @title PositionManager
/// @notice Leveraged long positions in Polymarket outcome tokens. (A short on YES is a long on NO.)
///
/// open:      trader posts USDC margin and borrows from the pool. The venue buys shares, which this
///            contract holds as collateral.
/// close:     sell shares through the venue, repay the debt, and send the rest to the trader.
/// liquidate: Aave-style. The liquidator repays the debt in USDC and receives shares worth debt * (1 + bonus)
///            at the oracle price. No venue trade is needed, so liquidations don't depend on order-book depth.
///            If the shares are worth less than that, the liquidator takes all of them and the shortfall is
///            written off (junior tranche first).
contract PositionManager is ERC1155Holder, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;

    struct Position {
        address owner;
        uint256 tokenId;
        uint256 shares;
        uint256 scaledDebt;
    }

    struct Health {
        uint256 priceWad;
        uint256 value; // USDC, shares marked at oracle
        uint256 debt; // USDC
        uint256 ltvBps;
        uint256 maxLtvBps;
        uint256 liqLtvBps;
        bool liquidatable;
    }

    IERC20 public immutable usdc;
    IERC1155 public immutable ctf;
    LendingPool public immutable pool;
    RiskEngine public immutable risk;
    IPriceOracle public oracle;
    IExecutionVenue public venue;

    uint256 public liquidationBonusBps = 500; // to the liquidator (starting bonus)
    /// @notice Dutch-auction bonus: once flagged liquidatable, the bonus grows by this much per hour up to the max,
    ///         so liquidations clear at whatever discount the market's depth requires. 0 = fixed bonus.
    uint256 public bonusRampBpsPerHour;
    uint256 public maxLiquidationBonusBps = 500;
    mapping(uint256 => uint256) public liquidatableSince;
    uint256 public liquidationFeeBps; // to the pool (junior), on top of the bonus
    uint256 public openFeeBps; // of the borrowed amount, to the pool (junior)
    uint256 public maxPriceAge = 10 minutes;

    uint256 public nextId = 1;
    mapping(uint256 => Position) public positions;
    mapping(uint256 => uint256) public marketScaledDebt;
    mapping(uint32 => uint256) public clusterScaledDebt;
    /// @notice Leftover shares from liquidations, claimed by pulling (so a non-receiver owner can't block liquidation).
    mapping(address => mapping(uint256 => uint256)) public claimableShares;

    /// @notice If set, underwater positions can't be fire-sold to liquidators. They're absorbed instead: the debt
    ///         is written off against junior immediately (conservative NAV), and the shares go to `inventory`.
    ///         The shares are later redeemed at resolution, or sold when the book is healthy, and the proceeds go
    ///         back to junior. Outcome-token prices are ~martingales, so holding has the same expected value as
    ///         selling now, minus the liquidation discount and minus slippage into a book that just crashed.
    bool public absorbUnderwater;
    mapping(uint256 => uint256) public inventory;
    mapping(address => bool) public keepers;

    event Opened(
        uint256 indexed id, address indexed owner, uint256 indexed tokenId, uint256 margin, uint256 borrowed, uint256 shares
    );
    event MarginAdded(uint256 indexed id, uint256 repaid);
    event Closed(uint256 indexed id, uint256 proceeds, uint256 repaid, uint256 toOwner);
    event Liquidated(
        uint256 indexed id,
        address indexed liquidator,
        uint256 debt,
        uint256 paid,
        uint256 sharesSeized,
        uint256 sharesToOwner,
        uint256 badDebt
    );
    event Flagged(uint256 indexed id, uint256 since);
    event SharesClaimed(address indexed owner, uint256 indexed tokenId, uint256 shares);
    event Absorbed(uint256 indexed id, uint256 indexed tokenId, uint256 debt, uint256 shares, uint256 markValue);
    event InventorySold(uint256 indexed tokenId, uint256 shares, uint256 proceeds);

    error NotOwner();
    error OpenNotAllowed();
    error StalePrice();
    error LtvTooHigh();
    error BorrowCapExceeded();
    error ClusterCapExceeded();
    error PositionTooLarge();
    error Underwater();
    error Healthy();
    error NoPosition();
    error ZeroAmount();
    error NotUnderwater();
    error UseAbsorb();
    error NotKeeper();

    constructor(
        IERC20 _usdc,
        IERC1155 _ctf,
        LendingPool _pool,
        RiskEngine _risk,
        IPriceOracle _oracle,
        IExecutionVenue _venue
    ) Ownable(msg.sender) {
        usdc = _usdc;
        ctf = _ctf;
        pool = _pool;
        risk = _risk;
        oracle = _oracle;
        _setVenue(_venue);
    }

    // ------------------------------------------------------------------ admin

    function setVenue(IExecutionVenue v) external onlyOwner {
        ctf.setApprovalForAll(address(venue), false);
        _setVenue(v);
    }

    function setOracle(IPriceOracle o) external onlyOwner {
        oracle = o;
    }

    function setParams(uint256 _liquidationBonusBps, uint256 _maxPriceAge) external onlyOwner {
        require(_liquidationBonusBps <= 2_000, "bonus");
        (liquidationBonusBps, maxPriceAge) = (_liquidationBonusBps, _maxPriceAge);
        if (maxLiquidationBonusBps < _liquidationBonusBps) maxLiquidationBonusBps = _liquidationBonusBps;
    }

    function setBonusRamp(uint256 rampBpsPerHour, uint256 maxBonusBps) external onlyOwner {
        require(maxBonusBps >= liquidationBonusBps && maxBonusBps <= 2_500, "bonus");
        (bonusRampBpsPerHour, maxLiquidationBonusBps) = (rampBpsPerHour, maxBonusBps);
    }

    function setAbsorbUnderwater(bool on) external onlyOwner {
        absorbUnderwater = on;
    }

    function setKeeper(address who, bool allowed) external onlyOwner {
        keepers[who] = allowed;
    }

    function setFees(uint256 _openFeeBps, uint256 _liquidationFeeBps) external onlyOwner {
        require(_openFeeBps <= 500 && _liquidationFeeBps <= 1_000, "fee");
        (openFeeBps, liquidationFeeBps) = (_openFeeBps, _liquidationFeeBps);
    }

    function _setVenue(IExecutionVenue v) internal {
        venue = v;
        ctf.setApprovalForAll(address(v), true);
    }

    // ------------------------------------------------------------------ trader actions

    /// @param margin       USDC the trader posts.
    /// @param borrowAmount USDC borrowed from the pool. Leverage = (margin + borrow) / margin.
    ///                     The opening fee (openFeeBps of this) is pulled on top of `margin`.
    /// @param minShares    Slippage bound on the venue buy.
    function open(uint256 tokenId, uint256 margin, uint256 borrowAmount, uint256 minShares)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (margin == 0) revert ZeroAmount();
        if (!risk.isOpenAllowed(tokenId)) revert OpenNotAllowed();
        uint256 price = _price(tokenId);

        usdc.safeTransferFrom(msg.sender, address(this), margin);
        uint256 fee = borrowAmount * openFeeBps / BPS;
        if (fee > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), fee);
            usdc.forceApprove(address(pool), fee);
            pool.donate(fee);
        }

        uint256 maxBorrow = risk.maxPositionBorrow(tokenId);
        if (maxBorrow != 0 && borrowAmount > maxBorrow) revert PositionTooLarge();

        uint256 scaled;
        if (borrowAmount > 0) {
            scaled = pool.borrow(borrowAmount);
            uint256 mktDebt = (marketScaledDebt[tokenId] + scaled).mulDiv(pool.borrowIndex(), RAY);
            if (mktDebt > risk.borrowCap(tokenId)) revert BorrowCapExceeded();
            marketScaledDebt[tokenId] += scaled;
            uint32 c = risk.clusterOf(tokenId);
            if (c != 0) {
                clusterScaledDebt[c] += scaled;
                if (clusterScaledDebt[c].mulDiv(pool.borrowIndex(), RAY) > risk.clusterCap(c)) revert ClusterCapExceeded();
            }
        }

        uint256 spend = margin + borrowAmount;
        usdc.forceApprove(address(venue), spend);
        uint256 shares = venue.buy(tokenId, spend, minShares);

        uint256 debt = pool.debtOf(scaled);
        uint256 value = shares.mulDiv(price, WAD);
        if (debt * BPS > value * risk.maxLtvBps(tokenId, price)) revert LtvTooHigh();

        id = nextId++;
        positions[id] = Position({owner: msg.sender, tokenId: tokenId, shares: shares, scaledDebt: scaled});
        emit Opened(id, msg.sender, tokenId, margin, borrowAmount, shares);
    }

    /// @notice Repay part of the debt with fresh USDC (deleverage / move away from liquidation). Any excess is refunded.
    function addMargin(uint256 id, uint256 amount) external nonReentrant {
        Position storage p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        if (amount == 0) revert ZeroAmount();
        pool.accrue();

        uint256 scaledRepay = Math.min(p.scaledDebt, amount.mulDiv(RAY, pool.borrowIndex()));
        if (scaledRepay == 0) revert ZeroAmount();
        uint256 owed = pool.debtOf(scaledRepay);

        usdc.safeTransferFrom(msg.sender, address(this), owed);
        usdc.forceApprove(address(pool), owed);
        pool.repay(scaledRepay);

        p.scaledDebt -= scaledRepay;
        marketScaledDebt[p.tokenId] -= scaledRepay;
        uint32 c = risk.clusterOf(p.tokenId);
        if (c != 0) clusterScaledDebt[c] -= scaledRepay;
        emit MarginAdded(id, owed);
    }

    /// @notice Sell everything through the venue and settle. Reverts if the proceeds can't cover the debt
    ///         (that position is a liquidation candidate instead).
    function close(uint256 id, uint256 minUsdcOut) external nonReentrant {
        Position memory p = positions[id];
        if (p.owner != msg.sender) revert NotOwner();
        pool.accrue();

        uint256 proceeds = venue.sell(p.tokenId, p.shares, minUsdcOut);
        uint256 owed = pool.debtOf(p.scaledDebt);
        if (proceeds < owed) revert Underwater();

        _clear(id, p);
        if (p.scaledDebt > 0) {
            usdc.forceApprove(address(pool), owed);
            pool.repay(p.scaledDebt);
        }
        uint256 rest = proceeds - owed;
        if (rest > 0) usdc.safeTransfer(p.owner, rest);
        emit Closed(id, proceeds, owed, rest);
    }

    function claimShares(uint256 tokenId) external nonReentrant {
        uint256 amt = claimableShares[msg.sender][tokenId];
        if (amt == 0) revert ZeroAmount();
        claimableShares[msg.sender][tokenId] = 0;
        ctf.safeTransferFrom(address(this), msg.sender, tokenId, amt, "");
        emit SharesClaimed(msg.sender, tokenId, amt);
    }

    // ------------------------------------------------------------------ liquidation

    /// @notice Start (or reset) a position's liquidation auction clock. Permissionless: keepers call it as soon as a
    ///         position is liquidatable, and anyone can clear the flag once the position is healthy again.
    function flag(uint256 id) external {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        bool liq = _health(p, pool.currentBorrowIndex()).liquidatable;
        if (liq && liquidatableSince[id] == 0) {
            liquidatableSince[id] = block.timestamp;
            emit Flagged(id, block.timestamp);
        } else if (!liq && liquidatableSince[id] != 0) {
            delete liquidatableSince[id];
            emit Flagged(id, 0);
        }
    }

    /// @notice Current liquidator bonus for a position (bps): the start bonus, plus the ramp since it was flagged.
    function currentBonusBps(uint256 id) public view returns (uint256) {
        uint256 since = liquidatableSince[id];
        if (since == 0 || bonusRampBpsPerHour == 0) return liquidationBonusBps;
        uint256 b = liquidationBonusBps + (block.timestamp - since) * bonusRampBpsPerHour / 1 hours;
        return b > maxLiquidationBonusBps ? maxLiquidationBonusBps : b;
    }

    /// @notice Full liquidation. The caller pays USDC and receives shares at a discount.
    /// @param maxPay Most USDC the caller is willing to pay (front-running guard).
    function liquidate(uint256 id, uint256 maxPay) external nonReentrant returns (uint256 paid, uint256 seized) {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        pool.accrue();

        Health memory h = _health(p, pool.borrowIndex());
        if (!h.liquidatable) revert Healthy();

        // Shares the debt (plus protocol fee) buys at the discounted (bonus) price.
        uint256 bonus = currentBonusBps(id);
        uint256 premium = bonus + liquidationFeeBps;
        uint256 sharesForDebt =
            h.priceWad == 0 ? type(uint256).max : h.debt.mulDiv((BPS + premium) * WAD, BPS * h.priceWad);

        uint256 badDebt;
        uint256 toOwner;
        uint256 fee;
        if (sharesForDebt <= p.shares) {
            fee = h.debt * liquidationFeeBps / BPS;
            paid = h.debt + fee;
            seized = sharesForDebt;
            toOwner = p.shares - seized;
        } else {
            if (absorbUnderwater) revert UseAbsorb();
            // Underwater: everything recovered goes to the debt, no protocol fee.
            seized = p.shares;
            paid = h.value.mulDiv(BPS, BPS + bonus);
            if (paid > h.debt) paid = h.debt; // collateral covers debt but not debt+fee+bonus
            badDebt = h.debt - paid;
        }
        require(paid <= maxPay, "maxPay");

        _clear(id, p);
        if (paid > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), paid);
            usdc.forceApprove(address(pool), paid);
        }
        if (badDebt == 0) pool.repay(p.scaledDebt);
        else pool.writeOff(p.scaledDebt, paid);
        if (fee > 0) pool.donate(fee);

        if (toOwner > 0) claimableShares[p.owner][p.tokenId] += toOwner;
        ctf.safeTransferFrom(address(this), msg.sender, p.tokenId, seized, "");

        emit Liquidated(id, msg.sender, h.debt, paid, seized, toOwner, badDebt);
    }

    /// @notice Absorb an underwater position (collateral at oracle < debt * (1 + bonus + fee)) into the backstop
    ///         inventory. Permissionless. The trader has already lost their margin, and the LPs keep the
    ///         shares' upside instead of selling them at the bottom.
    function absorb(uint256 id) external nonReentrant {
        if (!absorbUnderwater) revert UseAbsorb();
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        pool.accrue();

        Health memory h = _health(p, pool.borrowIndex());
        if (!h.liquidatable) revert Healthy();
        uint256 premium = currentBonusBps(id) + liquidationFeeBps;
        if (h.priceWad > 0 && h.debt.mulDiv((BPS + premium) * WAD, BPS * h.priceWad) <= p.shares) revert NotUnderwater();

        _clear(id, p);
        pool.writeOff(p.scaledDebt, 0);
        inventory[p.tokenId] += p.shares;
        emit Absorbed(id, p.tokenId, h.debt, p.shares, h.value);
    }

    /// @notice Sell backstop inventory through the venue (after resolution, or once the book has recovered).
    ///         Proceeds go to the pool's junior tranche. Keeper-gated: the timing is a judgement call.
    function sellInventory(uint256 tokenId, uint256 shares, uint256 minUsdcOut)
        external
        nonReentrant
        returns (uint256 proceeds)
    {
        if (!keepers[msg.sender] && msg.sender != owner()) revert NotKeeper();
        inventory[tokenId] -= shares;
        proceeds = venue.sell(tokenId, shares, minUsdcOut);
        if (proceeds > 0) {
            usdc.forceApprove(address(pool), proceeds);
            pool.donate(proceeds);
        }
        emit InventorySold(tokenId, shares, proceeds);
    }

    /// @notice Inventory marked at the oracle price (USDC). Off-book: junior NAV excludes it until it's realized.
    function inventoryValue(uint256 tokenId) external view returns (uint256) {
        (uint256 price,) = oracle.getPrice(tokenId);
        return inventory[tokenId].mulDiv(price, WAD);
    }

    // ------------------------------------------------------------------ views

    function health(uint256 id) external view returns (Health memory) {
        Position memory p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
        return _health(p, pool.currentBorrowIndex());
    }

    function debtOf(uint256 id) external view returns (uint256) {
        return positions[id].scaledDebt.mulDiv(pool.currentBorrowIndex(), RAY, Math.Rounding.Ceil);
    }

    // ------------------------------------------------------------------ internal

    function _health(Position memory p, uint256 index) internal view returns (Health memory h) {
        (uint256 price, uint256 updatedAt) = oracle.getPrice(p.tokenId);
        h.priceWad = price;
        h.value = p.shares.mulDiv(price, WAD);
        h.debt = p.scaledDebt.mulDiv(index, RAY, Math.Rounding.Ceil);
        h.ltvBps = h.value == 0 ? (h.debt == 0 ? 0 : type(uint256).max) : h.debt * BPS / h.value;
        h.maxLtvBps = risk.maxLtvBps(p.tokenId, price);
        h.liqLtvBps = risk.liqLtvBps(p.tokenId, price);
        // Stale prices block liquidation: never liquidate on bad data. Keepers must keep the oracle fresh.
        h.liquidatable = h.debt > 0 && block.timestamp - updatedAt <= maxPriceAge && h.debt * BPS > h.value * h.liqLtvBps;
    }

    function _price(uint256 tokenId) internal view returns (uint256 price) {
        uint256 updatedAt;
        (price, updatedAt) = oracle.getPrice(tokenId);
        if (block.timestamp - updatedAt > maxPriceAge) revert StalePrice();
    }

    function _clear(uint256 id, Position memory p) internal {
        marketScaledDebt[p.tokenId] -= p.scaledDebt;
        uint32 c = risk.clusterOf(p.tokenId);
        if (c != 0) clusterScaledDebt[c] -= p.scaledDebt;
        delete positions[id];
        delete liquidatableSince[id];
    }
}
