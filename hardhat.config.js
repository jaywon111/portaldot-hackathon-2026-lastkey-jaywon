require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const PORTALDOT_TESTNET_RPC = process.env.PORTALDOT_RPC || "https://test-evm-rpc-v3.portaldot.dev";
const DEPLOYER_KEY = process.env.PRIVATE_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { 
      optimizer: { enabled: true, runs: 200 }, 
      viaIR: true,
      metadata: {
        bytecodeHash: "none"
      }
    },
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    hardhat: { chainId: 31338 },
    portaldotTestnet: {
      url: PORTALDOT_TESTNET_RPC,
      chainId: 420420777,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
};
