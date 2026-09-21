# GoodsMash Vaults

[![tests](https://github.com/goodsmash/goodsmash-vaults/actions/workflows/tests.yml/badge.svg)](https://github.com/goodsmash/goodsmash-vaults/actions/workflows/tests.yml)

Three small, self-contained Solidity contracts for **proving you are holding** and **trading between builders without coordination**.

MIT licensed. No owner, no pause, no upgrade path, no fee — in any of them. That is the point, not an oversight: a lock that an operator can open is not a lock.

- **Tests:** 101 assertions passing across five suites, plus a 10-case adversarial suite
- **Hardening:** `ReentrancyGuard` on every state-changing function, checks-effects-interactions
  throughout, ERC-165 gate so `lock()` cannot be pointed at a non-NFT, and no unbounded loops
- **Dependencies:** OpenZeppelin 5.x only
- **Status:** written, compiled and fully tested. Not broadcast anywhere.

---

## The three contracts

### `CommitmentVault.sol` — lock an NFT as public proof

Lock **your own** ERC-721 for 7–365 days. While it sits in the vault, anyone can read that it is locked and until when.

```solidity
function lock(address collection, uint256 tokenId, uint16 periodDays) external returns (uint256 lockId);
function lockMany(address[] collections, uint256[] tokenIds, uint16 periodDays) external returns (uint256[] lockIds);
function unlock(uint256 lockId) external;
function extend(uint256 lockId, uint16 extraDays) external;
```

**Use it for:** showing you are holding rather than flipping. This also covers **Uniswap V3/V4 LP positions**, which are ERC-721s.

### `TokenLocker.sol` — lock LP or any ERC-20

The fungible twin. `lockedAmount(token)` is the number that turns *"liquidity is locked"* from the most-claimed sentence in crypto into a value anyone can read.

```solidity
function lock(address token, uint256 amount, uint16 periodDays) external returns (uint256 lockId);
function unlock(uint256 lockId) external;
function extend(uint256 lockId, uint16 extraDays) external;
function lockedAmount(address token) external view returns (uint256);
```

**Use it for:** **Uniswap V2-style LP tokens**, treasury tokens, team allocations. Combined with `CommitmentVault` this covers both LP shapes:

| LP shape | Token standard | Use |
|---|---|---|
| Uniswap V2-style pair | ERC-20 | `TokenLocker` |
| Uniswap V3 / V4 positions | ERC-721 | `CommitmentVault` |

### `VestingVault.sol` — tokens that unlock gradually, and cannot be cancelled

Fund a schedule for a beneficiary; it releases **linearly** from a cliff date. Anyone can
trigger a claim and the payout always goes to the beneficiary, so a stranger can pay the gas.

```solidity
function create(address token, address beneficiary, uint256 amount,
                uint16 durationDays, uint16 cliffDays, uint40 start) external returns (uint256);
function claim(uint256 scheduleId) external returns (uint256);
function vested(uint256 scheduleId) external view returns (uint256);
function outstanding(address token) external view returns (uint256);
```

**Not revocable, deliberately.** There is no owner and no cancel function — a vesting schedule
an operator can cancel is a promise, and this exists to replace promises with arithmetic.

**Use it for:** team allocations, community drops that arrive over time, contributor grants.
`outstanding(token)` makes "we are vested" a number rather than a claim.

### `DevBarter.sol` — two people sign, anyone submits

EIP-712 signed NFT-for-NFT trades. Both parties sign the same terms; **anyone** can submit both signatures in one transaction and it settles atomically.

```solidity
function execute(Trade calldata t, bytes calldata makerSig, bytes calldata takerSig) external;
function cancelNonce(uint256 nonce) external;
function isExecutable(Trade calldata t) external view returns (bool, string memory);
```

**Why:** the blocker for dev-to-dev trading is never the swap, it is coordination — one side has to be online, hold gas, and be holding at the right moment. Here both sides only *sign*. **The side that does not submit pays nothing.**

**Honest constraint:** each party still needs an ERC-721 approval on the collection, once. After that, unlimited trades by signature.

---

## Safety guarantees, and where they are enforced

| Guarantee | How |
|---|---|
| You can only lock what you own | `lock()` compares `ownerOf(tokenId)` against `msg.sender` |
| A locked token can only return to whoever locked it | The destination is read from the lock record; there is no destination parameter |
| It cannot be unlocked early — by anyone | `unlock()` requires `block.timestamp >= unlockAt`, and there is no override |
| Locks only get longer | `extend()` pushes the date out; nothing pulls it in |
| No admin surface | No `owner()`, `pause()`, `sweep()`, `rescue()` or upgrade path in any contract |
| Batches are atomic | One bad element reverts the whole call; no partial state |
| Re-entrancy | `ReentrancyGuard` **and** checks-effects-interactions (state written before any transfer) |
| Only real NFTs can be locked | An ERC-165 `supportsInterface` gate rejects anything that is not an ERC-721 |
| No unbounded gas | Every loop is capped by a constant; `isLocked` is an O(1) mapping read, not a scan |
| Signatures cannot be replayed | EIP-712 domain binds `chainId` + `verifyingContract`, plus a consumed-nonce check |

### ⚠️ One behaviour you must know

**A token sent to a vault by a manual `transferFrom` — not through `lock()` — has no lock record and can never be moved again.** It is permanently stuck.

This is deliberate. A `sweep()` that recovered a stray token would also be usable on a real lock, so the escape hatch was refused. **Always call `lock()`.**

---

## What these are not

- **Not yield products.** Locking pays nothing. No rewards, no APR, no token.
- **Not price signals.** Anyone can lock a worthless token in ten seconds. A lock proves *what is locked* and nothing about what it is worth.
- **Not fractionalised.** One lock is one whole token or one whole amount.
- **Not marketplaces.** `DevBarter` sets no prices and keeps no listings; two people agree and the contract settles what they agreed.

---

## Running the tests

```bash
npm install
npx hardhat compile
npx hardhat run test/commitment-vault.test.cjs
npx hardhat run test/token-locker.test.cjs
npx hardhat run test/vesting-vault.test.cjs
npx hardhat run test/dev-barter.test.cjs
npx hardhat run test/adversarial.test.cjs
```

The adversarial suite deploys hostile collections that lie about ownership, re-enter during transfers, and burn gas — then reports what actually happened. Where an attack succeeds it is reported as a finding rather than hidden.

---

## Deploying

The contracts have **no constructor arguments and no owner**, so the address *is* the deployment — there is nothing to configure afterwards.

```bash
npx hardhat run scripts/deploy-testnet.cjs
```

The included deploy script is fail-closed: it asserts the live `chainId` before doing anything, refuses any chain it was not built for, estimates real gas, and exits cleanly if the signer cannot afford it rather than broadcasting half a transaction.

---

## Design notes

**Why no owner at all.** It is tempting to add an owner "just for emergencies". But an owner who can unlock is an owner who can rug, and every user then has to trust an operator instead of reading code. Removing the role entirely is the only version where the guarantee is structural.

**Why the lock proves nothing about value.** Contracts can verify that a token is held. They cannot verify it is worth anything. Any project that ranks or prices locked tokens is inventing a signal the chain does not support, so these contracts deliberately expose no such number.

**Why `commitment-vault.test.cjs` asserts against the compiled ABI.** An earlier draft asserted with a source-text regex and matched an interface declaration, reporting a false failure on a contract with no transfer function. Assertions belong against the artifact that ships.

---

## Thanks for using this

Built by **GoodsMash Rigs** — hand-dug minerals, onchain.

If you found this useful, copy it, fork it, deploy your own; that is what it is here for. The
credit line at the top of each contract is a thank-you, not a condition — the licence is MIT
and you are free to do whatever you like with it.

---

## Why this exists at all

Most of crypto's losses do not come from broken contracts. They come from two things:

**1. You cannot tell who is holding.** A wallet address shows a balance. It does not show
whether the person behind it intends to stay, and it cannot, because intent is not a number.
What it CAN show is whether they have given something up to prove it.

**2. Builders cannot trade with each other.** Two people ship a collection in the same week
and never touch each other's work, because a trade means coordinating a time, a price and two
signatures, and everyone is busy. So the two communities never overlap, and the "ecosystem"
stays a list of launches instead of a network.

These four contracts are a small attempt at both:

| | The problem | What the contract does |
|---|---|---|
| `CommitmentVault` | you cannot prove you are holding | lock your own NFT 7-365 days. Anyone can read it. |
| `TokenLocker` | "liquidity is locked" is a sentence, not a fact | lock LP or any ERC-20, and `lockedAmount(token)` returns a number |
| `VestingVault` | a vesting schedule is a promise | linear release with arithmetic, and **no cancel function to take it back** |
| `DevBarter` | a trade needs both people free at the same moment | both sign once; **anyone** submits it, so one side pays nothing |

### The four rules all of them follow

1. **No owner.** Not "the owner is a multisig" — there is no owner variable to compromise.
2. **No pause.** A lock with an admin key is not a lock.
3. **No fee.** There is no fee variable, so there is nothing to raise later.
4. **Nothing can be swept.** Tokens can only ever go back to whoever locked them.

A leaked key on any of these cannot take anything, because there is no function a key could
call that moves someone else's asset. **That is the point.**

### What these cannot do

- **They cannot tell you whether a token is worth anything.** Anyone can lock garbage in ten
  seconds. A lock proves *what* is locked, never *what it is worth*.
- **They cannot stop a collection going bad.** A lock is a fact about one token, not a
  character reference for its dev.
- **They are not a way to trade onchain safely in general.** A signed trade is binding on the
  terms it names; it is not escrow for an offchain promise.

**If you copy one thing from here, copy the four rules.** The code is short enough to read in
an afternoon, and the tests print every revert reason so you can see what each guard blocks.

---

*Built by one person with a disability and the agents he runs. No name on it on purpose.*

---

## Multichain, not omnichain — and why that distinction matters

**These contracts contain no chain-specific code.** Verified, not asserted:

```
chain ids hardcoded in the source ................ none
oracles, bridges, precompiles .................... none
external dependencies ............................ OpenZeppelin only
```

**So the same bytecode deploys to any EVM chain unchanged.** Clone it, point `
hardhat.config.js` at your chain, deploy. There is nothing to port and nothing to re-audit
per chain. That is the multichain property, and it is free — it comes from having written
nothing chain-specific, not from having added something.

### "Omnichain" would require a bridge, and this does not use one

There is a version of this project that would let a lock on one chain count on another. It
would need a message-passing layer. **This deliberately does not have one**, because:

- **Bridges are the most-attacked component in the entire ecosystem.** More value has been
  lost to bridge exploits than to almost any other contract class.
- **A lock does not need to be cross-chain to be useful.** "This wallet has not moved this
  token for 180 days" is true on the chain it happened on, and anyone can check it there.
- **Adding a bridge to prove honesty would introduce the exact attack surface the honesty is
  meant to demonstrate.** A vault that can be emptied through a bridge message is worse than a
  vault that is simply chain-local.

**If you need cross-chain locks, deploy this on each chain independently.** You then have
N honest locks instead of one lock plus a bridge. That is a better trade, and it is the honest
one.

### Where a shared state WOULD be needed, and the answer there

A **registry** — one page listing what is locked across chains — needs to read many chains.
That is a *read* problem, solvable by querying each chain's RPC and merging the results
offchain. **Reads can be aggregated without a bridge; writes cannot.** So a cross-chain
dashboard is achievable and safe, while cross-chain *custody* is neither. This design takes
the first and refuses the second.

---

## Deployed

### Robinhood Chain testnet — chain 46630

Live and verified: each address was read back with `eth_getCode` and answered its own getters.

| Contract | Address | Runtime |
|---|---|---|
| `CommitmentVault` | `0x5E91368A6263997c81BB868Eb24AE0F432CebA0d` | 4,822 B |
| `TokenLocker` | `0x0A16946C53De69187E63cf2Bc127619dF5Ad08D5` | 4,089 B |
| `VestingVault` | `0x6247D1C620A96f36cE0e81d3bc5E549DfE10A87F` | 4,479 B |
| `DevBarter` | `0x7D980EDe6839AD219c4b8DD9deE74DAEcA42A01B` | 6,701 B |

Explorer: `https://explorer.testnet.chain.robinhood.com/address/<address>`

**These are rehearsal deployments on a testnet, not mainnet, and the README says so on
purpose.** Gas cost to deploy all four: **0.000045 tETH.**

### Mainnet

**None yet.** Nothing here is on a mainnet. When it is, this section changes and nothing else
does — the contracts do not need to.
