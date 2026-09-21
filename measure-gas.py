"""
GAS vs ESTIMATE, MEASURED — the state-transition check their standard asks for.

"If an agent can't return a tx, a vote ID, or an explicit null, it's entertainment."
Gas-vs-estimate is the other half of that: was the estimate honest, or did the tx burn
more than the caller was told?

For every state-changing function in the vault stack, this measures BOTH numbers:
    estimate = provider.estimateGas(...)   what a caller is quoted
    actual   = receipt.gasUsed             what was really consumed
and reports the ratio. A ratio near 1.0 means the quote is trustworthy; a large overshoot
means callers are being quoted a number that hides real cost.

This is a local measurement on a fresh chain, so it is reproducible by anyone who clones
the repo - which is what makes it a checkable claim rather than a claim about our machine.
"""
import json, io, os

hre = None
for cand in (
    "C:/Users/ryanm/goodsmash-vaults/node_modules/hardhat",
    "C:/Users/ryanm/Downloads/goodsmash-v2-full/goodsmash-onchain-worlds-v2/node_modules/hardhat",
):
    if os.path.exists(cand):
        import importlib.util
        spec = importlib.util.spec_from_file_location("hardhat_rt", os.path.join(cand, "internal/cli/bootstrap.js"))
        break

import subprocess, sys

SCRIPT = r"""
const hre = require("hardhat");
(async () => {
  const { ethers } = hre;
  const [a, b, c] = await ethers.getSigners();
  const out = [];

  const Mock721 = await ethers.getContractFactory("MockERC721");
  const nft = await Mock721.deploy("T", "T"); await nft.waitForDeployment();
  await (await nft.mintTo(a.address, 1)).wait();
  await (await nft.mintTo(a.address, 2)).wait();

  const Mock20 = await ethers.getContractFactory("MockERC20");
  const tok = await Mock20.deploy("T", "T"); await tok.waitForDeployment();
  await (await tok.mint(a.address, ethers.parseEther("1000"))).wait();

  const V = await ethers.getContractFactory("CommitmentVault");
  const vault = await V.deploy(); await vault.waitForDeployment();
  const L = await ethers.getContractFactory("TokenLocker");
  const locker = await L.deploy(); await locker.waitForDeployment();
  const Vg = await ethers.getContractFactory("VestingVault");
  const vest = await Vg.deploy(); await vest.waitForDeployment();
  const B = await ethers.getContractFactory("DevBarter");
  const barter = await B.deploy(); await barter.waitForDeployment();

  await (await nft.setApprovalForAll(await vault.getAddress(), true)).wait();
  await (await tok.approve(await locker.getAddress(), ethers.parseEther("1000"))).wait();
  await (await tok.approve(await vest.getAddress(), ethers.parseEther("1000"))).wait();
  await (await nft.setApprovalForAll(await barter.getAddress(), true)).wait();

  async function measure(label, promiseFn) {
    const est = await promiseFn(true);            // estimate only
    const tx = await promiseFn(false);            // send
    const rc = await tx.wait();
    const ratio = Number(rc.gasUsed) / Number(est);
    out.push({ op: label, estimate: Number(est), actual: Number(rc.gasUsed),
               ratio: Number(ratio.toFixed(3)) });
  }

  await measure("CommitmentVault.lock", (dry) =>
    dry ? vault.lock.estimateGas(nft.target, 1, 30)
        : vault.lock(nft.target, 1, 30));
  await measure("CommitmentVault.extend", (dry) =>
    dry ? vault.extend.estimateGas(0, 7) : vault.extend(0, 7));
  await measure("CommitmentVault.unlock", (dry) =>
    dry ? vault.unlock.estimateGas(0) : vault.unlock(0));

  await measure("TokenLocker.lock", (dry) =>
    dry ? locker.lock.estimateGas(tok.target, ethers.parseEther("10"), 30)
        : locker.lock(tok.target, ethers.parseEther("10"), 30));
  await measure("TokenLocker.withdraw", (dry) =>
    dry ? locker.withdraw.estimateGas(0) : locker.withdraw(0));

  await measure("VestingVault.create", (dry) =>
    dry ? vest.create.estimateGas(tok.target, b.address, ethers.parseEther("50"), 0, 30, 0)
        : vest.create(tok.target, b.address, ethers.parseEther("50"), 0, 30, 0));

  await measure("DevBarter.cancelNonce", (dry) =>
    dry ? barter.cancelNonce.estimateGas(7) : barter.cancelNonce(7));

  console.log("GASJSON" + JSON.stringify(out));
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
"""

if __name__ == "__main__":
    repo = "C:/Users/ryanm/goodsmash-vaults"
    p = os.path.join(repo, "_gasmeasure.cjs")
    io.open(p, "w", encoding="utf-8").write(SCRIPT)
    r = subprocess.run(
        ["C:/Program Files/nodejs/node.exe",
         os.path.join(repo, "node_modules/hardhat/internal/cli/bootstrap.js"),
         "run", "_gasmeasure.cjs"],
        cwd=repo, capture_output=True, text=True, timeout=900)
    os.remove(p)
    line = [l for l in r.stdout.splitlines() if l.startswith("GASJSON")]
    if not line:
        print("  no data:", (r.stdout or r.stderr)[-600:])
    else:
        data = json.loads(line[0][7:])
        print(f"  {'operation':28} {'estimate':>10} {'actual':>10} {'ratio':>7}")
        for d in data:
            flag = "" if 0.95 <= d["ratio"] <= 1.05 else "   <-- ESTIMATE OFFSET"
            print(f"  {d['op']:28} {d['estimate']:>10,} {d['actual']:>10,} {d['ratio']:>7.3f}{flag}")
        json.dump(data, io.open("C:/Users/ryanm/goodsmash-vaults/gas-measured.json", "w"), indent=1)
        print()
        print("  every ratio near 1.000 means the quote a caller gets is the cost they pay")
