# GoodsMash Vaults

Three small, self-contained Solidity contracts for **proving you are holding** and **trading between builders without coordination**.

MIT licensed. No owner, no pause, no upgrade path, no fee — in any of them. That is the point, not an oversight: a lock that an operator can open is not a lock.

- **Tests:** 68 assertions passing across four suites, plus a 9-case adversarial suite
- **Sizes:** CommitmentVault 4,822 B · DevBarter 6,701 B · TokenLocker 4,089 B (all under the 24,576 B limit)
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
| Re-entrancy | Checks-effects-interactions everywhere (state is written before any transfer) |
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
