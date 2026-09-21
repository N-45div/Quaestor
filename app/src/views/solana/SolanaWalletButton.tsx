import { ChevronDown, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shortKey } from "../../lib/solana/chain";
import { useSolana } from "../../lib/solana/store";

/**
 * Connect whichever Solana wallet the owner uses: one installed, a button with
 * its name; several, a menu of them; none, what to do instead.
 */
export function SolanaWalletButton({ onError }: { onError: (message: string) => void }) {
  const { wallets, account, connect, disconnect } = useSolana();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const go = (name: string) => {
    setOpen(false);
    setBusy(true);
    connect(name).catch((e) => onError((e as Error).message)).finally(() => setBusy(false));
  };

  if (account) {
    return <span className="wallet-connected"><span className="state-badge live">{account.wallet.name} {shortKey(account.address)}</span><button className="btn btn-ghost btn-sm" onClick={disconnect}>Disconnect</button></span>;
  }
  if (!wallets.length) {
    return <span className="wallet-none">No Solana wallet found. Install one such as Phantom, Solflare or Backpack, or open this page in your wallet app&rsquo;s browser.</span>;
  }
  const icon = (w: (typeof wallets)[number]) => (w.icon ? <img src={w.icon} alt="" width={18} height={18} /> : <Wallet size={16} />);
  if (wallets.length === 1) {
    return <button className="btn btn-gold wallet-connect" disabled={busy} onClick={() => go(wallets[0].name)}>{icon(wallets[0])}{busy ? "Connecting…" : `Connect ${wallets[0].name}`}</button>;
  }
  return (
    <div className="wallet-pick" ref={menu}>
      <button className="btn btn-gold wallet-connect" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Wallet size={16} />{busy ? "Connecting…" : "Connect a Solana wallet"}<ChevronDown size={14} />
      </button>
      {open ? <div className="wallet-menu" role="menu">{wallets.map((w) => <button key={w.name} role="menuitem" onClick={() => go(w.name)}>{icon(w)}{w.name}</button>)}</div> : null}
    </div>
  );
}
