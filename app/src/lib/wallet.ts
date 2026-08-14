import {
  createPublicClient,
  createWalletClient,
  custom,
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

export function makePublicClient(cfg: AppConfig): PublicClient {
  return createPublicClient({ transport: http(cfg.rpcUrl) });
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
            cfg.chainId === 195
              ? "X Layer Testnet"
              : cfg.chainId === 196
                ? "X Layer"
                : cfg.network,
          nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls:
            cfg.chainId === 195
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
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  }) as const;
