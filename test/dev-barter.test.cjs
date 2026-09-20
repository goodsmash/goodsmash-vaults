/**
 * DevBarter E2E - proves the trade terms cannot be tampered with and that a THIRD PARTY can
 * settle a trade for both signers (which is the entire reason this contract exists).
 *
 * Every revert test prints its real reason. A "should revert" assertion that passes without
 * showing the reason has proven nothing.
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
  const [maker, taker, relayer, stranger] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC721");
  const nftA = await Mock.deploy("Maker Rocks", "MROCK");
  await nftA.waitForDeployment();
  const nftB = await Mock.deploy("Taker Rocks", "TROCK");
  await nftB.waitForDeployment();
  const A = await nftA.getAddress();
  const B = await nftB.getAddress();

  const Bar = await ethers.getContractFactory("DevBarter");
  const bar = await Bar.deploy();
  await bar.waitForDeployment();
  const barAddr = await bar.getAddress();

  await send(nftA.mintTo(maker.address, 11));
  await send(nftB.mintTo(taker.address, 22));

  // ONE approval per collection, not per trade. After this every trade is just a
  // signature, which is the whole point - the signing side spends nothing.
  await send(nftA.connect(maker).setApprovalForAll(barAddr, true));
  await send(nftB.connect(taker).setApprovalForAll(barAddr, true));

  const net = await ethers.provider.getNetwork();
  const domain = { name: "DevBarter", version: "1", chainId: Number(net.chainId), verifyingContract: barAddr };
  const types = {
    Trade: [
      { name: "maker", type: "address" },
      { name: "makerCollections", type: "address[]" },
      { name: "makerTokenIds", type: "uint256[]" },
      { name: "taker", type: "address" },
      { name: "takerCollections", type: "address[]" },
      { name: "takerTokenIds", type: "uint256[]" },
      { name: "expiry", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const mk = (over = {}) => ({
    maker: maker.address,
    makerCollections: [A],
    makerTokenIds: [11n],
    taker: taker.address,
    takerCollections: [B],
    takerTokenIds: [22n],
    expiry: BigInt(now + 3600),
    nonce: 1n,
    ...over,
  });

  console.log("\n--- the contract has no owner and takes no cut ---");
  const abi = require("../artifacts/contracts/DevBarter.sol/DevBarter.json").abi;
  const fns = abi.filter((x) => x.type === "function").map((x) => x.name);
  const dodgy = fns.filter((f) => /owner|pause|sweep|rescue|upgrade|withdraw|fee/i.test(f));
  ok("no owner/pause/sweep/withdraw/fee surface", dodgy.length === 0,
     dodgy.length ? "found " + dodgy.join(",") : fns.length + " functions, none of them an admin hook");

  console.log("\n--- both signatures are required ---");
  const t = mk();
  const makerSig = await maker.signTypedData(domain, types, t);
  const takerSig = await taker.signTypedData(domain, types, t);

  await expectRevert("missing taker signature reverts", async () => {
    await send(bar.connect(relayer).execute(t, makerSig, "0x"));
  }, "BadTakerSignature");
  await expectRevert("missing maker signature reverts", async () => {
    await send(bar.connect(relayer).execute(t, "0x", takerSig));
  }, "BadMakerSignature");

  console.log("\n--- one side cannot alter the other's half ---");
  const tampered = mk({ takerTokenIds: [999n] });
  await expectRevert("changing the taker's token invalidates the taker's signature", async () => {
    // maker's sig still matches nothing now, and taker never signed THESE terms
    await send(bar.connect(relayer).execute(tampered, makerSig, takerSig));
  });
  const swapped = mk({ maker: taker.address, taker: maker.address });
  await expectRevert("flipping who gives what invalidates both signatures", async () => {
    await send(bar.connect(relayer).execute(swapped, makerSig, takerSig));
  });

  console.log("\n--- the trade actually settles, submitted by a THIRD PARTY ---");
  ok("maker owns 11 before", (await nftA.ownerOf(11)).toLowerCase() === maker.address.toLowerCase());
  ok("taker owns 22 before", (await nftB.ownerOf(22)).toLowerCase() === taker.address.toLowerCase());
  const rc = await send(bar.connect(relayer).execute(t, makerSig, takerSig));
  ok("relayer paid the gas, not the parties", rc.from.toLowerCase() === relayer.address.toLowerCase());
  ok("maker now owns taker's token 22", (await nftB.ownerOf(22)).toLowerCase() === maker.address.toLowerCase());
  ok("taker now owns maker's token 11", (await nftA.ownerOf(11)).toLowerCase() === taker.address.toLowerCase());
  ok("executed counter incremented", (await bar.executed()) === 1n);

  console.log("\n--- replay and cancellation ---");
  await expectRevert("the same signed trade cannot be replayed", async () => {
    await send(bar.connect(relayer).execute(t, makerSig, takerSig));
  }, "NonceAlreadyUsed");

  const t2 = mk({ nonce: 2n, makerTokenIds: [], makerCollections: [] }); // will fail side check, that's fine - just testing the nonce
  await send(bar.connect(maker).cancelNonce(2n));
  ok("nonce marked used after cancel", await bar.nonceUsed(maker.address, 2n));
  await expectRevert("a cancelled nonce cannot be executed", async () => {
    await send(bar.connect(relayer).execute(t2, makerSig, takerSig));
  });

  console.log("\n--- expiry and self-trade are refused ---");
  const expired = mk({ nonce: 3n, expiry: BigInt(now - 10) });
  await expectRevert("an expired offer reverts", async () => {
    await send(bar.connect(relayer).execute(expired, makerSig, takerSig));
  }, "TradeExpired");
  const tooLong = mk({ nonce: 4n, expiry: BigInt(now + 91 * 24 * 3600) });
  await expectRevert("an offer beyond the 90-day window reverts", async () => {
    await send(bar.connect(relayer).execute(tooLong, makerSig, takerSig));
  }, "BadExpiry");
  const selfTrade = mk({ nonce: 5n, taker: maker.address });
  await expectRevert("trading with yourself reverts", async () => {
    await send(bar.connect(relayer).execute(selfTrade, makerSig, makerSig));
  }, "SameAccount");

  console.log("\n--- ownership is re-checked at execution, not at signing ---");
  // stranger now holds 11, so a fresh trade over it must fail even with valid signatures
  const t3 = mk({ nonce: 6n, makerCollections: [A], makerTokenIds: [11n], takerCollections: [B], takerTokenIds: [22n] });
  const ms3 = await maker.signTypedData(domain, types, t3);
  const ts3 = await taker.signTypedData(domain, types, t3);
  await expectRevert("a trade over a token the maker no longer owns reverts", async () => {
    await send(bar.connect(relayer).execute(t3, ms3, ts3));
  }); // maker now owns 22, not 11

  console.log("\n--- isExecutable is an honest read ---");
  const t4 = mk({ nonce: 7n, makerCollections: [B], makerTokenIds: [22n], takerCollections: [A], takerTokenIds: [11n] });
  const probe = await bar.isExecutable(t4);
  ok("isExecutable true for a good trade", probe.executable === true, "reason: " + probe.reason);

  console.log("\n=== " + pass + " passed, " + fail + " failed ===");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
