// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title LendingPool
/// @notice Holds LP USDC for two tranches and lends it to the PositionManager.
///
/// Invariant (up to rounding): seniorAssets + juniorAssets == cash + totalDebt
///
/// - Interest: borrowers pay a rate that rises with utilization, using a kinked curve. Senior gets
///   `seniorYieldShareBps` of its pro-rata share of interest, and junior gets everything else
///   (a boosted yield in exchange for taking first loss).
/// - Losses: bad debt is written off against junior first, then senior.
/// - Coverage: new borrows and junior withdrawals must leave
///   juniorAssets >= totalDebt * minJuniorCoverageBps. If junior gets thin, leverage stops growing.
contract LendingPool is Ownable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint8 public constant SENIOR = 0;
    uint8 public constant JUNIOR = 1;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant YEAR = 365 days;

    IERC20 public immutable usdc;
    address public manager;
    address[2] public vaults;

    // --- accounting (as of lastAccrual)
    uint256 public cash;
    uint256 public totalScaledDebt;
    uint256 public borrowIndex = RAY;
    uint256 public lastAccrual;
    uint256[2] internal trancheAssets_;

    // --- params (WAD per year for rates)
    uint256 public baseRate = 0.05e18;
    uint256 public slope1 = 0.15e18;
    uint256 public kink = 0.8e18;
    uint256 public slope2 = 1.5e18;
    uint256 public seniorYieldShareBps = 6_000;
    uint256 public minJuniorCoverageBps = 2_000; // junior >= 20% of outstanding debt

    // --- launch guards: per-tranche deposit caps, and a deposit pause (guardians pause, only the owner un-pauses)
    uint256[2] public depositCap = [type(uint256).max, type(uint256).max];
    bool public depositsPaused;
    mapping(address => bool) public guardians;

    event Accrued(uint256 interest, uint256 toSenior, uint256 toJunior, uint256 borrowIndex);
    event Borrowed(uint256 amount, uint256 scaled);
    event Repaid(uint256 amount, uint256 scaled);
    event WrittenOff(uint256 owed, uint256 recovered, uint256 juniorLoss, uint256 seniorLoss);
    event Donated(uint256 amount, uint8 tranche);
    event TrancheDeposit(uint8 indexed tranche, uint256 assets);
    event TrancheWithdraw(uint8 indexed tranche, uint256 assets, address receiver);

    error OnlyManager();
    error OnlyVault();
    error AlreadySet();
    error InsufficientCash();
    error JuniorCoverage();
    error BadParams();
    error DepositCap();
    error NotGuardian();

    modifier onlyManager() {
        if (msg.sender != manager) revert OnlyManager();
        _;
    }

    constructor(IERC20 _usdc) Ownable(msg.sender) {
        usdc = _usdc;
        lastAccrual = block.timestamp;
    }

    // ------------------------------------------------------------------ wiring / params

    function setManager(address m) external onlyOwner {
        if (manager != address(0)) revert AlreadySet();
        manager = m;
    }

    function setVaults(address senior, address junior) external onlyOwner {
        if (vaults[0] != address(0)) revert AlreadySet();
        vaults = [senior, junior];
    }

    function setRateParams(uint256 _base, uint256 _slope1, uint256 _kink, uint256 _slope2) external onlyOwner {
        if (_kink == 0 || _kink > WAD) revert BadParams();
        accrue();
        (baseRate, slope1, kink, slope2) = (_base, _slope1, _kink, _slope2);
    }

    function setTrancheParams(uint256 _seniorYieldShareBps, uint256 _minJuniorCoverageBps) external onlyOwner {
        if (_seniorYieldShareBps > BPS) revert BadParams();
        accrue();
        (seniorYieldShareBps, minJuniorCoverageBps) = (_seniorYieldShareBps, _minJuniorCoverageBps);
    }

    function setDepositCaps(uint256 seniorCap, uint256 juniorCap) external onlyOwner {
        depositCap = [seniorCap, juniorCap];
    }

    function setGuardian(address who, bool allowed) external onlyOwner {
        guardians[who] = allowed;
    }

    function setDepositsPaused(bool on) external {
        if (msg.sender != owner() && !(on && guardians[msg.sender])) revert NotGuardian();
        depositsPaused = on;
    }

    // ------------------------------------------------------------------ views

    /// @notice Most a tranche can take in right now (deposit cap headroom; 0 while deposits are paused).
    function maxDepositable(uint8 tranche) public view returns (uint256) {
        if (depositsPaused) return 0;
        uint256 a = trancheAssets(tranche);
        uint256 cap = depositCap[tranche];
        return a >= cap ? 0 : cap - a;
    }

    function totalDebt() public view returns (uint256) {
        (uint256 idx,,) = _previewAccrual();
        return totalScaledDebt.mulDiv(idx, RAY, Math.Rounding.Ceil);
    }

    function currentBorrowIndex() public view returns (uint256 idx) {
        (idx,,) = _previewAccrual();
    }

    function trancheAssets(uint8 tranche) public view returns (uint256) {
        (, uint256 s, uint256 j) = _previewAccrual();
        return tranche == SENIOR ? s : j;
    }

    function utilization() public view returns (uint256) {
        uint256 debt = totalScaledDebt.mulDiv(borrowIndex, RAY);
        uint256 total = cash + debt;
        return total == 0 ? 0 : debt * WAD / total;
    }

    /// @return Annual borrow rate, WAD.
    function borrowRate() public view returns (uint256) {
        uint256 u = utilization();
        if (u <= kink) return baseRate + slope1 * u / kink;
        return baseRate + slope1 + slope2 * (u - kink) / (WAD - kink);
    }

    /// @notice Max assets a tranche can withdraw right now (cash-limited, junior also coverage-limited).
    function maxWithdrawable(uint8 tranche) public view returns (uint256) {
        (uint256 idx, uint256 s, uint256 j) = _previewAccrual();
        if (tranche == SENIOR) return Math.min(s, cash);
        uint256 required = totalScaledDebt.mulDiv(idx, RAY, Math.Rounding.Ceil) * minJuniorCoverageBps / BPS;
        uint256 free = j > required ? j - required : 0;
        return Math.min(free, cash);
    }

    /// @notice Max additional debt the junior tranche can currently cover.
    function borrowCapacity() external view returns (uint256) {
        (uint256 idx,, uint256 j) = _previewAccrual();
        uint256 debt = totalScaledDebt.mulDiv(idx, RAY, Math.Rounding.Ceil);
        uint256 maxDebt = minJuniorCoverageBps == 0 ? type(uint256).max : j * BPS / minJuniorCoverageBps;
        uint256 byCoverage = maxDebt > debt ? maxDebt - debt : 0;
        return Math.min(byCoverage, cash);
    }

    // ------------------------------------------------------------------ accrual

    function accrue() public {
        if (block.timestamp == lastAccrual) return;
        (uint256 idx, uint256 s, uint256 j) = _previewAccrual();
        uint256 interest = (s + j) - (trancheAssets_[SENIOR] + trancheAssets_[JUNIOR]);
        if (interest > 0) {
            emit Accrued(interest, s - trancheAssets_[SENIOR], j - trancheAssets_[JUNIOR], idx);
        }
        borrowIndex = idx;
        trancheAssets_[SENIOR] = s;
        trancheAssets_[JUNIOR] = j;
        lastAccrual = block.timestamp;
    }

    function _previewAccrual() internal view returns (uint256 idx, uint256 s, uint256 j) {
        idx = borrowIndex;
        s = trancheAssets_[SENIOR];
        j = trancheAssets_[JUNIOR];
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0 || totalScaledDebt == 0) return (idx, s, j);

        uint256 newIdx = idx + idx.mulDiv(borrowRate() * dt, WAD * YEAR);
        uint256 interest = totalScaledDebt.mulDiv(newIdx - idx, RAY);
        idx = newIdx;

        uint256 total = s + j;
        if (total == 0) return (idx, s, j + interest);
        uint256 seniorCut = interest.mulDiv(s, total).mulDiv(seniorYieldShareBps, BPS);
        s += seniorCut;
        j += interest - seniorCut;
    }

    // ------------------------------------------------------------------ manager: borrow / repay / write-off

    /// @notice Sends `amount` USDC to the manager. Returns the scaled debt to book against the position.
    function borrow(uint256 amount) external onlyManager returns (uint256 scaled) {
        accrue();
        if (amount > cash) revert InsufficientCash();
        uint256 debtAfter = totalScaledDebt.mulDiv(borrowIndex, RAY, Math.Rounding.Ceil) + amount;
        if (trancheAssets_[JUNIOR] * BPS < debtAfter * minJuniorCoverageBps) revert JuniorCoverage();

        scaled = amount.mulDiv(RAY, borrowIndex, Math.Rounding.Ceil);
        totalScaledDebt += scaled;
        cash -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Borrowed(amount, scaled);
    }

    /// @notice Repays `scaled` debt in full. Pulls the owed USDC from the manager.
    function repay(uint256 scaled) external onlyManager returns (uint256 amount) {
        accrue();
        amount = debtOf(scaled);
        totalScaledDebt -= scaled;
        cash += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Repaid(amount, scaled);
    }

    /// @notice Closes out `scaled` debt with only `recovered` USDC. The shortfall hits junior first, then senior.
    function writeOff(uint256 scaled, uint256 recovered) external onlyManager returns (uint256 loss) {
        accrue();
        uint256 owed = debtOf(scaled);
        if (recovered > owed) recovered = owed;
        loss = owed - recovered;

        totalScaledDebt -= scaled;
        cash += recovered;
        if (recovered > 0) usdc.safeTransferFrom(msg.sender, address(this), recovered);

        uint256 jl = Math.min(loss, trancheAssets_[JUNIOR]);
        uint256 sl = Math.min(loss - jl, trancheAssets_[SENIOR]);
        trancheAssets_[JUNIOR] -= jl;
        trancheAssets_[SENIOR] -= sl;
        emit WrittenOff(owed, recovered, jl, sl);
    }

    /// @notice Protocol fees (opening fees, liquidation fees) paid to the pool. They go to junior, the insurance
    ///         buffer that takes first loss, or to senior if there's no junior.
    function donate(uint256 amount) external onlyManager {
        accrue();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        cash += amount;
        uint8 t = trancheAssets_[JUNIOR] > 0 ? JUNIOR : SENIOR;
        trancheAssets_[t] += amount;
        emit Donated(amount, t);
    }

    /// @notice Converts scaled debt to USDC owed at the current (already-accrued) index.
    function debtOf(uint256 scaled) public view returns (uint256) {
        return scaled.mulDiv(borrowIndex, RAY, Math.Rounding.Ceil);
    }

    // ------------------------------------------------------------------ vault hooks

    /// @dev Vault has already transferred `assets` USDC to this contract.
    function onDeposit(uint8 tranche, uint256 assets) external {
        if (msg.sender != vaults[tranche]) revert OnlyVault();
        accrue();
        if (depositsPaused || trancheAssets_[tranche] + assets > depositCap[tranche]) revert DepositCap();
        cash += assets;
        trancheAssets_[tranche] += assets;
        emit TrancheDeposit(tranche, assets);
    }

    function onWithdraw(uint8 tranche, uint256 assets, address receiver) external {
        if (msg.sender != vaults[tranche]) revert OnlyVault();
        accrue();
        if (assets > cash) revert InsufficientCash();
        trancheAssets_[tranche] -= assets;
        if (tranche == JUNIOR) {
            uint256 debt = totalScaledDebt.mulDiv(borrowIndex, RAY, Math.Rounding.Ceil);
            if (trancheAssets_[JUNIOR] * BPS < debt * minJuniorCoverageBps) revert JuniorCoverage();
        }
        cash -= assets;
        usdc.safeTransfer(receiver, assets);
        emit TrancheWithdraw(tranche, assets, receiver);
    }
}
