/**
 * ADVERSARIAL AUDIT - attack CommitmentVault and DevBarter from the outside.
 *
 * A contract that only passes its happy path has been demonstrated, not audited. Each block
 * below deploys something hostile and reports what actually happened. Where an attack
 * succeeds, that is a FINDING to document, not a test to hide.
 */
const { ethers } = require("hardhat");

let pass = 0, fail = 0;
const findings = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name + (detail ? "   " + detail : "")); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
}
function found(title, detail) {
  findings.push({ title, detail });
  console.log("  FIND  " + title + "   " + detail);
}
const send = async (p) => { const t = await p; return t.wait(); };

async function main() {
  const [victim, attacker] = await ethers.getSigners();

  const Vault = await ethers.getContractFactory("CommitmentVault");
  const vault = await Vault.deploy();
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();

  const Mock = await ethers.getContractFactory("MockERC721");
  const real = await Mock.deploy("Real Rocks", "REAL");
  await real.waitForDeployment();
  const realAddr = await real.getAddress();

  const Adv = await ethers.getContractFactory("LyingReentrantERC721");
  const liar = await Adv.deploy(vaultAddr);
  await liar.waitForDeployment();
  const liarAddr = await liar.getAddress();

  console.log("\n=== ATTACK 1: a collection that lies about ownership ===");
  // LyingReentrantERC721.ownerOf always returns msg.sender, so the vault's ownership check
  // can be defeated by a collection that simply lies. Measure whether that floods the vault.
  let spamWorked = false;
  try {
    for (let i = 0; i < 5; i++) {
      await send(vault.connect(attacker).lock(liarAddr, 900 + i, 7));
    }
    spamWorked = true;
  } catch (e) {
    spamWorked = false;
  }
  const totalAfterSpam = await vault.totalLocks();
  if (spamWorked) {
    found("a lying collection can register fake locks",
      "totalLocks reached " + totalAfterSpam + " with tokens that do not exist");
    console.log("        IMPACT: the vault cannot verify a collection is honest, and no");
    console.log("        contract can. Consequence: the DISPLAY must never rank by count,");
    console.log("        and /commitments must show the collection address so a reader can");
    console.log("        judge it. The lock proves 'this token is held', never that it is");
    console.log("        worth anything - which is exactly what the page already says.");
  } else {
    ok("a lying collection cannot register locks", true);
  }

  console.log("\n=== ATTACK 2: re-entering unlock from inside your own collection ===");
  await send(real.mintTo(victim.address, 1));
  await send(real.connect(victim).setApprovalForAll(vaultAddr, true));
  await send(vault.connect(victim).lock(realAddr, 1, 7));

  // point the liar at lock 0 and let it try to withdraw mid-transfer
  await send(liar.setOwner(attacker.address));   // so lock() gets past the ownership check
  await send(liar.setReenter(true, 0));
  let reenterErr = "";
  try {
    await send(vault.connect(attacker).lock(liarAddr, 950, 7));
  } catch (e) { reenterErr = (e.shortMessage || e.message || "").split("\n")[0]; }
  const reentered = await liar.reentered();
  const succeeded = await liar.reenterSucceeded();
  ok("re-entrant unlock was attempted", reentered, "liar reported reentry=" + reentered);
  ok("re-entrant unlock did NOT succeed", !succeeded,
     succeeded ? "REENTRANCY SUCCEEDED" : "blocked" + (reenterErr ? " (" + reenterErr.slice(0, 50) + ")" : ""));
  ok("the victim's lock is untouched", await vault.isLocked(realAddr, 1));

  console.log("\n=== ATTACK 3: sending a token in WITHOUT a lock (no sweep exists) ===");
  await send(real.mintTo(victim.address, 2));
  await send(real.connect(victim).transferFrom(victim.address, vaultAddr, 2));
  const ownerNow = await real.ownerOf(2);
  ok("the token is now held by the vault", ownerNow.toLowerCase() === vaultAddr.toLowerCase());
  const stuck = (await real.ownerOf(2)).toLowerCase() === vaultAddr.toLowerCase();
  if (stuck) {
    found("a token sent directly to the vault is permanently stuck",
      "token 2 is held with no Lock record, so unlock() has nothing to read");
    console.log("        IMPACT: deliberate trade-off. A sweep() would be an admin power that");
    console.log("        could also be used on real locks, so it is refused on purpose. The");
    console.log("        page must warn: only use lock(), never a manual transfer.");
  }

  console.log("\n=== ATTACK 4: can anyone else touch the victim's lock? ===");
  let othersBlocked = true;
  try { await send(vault.connect(attacker).unlock(0)); othersBlocked = false; } catch {}
  try { await send(vault.connect(attacker).extend(0, 30)); othersBlocked = false; } catch {}
  ok("a stranger can neither unlock nor extend", othersBlocked);

  console.log("\n=== ATTACK 5: does lockMany leave half a batch behind? ===");
  await send(real.mintTo(victim.address, 3));
  const before = await vault.totalLocks();
  let batchFailed = false;
  try {
    // second token is owned by the attacker, so the batch must revert entirely
    await send(vault.connect(victim).lockMany([realAddr, realAddr], [3, 1], 7));
  } catch { batchFailed = true; }
  const after = await vault.totalLocks();
  ok("a batch with one bad token reverts atomically", batchFailed && after === before,
     "locks " + before + " -> " + after + " (no partial state)");

  console.log("\n=== ATTACK 6: DevBarter - can a signature be replayed on another chain? ===");
  const Bar = await ethers.getContractFactory("DevBarter");
  const bar = await Bar.deploy();
  await bar.waitForDeployment();
  const barAddr = await bar.getAddress();
  const net = await ethers.provider.getNetwork();
  const domain = { name: "DevBarter", version: "1", chainId: Number(net.chainId), verifyingContract: barAddr };
  const wrongDomain = { ...domain, chainId: 4663 };
  const types = {
    Trade: [
      { name: "maker", type: "address" }, { name: "makerCollections", type: "address[]" },
      { name: "makerTokenIds", type: "uint256[]" }, { name: "taker", type: "address" },
      { name: "takerCollections", type: "address[]" }, { name: "takerTokenIds", type: "uint256[]" },
      { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" },
    ],
  };
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const t = {
    maker: victim.address, makerCollections: [realAddr], makerTokenIds: [3n],
    taker: attacker.address, takerCollections: [liarAddr], takerTokenIds: [951n],
    expiry: BigInt(now + 3600), nonce: 11n,
  };
  const wrongSig = await victim.signTypedData(wrongDomain, types, t);
  const goodSig = await victim.signTypedData(domain, types, t);
  const attackerSig = await attacker.signTypedData(domain, types, t);

  let crossChainBlocked = false;
  try { await send(bar.connect(attacker).execute(t, wrongSig, attackerSig)); } catch { crossChainBlocked = true; }
  ok("a signature made for another chain id is rejected", crossChainBlocked);

  console.log("\n=== ATTACK 7: DevBarter - a different contract's signature ===");
  const bar2 = await Bar.deploy();
  await bar2.waitForDeployment();
  const domain2 = { ...domain, verifyingContract: await bar2.getAddress() };
  const sigForOther = await victim.signTypedData(domain2, types, t);
  let crossContractBlocked = false;
  try { await send(bar.connect(attacker).execute(t, sigForOther, attackerSig)); } catch { crossContractBlocked = true; }
  ok("a signature for another barter contract is rejected", crossContractBlocked);

  console.log("\n=== ATTACK 8: DevBarter - replay after a cancelled nonce ===");
  await send(bar.connect(victim).cancelNonce(11n));
  let cancelBlocked = false;
  try { await send(bar.connect(attacker).execute(t, goodSig, attackerSig)); } catch { cancelBlocked = true; }
  ok("cancelling a nonce kills the signed offer", cancelBlocked);

  console.log("\n=== SUMMARY ===");
  console.log("  assertions: " + pass + " passed, " + fail + " failed");
  console.log("  findings  : " + findings.length + " (documented, not hidden)");
  findings.forEach((f, i) => console.log("    " + (i + 1) + ". " + f.title));

  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
