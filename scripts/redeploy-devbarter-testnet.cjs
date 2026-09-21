/* Redeploy DevBarter to Robinhood Chain testnet (46630) with the full never-revert isExecutable.
   Probes the OLD deployment, deploys the current artifact, probes the NEW one, saves a record. */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const RPC = process.env.RH_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const KEYFILE = "C:/Users/ryanm/goodsmash-ops/TESTNET-DEPLOYER-fresh.json";
const OLD = "0x7D980EDe6839AD219c4b8DD9deE74DAEcA42A01B";
function cases(signer, now) {
  const A1 = "0x1111111111111111111111111111111111111111";
  const A2 = "0x2222222222222222222222222222222222222222";
  const A3 = "0x3333333333333333333333333333333333333333";
  return [
    ["expired", { maker: signer, makerCollections: [A1], makerTokenIds: [1n], taker: A2, takerCollections: [A3], takerTokenIds: [2n], expiry: now - 10n, nonce: 1n }],
    ["same account", { maker: signer, makerCollections: [], makerTokenIds: [], taker: signer, takerCollections: [], takerTokenIds: [], expiry: now + 3600n, nonce: 2n }],
    ["bad side length", { maker: signer, makerCollections: [], makerTokenIds: [], taker: A2, takerCollections: [], takerTokenIds: [], expiry: now + 3600n, nonce: 3n }],
    ["not a contract", { maker: signer, makerCollections: [A1], makerTokenIds: [1n], taker: A2, takerCollections: [A3], takerTokenIds: [2n], expiry: now + 3600n, nonce: 4n }],
    ["beyond max window", { maker: signer, makerCollections: [A1], makerTokenIds: [1n], taker: A2, takerCollections: [A3], takerTokenIds: [2n], expiry: now + 7776001n, nonce: 5n }],
  ];
}
async function probe(label, addr, abi, provider, cs) {
  const c = new ethers.Contract(addr, abi, provider);
  console.log("--- " + label + " " + addr);
  for (const [name, t] of cs) {
    try {
      const r = await c.isExecutable(t);
      console.log("  " + name.padEnd(18) + " -> (" + r[0] + ", " + JSON.stringify(r[1]) + ")");
    } catch (e) {
      console.log("  " + name.padEnd(18) + " -> REVERTED: " + String(e.shortMessage || e.message || e).slice(0, 100));
    }
  }
}
async function main() {
  const kf = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== 46630) throw new Error("REFUSING: chain " + net.chainId);
  const wallet = new ethers.Wallet(kf.privateKey, provider);
  console.log("deployer:", wallet.address, "| balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "tETH");
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "DevBarter.sol", "DevBarter.json"), "utf8"));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const cs = cases(wallet.address, now);
  await probe("OLD deployed", OLD, artifact.abi, provider, cs);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const c = await factory.deploy();
  const tx = c.deploymentTransaction();
  console.log("deploy tx:", tx.hash);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  const rc = await provider.getTransactionReceipt(tx.hash);
  console.log("NEW DevBarter:", addr, "| gas:", rc.gasUsed.toString());
  await probe("NEW deployed", addr, artifact.abi, provider, cs);
  const out = { at: new Date().toISOString(), chainId: 46630, address: addr, deployer: wallet.address, tx: tx.hash, supersedes: OLD };
  fs.writeFileSync(path.join(__dirname, "..", "testnet-devbarter-v2.json"), JSON.stringify(out, null, 2));
  console.log("saved testnet-devbarter-v2.json");
}
main().catch((e) => { console.error(e); process.exit(1); });