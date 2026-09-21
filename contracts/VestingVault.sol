// SPDX-License-Identifier: MIT
/*
 * GoodsMash Rigs - thanks for using this.
 * Built in the open at github.com/goodsmash/goodsmash-vaults
 * Copy it, fork it, deploy your own - that is what it is here for.
 */
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title VestingVault
 * @notice Tokens that unlock gradually over time, with no way to cancel the schedule.
 *
 * WHY THIS EXISTS
 *   "Team tokens are locked for 12 months" is another sentence nobody can check. This makes
 *   it a curve: a fixed amount, released linearly from a start date, optionally after a
 *   cliff, readable by anyone at any block. Community allocations and contributor grants use
 *   the same primitive - the tokens simply arrive over time instead of all at once.
 *
 * WHAT IT IS NOT
 *   - NOT REVOCABLE. There is no owner and no cancel function. Once a schedule is funded it
 *     pays out on its own terms, forever. That is deliberate: a vesting schedule an operator
 *     can cancel is not a commitment, it is a promise, and this contract exists to replace
 *     promises with arithmetic.
 *   - Not a yield product. Vesting adds no tokens; it releases what was already deposited.
 *   - Not fractionalised. One schedule, one beneficiary.
 *
 * WHO CAN CLAIM
 *   The beneficiary, OR anyone at all. A claim always pays the BENEFICIARY regardless of who
 *   sent it, so a friend, a relayer or a public bot can pay the gas for someone else. Nobody
 *   can redirect a payout.
 *
 * SAFETY
 *   - ReentrancyGuard plus checks-effects-interactions on every claim.
 *   - SafeERC20, so a token that returns nothing on transfer cannot corrupt the accounting.
 *   - Math is linear and compares against a stored total; a schedule can never pay out more
 *     than was funded.
 *   - No owner, no pause, no upgrade, no fee, no sweep.
 */
contract VestingVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MIN_DURATION_DAYS = 1;
    uint16 public constant MAX_DURATION_DAYS = 1825; // 5 years
    uint16 public constant MAX_CLIFF_DAYS = 1825;

    struct Schedule {
        address token;
        address funder;       // who deposited, for the record only - it carries no power
        address beneficiary;  // the only address a payout can ever reach
        uint128 total;        // the full amount deposited
        uint128 claimed;      // how much has been taken so far
        uint40 start;         // vesting begins
        uint40 cliffEnd;      // nothing is claimable before this
        uint40 end;           // fully vested at this point
    }

    Schedule[] private _schedules;
    mapping(address => uint256[]) private _byBeneficiary;
    mapping(address => uint256) private _openByToken;      // still owed, per token
    mapping(address => uint256) private _openCountByToken;

    event ScheduleCreated(
        uint256 indexed scheduleId,
        address indexed funder,
        address indexed beneficiary,
        address token,
        uint256 total,
        uint40 start,
        uint40 cliffEnd,
        uint40 end
    );
    event Claimed(uint256 indexed scheduleId, address indexed beneficiary, uint256 amount, address caller);

    error BadDuration();
    error BadCliff();
    error BadAmount();
    error NotAContract();
    error NothingToClaim();

    /**
     * @notice Fund a vesting schedule for `beneficiary`.
     * @param token          the ERC-20 to vest
     * @param beneficiary    the only address that can ever receive a payout
     * @param amount         how much to vest, pulled from the caller now
     * @param durationDays   total vesting length from `start`
     * @param cliffDays      nothing claimable before this many days (0 for none)
     * @param start          unix time vesting begins; pass 0 for "now"
     */
    function create(
        address token,
        address beneficiary,
        uint256 amount,
        uint16 durationDays,
        uint16 cliffDays,
        uint40 start
    ) external nonReentrant returns (uint256 scheduleId) {
        if (token.code.length == 0) revert NotAContract();
        if (amount == 0) revert BadAmount();
        if (durationDays < MIN_DURATION_DAYS || durationDays > MAX_DURATION_DAYS) revert BadDuration();
        if (cliffDays > MAX_CLIFF_DAYS) revert BadCliff();
        if (cliffDays > durationDays) revert BadCliff();

        uint40 s = start == 0 ? uint40(block.timestamp) : start;
        uint40 e = uint40(s + uint256(durationDays) * 1 days);
        uint40 c = uint40(s + uint256(cliffDays) * 1 days);

        scheduleId = _schedules.length;
        _schedules.push(Schedule({
            token: token,
            funder: msg.sender,
            beneficiary: beneficiary,
            total: uint128(amount),
            claimed: 0,
            start: s,
            cliffEnd: c,
            end: e
        }));
        _byBeneficiary[beneficiary].push(scheduleId);
        _openByToken[token] += amount;
        _openCountByToken[token] += 1;

        // effects recorded, now pull the tokens in
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit ScheduleCreated(scheduleId, msg.sender, beneficiary, token, amount, s, c, e);
    }

    /**
     * @notice Claim whatever has vested so far. Always pays the beneficiary.
     * @dev Callable by ANYONE. If a stranger calls it, the beneficiary still receives every
     *      token - which lets someone else cover the gas for a beneficiary who has none.
     */
    function claim(uint256 scheduleId) external nonReentrant returns (uint256 amount) {
        amount = vested(scheduleId) - uint256(_schedules[scheduleId].claimed);
        if (amount == 0) revert NothingToClaim();

        Schedule storage S = _schedules[scheduleId];
        S.claimed = uint128(uint256(S.claimed) + amount);
        _openByToken[S.token] -= amount;
        if (S.claimed >= S.total) _openCountByToken[S.token] -= 1;

        // destination is read from the schedule - no parameter can redirect it
        IERC20(S.token).safeTransfer(S.beneficiary, amount);

        emit Claimed(scheduleId, S.beneficiary, amount, msg.sender);
    }

    /// @notice Claim every schedule this caller is the beneficiary of. Convenience only.
    function claimAll() external nonReentrant returns (uint256 total) {
        uint256[] storage ids = _byBeneficiary[msg.sender];
        for (uint256 i = 0; i < ids.length; i++) {
            Schedule storage S = _schedules[ids[i]];
            uint256 amt = vested(ids[i]) - uint256(S.claimed);
            if (amt == 0) continue;
            S.claimed = uint128(uint256(S.claimed) + amt);
            _openByToken[S.token] -= amt;
            if (S.claimed >= S.total) _openCountByToken[S.token] -= 1;
            IERC20(S.token).safeTransfer(S.beneficiary, amt);
            total += amt;
            emit Claimed(ids[i], S.beneficiary, amt, msg.sender);
        }
        if (total == 0) revert NothingToClaim();
    }

    // ---------------------------------------------------------------- the maths

    /**
     * @notice How much has vested in total (ignoring what was already claimed).
     * @dev Linear between cliffEnd and end. Before the cliff, zero. After end, everything.
     */
    function vested(uint256 scheduleId) public view returns (uint256) {
        Schedule storage S = _schedules[scheduleId];
        uint256 t = block.timestamp;
        if (t < S.cliffEnd) return 0;
        if (t >= S.end) return uint256(S.total);
        // linear from the cliff, over the remaining window
        uint256 elapsed = t - S.cliffEnd;
        uint256 window = uint256(S.end) - S.cliffEnd;
        if (window == 0) return uint256(S.total);
        return (uint256(S.total) * elapsed) / window;
    }

    /// @notice What the beneficiary could withdraw right now.
    function claimable(uint256 scheduleId) external view returns (uint256) {
        return vested(scheduleId) - uint256(_schedules[scheduleId].claimed);
    }

    // ---------------------------------------------------------------- views

    function totalSchedules() external view returns (uint256) {
        return _schedules.length;
    }

    function scheduleAt(uint256 scheduleId) external view returns (Schedule memory) {
        return _schedules[scheduleId];
    }

    function schedulesOf(address beneficiary) external view returns (uint256[] memory) {
        return _byBeneficiary[beneficiary];
    }

    /// @notice Tokens of `token` still owed by this contract across every schedule. The
    ///         number that makes "we are vested" checkable rather than claimed.
    function outstanding(address token) external view returns (uint256) {
        return _openByToken[token];
    }

    function openSchedulesFor(address token) external view returns (uint256) {
        return _openCountByToken[token];
    }
}
