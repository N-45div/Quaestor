import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, Wallet } from "lucide-react";
import type { Address, WalletClient } from "viem";
import { explorerHref } from "../../components/ExplorerShell";
import type { WalletOption } from "../../lib/wallet";
import { explorerAddress, explorerTx, short, show, sourceLabel, words, type EvmNetwork, type TradeRow } from "../../lib/evm/stocks";

export interface EvmCtx {
  net: EvmNetwork;
  wallets: WalletOption[];
  owner: { client: WalletClient; account: Address } | null;
  connect: (id: string) => Promise<void>;
}

export const Ctx = createContext<EvmCtx | null>(null);

export function useEvm(): EvmCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useEvm outside EvmPages");
  return c;
}

/** A hub read that refreshes on its own every `everyMs`, and says so when it fails. */
export function useHub<T>(read: () => Promise<T>, deps: unknown[], everyMs = 20_000): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const run = () => read().then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => live && setError((e as Error).message));
    run();
    const t = everyMs ? setInterval(run, everyMs) : undefined;
    return () => { live = false; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((x) => x + 1) };
}

export function AddressLink({ value, kind = "address" }: { value: string; kind?: "address" | "tx" }) {
  const { net } = useEvm();
  const href = kind === "tx" ? explorerTx(net, value) : explorerAddress(net, value);
  return <a className="mono-link" href={href} target="_blank" rel="noreferrer" title={value}>{short(value)}<ArrowUpRight size={12} /></a>;
}

export function OwnerWallet({ onError }: { onError: (m: string) => void }) {
  const { wallets, owner, connect } = useEvm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const go = (id: string) => {
    setOpen(false);
    setBusy(true);
    connect(id).catch((e) => onError((e as Error).message)).finally(() => setBusy(false));
  };
  if (owner) return <span className="wallet-connected"><Wallet size={15} />{short(owner.account)}</span>;
  if (!wallets.length) return <span className="wallet-none">No browser wallet found. Install one, or open this page in your wallet app&rsquo;s browser.</span>;
  if (wallets.length === 1) return <button className="btn btn-gold wallet-connect" disabled={busy} onClick={() => go(wallets[0].id)}><Wallet size={16} />{busy ? "Connecting…" : `Connect ${wallets[0].name}`}</button>;
  return (
    <div className="wallet-pick" ref={menu}>
      <button className="btn btn-gold wallet-connect" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Wallet size={16} />{busy ? "Connecting…" : "Connect a wallet"}<ChevronDown size={14} /></button>
      {open ? <div className="wallet-menu" role="menu">{wallets.map((w) => <button key={w.id} role="menuitem" onClick={() => go(w.id)}>{w.icon ? <img src={w.icon} alt="" width={18} height={18} /> : <Wallet size={16} />}{w.name}</button>)}</div> : null}
    </div>
  );
}

export function TradesTable({ rows, title = "Settled trades", limit, labelOf, source }: { rows: TradeRow[]; title?: string; limit?: number; labelOf?: (governor: string) => string; source?: string }) {
  const { net } = useEvm();
  const w = words(net);
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">ON-CHAIN ACTIVITY</span><h2>{title}</h2></div><span className="row-count">{rows.length} on chain · {sourceLabel(source)}</span></div>
      <div className="explorer-table-wrap">
        <table className="explorer-table activity-table">
          <thead><tr><th>Status</th><th>Agent</th><th>{w.Asset}</th><th>Spent</th><th>Received</th><th>Price a {w.unit}</th><th>Trade</th></tr></thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.tx}>
                <td><span className="status-inline"><i />Settled</span></td>
                <td><a className="table-primary" href={explorerHref(`/evm/${net.key}/agents/${t.governor}`)}>{labelOf?.(t.governor) ?? `Governor ${short(t.governor)}`}</a></td>
                <td>{t.stock}</td>
                <td className="numeric">{show(t.spent, 2)} {t.budget ?? net.budget.symbol}</td>
                <td className="numeric">{show(t.received, 6)}</td>
                <td className="numeric">{show(t.pricePerShare, 2)}</td>
                <td><a className="mono-link" href={explorerHref(`/evm/${net.key}/trades/${t.tx}`)} title="Open the trade and its reason, re-hashed">{short(t.tx)}</a></td>
              </tr>
            ))}
            {!shown.length && <tr><td className="table-empty" colSpan={7}>No trade has settled on these governors yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="muted-copy">{children}</p>;
}
