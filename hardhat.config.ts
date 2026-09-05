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
    // X Layer testnet — chain id 1952 (0x7a0, verified via eth_chainId),
    // gas token OKB (faucet: web3.okx.com/xlayer/faucet)
    xlayerTestnet: {
      url: process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech",
      chainId: 1952,
      accounts,
    },
    // X Layer mainnet — chain id 196
    xlayer: {
      url: process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech",
      chainId: 196,
      accounts,
    },
    // Hedera testnet — chain id 296 (0x128), reached over the Hashio JSON-RPC
    // relay. Gas token HBAR (portal.hedera.com hands out testnet HBAR). HBAR
    // has 8 decimals natively while the EVM sees 18-decimal weibar, so any
    // native amount must be a multiple of 10^10 wei to be representable.
    hederaTestnet: {
      url: process.env.HEDERA_TESTNET_RPC ?? "https://testnet.hashio.io/api",
      chainId: 296,
      accounts: process.env.HEDERA_PRIVATE_KEY
        ? [process.env.HEDERA_PRIVATE_KEY]
        : accounts,
    },
  },
};

export default config;
