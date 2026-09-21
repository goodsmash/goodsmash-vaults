# GoodsMash Vaults

[![tests](https://github.com/goodsmash/goodsmash-vaults/actions/workflows/tests.yml/badge.svg)](https://github.com/goodsmash/goodsmash-vaults/actions/workflows/tests.yml)

**Five small Solidity contracts** for proving you are holding, locking liquidity, vesting over
time, and trading between builders without coordination — plus a deployer that puts every one of
them at **the same address on every EVM chain**.

| Contract | Lines | What it does |
|---|---|---|
| `CommitmentVault` | 238 | Lock your own ERC-721 for 7–365 days as public proof |
| `VestingVault` | 215 | Release tokens on arithmetic over time. No cancel function |
| `DevBarter` | 210 | EIP-712 signed trades. Both sign, anyone submits, one side pays no gas |
| `TokenLocker` | 195 | Lock LP or any ERC-20 for 7–1460 days. `lockedAmount(token)` is a read |
| `DeterministicDeployer` | 99 | One address on every chain, via CREATE2 — no bridge |

**957 lines of Solidity. 191 assertions. No owner, no pause, no fee, no sweep — verified by grep,
not by copy.** The three files under `AdversaryMocks.sol` exist to attack the other five.

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

---

## One address on every chain (the omnichain property, without a bridge)

`DeterministicDeployer.sol` deploys any contract at **the same address on every EVM chain**.

### Why that matters, concretely

Deploy the same contract on ten chains and you normally get ten different addresses. A user who
verified your address on one chain cannot recognise it on another, so they must re-verify by
hand every time — and repeated *"just check this again"* is exactly the habit phishing erodes.
**Ten addresses is ten chances to be fooled. One address is something a person can remember.**

### How, in one paragraph

CREATE2 (EIP-1014) derives an address from `keccak256(0xff ++ deployer ++ salt ++ keccak(code))`.
**The chain id is not an input.** So if the deployer sits at the same address on two chains —
which the universal factory at `0x4e59b44847b379578588920cA78FbF26c0B4956C` guarantees, verified
present on both Robinhood Chain 4663 and 46630 — then the same salt and the same bytecode
produce the same address on both. That is arithmetic, not trust.

### Proven, not claimed

```
DeterministicDeployer  0xC67e76647385B6955C379C25489522B783B1a5c4   984 bytes

predict() matched the EIP-1014 formula for all four contracts   ✅
a real deployment landed at EXACTLY the predicted address        ✅
and answered its own getters (MIN_DAYS 7, MAX_DAYS 365)          ✅

CommitmentVault  0xbDFE455bEd4Fbd22de5EeabC5D06ad46509A3328
TokenLocker      0x3975DB3810c2CbdbC8DEE001e217A2b667193cA4
VestingVault     0x09f1984Fdcc1D04bE27bB5D5e40215E95E62aac2
DevBarter        0xD562918BEfC8ccF4819617D95eb6De9b99c80C75
```

`predict(salt, initCode)` is a free read, so a frontend can show a user the address **before**
they sign. "Trust me" is never required.

### What this deliberately does not do

**It does not share state.** A lock on one chain is not visible on another. That needs a bridge,
and **cross-chain custody is refused on purpose** — bridges are the most-attacked component in
the ecosystem, and adding one to prove honesty would introduce exactly the attack surface the
honesty is meant to demonstrate.

**Cross-chain READING is safe and is supported.** A dashboard can query each chain's RPC and
merge the results offchain. **Reads can be aggregated without a bridge; writes cannot.** This
design takes the first and refuses the second.

### Design note: a 24x size fix

An earlier draft embedded `type(X).creationCode` for every contract it deployed, making the
deployer **23,787 bytes against the 24,576-byte EIP-170 limit** — 97% full with under 800 bytes
of headroom, so adding a fifth contract would have bricked it. Accepting the creation code as
calldata brought it to **991 bytes** and made it work for *any* contract, including ones that
did not exist when it was written.

---

## Using this from an agent

These contracts were built to be read by software before a human signs anything. Three
properties make that possible, and all three are testable:

**1. Every failure is a machine-readable reason, not a string in a log.**
40 custom errors across the contracts, so a revert decodes to a 4-byte selector an agent
can branch on:

```
lock() with a non-contract collection
  raw revert data : 0x09ee12d5
  decoded name    : NotAContract
```

**2. `DevBarter.isExecutable(terms)` is a true pre-flight check.**

It takes **TERMS ONLY — no signatures** — so an agent can ask "would this execute?" before
anything is signed, at zero gas and with no wallet. It **never reverts**: every failure path
returns `(false, reason)` with one of 11 distinct reasons.

```
invalid                 -> (false, "expired")
invalid                 -> (false, "maker token does not exist")
valid                   -> (true, "ok")
```

That property is enforced by its own suite (`test/agent-preflight.test.cjs`, 16 assertions)
which asserts on every refusal path that the call **answers rather than throws**. Getting
there required `try/catch` around each `ownerOf`: a code-length guard is not enough, because
`ownerOf` on a **nonexistent** token reverts inside a perfectly real collection.

**3. Verify what you are about to sign.**

```
tradeDigest(terms)  -> bytes32   the exact hash the signature covers
offerHash(terms)    -> bytes32
nonceUsed(addr, n)  -> bool      replay check
executed()          -> uint256   already-settled check
```

An agent can compute the digest, compare it to the payload it was handed, and refuse if they
disagree — without trusting the caller.

**Reading state is safe and cheap.** `isLocked`, `lockAt`, `locksOf`, `openLocksOf`,
`lockedAmount`, `timeRemaining`, `claimable`, `vested`, `outstanding` are all `view`, so any
of them can be batched through Multicall3 into a single call.

**Why this matters beyond convenience:** a contract with no owner and no admin is a *claim*.
A contract with no owner, no admin, **and a pre-flight that always answers with a reason** is
something another program can build on. The second is policy; the first is a promise.

---

## How this is tested

Seven suites, 133 assertions, plus a seeded fuzzer that throws thousands of malformed and
hostile inputs at the contracts. Everything runs on GitHub's runners on every push, so the
badge on this page is not a decoration.

| Suite | Assertions | What it proves |
|---|---|---|
| commitment-vault | 25 | locking, extending, unlocking, ownership guards |
| token-locker | 24 | LP/ERC-20 locks, `lockedAmount` totals, withdrawal paths |
| vesting-vault | 23 | cliff and linear release maths, permissionless claim to the right payee |
| dev-barter | 19 | EIP-712 signing, relayer submission, both tokens swap atomically |
| adversarial | 10 | hostile collections try to fake locks, re-enter, and replay signatures |
| agent-preflight | 16 | `isExecutable` ANSWERS on every refusal path rather than reverting |
| **fuzz** | **12,000 cases** | randomised hostile trades, locks and signatures |

### The fuzzer

```
FUZZ_N=200000 npx hardhat run test/fuzz.test.cjs      # explore far beyond CI
FUZZ_SEED=12345 npx hardhat run test/fuzz.test.cjs    # a different corner of the space
```

It is **seeded and deterministic** — the seed prints at the top of every run, so a failure
reproduces exactly rather than being a one-off you can never see again.

It found real things. Two of its first three findings were bugs **in the test**, not the
contracts (a negative number handed to a `uint256`, and `100000` handed to a `uint16` — both
ethers encoding refusals that never reached the chain and looked exactly like contract
failures). The third was real: `isExecutable` reverted instead of answering when a token did
not exist, because `ownerOf` throws inside an otherwise perfectly valid collection. A code
length check was not enough. Only `try/catch` catches that.

**That is why the raw error is printed rather than the failure count.** A red number is a
prompt to look, not a conclusion.
