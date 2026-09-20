/**
 * CommitmentVault E2E - proves the safety rules hold, on a local chain.
 *
 * These are the properties the contract CLAIMS in its header comment. Each one is tested
 * as a real transaction, and every "should revert" case prints the actual revert reason -
 * a revert test that passes without showing the reason has proven nothing.
 */
const { ethers } = require("hardhat");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name + (detail ? "   " + detail : "")); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
}

// ethers v6: a contract call returns a Promise, so chaining .wait() directly throws a
// TypeError that a try/catch swallows - making every revert test pass without touching the
// contract. These two helpers are the fix.
const send = async (p) => { const t = await p; return t.wait(); };
async function expectRevert(name, fn, wantFragment) {
  try {
    await fn();
    fail++; console.log("  FAIL  " + name + "   (did NOT revert)");
    return "";
  } catch (e) {
    const msg = (e.shortMessage || e.message || "").split("\n")[0];
    const good = !wantFragment || msg.toLowerCase().includes(wantFragment.toLowerCase());
    if (good) { pass++; console.log("  PASS  " + name + "   reason: " + msg); }
    else { fail++; console.log("  FAIL  " + name + "   wrong reason: " + msg); }
    return msg;
  }
}

async function main() {
  const [locker, other, stranger] = await ethers.getSigners();

  // a plain ERC-721 to lock
  const Mock = await ethers.getContractFactory("MockERC721");
  const nft = await Mock.deploy("Test Rocks", "TROCK");
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();

  const Vault = await ethers.getContractFactory("CommitmentVault");
  const vault = await Vault.deploy();
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();

  // mint #1 and #2 to locker, #3 to other
  await send(nft.mintTo(locker.address, 1));
  await send(nft.mintTo(locker.address, 2));
  await send(nft.mintTo(other.address, 3));

  console.log("\n--- the vault has no owner and no admin surface ---");
  const src = require("fs").readFileSync("contracts/CommitmentVault.sol", "utf8");
  ok("no owner() in the contract", !/function\s+owner\s*\(/.test(src));
  ok("no pause()", !/function\s+pause\s*\(/.test(src));
  ok("no sweep/rescue/emergency", !/function\s+(sweep|rescue|emergency)/i.test(src));

  console.log("\n--- rule 1: you can only lock what you own ---");
  await send(nft.connect(locker).approve(vaultAddr, 1));
  await expectRevert("locking someone else's token reverts", async () => {
    await send(vault.connect(stranger).lock(nftAddr, 1, 7));
  }, "NotOwnerOfToken");

  await expectRevert("period below the minimum reverts", async () => {
    await send(vault.connect(locker).lock(nftAddr, 1, 1));
  }, "BadPeriod");

  await expectRevert("period above the maximum reverts", async () => {
    await send(vault.connect(locker).lock(nftAddr, 1, 400));
  }, "BadPeriod");

  console.log("\n--- the happy path ---");
  await send(vault.connect(locker).lock(nftAddr, 1, 7));
  ok("token 1 now held by the vault", (await nft.ownerOf(1)).toLowerCase() === vaultAddr.toLowerCase());
  ok("lock recorded for the locker", (await vault.totalLocks()) === 1n);
  ok("isLocked reports true", await vault.isLocked(nftAddr, 1));
  const L0 = await vault.lockAt(0);
  ok("lock stores the period chosen", L0.periodDays === 7n, "periodDays=" + L0.periodDays);

  console.log("\n--- rule 2: the token can only go back to the locker ---");
  await expectRevert("a stranger cannot unlock", async () => {
    await send(vault.connect(stranger).unlock(0));
  }, "NotYourLock");
  await expectRevert("even the original owner cannot take it early", async () => {
    await send(vault.connect(locker).unlock(0));
  }, "StillLocked");

  console.log("\n--- rule 3: extend only ever lengthens ---");
  const before = (await vault.lockAt(0)).unlockAt;
  await send(vault.connect(locker).extend(0, 30));
  const after = (await vault.lockAt(0)).unlockAt;
  ok("extend pushed the unlock later", after > before, before + " -> " + after);
  ok("period accumulated", (await vault.lockAt(0)).periodDays === 37n);
  await expectRevert("a stranger cannot extend", async () => {
    await send(vault.connect(stranger).extend(0, 30));
  }, "NotYourLock");
  await expectRevert("cannot extend by zero", async () => {
    await send(vault.connect(locker).extend(0, 0));
  }, "NothingToExtend");

  console.log("\n--- batch locking ---");
  await send(nft.connect(locker).approve(vaultAddr, 2));
  await send(vault.connect(locker).lockMany([nftAddr], [2], 30));
  ok("batch lock landed", (await vault.totalLocks()) === 2n);
  ok("open locks for locker is 2", (await vault.openLocksOf(locker.address)) === 2n);
  ok("collection counter tracks both", (await vault.openLocksInCollection(nftAddr)) === 2n);

  console.log("\n--- rule 4: after the period, it returns to the locker ---");
  await ethers.provider.send("evm_increaseTime", [38 * 24 * 3600]);
  await ethers.provider.send("evm_mine", []);
  const bankBefore = await nft.ownerOf(3); // unrelated, just to prove we read live state
  await send(vault.connect(locker).unlock(0));
  ok("token 1 back with the locker", (await nft.ownerOf(1)).toLowerCase() === locker.address.toLowerCase());
  ok("isLocked now false", !(await vault.isLocked(nftAddr, 1)));
  ok("open locks dropped to 1", (await vault.openLocksOf(locker.address)) === 1n);
  await expectRevert("cannot withdraw twice", async () => {
    await send(vault.connect(locker).unlock(0));
  }, "AlreadyWithdrawn");
  console.log("\n--- the real safety check: the COMPILED surface, not the source text ---");
  // A source regex matched IERC721Minimal's interface declaration, not an implementation.
  // The artifact ABI is what actually ships, so assert against THAT.
  const abi = require("../artifacts/contracts/CommitmentVault.sol/CommitmentVault.json").abi;
  const fns = abi.filter((x) => x.type === "function").map((x) => x.name);
  const dangerous = fns.filter((f) => /transfer|owner|pause|sweep|rescue|upgrade|mint/i.test(f));
  ok("no transfer/owner/pause/sweep in the compiled contract", dangerous.length === 0,
     dangerous.length ? "found: " + dangerous.join(", ") : fns.length + " functions, none of them dangerous");
  ok("unlock is the only way a token leaves", fns.includes("unlock") && !fns.includes("transferFrom"));

  console.log("\n=== " + pass + " passed, " + fail + " failed ===");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
