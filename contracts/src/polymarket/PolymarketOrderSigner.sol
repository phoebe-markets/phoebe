// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {SignerECDSA} from "@openzeppelin/contracts/utils/cryptography/signers/SignerECDSA.sol";

/// @title PolymarketOrderSigner
/// @notice A contract maker for Polymarket's CTF Exchange V2 (SignatureType.POLY_1271: signer == maker == this).
///         Built to answer one question before the vault depends on it: will Polymarket's CLOB accept orders from
///         an arbitrary EIP-1271 contract? See NOTES.md and keeper/src/polymarket-1271-test.ts.
///
/// An order signature is valid if EITHER
///   1. the owner pre-approved the exact order hash on-chain (approveHash). This is the planned vault design: the
///      vault decides which orders exist, and the signature bytes are irrelevant; or
///   2. it is an ERC-7739 nested typed-data signature by the owner over the order: the same wire format Polymarket's
///      client produces for its own deposit wallets, but under THIS contract's EIP-712 domain ("PhoebeOrderSigner").
///
/// The contract holds the funds (pUSD collateral, outcome shares). Only the owner can approve spenders or withdraw.
contract PolymarketOrderSigner is ERC7739, SignerECDSA, ERC1155Holder {
    using SafeERC20 for IERC20;

    mapping(bytes32 => bool) public approvedHash;

    event HashApproved(bytes32 indexed hash, bool approved);

    error NotOwner();

    constructor(address owner_) EIP712("PhoebeOrderSigner", "1") SignerECDSA(owner_) {}

    modifier onlyOwner() {
        if (msg.sender != signer()) revert NotOwner();
        _;
    }

    function owner() external view returns (address) {
        return signer();
    }

    // ------------------------------------------------------------------ signatures

    function isValidSignature(bytes32 hash, bytes calldata signature)
        public
        view
        override(ERC7739)
        returns (bytes4)
    {
        if (approvedHash[hash]) return IERC1271.isValidSignature.selector;
        return super.isValidSignature(hash, signature);
    }

    function approveHash(bytes32 hash, bool approved) external onlyOwner {
        approvedHash[hash] = approved;
        emit HashApproved(hash, approved);
    }

    // ------------------------------------------------------------------ funds (owner only)

    /// @notice e.g. let the exchange pull pUSD for BUY orders.
    function approveERC20(IERC20 token, address spender, uint256 amount) external onlyOwner {
        token.forceApprove(spender, amount);
    }

    /// @notice e.g. let the exchange move outcome shares for SELL orders.
    function setApprovalForAll(IERC1155 token, address operator, bool approved) external onlyOwner {
        token.setApprovalForAll(operator, approved);
    }

    function withdrawERC20(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    function withdrawERC1155(IERC1155 token, uint256 id, address to, uint256 amount) external onlyOwner {
        token.safeTransferFrom(address(this), to, id, amount, "");
    }
}
