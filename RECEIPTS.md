# Receipts, and what an agent should do with them

A custom error is only useful to a program if the program can read the 4 bytes and **decide what
to do**. A selector with no branch attached is just a shorter revert string. This file is the
mapping, so a caller does not have to reverse-engineer it.

Two paths exist, and they cover the same failure space:

| Path | Cost | Shape |
|---|---|---|
| **Pre-flight** `DevBarter.isExecutable(terms)` | free — no wallet, no gas, no signature | returns `(bool, string reason)`, **never reverts** |
| **Execution** any state-changing call | gas | reverts with a 4-byte selector |

Verify the pre-flight path for yourself: it is fuzzed with 12,000 random hostile trades per
push, and the assertion fails if **any** refusal path throws instead of answering.

## The table

| Selector | Error | What happened | What a caller should do | Can a retry help |
|---|---|---|---|---|
| `0x09ee12d5` | `NotAContract` | The address passed has no code | ABORT - bad configuration, not a transient fault | no |
| `0x0f17c4da` | `StillLocked` | Time has not reached the unlock point | WAIT_UNTIL(returned uint40) - the error CARRIES the timestamp | yes, after the timestamp |
| `0x14dd605d` | `BadCliff` | Cliff outside MIN/MAX | ABORT - clamp and resend | no |
| `0x1858b10b` | `EmptyCode` | Deployment code was empty | ABORT - fix the input | no |
| `0x1fb09b80` | `NonceAlreadyUsed` | This nonce was already executed or cancelled | STOP - do not resend; check nonceUsed() first | no |
| `0x29ab51bf` | `AlreadyDeployed` | Something already lives at that address | STOP - the deployment succeeded previously; read it | no |
| `0x305a27a9` | `StringTooLong` | EIP-712 domain string too long | ABORT - deployment-time misconfiguration | no |
| `0x35abf5ae` | `BadMakerSignature` | Maker signature does not recover to the maker | ABORT - the payload or signer is wrong. Use tradeDigest() to compare | no |
| `0x3ee5aeb5` | `ReentrancyGuardReentrantCall` | A re-entrant call was attempted and blocked | NEVER_RETRY - treat as hostile input | no |
| `0x45d54384` | `TakerNotOwner` | Taker no longer owns a token in the trade | ABORT - same | no |
| `0x4c084f14` | `NotOwnerOfToken` | Caller does not own the token being locked | ABORT - wrong signer, or the token moved | no |
| `0x4d84c2e9` | `BadDuration` | Duration outside MIN/MAX | ABORT - clamp and resend | no |
| `0x4dc33c7a` | `NothingToExtend` | Nothing left to extend by the given amount | ABORT - already at MAX_DAYS | no |
| `0x5274afe7` | `SafeERC20FailedOperation` | The token refused the transfer (pause/blacklist/funds) | INSPECT - the token rejected it; the vault is not at fault | maybe, if the token state changes |
| `0x5444e56f` | `NotERC721` | Collection does not implement ERC-165 0x80ac58cd | ABORT - not an NFT collection | no |
| `0x5e885439` | `MakerNotOwner` | Maker no longer owns a token in the trade | ABORT - re-derive the trade from current ownership | no |
| `0x6507689f` | `AlreadyWithdrawn` | That lock was already released | STOP - the work is done; do not resend | no |
| `0x748e67b2` | `TooManyTokens` | A side exceeds MAX_TOKENS_PER_SIDE | ABORT - split into multiple trades | no |
| `0x749b5939` | `BadAmount` | Amount is zero or otherwise invalid | ABORT - fix the input | no |
| `0x77cddf27` | `MismatchedSides` | The two sides differ in length or value | ABORT - rebuild the terms | no |
| `0x78ef33c1` | `TradeExpired` | The offer's expiry has passed | ABORT - the offer is dead; a new signature is required | no |
| `0x7bdc76e2` | `BadPeriod` | The lock period is outside MIN/MAX | ABORT - clamp to the contract's published bounds and resend | no |
| `0x7d32173d` | `NotYourLock` | Caller is not the lock owner | ABORT - wrong signer; a different key is needed | no |
| `0x969bf728` | `NothingToClaim` | Nothing has vested yet, or it was all claimed | WAIT or STOP - check `claimable()` first for free | no |
| `0xa369aa70` | `BadTakerSignature` | Taker signature does not recover to the taker | ABORT - same as above for the taker side | no |
| `0xb3512b0c` | `InvalidShortString` | EIP-712 domain string too short | ABORT - deployment-time misconfiguration | no |
| `0xf1a9a563` | `DeployFailed` | CREATE2 returned the zero address | INSPECT - read the returned bytes32 for the inner reason | no |
| `0xf2a1a85b` | `SameAccount` | Maker and taker are the same address | ABORT - meaningless trade | no |
| `0xf4ad9a1f` | `BadExpiry` | Expiry is in the past or beyond MAX_OFFER_WINDOW | ABORT - rebuild the terms with a valid expiry | no |
| `0xf4db984e` | `TooManyLocks` | Per-holder lock cap reached | ABORT - consolidate existing locks first | no |

`StillLocked` is worth singling out: **it returns the unlock timestamp as an argument.** A
scheduler can read the number out of the revert and come back at exactly that time instead of
polling. That is a receipt designed to be actionable rather than merely informative.

## Pre-flight reasons, and the selectors they correspond to

`isExecutable` gives you the decision **before** you sign anything. Each reason maps to a
selector you would otherwise only meet at send time:

| `isExecutable` reason | Execution selector | Error |
|---|---|---|
| `expired` | `0x78ef33c1` | TradeExpired |
| `expiry beyond max window` | `0xf4ad9a1f` | BadExpiry |
| `cancelled or already used` | `0x1fb09b80` | NonceAlreadyUsed |
| `same account` | `0xf2a1a85b` | SameAccount |
| `zero account` | `0x1858b10b` | EmptyCode-ish / refused before send |
| `bad side length` | `0x748e67b2` | TooManyTokens |
| `maker side length mismatch` | `0x77cddf27` | MismatchedSides |
| `taker side length mismatch` | `0x77cddf27` | MismatchedSides |
| `maker collection is not a contract` | `0x09ee12d5` | NotAContract |
| `taker collection is not a contract` | `0x09ee12d5` | NotAContract |
| `maker token does not exist` | `0x7e273289` | ERC721NonexistentToken (standard) |
| `taker token does not exist` | `0x7e273289` | ERC721NonexistentToken (standard) |
| `maker no longer owns a token` | `0x5e885439` | MakerNotOwner |
| `taker no longer owns a token` | `0x45d54384` | TakerNotOwner |

## The distinction that matters for branching

Three kinds of failure, and they should be handled differently:

```
ABORT    the input or the signer is wrong. Retrying is wasted gas.
         BadPeriod · BadExpiry · SameAccount · MismatchedSides ·
         NotOwnerOfToken · BadMakerSignature · NotAContract · NotERC721

STOP     the work is already done, or the offer is dead. Retrying is wrong.
         AlreadyWithdrawn · NonceAlreadyUsed · AlreadyDeployed

WAIT     time will fix it. Retrying later is correct.
         StillLocked (carries the timestamp) · NothingToClaim

INSPECT  something outside the vault refused - a token, a collection.
         SafeERC20FailedOperation · ERC721NonexistentToken
         The vault is behaving correctly; look at the counterparty.
```

## Collection-standard errors that bubble up

The vaults do **not** redefine ERC-721's errors. When a collection reverts, its own error
surfaces unchanged, and that is correct — a vault that redefined them would be harder to
reason about, not easier. Two appear in practice:

```
0x7e273289   ERC721NonexistentToken      the token id was never minted
0x177e802f   ERC721InsufficientApproval  the vault was not approved for that token
```

Both are standard, both are documented in EIP-721 implementations everywhere, and both mean
the same thing wherever they appear.

## Why "never reverts" is the load-bearing property

A pre-flight check that throws when it is unhappy is not a pre-flight check. The caller then
needs two error paths for one question — one for the answer, one for the refusal that came
back as an exception — and the branch table has to be written twice.

`isExecutable` always answers. That is why it is fuzzed at 12,000 cases per push, and why the
test asserts on every refusal path rather than only the happy one.
