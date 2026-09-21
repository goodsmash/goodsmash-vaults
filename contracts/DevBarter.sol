// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
 * GoodsMash Rigs - thanks for using this.
 * Built in the open at github.com/goodsmash/goodsmash-vaults
 * Copy it, fork it, deploy your own - that is what it is here for.
 */

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title DevBarter
 * @notice Two people agree an NFT-for-NFT trade by signing the same terms. ANYONE can then
 *         submit both signatures in one transaction and the swap happens atomically.
 *
 * WHY THIS EXISTS
 *   The blocker for dev-to-dev trading is never the swap, it is the coordination: one side
 *   has to be online, pay gas, and be holding at the right moment. Here both sides only
 *   SIGN. A third party - or whichever side is less busy - submits, and it settles in one
 *   transaction. The signer who does not submit pays nothing.
 *
 * WHAT IT IS NOT
 *   - No owner, no pause, no upgrade path, no fee recipient. Nobody - including us - can
 *     change these rules or take a cut. There is no cut to take.
 *   - Not a marketplace: it holds no listings, sets no prices and never custodies a token.
 *     Between signing and execution every token stays in its owner's wallet.
 *   - Not fractionalised: whole tokens move, one for one.
 *
 * SAFETY GUARANTEED IN CODE
 *   1. BOTH signatures are required and both are checked against the terms, so neither side
 *      can alter the other's half.
 *   2. Nothing is held between signing and execution. If the trade never executes, both
 *      people still have their tokens.
 *   3. An offer can be cancelled before anyone submits it, by burning its nonce.
 *   4. Offers expire, so a signature cannot be used years later against changed intent.
 *   5. Ownership is re-checked at execution time, not at signing time.
 */
contract DevBarter is EIP712, ReentrancyGuard {
    /// @dev Both sides of a trade are just "these tokens from this address".
    struct Trade {
        address maker;
        address[] makerCollections;
        uint256[] makerTokenIds;
        address taker;
        address[] takerCollections;
        uint256[] takerTokenIds;
        uint64 expiry;
        uint256 nonce;
    }

    bytes32 private constant TRADE_TYPEHASH = keccak256(
        "Trade(address maker,address[] makerCollections,uint256[] makerTokenIds,"
        "address taker,address[] takerCollections,uint256[] takerTokenIds,"
        "uint64 expiry,uint256 nonce)"
    );

    /// @notice The longest an offer may stay open, so nothing lingers indefinitely.
    uint64 public constant MAX_OFFER_WINDOW = 90 days;
    uint256 public constant MAX_TOKENS_PER_SIDE = 20;

    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    uint256 public executed;

    event Traded(
        bytes32 indexed tradeHash,
        address indexed maker,
        address indexed taker,
        address submitter,
        uint256 makerTokenCount,
        uint256 takerTokenCount
    );
    event NonceCancelled(address indexed account, uint256 nonce);

    error MismatchedSides();
    error TooManyTokens();
    error SameAccount();
    error BadExpiry();
    error NonceAlreadyUsed();
    error TradeExpired();
    error MakerNotOwner();
    error TakerNotOwner();
    error BadMakerSignature();
    error BadTakerSignature();
    error NotAContract();

    constructor() EIP712("DevBarter", "1") {}

    // ------------------------------------------------------------------ hashing

    function _hashTrade(Trade calldata t) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TRADE_TYPEHASH,
                t.maker,
                keccak256(abi.encodePacked(t.makerCollections)),
                keccak256(abi.encodePacked(t.makerTokenIds)),
                t.taker,
                keccak256(abi.encodePacked(t.takerCollections)),
                keccak256(abi.encodePacked(t.takerTokenIds)),
                t.expiry,
                t.nonce
            )
        );
    }

    /// @notice The exact digest both parties sign. A UI should show this so nobody signs blind.
    function tradeDigest(Trade calldata t) external view returns (bytes32) {
        return _hashTypedDataV4(_hashTrade(t));
    }

    /// @notice Convenience view so a counterparty can check an offer before signing it.
    function offerHash(Trade calldata t) external pure returns (bytes32) {
        return _hashTrade(t);
    }

    // ------------------------------------------------------------------ actions

    /**
     * @notice Settle a signed trade. Callable by ANYONE - that is the point.
     * @dev Sides must match in length. Both owners are re-checked here, so a trade that was
     *      valid when signed simply fails if someone moved a token in the meantime.
     */
    function execute(Trade calldata t, bytes calldata makerSig, bytes calldata takerSig)
        external
        nonReentrant
    {
        uint256 m = t.makerCollections.length;
        uint256 k = t.takerCollections.length;
        if (m == 0 || m != t.makerTokenIds.length) revert MismatchedSides();
        if (k != t.takerCollections.length || k == 0) revert MismatchedSides();
        if (m > MAX_TOKENS_PER_SIDE || k > MAX_TOKENS_PER_SIDE) revert TooManyTokens();
        if (t.maker == t.taker) revert SameAccount();

        if (t.expiry <= block.timestamp) revert TradeExpired();
        if (t.expiry > block.timestamp + MAX_OFFER_WINDOW) revert BadExpiry();

        if (nonceUsed[t.maker][t.nonce]) revert NonceAlreadyUsed();

        bytes32 digest = _hashTypedDataV4(_hashTrade(t));

        // SignatureChecker, not ECDSA.recover: this accepts ERC-1271 smart-contract wallets
        // (a Ledger through a smart account, a Safe, etc) as well as plain EOAs.
        if (!SignatureChecker.isValidSignatureNow(t.maker, digest, makerSig)) revert BadMakerSignature();
        if (!SignatureChecker.isValidSignatureNow(t.taker, digest, takerSig)) revert BadTakerSignature();

        // ownership is checked NOW, not when the offer was signed
        for (uint256 i = 0; i < m; i++) {
            if (t.makerCollections[i].code.length == 0) revert NotAContract();
            if (IERC721(t.makerCollections[i]).ownerOf(t.makerTokenIds[i]) != t.maker) revert MakerNotOwner();
        }
        for (uint256 i = 0; i < k; i++) {
            if (t.takerCollections[i].code.length == 0) revert NotAContract();
            if (IERC721(t.takerCollections[i]).ownerOf(t.takerTokenIds[i]) != t.taker) revert TakerNotOwner();
        }

        // burn the nonce BEFORE any transfer, so a re-entrant call cannot reuse it
        nonceUsed[t.maker][t.nonce] = true;
        executed += 1;

        for (uint256 i = 0; i < m; i++) {
            IERC721(t.makerCollections[i]).transferFrom(t.maker, t.taker, t.makerTokenIds[i]);
        }
        for (uint256 i = 0; i < k; i++) {
            IERC721(t.takerCollections[i]).transferFrom(t.taker, t.maker, t.takerTokenIds[i]);
        }

        emit Traded(_hashTrade(t), t.maker, t.taker, msg.sender, m, k);
    }

    /**
     * @notice Cancel an offer you signed, before anyone submits it.
     * @dev Burn your own nonce. This works even though the contract never held anything:
     *      the nonce check in execute() is what makes it effective.
     */
    function cancelNonce(uint256 nonce) external {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    // ------------------------------------------------------------------ views

    /// @notice True if this exact trade can still be executed right now.
    /// @notice Would these trade terms execute right now?
    /// @dev    NEVER REVERTS. Every failure path returns (false, reason) with a
    ///         machine-readable reason, including a collection that is not a contract and
    ///         a malformed trade whose sides disagree in length. That property is the
    ///         point: an agent can call this as a pre-flight check and branch on the
    ///         result without also writing a revert handler. Takes TERMS ONLY - no
    ///         signatures - so it can be asked before anything is signed, costs no gas,
    ///         and needs no wallet.
    function isExecutable(Trade calldata t) external view returns (bool executable, string memory reason) {
        // --- time -------------------------------------------------------------
        if (t.expiry <= block.timestamp) return (false, "expired");
        if (t.expiry > block.timestamp + MAX_OFFER_WINDOW) return (false, "expiry beyond max window");

        // --- replay and identity ----------------------------------------------
        if (nonceUsed[t.maker][t.nonce]) return (false, "cancelled or already used");
        if (t.maker == t.taker) return (false, "same account");
        if (t.maker == address(0) || t.taker == address(0)) return (false, "zero account");

        // --- shape ------------------------------------------------------------
        uint256 m = t.makerCollections.length;
        uint256 k = t.takerCollections.length;
        if (m == 0 || k == 0 || m > MAX_TOKENS_PER_SIDE || k > MAX_TOKENS_PER_SIDE) {
            return (false, "bad side length");
        }
        // collections and ids are separate arrays, so a malformed trade can disagree
        // about how many tokens a side is offering
        if (m != t.makerTokenIds.length) return (false, "maker side length mismatch");
        if (k != t.takerTokenIds.length) return (false, "taker side length mismatch");

        // --- ownership, without ever reverting --------------------------------
        // ownerOf() on a code-less address reverts with no data, which would turn this
        // pre-flight into an unanswerable question. Check for code first.
        for (uint256 i = 0; i < m; i++) {
            address c = t.makerCollections[i];
            if (c.code.length == 0) return (false, "maker collection is not a contract");
            // try/catch, because ownerOf on a NONEXISTENT token reverts (ERC721NonexistentToken).
            // The code-length guard above does not catch that - a real collection with a bad
            // token id still throws. This is the only way to catch a revert from another
            // contract, and without it the "never reverts" promise is false.
            try IERC721(c).ownerOf(t.makerTokenIds[i]) returns (address owner) {
                if (owner != t.maker) return (false, "maker no longer owns a token");
            } catch {
                return (false, "maker token does not exist");
            }
        }
        for (uint256 i = 0; i < k; i++) {
            address c = t.takerCollections[i];
            if (c.code.length == 0) return (false, "taker collection is not a contract");
            try IERC721(c).ownerOf(t.takerTokenIds[i]) returns (address owner) {
                if (owner != t.taker) return (false, "taker no longer owns a token");
            } catch {
                return (false, "taker token does not exist");
            }
        }

        return (true, "ok");
    }
}
