import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 800 },
      viaIR: true,
    },
  },
  networks: {
    // X Layer testnet — chain id 195, gas token OKB (faucet: web3.okx.com/xlayer/faucet)
    xlayerTestnet: {
      url: process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech",
      chainId: 195,
      accounts,
    },
    // X Layer mainnet — chain id 196
    xlayer: {
      url: process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech",
      chainId: 196,
      accounts,
    },
  },
};

export default config;
