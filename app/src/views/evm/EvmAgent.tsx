import { useState } from "react";
import { ArrowLeft, Pause, Play, Settings2 } from "lucide-react";
import { type Address } from "viem";
import { explorerHref } from "../../components/ExplorerShell";
import { GOVERNOR_ABI, budgetOf, chainOf, epochLabel, readClient, explainWalletError, fetchGovernor, fetchTrades, parseUnits, short, show, words, type GovernorView } from "../../lib/evm/stocks";
import { AddressLink, OwnerWallet, TradesTable, useEvm, useHub } from "./common";

/** The owner's controls: shown to everyone, usable only from the owner's wallet. */
function OwnerControls({ g, onDone }: { g: GovernorView; onDone: () => void }) {
  const { net, owner } = useEvm();
  const b = budgetOf(net, g.budgetToken) ?? net.budget;
  const isOwner = owner && owner.account.toLowerCase() === g.owner.toLowerCase();
  const [perTrade, setPerTrade] = useState(g.perTradeCap);
  const [epochCap, setEpochCap] = useState(g.epochCap);
  const [limits, setLimits] = useState<Record<string, string>>(Object.fromEntries(g.instruments.map((i) => [i.address, i.limitPrice])));
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async (label: string, functionName: "setPolicy" | "setSuspended" | "setPriceLimit" | "withdraw", args: readonly unknown[]) => {
    if (!owner) return;
    setBusy(label);
    setMsg(null);
    try {
      const hash = await owner.client.writeContract({ address: g.address, abi: GOVERNOR_ABI, functionName, args: args as never, account: owner.account, chain: chainOf(net) });
      await readClient(net).waitForTransactionReceipt({ hash });
      setMsg({ ok: true, text: `${label}: done (${short(hash)}).` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: explainWalletError(e) });
    } finally {
      setBusy(null);
    }
  };

  const units = (v: string, d = b.decimals) => parseUnits(v, d);
  return (
    <section className="data-section manage-area">
      <div className="section-heading"><div><span className="eyebrow">THE OWNER&rsquo;S CONTROLS</span><h2>Only the owner&rsquo;s wallet can use these</h2></div><OwnerWallet onError={(m) => setMsg({ ok: false, text: m })} /></div>
      {!isOwner ? <p className="muted-copy">{owner ? `Connected as ${short(owner.account)}, which is not this governor's owner (${short(g.owner)}). The contract would refuse these.` : "Connect the owner's wallet to change caps, limit prices, suspend the agent or take money and shares out. Anyone can read them."}</p> : null}
      <div className="form-card owner-controls">
        <div className="form-grid">
          <div className="field"><label>Per-trade cap ({b.symbol})</label><input value={perTrade} onChange={(e) => setPerTrade(e.target.value)} disabled={!isOwner} /></div>
          <div className="field"><label>Cap per {epochLabel(g.epochLength)} ({b.symbol})</label><input value={epochCap} onChange={(e) => setEpochCap(e.target.value)} disabled={!isOwner} /></div>
        </div>
        <div className="form-actions">
          <button className="btn btn-ghost btn-sm" disabled={!isOwner || Boolean(busy)} onClick={() => {
            const p = units(perTrade), c = units(epochCap);
            if (!p || !c || p > c) return setMsg({ ok: false, text: "Caps must be amounts above zero, and the per-trade cap no more than the epoch cap." });
            void send("Set the caps", "setPolicy", [p, c, BigInt(g.epochLength)]);
          }}><Settings2 size={14} />Set the caps</button>
          <button className="btn btn-ghost btn-sm" disabled={!isOwner || Boolean(busy)} onClick={() => void send(g.suspended ? "Resume" : "Suspend", "setSuspended", [!g.suspended])}>
            {g.suspended ? <><Play size={14} />Resume the agent</> : <><Pause size={14} />Suspend the agent</>}
          </button>
        </div>
        <div className="form-grid">
          {g.instruments.filter((i) => i.allowed).map((i) => (
            <div className="field" key={i.address}>
              <label>{i.symbol} limit price ({b.symbol} a {words(net).unit})</label>
              <div className="inline-field">
                <input value={limits[i.address] ?? ""} onChange={(e) => setLimits((l) => ({ ...l, [i.address]: e.target.value }))} disabled={!isOwner} />
                <button className="btn btn-ghost btn-sm" disabled={!isOwner || Boolean(busy)} onClick={() => {
                  const v = units(limits[i.address] ?? "");
                  if (v === null) return setMsg({ ok: false, text: "Write the limit as an amount such as 370." });
                  void send(`Set the ${i.symbol} limit`, "setPriceLimit", [i.address, v]);
                }}>Set</button>
              </div>
            </div>
          ))}
        </div>
        <div className="form-grid">
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>Take out, to the owner&rsquo;s wallet</label>
            <div className="inline-field">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`${b.symbol} amount`} disabled={!isOwner} />
              <button className="btn btn-ghost btn-sm" disabled={!isOwner || Boolean(busy)} onClick={() => {
                const v = units(amount);
                if (!v) return setMsg({ ok: false, text: `Write the ${b.symbol} amount to take out.` });
                void send(`Take out ${amount} ${b.symbol}`, "withdraw", [b.address, v, owner!.account as Address]);
              }}>Take out {b.symbol}</button>
              {g.instruments.filter((i) => Number(i.held) > 0).map((i) => (
                <button key={i.address} className="btn btn-ghost btn-sm" disabled={!isOwner || Boolean(busy)} onClick={() => {
                  const inst = net.instruments.find((x) => x.address.toLowerCase() === i.address.toLowerCase());
                  const v = parseUnits(i.held, inst?.decimals ?? 18);
                  if (v) void send(`Take out ${i.symbol}`, "withdraw", [i.address, v, owner!.account as Address]);
                }}>Take out all {i.symbol}</button>
              ))}
            </div>
          </div>
        </div>
        {busy ? <p className="form-msg">{busy}…</p> : msg ? <p className={`form-msg ${msg.ok ? "" : "err"}`}>{msg.text}</p> : null}
      </div>
    </section>
  );
}

export function EvmAgent({ address }: { address: string }) {
  const { net } = useEvm();
  const gov = useHub(() => fetchGovernor(net.key, address), [net.key, address]);
  const trades = useHub(() => fetchTrades(net.key, address), [net.key, address]);
  const g = gov.data;
  const b = (g && budgetOf(net, g.budgetToken)) || net.budget;

  if (gov.error && !g) return <div className="not-found"><strong>No governor at {short(address)}.</strong><p>{gov.error}</p><a href={explorerHref(`/evm/${net.key}`)}>{net.name} overview</a></div>;
  if (!g) return <div className="not-found"><strong>Reading governor {short(address)}…</strong></div>;

  const price = (symbol: string) => g.prices.find((p) => p.stock === symbol)?.chainlink;
  const held = g.instruments.filter((i) => i.allowed || Number(i.held) > 0);
  const value = held.reduce((sum, i) => sum + Number(i.held) * Number(price(i.symbol)?.price ?? 0), 0);

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={explorerHref(`/evm/${net.key}`)}><ArrowLeft size={13} />{net.name}</a>
      <span className="eyebrow">{g.demo ? "THE HOUSE AGENT" : "A GOVERNED AGENT"} · {net.name.toUpperCase()}</span>
      <h1>{g.demo ? "House agent" : `Agent ${short(g.operator)}`}</h1>
      <p>Governor <AddressLink value={g.address} /> · owner <AddressLink value={g.owner} /> · agent key <AddressLink value={g.operator} /> · {g.suspended ? <strong className="warn-text">suspended</strong> : "active"}</p>
    </div></section>

    <section className="metric-grid">
      <article><div className="metric-label">Budget</div><div className="metric-value metric-money">{show(g.budget)}</div><div className="metric-foot">{b.symbol} in the governor</div></article>
      <article><div className="metric-label">This {epochLabel(g.epochLength)}</div><div className="metric-value metric-money">{show(g.spentThisEpoch)} / {show(g.epochCap)}</div><div className="metric-foot">{show(g.remaining)} {b.symbol} can be spent now</div></article>
      <article><div className="metric-label">Per trade</div><div className="metric-value metric-money">{show(g.perTradeCap)}</div><div className="metric-foot">{b.symbol} at most</div></article>
      <article><div className="metric-label">{words(net).Asset === "Stock" ? "Shares held" : "Tokens held"}</div><div className="metric-value metric-money">${show(String(value))}</div><div className="metric-foot">at Chainlink&rsquo;s prices</div></article>
    </section>

    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">WHAT IT MAY BUY</span><h2>{words(net).Assets}, limit prices and Chainlink&rsquo;s checks</h2></div></div>
      <div className="explorer-table-wrap">
        <table className="explorer-table">
          <thead><tr><th>{words(net).Asset}</th><th>Allowed</th><th>Held</th><th>Limit a {words(net).unit}</th><th>Chainlink</th><th>Chainlink check</th></tr></thead>
          <tbody>
            {held.map((i) => {
              const c = price(i.symbol);
              return (
                <tr key={i.address}>
                  <td><strong>{i.symbol}</strong> <AddressLink value={i.address} /></td>
                  <td>{i.allowed ? "Yes" : "No"}</td>
                  <td className="numeric">{show(i.held, 8)}</td>
                  <td className="numeric">{Number(i.limitPrice) ? `${show(i.limitPrice)} ${b.symbol}` : "none"}</td>
                  <td className="numeric">{c ? <>${show(c.price)} <small>{new Date(c.updatedAt * 1000).toLocaleString()}</small></> : "—"}</td>
                  <td>{i.guard ? `at most ${i.guard.maxDeviationBps / 100}% over, price under ${Math.round(i.guard.maxStaleness / 3600)}h old` : "none"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted-copy">Venues: {g.venues.filter((v) => v.allowed).map((v) => v.label).join(", ") || "none"}. The agent&rsquo;s key can only ask this governor to buy these stocks through these venues; everything else here is the owner&rsquo;s.</p>
    </section>

    <TradesTable rows={trades.data?.trades ?? []} title="This agent's trades" source={trades.data?.source} />
    <OwnerControls g={g} onDone={gov.reload} />
  </>;
}
