/**
 * Does isExecutable ALWAYS answer, or does it sometimes blow up?
 *
 * This exists because the original version called ownerOf() directly, and ownerOf on a
 * code-less address reverts with no data. An agent asking ONE question - "would these
 * terms execute?" - got two different failure modes. That makes it unusable as policy.
 *
 * Every case below must return (false, "<reason>"). If ANY of them reverts, the test
 * fails, because a pre-flight check that can throw is not a pre-flight check.
 */
const hre = require("hardhat");
const { ethers } = hre;

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? "   " + extra : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? "   " + extra : ""}`); }
}

async function main() {
  const [dev] = await ethers.getSigners();

  // a real ERC-721 so the good path can succeed
  const Mock = await ethers.getContractFactory("MockERC721");
  const nft = await Mock.deploy("Mock", "MOCK");
  await nft.waitForDeployment();
  const nftA = await nft.getAddress();

  const Bar = await ethers.getContractFactory("DevBarter");
  const bar = await Bar.deploy();
  await bar.waitForDeployment();
  const barA = await bar.getAddress();

  await (await nft.mintTo(dev.address, 1)).wait();
  await (await nft.mintTo(dev.address, 2)).wait();

  const dev2 = (await ethers.getSigners())[1];
  await (await nft.mintTo(dev2.address, 3)).wait();

  const NO_CODE = "0x3333333333333333333333333333333333333333"; // an address with no contracts
  const ZERO = ethers.ZeroAddress;
  const now = (await ethers.provider.getBlock("latest")).timestamp;

  const mk = (o = {}) => ({
    maker: dev.address,
    makerCollections: [nftA],
    makerTokenIds: [1n],
    taker: dev2.address,
    takerCollections: [nftA],
    takerTokenIds: [3n],
    expiry: BigInt(now + 3600),
    nonce: 1n,
    ...o,
  });

  console.log("=== every failure path must ANSWER, never revert ===");

  const cases = [
    ["expired",                 mk({ expiry: BigInt(now - 60) })],
    ["expiry beyond window",    mk({ expiry: BigInt(now + 400 * 86400) })],
    ["maker == taker",          mk({ taker: dev.address, takerTokenIds: [2n] })],
    ["zero maker",              mk({ maker: ZERO })],
    ["zero taker",              mk({ taker: ZERO })],
    ["empty maker side",        mk({ makerCollections: [], makerTokenIds: [] })],
    ["empty taker side",        mk({ takerCollections: [], takerTokenIds: [] })],
    ["maker length mismatch",   mk({ makerTokenIds: [1n, 2n] })],
    ["taker length mismatch",   mk({ takerTokenIds: [] })],
    ["too many tokens",         mk({ makerCollections: Array(21).fill(nftA), makerTokenIds: Array(21).fill(1n) })],
    ["maker coll not contract", mk({ makerCollections: [NO_CODE] })],
    ["taker coll not contract", mk({ takerCollections: [NO_CODE] })],
    ["maker owns nothing",      mk({ makerTokenIds: [999n] })],
    ["taker owns nothing",      mk({ takerTokenIds: [999n] })],
  ];

  for (const [label, trade] of cases) {
    let result = null, reverted = false, why = "";
    try {
      result = await bar.isExecutable(trade);
    } catch (e) {
      reverted = true;
      why = String(e.shortMessage || e.message).slice(0, 60);
    }
    if (reverted) {
      ok(`"${label}" answers instead of reverting`, false, `REVERTED: ${why}`);
    } else {
      ok(`"${label}" answers instead of reverting`, true, `-> (${result[0]}, "${result[1]}")`);
    }
  }

  console.log("");
  console.log("=== and the good path still says yes ===");
  let good = null;
  try { good = await bar.isExecutable(mk()); } catch (e) { good = null; }
  ok("valid terms return true", !!(good && good[0] === true), good ? `-> (${good[0]}, "${good[1]}")` : "REVERTED");

  console.log("");
  console.log("=== an agent can branch on the REASON, not just the boolean ===");
  const reasons = new Set();
  for (const [, trade] of cases) {
    try { const r = await bar.isExecutable(trade); reasons.add(r[1]); } catch {}
  }
  ok("reasons are distinct strings an agent can switch on", reasons.size >= 8, `${reasons.size} distinct reasons`);
  console.log("     " + [...reasons].sort().join(" | "));

  console.log("");
  console.log(`=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
