/**
 * The chains a project's outreach budget can live on. Arc first: USDC is its gas and its money,
 * and CCTP from Arc pays a payee on the chain they choose. On Mezo the budget is MUSD, borrowed
 * against BTC, and the gas is BTC. The Operator keeps every amount in
 * dollars to six places; a network's budget token may use more (MUSD on Mezo uses 18), and the
 * chain client converts at the contract's edge.
 */
export interface OpNetwork {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  /** The budget token (USDC on Arc, MUSD on Mezo). The name is historical. */
  usdc: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** The chain's gas, and how much of it a new budget hands the operator's key. */
  gasSymbol: string;
  gasGrant: string;
  /** The QuaestorPayouts factory; null where it is not deployed yet. */
  factory: string | null;
  tokenMessenger: string | null;
  /** Circle's attestation API for this chain's environment, for cross-chain fee quotes. */
  iris: string;
  explorer: string;
  /** The explorer's Blockscout API (…/api/v2), asked whether a transaction landed when the RPC's receipts lag. */
  explorerApi?: string;
  testnet: boolean;
  /** The chain's name in Circle's Wallets API, for an operator key held by Circle. */
  circleChain: string;
  /**
   * Where the budget token is not a dollar: how to price it. The Operator still agrees every amount in dollars, and
   * a deal escrows the token at this price when it opens (operator/price.ts). Absent, one token is one dollar.
   */
  price?: UniswapV4EthPrice;
}

/** A token priced by its Uniswap v4 pool against ETH, and ETH by a Chainlink feed. */
export interface UniswapV4EthPrice {
  kind: "uniswap-v4-eth";
  poolManager: string;
  poolId: string;
  /** True when the token is the pool's currency1 (native ETH, address zero, always sorts first). */
  tokenIsCurrency1: boolean;
  /** Chainlink's ETH / USD on this chain. */
  ethUsdFeed: string;
  /** In words, for a decision record and the app. */
  source: string;
}

export const OP_NETWORKS: Record<string, OpNetwork> = {
  "arc-testnet": {
    key: "arc-testnet",
    name: "Arc testnet",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    gasSymbol: "USDC",
    gasGrant: "0.5",
    factory: "0xA8371e91c0c434920AF06adcF03967679Dd971e1",
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    iris: "https://iris-api-sandbox.circle.com",
    explorer: "https://explorer.testnet.arc.io",
    testnet: true,
    circleChain: "ARC-TESTNET",
  },
  // Mezo: the budget is MUSD, the stablecoin a holder borrows against their BTC without selling it,
  // and the gas is BTC. No CCTP here, so a payee is paid on Mezo.
  "mezo-testnet": {
    key: "mezo-testnet",
    name: "Mezo testnet",
    chainId: 31611,
    rpcUrl: "https://rpc.test.mezo.org",
    usdc: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
    tokenSymbol: "MUSD",
    tokenDecimals: 18,
    gasSymbol: "BTC",
    gasGrant: "0.0005",
    factory: "0xC609f4c276DD36C96bCAf96a8E6e62914359a849",
    tokenMessenger: null,
    iris: "",
    explorer: "https://explorer.test.mezo.org",
    // Mezo's public RPC can answer "no receipt" for minutes after a transaction is mined; its explorer does not.
    explorerApi: "https://api.explorer.test.mezo.org/api/v2",
    testnet: true,
    circleChain: "",
  },
  // Robinhood Chain mainnet: the budget is WIF and the gas is ETH. The payouts factory here burns a share of every
  // payout through WIF's own burn(). WIF is not a dollar, so it is priced by its Uniswap v4 pool against ETH and
  // Chainlink's ETH / USD, and a deal escrows WIF at that price when it opens. No CCTP: a payee is paid here.
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    usdc: "0x5173b8ea6923c2d40267890d45c46a3480954773",
    tokenSymbol: "WIF",
    tokenDecimals: 18,
    gasSymbol: "ETH",
    gasGrant: "0.0002",
    factory: null,
    tokenMessenger: null,
    iris: "",
    explorer: "https://robinhoodchain.blockscout.com",
    testnet: false,
    circleChain: "",
    price: {
      kind: "uniswap-v4-eth",
      poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      poolId: "0xde72ea1422623e6b2ec5c09a8170c9f0d53fd31aacb6d341fc08dc714aba5076",
      tokenIsCurrency1: true,
      ethUsdFeed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
      source: "WIF's Uniswap v4 pool against ETH, and Chainlink's ETH / USD on Robinhood Chain",
    },
  },
};

export const explorerTx = (n: OpNetwork, tx: string) => `${n.explorer}/tx/${tx}`;
export const explorerAddress = (n: OpNetwork, a: string) => `${n.explorer}/address/${a}`;
