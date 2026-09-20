/**
 * Deploy the vault stack to Robinhood Chain testnet (46630).
 *
 * Configuration comes from the ENVIRONMENT, never from a file in this repo. That is both the
 * correct open-source pattern and the safe one: a deploy script that reads a local key file
 * tells every reader where keys live on someone's machine.
 *
 * Required:
 *   DEPLOYER_PRIVATE_KEY   the key that will pay for the deploys
 *
 * Optional:
 *   RH_TESTNET_RPC_URL     defaults to the public Robinhood Chain testnet RPC
 *
 * Fail-closed by design: the live chain id is asserted BEFORE anything else, so this script
 * cannot be pointed at a different network by accident. It estimates real gas, and if the
 * signer cannot afford the deploy it reports the shortfall and exits without broadcasting a
 * partial sequence.
 *
 * The contracts have no constructor arguments and no owner, so the address IS the
 * deployment - there is nothing to configure afterwards.
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const EXPECTED_CHAIN_ID = 46630;
const RPC = process.env.RH_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";

const CONTRACTS = ["CommitmentVault", "TokenLocker", "DevBarter"];

function artifact(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", name + ".sol", name + ".json");
  if (!fs.existsSync(p)) {
    console.error("missing artifact for " + name + " - run `npx hardhat compile` first");
    process.exit(4);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

(async () => {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) {
    console.error("DEPLOYER_PRIVATE_KEY is not set.");
    console.error("Export it in your shell, or put it in a .env you do NOT commit.");
    process.exit(3);
  }

  const provider = new ethers.JsonRpcProvider(RPC);

  // ---- fail closed: prove the network before doing anything else
  const chainId = Number((await provider.getNetwork()).chainId);
  console.log("chain id :", chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error("REFUSING: expected chain " + EXPECTED_CHAIN_ID + ", got " + chainId);
    process.exit(2);
  }

  const wallet = new ethers.Wallet(pk, provider);
  const bal = await provider.getBalance(wallet.address);
  const fee = await provider.getFeeData();
  const gasPrice = fee.maxFeePerGas || fee.gasPrice || 10n ** 9n;

  console.log("deployer :", wallet.address);
  console.log("balance  :", ethers.formatEther(bal), "ETH");

  // ---- estimate the whole sequence before sending any of it
  let totalGas = 0n;
  const prepared = [];
  for (const name of CONTRACTS) {
    const a = artifact(name);
    const f = new ethers.ContractFactory(a.abi, a.bytecode);
    const tx = await f.getDeployTransaction();
    const est = await provider.estimateGas({ ...tx, from: wallet.address }).catch(() => 2000000n);
    totalGas += est;
    prepared.push({ name, a, est });
  }

  const cost = totalGas * gasPrice;
  console.log("total gas:", totalGas.toString(), "| ~cost:", ethers.formatEther(cost), "ETH");

  if (bal < cost + cost / 10n) {
    console.log("");
    console.log("NOT DEPLOYING - not enough gas for the whole stack.");
    console.log("shortfall:", ethers.formatEther(cost + cost / 10n - bal), "ETH");
    console.log("Nothing was broadcast. Fund the deployer and run this again.");
    process.exit(0);
  }

  // ---- deploy, reading each one back from the chain
  const deployed = {};
  for (const { name, a } of prepared) {
    const f = new ethers.ContractFactory(a.abi, a.bytecode, wallet);
    const c = await f.deploy();
    console.log(name + " broadcast:", c.deploymentTransaction().hash);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    const code = await provider.getCode(addr);
    deployed[name] = addr;
    console.log("  " + name + " -> " + addr + "  (" + ((code.length - 2) / 2) + " bytes on chain)");
  }

  const out = {
    network: "robinhoodTestnet",
    chainId: EXPECTED_CHAIN_ID,
    deployedAt: new Date().toISOString(),
    contracts: deployed,
    note: "No owner, no pause, no upgrade path, no fee - in any of these. Nothing to configure after deploy.",
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployed-testnet.json"), JSON.stringify(out, null, 1));
  console.log("");
  console.log("recorded: deployed-testnet.json");
})().catch((e) => {
  console.error("FAILED:", e.shortMessage || e.message);
  process.exit(1);
});
