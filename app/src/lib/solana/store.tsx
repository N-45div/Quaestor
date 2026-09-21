import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Connection, PublicKey, type Signer, type Transaction } from "@solana/web3.js";
import { DEVNET } from "./devnet";
import { readGovernors, readTrades, type GovernorView, type TradeView } from "./chain";
import { connectSolana, signWithWallet, watchSolanaWallets, type SolanaAccount, type SolanaWallet } from "./wallets";

/**
 * The Solana side's state: every governor and every settled trade on devnet,
 * re-read every 20 seconds, and the owner's wallet when one is connected. It
 * is separate from the EVM store, which knows nothing about Solana.
 */
interface SolanaStore {
  conn: Connection;
  governors: GovernorView[];
  trades: TradeView[];
  ready: boolean;
  error: string | null;
  checkedAt: number | null;
  refresh: () => Promise<void>;
  wallets: SolanaWallet[];
  account: SolanaAccount | null;
  connect: (name: string) => Promise<void>;
  disconnect: () => void;
  /** Sign with the connected wallet (after any extra signers) and send; resolves with the signature once confirmed. */
  send: (transaction: Transaction, extraSigners?: Signer[]) => Promise<string>;
}

const Ctx = createContext<SolanaStore | null>(null);
const POLL_MS = 20_000;

export function useSolana(): SolanaStore {
  const store = useContext(Ctx);
  if (!store) throw new Error("useSolana outside SolanaStoreProvider");
  return store;
}

export function SolanaStoreProvider({ children }: { children: ReactNode }) {
  const conn = useMemo(() => new Connection(DEVNET.rpcUrl, "confirmed"), []);
  const [governors, setGovernors] = useState<GovernorView[]>([]);
  const [trades, setTrades] = useState<TradeView[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [wallets, setWallets] = useState<SolanaWallet[]>([]);
  const [account, setAccount] = useState<SolanaAccount | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [g, t] = await Promise.all([readGovernors(conn), readTrades(conn)]);
      setGovernors(g);
      setTrades(t);
      setReady(true);
      setError(null);
      setCheckedAt(Date.now());
    } catch (e) {
      setError(`Devnet did not answer: ${((e as Error).message ?? String(e)).slice(0, 140)}`);
    }
  }, [conn]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => watchSolanaWallets(setWallets), []);

  const connect = useCallback(async (name: string) => {
    const choice = wallets.find((w) => w.name === name);
    if (!choice) throw new Error(`${name} is not available.`);
    setAccount(await connectSolana(choice));
  }, [wallets]);

  const send = useCallback(async (transaction: Transaction, extraSigners: Signer[] = []) => {
    if (!account) throw new Error("Connect a Solana wallet first.");
    const latest = await conn.getLatestBlockhash("confirmed");
    transaction.feePayer = new PublicKey(account.address);
    transaction.recentBlockhash = latest.blockhash;
    if (extraSigners.length) transaction.partialSign(...extraSigners);
    const signed = await signWithWallet(account, transaction);
    const signature = await conn.sendRawTransaction(signed, { skipPreflight: false, preflightCommitment: "confirmed" });
    const result = await conn.confirmTransaction({ signature, ...latest }, "confirmed");
    if (result.value.err) throw new Error(`The transaction failed on chain (${signature}): ${JSON.stringify(result.value.err)}`);
    void refresh();
    return signature;
  }, [account, conn, refresh]);

  const value = useMemo<SolanaStore>(() => ({
    conn, governors, trades, ready, error, checkedAt, refresh, wallets, account, connect,
    disconnect: () => setAccount(null), send,
  }), [conn, governors, trades, ready, error, checkedAt, refresh, wallets, account, connect, send]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
