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
    // The in-process chain, optionally forked from Base mainnet so a test can
    // trade against the real Uniswap rather than a mock of it.
    ...(process.env.FORK_BASE
      ? { hardhat: { forking: { url: process.env.BASE_RPC ?? "https://mainnet.base.org" }, chainId: 8453 } }
      : {}),
    // Or from Robinhood Chain mainnet (chain id 4663), so a test can buy real
    // Stock Tokens with real USDG through the real Uniswap, priced by Chainlink.
    ...(process.env.FORK_ROBINHOOD
      ? {
          hardhat: {
            forking: { url: process.env.ROBINHOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com" },
            chainId: 4663,
            chains: { 4663: { hardforkHistory: { cancun: 0 } } },
          },
        }
      : {}),
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
    // Monad testnet — chain id 10143 (0x279f, verified via eth_chainId). Gas
    // token MON (faucet.monad.xyz). Monad charges the gas LIMIT, not the gas
    // used, so scripts here keep limits close to their estimates.
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts,
    },
    // Robinhood Chain testnet — chain id 46630 (0xb626). Gas token ETH from
    // faucet.testnet.chain.robinhood.com, which also hands out test Stock Tokens.
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts,
    },
    arcTestnet: {
      url: process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts: process.env.ARC_PRIVATE_KEY ? [process.env.ARC_PRIVATE_KEY] : accounts,
    },
    // Ethereum Sepolia — the source chain the Attestcoin prover attests
    // (chain key 1 on Creditcoin CC3 testnet).
    sepolia: {
      url: process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts,
    },
    // Base Sepolia — indexed by The Graph.
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    // Creditcoin CC3 testnet — where the budget root lives. Gas in tCTC.
    creditcoinTestnet: {
      url: process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network",
      chainId: 102031,
      accounts: process.env.CREDITCOIN_PRIVATE_KEY ? [process.env.CREDITCOIN_PRIVATE_KEY] : accounts,
    },
    // Arc mainnet. Chain id 5042 is from Circle's own docs (docs.arc.io) and was
    // confirmed against rpc.mainnet.arc.io on 21 Sep 2026; aggregator sites also
    // list 1243, which is wrong. Still overridable, never guessed: ethers refuses
    // to send when the configured id and the node's disagree.
    arc: {
      url: process.env.ARC_RPC ?? "https://rpc.mainnet.arc.io",
      chainId: Number(process.env.ARC_CHAIN_ID ?? 5042),
      accounts: process.env.ARC_PRIVATE_KEY ? [process.env.ARC_PRIVATE_KEY] : accounts,
    },
    // Base mainnet. Gas is ETH, so caps here are in ETH, not dollars: the same
    // contract, a different unit. MAINNET_PRIVATE_KEY lets a deployment use a key
    // that has never been near a testnet faucet or a hosted service.
    base: {
      url: process.env.BASE_RPC ?? "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : accounts,
    },
  },
  // Robinhood Chain's explorers are Blockscout, which takes Etherscan-style
  // verification with any API key.
  etherscan: {
    apiKey: { robinhoodTestnet: "blockscout", robinhood: "blockscout" },
    customChains: [
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: { apiURL: "https://explorer.testnet.chain.robinhood.com/api", browserURL: "https://explorer.testnet.chain.robinhood.com" },
      },
      {
        network: "robinhood",
        chainId: 4663,
        urls: { apiURL: "https://robinhoodchain.blockscout.com/api", browserURL: "https://robinhoodchain.blockscout.com" },
      },
    ],
  },
  // Source verification on Sourcify, which covers Monad and Robinhood Chain
  // (mainnets and testnets); no API key needed.
  // SOURCIFY_API_URL picks the instance: Monad's explorers read
  // https://sourcify-api-monad.blockvision.org; the public one is sourcify.dev.
  sourcify: {
    enabled: true,
    apiUrl: process.env.SOURCIFY_API_URL ?? "https://sourcify.dev/server",
    browserUrl: process.env.SOURCIFY_BROWSER_URL ?? "https://repo.sourcify.dev",
  },
};

export default config;
