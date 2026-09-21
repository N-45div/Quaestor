import { ChevronDown, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state";
import type { WalletOption } from "../lib/wallet";

function WalletIcon({ wallet }: { wallet: WalletOption }) {
  return wallet.icon ? <img src={wallet.icon} alt="" width={18} height={18} /> : <Wallet size={16} />;
}

/**
 * Connect whichever browser wallet the owner uses. One installed: a button
 * with its name. Several: a menu of them, each with the name and icon it
 * announced. None: what to do instead, since on a phone the answer is to open
 * the page inside the wallet app.
 */
export function WalletButton() {
  const { wallets, connect, notify } = useStore();
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
    connect(id).catch((e) => notify((e as Error).message)).finally(() => setBusy(false));
  };

  if (!wallets.length) {
    return <span className="wallet-none">No browser wallet found. Install one, or open this page in your wallet app&rsquo;s browser.</span>;
  }
  if (wallets.length === 1) {
    return <button className="btn btn-gold wallet-connect" disabled={busy} onClick={() => go(wallets[0].id)}><WalletIcon wallet={wallets[0]} />{busy ? "Connecting…" : `Connect ${wallets[0].name}`}</button>;
  }
  return (
    <div className="wallet-pick" ref={menu}>
      <button className="btn btn-gold wallet-connect" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Wallet size={16} />{busy ? "Connecting…" : "Connect a wallet"}<ChevronDown size={14} />
      </button>
      {open ? (
        <div className="wallet-menu" role="menu">
          {wallets.map((w) => (
            <button key={w.id} role="menuitem" onClick={() => go(w.id)}><WalletIcon wallet={w} />{w.name}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
