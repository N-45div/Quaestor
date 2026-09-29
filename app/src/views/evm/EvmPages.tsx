import { useCallback, useEffect, useState } from "react";
import { explorerHref } from "../../components/ExplorerShell";
import { watchWallets, type WalletOption } from "../../lib/wallet";
import { connectOwner, fetchNetworks } from "../../lib/evm/stocks";
import { Ctx, useHub, type EvmCtx } from "./common";
import { EvmOverview } from "./EvmOverview";
import { EvmRegister } from "./EvmRegister";
import { EvmAgent } from "./EvmAgent";
import { EvmTrade } from "./EvmTrade";
import { EvmBuy } from "./EvmBuy";

/**
 * Every /evm/<network> page: Stock Token governors on an EVM chain, Robinhood
 * Chain first. Loaded on its own, like the Solana side, so viem's wallet code
 * arrives only when someone opens it. The pages share the network row the hub
 * serves and, once the owner connects, their wallet.
 */
export default function EvmPages({ path }: { path: string }) {
  // /evm/<network>[/register | /buy | /agents/<address> | /trades/<tx>]
  const [, , netKey = "robinhood", section, id] = path.split("/");
  const { data: networks, error } = useHub(fetchNetworks, [], 0);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [owner, setOwner] = useState<EvmCtx["owner"]>(null);
  useEffect(() => watchWallets(setWallets), []);

  const net = networks?.find((n) => n.key === netKey);
  const connect = useCallback(async (walletId: string) => {
    if (!net) return;
    setOwner(await connectOwner(net, wallets.find((w) => w.id === walletId)));
  }, [net, wallets]);

  if (error && !networks) return <div className="not-found"><strong>The hub did not answer.</strong><p>{error}</p></div>;
  if (!networks) return <div className="not-found"><strong>Reading the hub…</strong><p>A free host may take up to a minute to wake.</p></div>;
  if (!net) {
    return <div className="not-found"><strong>The governor is not live on “{netKey}” yet.</strong>
      <p>{networks.length ? <>Served now: {networks.map((n) => <a key={n.key} href={explorerHref(`/evm/${n.key}`)}>{n.name} </a>)}</> : "No EVM chain is served by this hub yet."}</p></div>;
  }

  const page = !section ? <EvmOverview />
    : section === "register" ? <EvmRegister />
    : section === "buy" ? <EvmBuy />
    : section === "agents" && id ? <EvmAgent address={decodeURIComponent(id)} />
    : section === "trades" && id ? <EvmTrade tx={decodeURIComponent(id)} />
    : <div className="not-found"><strong>No such page.</strong><a href={explorerHref(`/evm/${net.key}`)}>{net.name} overview</a></div>;
  return <Ctx.Provider value={{ net, wallets, owner, connect }}>{page}</Ctx.Provider>;
}

