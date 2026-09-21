import { getWallets } from "@wallet-standard/app";
import type { Transaction } from "@solana/web3.js";

/**
 * Solana wallets, found the way every current one announces itself: the
 * Wallet Standard. Phantom, Solflare, Backpack and the rest register with the
 * page; the ones that can connect and sign a transaction are offered, and the
 * owner picks. Nothing here holds a key: the wallet signs, and the page sends.
 */

type Feature<T> = T | undefined;
interface WalletAccountLike {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
}
interface WalletLike {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccountLike[];
  features: Record<string, unknown>;
}
interface ConnectFeature {
  connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccountLike[] }>;
}
interface SignTransactionFeature {
  signTransaction: (
    ...inputs: { transaction: Uint8Array; account: WalletAccountLike; chain?: string }[]
  ) => Promise<readonly { signedTransaction: Uint8Array }[]>;
}

export interface SolanaWallet {
  name: string;
  /** A data: image the wallet supplies; nothing else is shown. */
  icon?: string;
  wallet: WalletLike;
}

export interface SolanaAccount {
  wallet: SolanaWallet;
  account: WalletAccountLike;
  address: string;
}

const CHAIN = "solana:devnet";

function canSign(w: WalletLike): boolean {
  return (
    w.chains.some((c) => c.startsWith("solana:")) &&
    Boolean((w.features["standard:connect"] as Feature<ConnectFeature>)?.connect) &&
    Boolean((w.features["solana:signTransaction"] as Feature<SignTransactionFeature>)?.signTransaction)
  );
}

/** Every Solana wallet in the browser that can sign, now and as more register. */
export function watchSolanaWallets(onChange: (wallets: SolanaWallet[]) => void): () => void {
  const { get, on } = getWallets();
  const publish = () =>
    onChange(
      (get() as unknown as WalletLike[]).filter(canSign).map((wallet) => ({
        name: wallet.name,
        icon: typeof wallet.icon === "string" && wallet.icon.startsWith("data:image/") ? wallet.icon : undefined,
        wallet,
      })),
    );
  publish();
  const offRegister = on("register", publish);
  const offUnregister = on("unregister", publish);
  return () => {
    offRegister();
    offUnregister();
  };
}

export async function connectSolana(choice: SolanaWallet): Promise<SolanaAccount> {
  const connect = choice.wallet.features["standard:connect"] as ConnectFeature;
  const { accounts } = await connect.connect();
  const account = accounts.find((a) => a.chains.length === 0 || a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error(`${choice.name} returned no account.`);
  return { wallet: choice, account, address: account.address };
}

/**
 * Have the wallet sign a transaction the page built. It is handed over with
 * any signatures already on it (a new vault account signs its own creation),
 * and the wallet adds the owner's.
 */
export async function signWithWallet(connected: SolanaAccount, transaction: Transaction): Promise<Uint8Array> {
  const feature = connected.wallet.wallet.features["solana:signTransaction"] as SignTransactionFeature;
  const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  const [result] = await feature.signTransaction({ transaction: bytes, account: connected.account, chain: CHAIN });
  if (!result?.signedTransaction) throw new Error(`${connected.wallet.name} did not return a signed transaction.`);
  return result.signedTransaction;
}
