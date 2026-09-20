// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
 * GoodsMash Rigs - thanks for using this.
 * Built in the open at github.com/goodsmash/goodsmash-vaults
 * Copy it, fork it, deploy your own - that is what it is here for.
 */

/**
 * @title TokenLocker
 * @notice Lock ERC-20 tokens - including LP tokens - for a fixed period so anyone can verify
 *         they cannot be pulled.
 *
 * WHY THIS EXISTS
 *   "Liquidity locked" is the single most-claimed and least-verifiable sentence in this
 *   space. Turning it into a contract read changes it from a promise into a number: this
 *   much of this token, locked until this date, readable by anyone at any time. It is the
 *   fungible twin of CommitmentVault, and together they cover both halves of the problem:
 *
 *     CommitmentVault  -> ERC-721  (including Uniswap V3/V4 positions, which are NFTs)
 *     TokenLocker      -> ERC-20   (including Uniswap V2-style pair/LP tokens)
 *
 * WHAT IT IS NOT
 *   - No owner, no pause, no upgrade path, no fee. No rescue. There is nothing to take.
 *   - Not a yield product: locking pays nothing and promises nothing.
 *   - Not fractionalised: whole amounts, owned by whoever deposited them.
 *
 * SAFETY GUARANTEED IN CODE
 *   1. Only you can lock your own tokens - the vault pulls from msg.sender.
 *   2. On unlock the tokens can only go back to the address that locked them. There is no
 *      destination parameter and no sweep.
 *   3. The unlock time can only be pushed LATER.
 *   4. SafeERC20 throughout, so a token that returns nothing on transfer does not silently
 *      corrupt the accounting - the failure mode that has broken many lockers.
 */
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TokenLocker is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MIN_DAYS = 7;
    uint16 public constant MAX_DAYS = 1460; // 4 years - long enough to matter for a lock
    uint256 public constant MAX_LOCKS_PER_CALL = 10;

    struct Lock {
        address token;
        address locker;   // the only address these tokens can ever return to
        uint192 amount;
        uint40 unlockAt;
        uint16 periodDays;
        bool open;
    }

    Lock[] private _locks;
    mapping(address => uint256[]) private _byLocker;
    mapping(address => uint256) private _openByToken;   // live locked amount per token
    mapping(address => uint256) private _openCountByToken;
    mapping(address => uint256) private _openByLocker;

    event TokensLocked(
        uint256 indexed lockId,
        address indexed locker,
        address indexed token,
        uint256 amount,
        uint16 periodDays,
        uint40 unlockAt
    );
    event TokensWithdrawn(uint256 indexed lockId, address indexed locker, uint256 amount);
    event LockExtended(uint256 indexed lockId, uint40 newUnlockAt, uint16 extraDays);

    error BadPeriod();
    error BadAmount();
    error TooManyLocks();
    error NotYourLock();
    error StillLocked(uint40 unlockAt);
    error AlreadyWithdrawn();
    error NothingToExtend();
    error NotAContract();

    /**
     * @notice Lock `amount` of `token` for `periodDays`.
     * @dev Pulls with safeTransferFrom, so the caller must have approved this contract first.
     */
    function lock(address token, uint256 amount, uint16 periodDays) public nonReentrant returns (uint256 lockId) {
        if (token.code.length == 0) revert NotAContract();
        if (amount == 0) revert BadAmount();
        if (periodDays < MIN_DAYS || periodDays > MAX_DAYS) revert BadPeriod();

        // effects before interaction: record the lock, THEN pull the tokens
        uint40 unlockAt = uint40(block.timestamp + uint256(periodDays) * 1 days);
        lockId = _locks.length;
        _locks.push(Lock({
            token: token,
            locker: msg.sender,
            amount: uint192(amount),
            unlockAt: unlockAt,
            periodDays: periodDays,
            open: true
        }));
        _byLocker[msg.sender].push(lockId);
        _openByToken[token] += amount;
        _openCountByToken[token] += 1;
        _openByLocker[msg.sender] += 1;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit TokensLocked(lockId, msg.sender, token, amount, periodDays, unlockAt);
    }

    /// @notice Lock several tokens in one transaction. Atomic - one failure reverts all.
    function lockMany(address[] calldata tokens, uint256[] calldata amounts, uint16 periodDays)
        external
        nonReentrant
        returns (uint256[] memory lockIds)
    {
        uint256 n = tokens.length;
        if (n == 0 || n != amounts.length || n > MAX_LOCKS_PER_CALL) revert TooManyLocks();
        lockIds = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            lockIds[i] = lock(tokens[i], amounts[i], periodDays);
        }
    }

    /// @notice Make a lock longer. Never shorter. Same locker only.
    function extend(uint256 lockId, uint16 extraDays) external nonReentrant {
        Lock storage L = _locks[lockId];
        if (!L.open) revert AlreadyWithdrawn();
        if (L.locker != msg.sender) revert NotYourLock();
        if (extraDays == 0) revert NothingToExtend();

        uint40 base = L.unlockAt > block.timestamp ? L.unlockAt : uint40(block.timestamp);
        L.unlockAt = uint40(base + uint256(extraDays) * 1 days);
        L.periodDays = L.periodDays + extraDays;

        emit LockExtended(lockId, L.unlockAt, extraDays);
    }

    /// @notice Withdraw after the period. The tokens can only go back to the locker.
    function unlock(uint256 lockId) external nonReentrant {
        Lock storage L = _locks[lockId];
        if (!L.open) revert AlreadyWithdrawn();
        if (L.locker != msg.sender) revert NotYourLock();
        if (block.timestamp < L.unlockAt) revert StillLocked(L.unlockAt);

        // effects first, so a re-entrant token cannot withdraw twice
        L.open = false;
        uint256 amount = uint256(L.amount);
        _openByToken[L.token] -= amount;
        _openCountByToken[L.token] -= 1;
        _openByLocker[msg.sender] -= 1;

        // destination read from the record - no parameter can redirect it
        IERC20(L.token).safeTransfer(L.locker, amount);

        emit TokensWithdrawn(lockId, L.locker, amount);
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

    /// @notice Tokens of `token` currently locked across everyone. This is the number that
    ///         turns "liquidity is locked" from a claim into a read.
    function lockedAmount(address token) external view returns (uint256) {
        return _openByToken[token];
    }

    function openLocksForToken(address token) external view returns (uint256) {
        return _openCountByToken[token];
    }

    function openLocksOf(address locker) external view returns (uint256) {
        return _openByLocker[locker];
    }

    /// @notice Seconds until a lock can be withdrawn, or 0 if it already can.
    function timeRemaining(uint256 lockId) external view returns (uint256) {
        Lock storage L = _locks[lockId];
        if (!L.open || L.unlockAt <= block.timestamp) return 0;
        return uint256(L.unlockAt) - block.timestamp;
    }
}
