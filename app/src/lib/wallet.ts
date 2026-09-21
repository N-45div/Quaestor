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

/** An EIP-1193 provider: what every browser wallet hands a page. */
export interface Eip1193 {
  request: (args: { method: string; params?: unknown }) => Promise<any>;
}

/** A browser wallet the page can talk to, as it described itself. */
export interface WalletOption {
  /** The wallet's reverse-DNS id (io.metamask, com.okex.wallet), or "injected" for one found the old way. */
  id: string;
  name: string;
  /** A data: image the wallet supplies; nothing else is shown. */
  icon?: string;
  provider: Eip1193;
}

/** A name for a provider found the old way, from the flags wallets set on it. */
function legacyName(p: any): string {
  if (p?.isOkxWallet || p?.isOKExWallet) return "OKX Wallet";
  if (p?.isCoinbaseWallet) return "Coinbase Wallet";
  if (p?.isRabby) return "Rabby";
  if (p?.isPhantom) return "Phantom";
  if (p?.isMetaMask) return "MetaMask";
  return "Browser wallet";
}

/**
 * Every browser wallet installed, not only whichever one won the race to
 * window.ethereum. Under EIP-6963 each wallet answers a request event with its
 * name, icon and its own provider, so two extensions no longer overwrite each
 * other and the owner picks one. A wallet too old to announce itself is still
 * found through window.ethereum or window.okxwallet.
 */
export function watchWallets(onChange: (wallets: WalletOption[]) => void): () => void {
  const announced = new Map<string, WalletOption>();
  const publish = () => {
    const list = [...announced.values()];
    for (const legacy of [window.okxwallet, window.ethereum]) {
      if (!legacy?.request) continue;
      const name = legacyName(legacy);
      if (list.some((w) => w.provider === legacy || w.name === name)) continue;
      list.push({ id: legacy === window.okxwallet ? "injected-okx" : "injected", name, provider: legacy });
    }
    onChange(list);
  };
  const onAnnounce = (event: Event) => {
    const { info, provider } = (event as CustomEvent).detail ?? {};
    if (!info || !provider?.request) return;
    const id = String(info.rdns || info.uuid || info.name);
    announced.set(id, {
      id,
      name: String(info.name ?? "Wallet").slice(0, 40),
      icon: typeof info.icon === "string" && info.icon.startsWith("data:image/") ? info.icon : undefined,
      provider,
    });
    publish();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  publish();
  return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
}

/** The injected wallet's name, for the old single-wallet screens. */
export function providerName(): string {
  const p = window.okxwallet ?? window.ethereum;
  return p ? legacyName(p) : "wallet";
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
  cfg: AppConfig,
  wallet: WalletOption | undefined,
): Promise<{ client: WalletClient; account: Address }> {
  const provider = wallet?.provider;
  if (!provider) {
    throw new Error("No browser wallet found. Install one such as MetaMask, Coinbase Wallet, Rabby or OKX Wallet, or open this page in your wallet app's browser.");
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
                : cfg.label ?? cfg.network,
          nativeCurrency: { name: cfg.symbol ?? "Native", symbol: cfg.symbol ?? "ETH", decimals: 18 },
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls:
            cfg.chainId === 1952
              ? ["https://www.oklink.com/xlayer-test"]
              : cfg.chainId === 196
                ? ["https://www.oklink.com/xlayer"]
                : cfg.explorerTx
                  ? [new URL(cfg.explorerTx).origin]
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
