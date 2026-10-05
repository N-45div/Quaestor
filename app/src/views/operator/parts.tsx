import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, Wallet } from "lucide-react";
import { short } from "../../lib/evm/stocks";
import type { OpNetworkRow } from "../../lib/operator";
import { useOp } from "./OperatorPages";

/** Connect a browser wallet on this network; once connected, its address. */
export function ConnectWallet({ network, onError, label = "Connect a wallet" }: { network: OpNetworkRow; onError: (m: string) => void; label?: string }) {
  const { wallets, wallet, connect } = useOp();
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
    connect(id, network).catch((e) => onError((e as Error).message)).finally(() => setBusy(false));
  };
  if (wallet && wallet.network === network.key) return <span className="wallet-connected"><Wallet size={15} />{short(wallet.account)}</span>;
  if (!wallets.length) return <span className="wallet-none">No browser wallet found. Install one, or open this page in your wallet app&rsquo;s browser.</span>;
  if (wallets.length === 1) return <button className="btn btn-gold wallet-connect" disabled={busy} onClick={() => go(wallets[0].id)}><Wallet size={16} />{busy ? "Connecting…" : `${label === "Connect a wallet" ? `Connect ${wallets[0].name}` : label}`}</button>;
  return (
    <div className="wallet-pick" ref={menu}>
      <button className="btn btn-gold wallet-connect" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Wallet size={16} />{busy ? "Connecting…" : label}<ChevronDown size={14} /></button>
      {open ? <div className="wallet-menu" role="menu">{wallets.map((w) => <button key={w.id} role="menuitem" onClick={() => go(w.id)}>{w.icon ? <img src={w.icon} alt="" width={18} height={18} /> : <Wallet size={16} />}{w.name}</button>)}</div> : null}
    </div>
  );
}

export function TxLink({ href, value }: { href: string | null; value: string }) {
  if (!href) return <span className="mono">{short(value)}</span>;
  return <a className="mono-link" href={href} target="_blank" rel="noreferrer" title={value}>{short(value)}<ArrowUpRight size={12} /></a>;
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="op-ext" href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={12} /></a>;
}

const STATUS_TONE: Record<string, string> = {
  new: "wait", offered: "gold", accepted: "ok", escalated: "warn", waitlisted: "wait", rejected: "off", declined: "off",
  open: "ok", pending_owner: "warn", closed: "ok", cancelled: "off", expired: "off",
  paid: "ok", needs_owner: "warn",
};

const STATUS_WORD: Record<string, string> = {
  new: "Waiting to be read", offered: "Offer made", accepted: "Accepted", escalated: "With the owner", waitlisted: "Waitlisted", rejected: "Turned down", declined: "Declined",
  open: "Escrowed", pending_owner: "Awaiting the owner", closed: "Paid in full", cancelled: "Cancelled", expired: "Lapsed",
  paid: "Paid", needs_owner: "With the owner",
};

export function Status({ value }: { value: string }) {
  return <span className={`op-status ${STATUS_TONE[value] ?? "wait"}`}><i />{STATUS_WORD[value] ?? value}</span>;
}

export const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
