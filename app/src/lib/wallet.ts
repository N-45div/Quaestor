import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { AppConfig } from "./config";

declare global {
  interface Window {
    okxwallet?: any;
    ethereum?: any;
  }
}

/** Prefer OKX Wallet, fall back to any injected provider. */
export function injectedProvider(): any | null {
  return window.okxwallet ?? window.ethereum ?? null;
}

export function providerName(): string {
  if (window.okxwallet) return "OKX Wallet";
  if (window.ethereum?.isMetaMask) return "MetaMask";
  return "wallet";
}

/**
 * The canonical Multicall3, at the same address on every chain we deploy to
 * (verified on X Layer, Arc, Base Sepolia and Sepolia). With it declared, viem
 * folds every `readContract` issued in the same tick into ONE eth_call — the
 * explorer reads ~10 values per agent, and X Layer's public RPC allows six
 * requests a second. Without batching, page load fires 80 calls at once and
 * the rejected ones surface in the console as CORS errors.
 */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export function makePublicClient(cfg: AppConfig): PublicClient {
  const symbol = cfg.symbol ?? "ETH";
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.label ?? cfg.network,
    nativeCurrency: { name: symbol, symbol, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  return createPublicClient({
    chain,
    transport: http(cfg.rpcUrl, { batch: true }),
    batch: { multicall: { wait: 16 } },
  }) as PublicClient;
}

export async function connectWallet(
  cfg: AppConfig
): Promise<{ client: WalletClient; account: Address }> {
  const provider = injectedProvider();
  if (!provider) {
    throw new Error("No wallet found — install OKX Wallet to continue.");
  }

  const accounts: string[] = await provider.request({
    method: "eth_requestAccounts",
  });
  if (!accounts.length) throw new Error("Wallet returned no accounts.");

  await ensureChain(provider, cfg);

  const client = createWalletClient({ transport: custom(provider) });
  return { client, account: accounts[0] as Address };
}

async function ensureChain(provider: any, cfg: AppConfig) {
  const hexId = `0x${cfg.chainId.toString(16)}`;
  const current: string = await provider.request({ method: "eth_chainId" });
  if (parseInt(current, 16) === cfg.chainId) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (err: any) {
    if (err?.code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexId,
          chainName:
            cfg.chainId === 1952
              ? "X Layer Testnet"
              : cfg.chainId === 196
                ? "X Layer"
                : cfg.network,
          nativeCurrency: { name: cfg.symbol ?? "Native", symbol: cfg.symbol ?? "ETH", decimals: 18 },
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls:
            cfg.chainId === 1952
              ? ["https://www.oklink.com/xlayer-test"]
              : cfg.chainId === 196
                ? ["https://www.oklink.com/xlayer"]
                : [],
        },
      ],
    });
  }
}

export const viemChainOf = (cfg: AppConfig) =>
  ({
    id: cfg.chainId,
    name: cfg.network,
    nativeCurrency: { name: cfg.symbol ?? "Native", symbol: cfg.symbol ?? "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  }) as const;
