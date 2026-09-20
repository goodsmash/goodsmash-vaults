// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
 * GoodsMash Rigs - thanks for using this.
 * Built in the open at github.com/goodsmash/goodsmash-vaults
 * Copy it, fork it, deploy your own - that is what it is here for.
 */

/**
 * @title CommitmentVault
 * @notice Lock YOUR OWN NFT for a fixed period, onchain, as public proof of commitment.
 *
 * WHY THIS EXISTS
 *   Devs on a young chain are too busy shipping to mint each other's work, and there is no
 *   honest way to show you are holding something rather than flipping it. This gives one
 *   primitive: a time lock you can point at and nothing more.
 *
 * WHAT IT DELIBERATELY IS NOT
 *   - Not a yield product. No rewards, no APR, no token, no promise of value.
 *   - Not a marketplace. It never sells or swaps anything.
 *   - Not fractionalised. One lock == one whole token, always.
 *   - Not admin-controllable. There is NO owner, NO pause, NO rescue and NO upgrade path.
 *     A lock that an operator can open is not a lock, so this contract has no operator.
 *
 * SAFETY RULES ENFORCED IN CODE (not promised in prose)
 *   1. You can only lock a token you own at the moment of locking.
 *   2. On unlock the token can only go back to the address that locked it. There is no
 *      destination parameter to misuse and no sweep function.
 *   3. The unlock time can only ever be pushed LATER. extend() cannot shorten a lock.
 *   4. There is no code path that transfers a locked token anywhere except to its locker.
 */
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC165Minimal {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721Minimal {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

contract CommitmentVault is ReentrancyGuard {
    /// @notice Allowed periods. A lock is always one of these; there is no custom duration.
    uint16 public constant MIN_DAYS = 7;
    uint16 public constant MAX_DAYS = 365;
    uint32 public constant MAX_LOCKS_PER_CALL = 20;
    /// @dev ERC-165 id for ERC-721. Refusing anything else means lock() cannot be
    ///      pointed at a contract that has no ownerOf.
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;

    struct Lock {
        address collection; // the ERC-721 the token belongs to
        uint40 unlockAt;    // unix time the token becomes withdrawable
        uint16 periodDays;  // the period chosen at lock time
        address locker;     // the only address this token can ever return to
        uint256 tokenId;
        bool open;          // false once withdrawn
    }

    Lock[] private _locks;
    mapping(address => uint256[]) private _byLocker;
    mapping(address => uint256) private _openByCollection;
    mapping(address => uint256) private _openTotal;
    // O(1) view of which lock currently holds a given token (+1 so 0 means 'none').
    // Replaces a loop that walked every lock ever created.
    mapping(address => mapping(uint256 => uint256)) private _activeLock;

    event Locked(
        uint256 indexed lockId,
        address indexed locker,
        address indexed collection,
        uint256 tokenId,
        uint16 periodDays,
        uint40 unlockAt
    );
    event Withdrawn(uint256 indexed lockId, address indexed locker);
    event Extended(uint256 indexed lockId, uint40 newUnlockAt, uint16 extraDays);

    error NotOwnerOfToken();
    error BadPeriod();
    error NotYourLock();
    error StillLocked(uint40 unlockAt);
    error AlreadyWithdrawn();
    error NotAContract();
    error NotERC721();
    error NothingToExtend();

    /**
     * @notice Lock one of your own tokens for `days`.
     * @dev Requires the vault be approved for this token first (approve or setApprovalForAll).
     *      Ownership is re-checked here, so approving early cannot be used against you.
     */
    function lock(address collection, uint256 tokenId, uint16 periodDays) external nonReentrant returns (uint256 lockId) {
        if (collection.code.length == 0) revert NotAContract();
        if (!_isERC721(collection)) revert NotERC721();
        if (periodDays < MIN_DAYS || periodDays > MAX_DAYS) revert BadPeriod();
        if (IERC721Minimal(collection).ownerOf(tokenId) != msg.sender) revert NotOwnerOfToken();

        // pull the token in. transferFrom (not safeTransferFrom) keeps this callable for
        // every ERC-721 without assuming receiver hooks exist.
        IERC721Minimal(collection).transferFrom(msg.sender, address(this), tokenId);

        uint40 unlockAt = uint40(block.timestamp + uint256(periodDays) * 1 days);
        lockId = _locks.length;
        _locks.push(Lock({
            collection: collection,
            unlockAt: unlockAt,
            periodDays: periodDays,
            locker: msg.sender,
            tokenId: tokenId,
            open: true
        }));
        _byLocker[msg.sender].push(lockId);
        _openByCollection[collection] += 1;
        _openTotal[msg.sender] += 1;
        _activeLock[collection][tokenId] = lockId + 1;

        emit Locked(lockId, msg.sender, collection, tokenId, periodDays, unlockAt);
    }

    /// @notice Lock several of your own tokens, all for the same period, in one transaction.
    function lockMany(address[] calldata collections, uint256[] calldata tokenIds, uint16 periodDays)
        external
        nonReentrant
        returns (uint256[] memory lockIds)
    {
        uint256 n = collections.length;
        if (n == 0 || n != tokenIds.length || n > MAX_LOCKS_PER_CALL) revert BadPeriod();
        if (periodDays < MIN_DAYS || periodDays > MAX_DAYS) revert BadPeriod();

        lockIds = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address c = collections[i];
            if (c.code.length == 0) revert NotAContract();
            if (!_isERC721(c)) revert NotERC721();
            if (IERC721Minimal(c).ownerOf(tokenIds[i]) != msg.sender) revert NotOwnerOfToken();
            IERC721Minimal(c).transferFrom(msg.sender, address(this), tokenIds[i]);

            uint40 unlockAt = uint40(block.timestamp + uint256(periodDays) * 1 days);
            uint256 id = _locks.length;
            _locks.push(Lock({
                collection: c,
                unlockAt: unlockAt,
                periodDays: periodDays,
                locker: msg.sender,
                tokenId: tokenIds[i],
                open: true
            }));
            _byLocker[msg.sender].push(id);
            _openByCollection[c] += 1;
            _openTotal[msg.sender] += 1;
            _activeLock[c][tokenIds[i]] = id + 1;
            lockIds[i] = id;
            emit Locked(id, msg.sender, c, tokenIds[i], periodDays, unlockAt);
        }
    }

    /**
     * @notice Make an existing lock longer. Never shorter.
     * @dev Same locker only. A lock can be extended as many times as you like.
     */
    function extend(uint256 lockId, uint16 extraDays) external nonReentrant {
        Lock storage L = _locks[lockId];
        if (!L.open) revert AlreadyWithdrawn();
        if (L.locker != msg.sender) revert NotYourLock();
        if (extraDays == 0) revert NothingToExtend();

        // extend from whichever is later: now, or the existing unlock time. Extending a
        // lock that already expired still keeps it locked for the full new period.
        uint40 base = L.unlockAt > block.timestamp ? L.unlockAt : uint40(block.timestamp);
        L.unlockAt = uint40(base + uint256(extraDays) * 1 days);
        L.periodDays = L.periodDays + extraDays;

        emit Extended(lockId, L.unlockAt, extraDays);
    }

    /**
     * @notice Withdraw your token once the period has ended.
     * @dev The token can only ever go to the locker recorded at lock time.
     */
    function unlock(uint256 lockId) external nonReentrant {
        Lock storage L = _locks[lockId];
        if (!L.open) revert AlreadyWithdrawn();
        if (L.locker != msg.sender) revert NotYourLock();
        if (block.timestamp < L.unlockAt) revert StillLocked(L.unlockAt);

        L.open = false;
        _openByCollection[L.collection] -= 1;
        _openTotal[msg.sender] -= 1;
        _activeLock[L.collection][L.tokenId] = 0;

        // the only transfer out of this contract, and the destination is read from the
        // lock itself - there is no parameter a caller could point anywhere else.
        IERC721Minimal(L.collection).transferFrom(address(this), L.locker, L.tokenId);

        emit Withdrawn(lockId, L.locker);
    }

    /// @dev ERC-165 probe, tolerant of contracts that do not implement it at all.
    function _isERC721(address collection) private view returns (bool) {
        try IERC165Minimal(collection).supportsInterface(ERC721_INTERFACE_ID) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- views

    function totalLocks() external view returns (uint256) {
        return _locks.length;
    }

    function lockAt(uint256 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }

    function locksOf(address locker) external view returns (uint256[] memory) {
        return _byLocker[locker];
    }

    function openLocksOf(address locker) external view returns (uint256) {
        return _openTotal[locker];
    }

    function openLocksInCollection(address collection) external view returns (uint256) {
        return _openByCollection[collection];
    }

    /// @notice Whether a token is currently held by this vault under an open lock.
    /// @dev O(1). An earlier version looped over every lock ever created, which becomes
    ///      unusable at a few thousand locks.
    function isLocked(address collection, uint256 tokenId) external view returns (bool) {
        return _activeLock[collection][tokenId] != 0;
    }
}
