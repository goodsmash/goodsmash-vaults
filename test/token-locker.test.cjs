/**
 * TokenLocker E2E - the LP-lock product, proven the same way as the NFT vault.
 * Every revert test prints its real reason.
 */
const { ethers } = require("hardhat");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name + (detail ? "   " + detail : "")); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
}
const send = async (p) => { const t = await p; return t.wait(); };
async function expectRevert(name, fn, want) {
  try { await fn(); fail++; console.log("  FAIL  " + name + "   (did NOT revert)"); }
  catch (e) {
    const m = (e.shortMessage || e.message || "").split("\n")[0];
    const good = !want || m.toLowerCase().includes(want.toLowerCase());
    if (good) { pass++; console.log("  PASS  " + name + "   reason: " + m); }
    else { fail++; console.log("  FAIL  " + name + "   wrong reason: " + m); }
  }
}

async function main() {
  const [locker, other, dev] = await ethers.getSigners();

  const TOK = await ethers.getContractFactory("MockERC20");
  const lp = await TOK.deploy("GoodsMash LP", "GM-LP");
  await lp.waitForDeployment();
  const lpAddr = await lp.getAddress();

  const Lck = await ethers.getContractFactory("TokenLocker");
  const lockerC = await Lck.deploy();
  await lockerC.waitForDeployment();
  const lkAddr = await lockerC.getAddress();

  const ONE = 10n ** 18n;

  console.log("\n--- no admin surface ---");
  const abi = require("../artifacts/contracts/TokenLocker.sol/TokenLocker.json").abi;
  const fns = abi.filter((x) => x.type === "function").map((x) => x.name);
  const dodgy = fns.filter((f) => /owner|pause|sweep|rescue|upgrade|withdrawAll|setFee/i.test(f));
  ok("no owner/pause/sweep/rescue/fee", dodgy.length === 0,
     dodgy.length ? "found " + dodgy.join(",") : fns.length + " functions, none an admin hook");

  console.log("\n--- needs an approval, and refuses nonsense ---");
  await send(lp.mint(locker.address, 1000n * ONE));
  await expectRevert("locking without approval reverts", async () => {
    await send(lockerC.connect(locker).lock(lpAddr, 100n * ONE, 30));
  });
  await send(lp.connect(locker).approve(lkAddr, ethers.MaxUint256));

  await expectRevert("zero amount reverts", async () => {
    await send(lockerC.connect(locker).lock(lpAddr, 0, 30));
  }, "BadAmount");
  await expectRevert("below the 7 day minimum reverts", async () => {
    await send(lockerC.connect(locker).lock(lpAddr, 1n * ONE, 3));
  }, "BadPeriod");
  await expectRevert("above the 4 year maximum reverts", async () => {
    await send(lockerC.connect(locker).lock(lpAddr, 1n * ONE, 2000));
  }, "BadPeriod");

  console.log("\n--- the LP lock itself ---");
  const balBefore = await lp.balanceOf(locker.address);
  await send(lockerC.connect(locker).lock(lpAddr, 400n * ONE, 365));
  const balAfter = await lp.balanceOf(locker.address);
  ok("tokens moved into the locker", balBefore - balAfter === 400n * ONE);
  ok("lockedAmount reads 400", (await lockerC.lockedAmount(lpAddr)) === 400n * ONE);
  ok("the token list works", (await lockerC.locksOf(locker.address)).length === 1);

  const secs = await lockerC.timeRemaining(0);
  const days = Number(secs) / 86400;
  ok("timeRemaining is about a year", days > 364 && days < 366, days.toFixed(1) + " days");

  console.log("\n--- it cannot come out early, by anyone ---");
  await expectRevert("the locker cannot withdraw early", async () => {
    await send(lockerC.connect(locker).unlock(0));
  }, "StillLocked");
  await expectRevert("a stranger cannot withdraw", async () => {
    await send(lockerC.connect(other).unlock(0));
  }, "NotYourLock");
  await expectRevert("a stranger cannot extend", async () => {
    await send(lockerC.connect(other).extend(0, 30));
  }, "NotYourLock");

  console.log("\n--- extend only lengthens ---");
  const before = (await lockerC.lockAt(0)).unlockAt;
  await send(lockerC.connect(locker).extend(0, 365));
  const after = (await lockerC.lockAt(0)).unlockAt;
  ok("extend pushed the date out", after > before, before + " -> " + after);
  ok("period accumulated to 730 days", (await lockerC.lockAt(0)).periodDays === 730n);
  await expectRevert("cannot extend by zero", async () => {
    await send(lockerC.connect(locker).extend(0, 0));
  }, "NothingToExtend");

  console.log("\n--- a second lock, and the aggregate number ---");
  await send(lockerC.connect(locker).lock(lpAddr, 100n * ONE, 30));
  ok("lockedAmount sums both locks", (await lockerC.lockedAmount(lpAddr)) === 500n * ONE,
     "500 expected, got " + ethers.formatEther(await lockerC.lockedAmount(lpAddr)));
  ok("openLocksForToken is 2", (await lockerC.openLocksForToken(lpAddr)) === 2n);

  console.log("\n--- after the period it returns to the locker ---");
  // lock 1 has 30 days; jump past it
  await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
  await ethers.provider.send("evm_mine", []);
  const pre = await lp.balanceOf(locker.address);
  await send(lockerC.connect(locker).unlock(1));
  const post = await lp.balanceOf(locker.address);
  ok("the 30-day lock paid out 100", post - pre === 100n * ONE);
  ok("lockedAmount dropped to 400", (await lockerC.lockedAmount(lpAddr)) === 400n * ONE);
  await expectRevert("cannot withdraw twice", async () => {
    await send(lockerC.connect(locker).unlock(1));
  }, "AlreadyWithdrawn");
  ok("the long lock is still held", await lockerC.timeRemaining(0) > 0n,
     "the year lock is untouched");

  console.log("\n--- batches are atomic ---");
  const before2 = await lockerC.totalLocks();
  await expectRevert("a batch with a bad token reverts entirely", async () => {
    await send(lockerC.connect(locker).lockMany([lpAddr, dev.address], [1n * ONE, 1n * ONE], 30));
  });
  ok("no partial state from the failed batch", (await lockerC.totalLocks()) === before2,
     before2 + " -> " + (await lockerC.totalLocks()));

  console.log("\n--- a token with no code is refused ---");
  await expectRevert("locking a non-contract reverts", async () => {
    await send(lockerC.connect(locker).lock(dev.address, 1n * ONE, 30));
  }, "NotAContract");

  console.log("\n=== " + pass + " passed, " + fail + " failed ===");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
