// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PolymarketOrderSigner} from "../src/polymarket/PolymarketOrderSigner.sol";

/// Mirror of CTFExchangeV2's Order struct (ctf-exchange-v2 src/exchange/libraries/Structs.sol).
struct Order {
    uint256 salt;
    address maker;
    address signer;
    uint256 tokenId;
    uint256 makerAmount;
    uint256 takerAmount;
    uint8 side; // 0 BUY, 1 SELL
    uint8 signatureType; // 3 = POLY_1271
    uint256 timestamp; // ms
    bytes32 metadata;
    bytes32 builder;
    bytes signature;
}

interface ICTFExchangeV2 {
    function hashOrder(Order memory order) external view returns (bytes32);
    function validateOrder(Order memory order) external view;
    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory);
}

/// @notice The on-chain half of the EIP-1271 question, against Polymarket's REAL deployed exchange on a Polygon fork:
///         does CTFExchangeV2 accept PolymarketOrderSigner as a POLY_1271 maker? (The off-chain half, whether the
///         CLOB API accepts it, needs keeper/src/polymarket-1271-test.ts and a real API key.)
///
///   POLYGON_RPC=https://polygon-bor-rpc.publicnode.com forge test --mc PolymarketFork -vv
contract PolymarketForkTest is Test {
    ICTFExchangeV2 constant EXCHANGE = ICTFExchangeV2(0xE111180000d2663C0091e4f400237545B87B996B);
    string constant ORDER_TYPE =
        "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
    // a real Polymarket outcome token id (2024 election, Trump YES); any id works for signature validation
    uint256 constant TOKEN = 21742633143463906290569050155826241533067272736897614950488156847949938836455;

    uint256 ownerPk = 0xA11CE;
    PolymarketOrderSigner s;
    bytes32 sep;

    function setUp() public {
        string memory rpc = vm.envOr("POLYGON_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        s = new PolymarketOrderSigner(vm.addr(ownerPk));
        (, string memory name, string memory version, uint256 chainId, address vc,,) = EXCHANGE.eip712Domain();
        sep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                vc
            )
        );
    }

    function _order() internal view returns (Order memory o) {
        o = Order({
            salt: 12345,
            maker: address(s),
            signer: address(s),
            tokenId: TOKEN,
            makerAmount: 1e6, // 1 pUSD
            takerAmount: 100e6, // for 100 shares: a 1c bid that would never fill
            side: 0,
            signatureType: 3,
            timestamp: 1_763_300_000_000,
            metadata: bytes32(0),
            builder: bytes32(0),
            signature: ""
        });
    }

    function _contentsHash(Order memory o) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(bytes(ORDER_TYPE)),
                o.salt, o.maker, o.signer, o.tokenId, o.makerAmount, o.takerAmount, o.side, o.signatureType,
                o.timestamp, o.metadata, o.builder
            )
        );
    }

    function _sign7739(Order memory o) internal view returns (bytes memory) {
        bytes32 contents = _contentsHash(o);
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "TypedDataSign(Order contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)",
                ORDER_TYPE
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(typeHash, contents, keccak256("PhoebeOrderSigner"), keccak256("1"), block.chainid, address(s), bytes32(0))
        );
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(ownerPk, MessageHashUtils.toTypedDataHash(sep, structHash));
        return abi.encodePacked(r, ss, v, sep, contents, ORDER_TYPE, uint16(bytes(ORDER_TYPE).length));
    }

    function test_ourOrderHashMatchesExchange() public view {
        Order memory o = _order();
        assertEq(MessageHashUtils.toTypedDataHash(sep, _contentsHash(o)), EXCHANGE.hashOrder(o));
    }

    function test_exchangeAccepts7739SignedOrder() public view {
        Order memory o = _order();
        o.signature = _sign7739(o);
        EXCHANGE.validateOrder(o); // reverts InvalidSignature() if rejected
    }

    function test_exchangeAcceptsPreapprovedHashOrder() public {
        Order memory o = _order();
        o.signature = hex"01"; // arbitrary bytes: only the on-chain approval matters
        vm.expectRevert();
        EXCHANGE.validateOrder(o);

        bytes32 h = EXCHANGE.hashOrder(o); // before the prank: vm.prank applies to the next external call
        vm.prank(vm.addr(ownerPk));
        s.approveHash(h, true);
        EXCHANGE.validateOrder(o);
    }

    function test_exchangeRejectsStrangerSignature() public {
        Order memory o = _order();
        o.signature = _sign7739(o);
        o.salt += 1; // signature no longer matches the order
        vm.expectRevert();
        EXCHANGE.validateOrder(o);
    }
}
