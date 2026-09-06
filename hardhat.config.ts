import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const settings = {
  optimizer: { enabled: true, runs: 800 },
  viaIR: true,
};

const config: HardhatUserConfig = {
  solidity: {
    // The August contracts stay on 0.8.24 so their artifacts match what is
    // deployed. The Attestcoin base contracts (@gluwa/asc-contracts) require
    // ^0.8.28, so contracts/attested/* compile with that.
    compilers: [
      { version: "0.8.24", settings },
      { version: "0.8.28", settings },
    ],
    overrides: {
      "contracts/Quaestor.sol": { version: "0.8.24", settings },
      "contracts/QuaestorDEX.sol": { version: "0.8.24", settings },
      "contracts/TestToken.sol": { version: "0.8.24", settings },
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
    // Hedera mainnet — chain id 295 (0x127), same relay family. Real HBAR:
    // contract creation is USD-priced (roughly a dollar per contract), and the
    // same 10^10-wei granularity rule applies.
    hederaMainnet: {
      url: process.env.HEDERA_MAINNET_RPC ?? "https://mainnet.hashio.io/api",
      chainId: 295,
      accounts: process.env.HEDERA_MAINNET_PRIVATE_KEY
        ? [process.env.HEDERA_MAINNET_PRIVATE_KEY]
        : process.env.HEDERA_PRIVATE_KEY
          ? [process.env.HEDERA_PRIVATE_KEY]
          : accounts,
    },
    // Arc testnet — Circle's L1, chain id 5042002 (0x4cef52). USDC is the gas
    // token (18-decimal native view), so the governor's native-denominated
    // caps are dollar caps here with no contract change. Faucet:
    // https://faucet.circle.com (20 USDC per address every 2 hours).
    arcTestnet: {
      url: process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts: process.env.ARC_PRIVATE_KEY ? [process.env.ARC_PRIVATE_KEY] : accounts,
    },
    // Arc mainnet — chain id and RPC are published at launch (16 Sep 2026);
    // set ARC_RPC and ARC_CHAIN_ID then, nothing else changes.
    ...(process.env.ARC_RPC && process.env.ARC_CHAIN_ID
      ? {
          arc: {
            url: process.env.ARC_RPC,
            chainId: Number(process.env.ARC_CHAIN_ID),
            accounts: process.env.ARC_PRIVATE_KEY ? [process.env.ARC_PRIVATE_KEY] : accounts,
          },
        }
      : {}),
  },
};

export default config;
