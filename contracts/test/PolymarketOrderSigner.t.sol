// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PolymarketOrderSigner} from "../src/polymarket/PolymarketOrderSigner.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract PolymarketOrderSignerTest is Test {
    bytes4 constant MAGIC = IERC1271.isValidSignature.selector;

    // Polymarket CTF Exchange V2 order type (clob-client-v2: ORDER_TYPE_STRING)
    string constant ORDER_TYPE =
        "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";

    uint256 ownerPk = 0xA11CE;
    address owner;
    PolymarketOrderSigner s;
    bytes32 exchangeSeparator;

    function setUp() public {
        owner = vm.addr(ownerPk);
        s = new PolymarketOrderSigner(owner);
        // stand-in for the exchange's EIP-712 domain separator
        exchangeSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Polymarket CTF Exchange"),
                keccak256("2"),
                block.chainid,
                address(0xE111180000d2663C0091e4f400237545B87B996B)
            )
        );
    }

    function _orderHash() internal view returns (bytes32 contentsHash, bytes32 orderHash) {
        contentsHash = keccak256(
            abi.encode(
                keccak256(bytes(ORDER_TYPE)),
                uint256(42), address(s), address(s), uint256(7), uint256(1e6), uint256(100e6), uint8(0), uint8(3),
                uint256(1_700_000_000_000), bytes32(0), bytes32(0)
            )
        );
        orderHash = MessageHashUtils.toTypedDataHash(exchangeSeparator, contentsHash);
    }

    /// Build the ERC-7739 nested typed-data signature exactly as clob-client-v2 does for POLY_1271:
    /// innerSig(65) || appDomainSep(32) || contentsHash(32) || contentsType || uint16(len)
    function _sign7739(uint256 pk, bytes32 contentsHash, address verifying) internal view returns (bytes memory) {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "TypedDataSign(Order contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)",
                ORDER_TYPE
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(typeHash, contentsHash, keccak256("PhoebeOrderSigner"), keccak256("1"), block.chainid, verifying, bytes32(0))
        );
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pk, MessageHashUtils.toTypedDataHash(exchangeSeparator, structHash));
        return abi.encodePacked(r, ss, v, exchangeSeparator, contentsHash, ORDER_TYPE, uint16(bytes(ORDER_TYPE).length));
    }

    function test_7739SignatureByOwnerIsValid() public view {
        (bytes32 contentsHash, bytes32 orderHash) = _orderHash();
        assertEq(s.isValidSignature(orderHash, _sign7739(ownerPk, contentsHash, address(s))), MAGIC);
    }

    function test_7739SignatureByStrangerIsInvalid() public view {
        (bytes32 contentsHash, bytes32 orderHash) = _orderHash();
        assertEq(s.isValidSignature(orderHash, _sign7739(0xB0B, contentsHash, address(s))), bytes4(0xffffffff));
    }

    function test_7739SignatureForAnotherContractIsInvalid() public view {
        (bytes32 contentsHash, bytes32 orderHash) = _orderHash();
        assertEq(s.isValidSignature(orderHash, _sign7739(ownerPk, contentsHash, address(0xdead))), bytes4(0xffffffff));
    }

    function test_approvedHashIsValidWithAnySignatureBytes() public {
        (, bytes32 orderHash) = _orderHash();
        assertEq(s.isValidSignature(orderHash, hex"00"), bytes4(0xffffffff));
        vm.prank(owner);
        s.approveHash(orderHash, true);
        assertEq(s.isValidSignature(orderHash, hex"00"), MAGIC);
        vm.prank(owner);
        s.approveHash(orderHash, false);
        assertEq(s.isValidSignature(orderHash, hex"00"), bytes4(0xffffffff));
    }

    function test_onlyOwnerManagesFunds() public {
        MockUSDC usdc = new MockUSDC();
        usdc.mint(address(s), 5e6);
        vm.expectRevert(PolymarketOrderSigner.NotOwner.selector);
        s.withdrawERC20(usdc, address(this), 5e6);
        vm.expectRevert(PolymarketOrderSigner.NotOwner.selector);
        s.approveHash(bytes32(uint256(1)), true);
        vm.prank(owner);
        s.withdrawERC20(usdc, owner, 5e6);
        assertEq(usdc.balanceOf(owner), 5e6);
    }
}
