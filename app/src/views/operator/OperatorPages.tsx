import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Address, WalletClient } from "viem";
import { watchWallets, type WalletOption } from "../../lib/wallet";
import { connectOwner } from "../../lib/evm/stocks";
import { chainRow, fetchIndex, opHref, type OpIndex, type OpNetworkRow } from "../../lib/operator";
import { useHub } from "../evm/common";
import { OpHome } from "./OpHome";
import { OpProject } from "./OpProject";
import { OpMe } from "./OpMe";
import { OpOwner } from "./OpOwner";
import { OpNew } from "./OpNew";
import { OpDecision } from "./OpDecision";
import "./operator.css";

/**
 * Quaestor Operator: a project's paid outreach, run by an AI operator from a USDC budget on Arc
 * that it cannot overspend. Loaded on its own, like the other chains' pages, so viem's wallet code
 * arrives only when someone opens it.
 */
export interface OpCtx {
  index: OpIndex;
  wallets: WalletOption[];
  wallet: { client: WalletClient; account: Address; network: string } | null;
  connect: (walletId: string, network: OpNetworkRow) => Promise<void>;
  networkOf: (key: string) => OpNetworkRow | undefined;
}

const Ctx = createContext<OpCtx | null>(null);

export function useOp(): OpCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useOp outside OperatorPages");
  return c;
}

export default function OperatorPages({ path }: { path: string }) {
  // /operator[/new | /p/<id>[/owner] | /me/<token> | /d/<hash>]
  const [, , section, id, sub] = path.split("/");
  const { data: index, error } = useHub(fetchIndex, [], 0);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [wallet, setWallet] = useState<OpCtx["wallet"]>(null);
  useEffect(() => watchWallets(setWallets), []);

  const connect = useCallback(async (walletId: string, network: OpNetworkRow) => {
    const w = await connectOwner(chainRow(network), wallets.find((x) => x.id === walletId));
    setWallet({ ...w, network: network.key });
  }, [wallets]);

  if (error && !index) return <div className="not-found"><strong>The hub did not answer.</strong><p>{error}</p></div>;
  if (!index) return <div className="not-found"><strong>Reading the hub…</strong><p>A free host may take up to a minute to wake.</p></div>;

  const networkOf = (key: string) => index.networks.find((n) => n.key === key);
  const page = !section ? <OpHome />
    : section === "new" ? <OpNew />
    : section === "p" && id && sub === "owner" ? <OpOwner id={decodeURIComponent(id)} />
    : section === "p" && id ? <OpProject id={decodeURIComponent(id)} />
    : section === "me" && id ? <OpMe token={decodeURIComponent(id)} />
    : section === "d" && id ? <OpDecision hash={decodeURIComponent(id)} />
    : <div className="not-found"><strong>No such page.</strong><a href={opHref("")}>Quaestor Operator</a></div>;
  return <Ctx.Provider value={{ index, wallets, wallet, connect, networkOf }}>{page}</Ctx.Provider>;
}
