/**
 * VestingVault E2E - proves the schedule pays out on arithmetic, cannot be cancelled, and
 * that a third party can claim on someone else's behalf without ever redirecting the payout.
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
const DAY = 24 * 3600;

async function main() {
  const [funder, beneficiary, relayer] = await ethers.getSigners();

  const TOK = await ethers.getContractFactory("MockERC20");
  const tok = await TOK.deploy("Vested Token", "VEST");
  await tok.waitForDeployment();
  const tokAddr = await tok.getAddress();

  const V = await ethers.getContractFactory("VestingVault");
  const v = await V.deploy();
  await v.waitForDeployment();
  const vAddr = await v.getAddress();

  const ONE = 10n ** 18n;

  console.log("\n--- no admin surface: a schedule cannot be cancelled ---");
  const abi = require("../artifacts/contracts/VestingVault.sol/VestingVault.json").abi;
  const fns = abi.filter((x) => x.type === "function").map((x) => x.name);
  const dodgy = fns.filter((f) => /owner|pause|sweep|rescue|upgrade|cancel|revoke|setFee/i.test(f));
  ok("no owner/pause/cancel/revoke/sweep in the compiled contract", dodgy.length === 0,
     dodgy.length ? "found " + dodgy.join(",") : fns.length + " functions, none an admin hook");

  console.log("\n--- funding a schedule ---");
  await send(tok.mint(funder.address, 1000n * ONE));
  await expectRevert("creating without approval reverts", async () => {
    await send(v.connect(funder).create(tokAddr, beneficiary.address, 100n * ONE, 100, 0, 0));
  });
  await send(tok.connect(funder).approve(vAddr, ethers.MaxUint256));

  await expectRevert("zero amount reverts", async () => {
    await send(v.connect(funder).create(tokAddr, beneficiary.address, 0, 100, 0, 0));
  }, "BadAmount");
  await expectRevert("a duration above the 5 year cap reverts", async () => {
    await send(v.connect(funder).create(tokAddr, beneficiary.address, 1n * ONE, 2000, 0, 0));
  }, "BadDuration");
  await expectRevert("a cliff longer than the duration reverts", async () => {
    await send(v.connect(funder).create(tokAddr, beneficiary.address, 1n * ONE, 100, 200, 0));
  }, "BadCliff");

  const funderBefore = await tok.balanceOf(funder.address);
  // 365 day schedule, 90 day cliff, meaning NO payout for 90 days then linear to day 365
  await send(v.connect(funder).create(tokAddr, beneficiary.address, 365n * ONE, 365, 90, 0));
  const funderAfter = await tok.balanceOf(funder.address);
  ok("the full amount moved into the vault", funderBefore - funderAfter === 365n * ONE);
  ok("outstanding() reports it", (await v.outstanding(tokAddr)) === 365n * ONE);

  console.log("\n--- the cliff is real ---");
  ok("nothing is claimable on day 0", (await v.claimable(0)) === 0n);
  await expectRevert("claiming during the cliff reverts", async () => {
    await send(v.claim(0));
  }, "NothingToClaim");

  await ethers.provider.send("evm_increaseTime", [89 * DAY]);
  await ethers.provider.send("evm_mine", []);
  ok("still nothing at day 89", (await v.claimable(0)) === 0n);

  console.log("\n--- it vests linearly after the cliff ---");
  await ethers.provider.send("evm_increaseTime", [92 * DAY]); // ~day 181
  await ethers.provider.send("evm_mine", []);
  const mid = await v.claimable(0);
  // Vesting starts at the CLIFF (day 90), not at day 0, and runs to day 365. At ~day 181
  // that is ~91 of a 275-day window, so ~121 tokens - my first expectation of 90-100 ignored
  // the cliff entirely. Assert against the interval the contract actually implements.
  ok("partially vested at the expected point", mid > 115n * ONE && mid < 126n * ONE,
     ethers.formatEther(mid) + " of 365 (91 of 275 days past the cliff)");
  ok("vested() equals claimable() when nothing has been taken", (await v.vested(0)) === mid);

  console.log("\n--- ANYONE can claim, and the BENEFICIARY is paid ---");
  const benBefore = await tok.balanceOf(beneficiary.address);
  const relayerBefore = await tok.balanceOf(relayer.address);
  const rc = await send(v.connect(relayer).claim(0)); // a stranger pays the gas
  // vesting accrues every second, so a snapshot taken before the tx is already stale by the
  // time it mines. Read the exact figure the contract emitted.
  const claimedEvt = rc.logs.map((l) => { try { return v.interface.parseLog(l); } catch { return null; } })
                        .find((e) => e && e.name === "Claimed");
  const paid = claimedEvt ? claimedEvt.args.amount : 0n;
  const benAfter = await tok.balanceOf(beneficiary.address);
  const relayerAfter = await tok.balanceOf(relayer.address);
  ok("the relayer paid the gas", rc.from.toLowerCase() === relayer.address.toLowerCase());
  ok("the BENEFICIARY received exactly what the event says", benAfter - benBefore === paid,
     ethers.formatEther(paid) + " tokens");
  ok("the relayer received nothing", relayerAfter === relayerBefore);
  ok("claimable is now zero", (await v.claimable(0)) === 0n);
  ok("claimed is recorded", (await v.scheduleAt(0)).claimed === paid);

  console.log("\n--- it never pays more than was funded ---");
  await ethers.provider.send("evm_increaseTime", [400 * DAY]);
  await ethers.provider.send("evm_mine", []);
  ok("fully vested after the end date", (await v.vested(0)) === 365n * ONE);
  const rest = await v.claimable(0);
  await send(v.connect(beneficiary).claim(0));
  const benFinal = await tok.balanceOf(beneficiary.address);
  ok("total paid equals exactly the funded amount", benFinal - benBefore === 365n * ONE,
     ethers.formatEther(benFinal - benBefore) + " of 365");
  ok("outstanding dropped to zero", (await v.outstanding(tokAddr)) === 0n);
  await expectRevert("nothing left to claim", async () => {
    await send(v.claim(0));
  }, "NothingToClaim");

  console.log("\n--- claimAll for a beneficiary with several schedules ---");
  await send(v.connect(funder).create(tokAddr, beneficiary.address, 10n * ONE, 1, 0, 0));
  await send(v.connect(funder).create(tokAddr, beneficiary.address, 20n * ONE, 1, 0, 0));
  await ethers.provider.send("evm_increaseTime", [2 * DAY]);
  await ethers.provider.send("evm_mine", []);
  const beforeAll = await tok.balanceOf(beneficiary.address);
  await send(v.connect(beneficiary).claimAll());
  const afterAll = await tok.balanceOf(beneficiary.address);
  ok("claimAll swept both short schedules", afterAll - beforeAll === 30n * ONE,
     ethers.formatEther(afterAll - beforeAll));

  console.log("\n--- a non-contract token is refused ---");
  await expectRevert("creating against a non-contract reverts", async () => {
    await send(v.connect(funder).create(relayer.address, beneficiary.address, 1n * ONE, 30, 0, 0));
  }, "NotAContract");

  console.log("\n=== " + pass + " passed, " + fail + " failed ===");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
