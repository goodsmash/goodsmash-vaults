require("@nomicfoundation/hardhat-toolbox");

// These contracts are small enough to compile without viaIR or a raised optimizer budget,
// so the config stays at the defaults and anyone can reproduce the bytecode exactly.
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    // Robinhood Chain testnet. Set RPC + DEPLOYER_PRIVATE_KEY in your environment; the
    // deploy script refuses to run against any other chain id.
    robinhoodTestnet: {
      url: process.env.RH_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  mocha: { timeout: 180000 },
};
