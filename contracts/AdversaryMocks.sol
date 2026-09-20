// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title AdversaryMocks
 * @notice Hostile implementations used to attack CommitmentVault and DevBarter from the
 *         outside. These exist because a contract that passes its own happy-path tests has
 *         not been audited - it has been demonstrated. Each mock targets one specific claim.
 */

interface IVaultLike {
    function lock(address collection, uint256 tokenId, uint16 periodDays) external returns (uint256);
    function unlock(uint256 lockId) external;
}


/**
 * A collection that lies about ownership and re-enters on transferFrom.
 *
 * Attack 1 (lie): claim every token id is owned by whoever asks, so `lock` accepts tokens
 * that do not exist. Measures whether the vault can be flooded with fake locks.
 *
 * Attack 2 (re-enter): during transferFrom, call back into the vault. The vault's unlock()
 * transfers BEFORE finishing? Or after? This proves whether checks-effects-interactions holds.
 */
contract LyingReentrantERC721 {
    address public vault;
    uint256 public reenterLockId;
    bool public reentered;
    bool public reenterSucceeded;
    bool public doReenter;
    uint256 public minted;

    constructor(address vault_) { vault = vault_; }

    function setReenter(bool on, uint256 lockId) external { doReenter = on; reenterLockId = lockId; }

    function mintTo(address, uint256) external { minted += 1; }

    // Returns a STORED owner, not msg.sender. An earlier version returned msg.sender, which
    // made the vault's ownership check fail before transferFrom ever ran - so the re-entry
    // assertion passed without the re-entry path being exercised at all. A test that cannot
    // reach the code it claims to test proves nothing.
    address public ownerAddr;
    function setOwner(address a) external { ownerAddr = a; }
    function ownerOf(uint256) external view returns (address) { return ownerAddr; }

    function getApproved(uint256) external pure returns (address) { return address(0); }

    function isApprovedForAll(address, address) external pure returns (bool) { return true; }


    // ERC-165: the hardened vault checks this before it will call ownerOf. An attacker who
    // wants past that door implements it - a mock that does not would be stopped at the gate
    // rather than at the attack, and the re-entry path would never be exercised.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd || interfaceId == 0x01ffc9a7;
    }

    function transferFrom(address, address, uint256) external {
        if (doReenter) {
            doReenter = false;
            reentered = true;
            // try to withdraw the same lock we are inside of
            (bool ok, ) = vault.call(abi.encodeWithSelector(IVaultLike.unlock.selector, reenterLockId));
            reenterSucceeded = ok;
        }
        // moves nothing - it is a lie
    }
}

/**
 * A collection whose transferFrom simply burns all the gas it is given, to see whether a
 * hostile collection can make the vault unusable for everyone (a griefing vector).
 */
contract GasBurnerERC721 {
    function ownerOf(uint256) external view returns (address) { return msg.sender; }
    function transferFrom(address, address, uint256) external pure {
        uint256 x;
        for (uint256 i = 0; i < 1000; i++) { x = x + i; }
        require(x > 0, "unreachable");
    }
}

/**
 * A collection that returns wildly different owners between calls, to check whether the
 * vault relies on a single ownerOf read (it does - and that is fine, because the transfer
 * itself is what proves ownership in practice).
 */
contract FlipFlopERC721 {
    uint256 public calls;
    function ownerOf(uint256) external returns (address) {
        calls += 1;
        return calls % 2 == 0 ? address(0) : msg.sender;
    }
    function transferFrom(address, address, uint256) external {}
}
