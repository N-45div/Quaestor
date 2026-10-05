/**
 * The chains a project's outreach budget can live on. Arc first: USDC is its gas and its money,
 * and CCTP from Arc pays a payee on the chain they choose.
 */
export interface OpNetwork {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  usdc: string;
  /** The QuaestorPayouts factory; null where it is not deployed yet. */
  factory: string | null;
  tokenMessenger: string | null;
  /** Circle's attestation API for this chain's environment, for cross-chain fee quotes. */
  iris: string;
  explorer: string;
  testnet: boolean;
  /** The chain's name in Circle's Wallets API, for an operator key held by Circle. */
  circleChain: string;
}

export const OP_NETWORKS: Record<string, OpNetwork> = {
  "arc-testnet": {
    key: "arc-testnet",
    name: "Arc testnet",
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    usdc: "0x3600000000000000000000000000000000000000",
    factory: "0xA8371e91c0c434920AF06adcF03967679Dd971e1",
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    iris: "https://iris-api-sandbox.circle.com",
    explorer: "https://explorer.testnet.arc.io",
    testnet: true,
    circleChain: "ARC-TESTNET",
  },
};

export const explorerTx = (n: OpNetwork, tx: string) => `${n.explorer}/tx/${tx}`;
export const explorerAddress = (n: OpNetwork, a: string) => `${n.explorer}/address/${a}`;
