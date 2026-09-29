import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, KeyRound, ShieldCheck, Terminal, Wallet } from "lucide-react";
import { createPublicClient, decodeEventLog, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { explorerHref } from "../../components/ExplorerShell";
import { ERC20_ABI, FACTORY_ABI, budgetOf, budgetsOf, chainOf, epochLabel, explainWalletError, parseUnits, short, withBudget, words, type EvmNetwork } from "../../lib/evm/stocks";
import { AddressLink, OwnerWallet, useEvm } from "./common";

export const EVM_CLI_URL = "https://gitlab.com/ndivij2004/quaestor/-/raw/cli-v4/cli/dist/quaestor-evm.mjs";
export const EVM_SKILL_URL = "https://gitlab.com/ndivij2004/quaestor/-/blob/main/skills/quaestor-evm/SKILL.md";

const EPOCHS = [{ value: 3600, label: "Hour" }, { value: 86_400, label: "Day" }, { value: 604_800, label: "Week" }];
const DEFAULTS = { deposit: "20", perTrade: "5", epochCap: "20", epoch: 86_400, marginPct: "1" };
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);

/** The link's own numbers, as the agent proposed them. */
function fromLink(): Record<string, string> {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return Object.fromEntries(q.entries());
}

/** What a wallet holds of a token, re-read when either changes; null until read. */
function useBalance(net: EvmNetwork, token: Address, account: Address | undefined): bigint | null {
  const [value, setValue] = useState<bigint | null>(null);
  useEffect(() => {
    setValue(null);
    if (!account) return;
    let live = true;
    const client = createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) });
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account] })
      .then((v) => live && setValue(v)).catch(() => undefined);
    return () => { live = false; };
  }, [net.key, token, account]);
  return value;
}

/** Chainlink's price for each stock that has a feed, in dollars. */
function useOraclePrices(net: EvmNetwork): Record<string, number> {
  const [prices, setPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    const client = createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) });
    let live = true;
    void Promise.all(net.instruments.filter((i) => i.feed).map(async (i) => {
      const [dec, round] = await Promise.all([
        client.readContract({ address: i.feed!, abi: FEED_ABI, functionName: "decimals" }),
        client.readContract({ address: i.feed!, abi: FEED_ABI, functionName: "latestRoundData" }),
      ]);
      return [i.symbol, Number(round[1]) / 10 ** Number(dec)] as const;
    })).then((pairs) => live && setPrices(Object.fromEntries(pairs))).catch(() => undefined);
    return () => { live = false; };
  }, [net.key]);
  return prices;
}

export function EvmRegister() {
  const { net: chain, owner } = useEvm();
  const link = useMemo(fromLink, []);
  const oracle = useOraclePrices(chain);
  const [budgetSymbol, setBudgetSymbol] = useState((budgetOf(chain, link.budget) ?? chain.budget).symbol);
  // The chain as this governor will see it: its dollar, and the stocks with a pool against that dollar.
  const net = withBudget(chain, budgetOf(chain, budgetSymbol) ?? chain.budget);
  const b = net.budget;
  const held = useBalance(chain, b.address, owner?.account);

  const [operator, setOperator] = useState(link.operator ?? "");
  const [deposit, setDeposit] = useState(link.deposit ?? DEFAULTS.deposit);
  const [perTrade, setPerTrade] = useState(link.perTrade ?? DEFAULTS.perTrade);
  const [epochCap, setEpochCap] = useState(link.epochCap ?? DEFAULTS.epochCap);
  const [epoch, setEpoch] = useState(Number(link.epoch ?? DEFAULTS.epoch));
  const [marginPct, setMarginPct] = useState(DEFAULTS.marginPct);
  // A link's symbols in any case, as the chain spells them.
  const canonical = (s: string) => chain.instruments.find((i) => i.symbol.toLowerCase() === s.trim().toLowerCase())?.symbol;
  const linkStocks = (link.stocks ?? "").split(",").map(canonical).filter((s): s is string => Boolean(s) && net.instruments.some((i) => i.symbol === s));
  const [picked, setChosen] = useState<string[]>(linkStocks.length ? linkStocks : [net.instruments[0]?.symbol].filter(Boolean) as string[]);
  // A stock picked under one dollar and without a pool against the next is dropped, not sent.
  const chosen = picked.filter((s) => net.instruments.some((i) => i.symbol === s));
  const linkLimits = Object.fromEntries((link.limit ?? "").split(",").map((p) => p.split("=")).filter((p) => p.length === 2 && canonical(p[0])).map(([s, v]) => [canonical(s)!, v]));
  const [limits, setLimits] = useState<Record<string, string>>(linkLimits);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ governor: Address; tx: Hex } | null>(null);

  // A limit a little over Chainlink's price unless the link or the owner says otherwise.
  useEffect(() => {
    setLimits((cur) => {
      const next = { ...cur };
      for (const s of Object.keys(oracle)) if (!next[s]) next[s] = String(Math.ceil(oracle[s] * 1.1));
      return next;
    });
  }, [oracle]);

  // Numbers a link can raise past the defaults, which the owner must see and agree to.
  const raised = [
    link.deposit && Number(link.deposit) > Number(DEFAULTS.deposit) ? `a deposit of ${link.deposit} ${b.symbol}` : null,
    link.perTrade && Number(link.perTrade) > Number(DEFAULTS.perTrade) ? `a per-trade cap of ${link.perTrade}` : null,
    link.epochCap && Number(link.epochCap) > Number(DEFAULTS.epochCap) ? `an epoch cap of ${link.epochCap}` : null,
    ...Object.entries(linkLimits).filter(([s, p]) => oracle[s] && Number(p) > oracle[s] * 1.15).map(([s, p]) => `a limit of ${p} for ${s}, over 15% above Chainlink`),
  ].filter(Boolean) as string[];
  const mustConfirm = Boolean(link.operator) || raised.length > 0;

  const problem = (): string | null => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(operator.trim())) return "The agent key must be the address your agent's keygen printed.";
    if (owner && operator.trim().toLowerCase() === owner.account.toLowerCase()) return "The agent key cannot be your own wallet: it would then set its own limits.";
    if (mustConfirm && !confirmed) return "Tick the box above to confirm the key and the numbers are yours.";
    const dep = parseUnits(deposit, b.decimals), per = parseUnits(perTrade, b.decimals), cap = parseUnits(epochCap, b.decimals);
    if (dep === null || per === null || cap === null) return "Write amounts like 20 or 2.5, with no commas or units.";
    if (per === 0n) return "The per-trade cap must be above zero.";
    if (per > cap) return "The per-trade cap is larger than the epoch cap.";
    if (!chosen.length) return "Choose at least one stock the agent may buy.";
    if (held !== null && dep !== null && held < dep) return `This wallet holds ${Number(held) / 10 ** b.decimals} ${b.symbol}; the deposit is ${deposit}.${b.faucet ? ` Paxos's faucet sends 100 a day.` : ""}`;
    for (const s of chosen) if (!parseUnits(limits[s] ?? "", b.decimals)) return `Set a limit price for ${s}: the most the governor may pay for one share.`;
    const m = Number(marginPct);
    if (!(m > 0 && m <= 50)) return "The Chainlink margin must be between 0 and 50%.";
    return null;
  };

  const register = async () => {
    setErr(null);
    const why = problem();
    if (why) return setErr(why);
    if (!owner) return setErr("Connect your wallet first.");
    const client = createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) });
    const dep = parseUnits(deposit, b.decimals)!;
    try {
      const allowance = await client.readContract({ address: b.address, abi: ERC20_ABI, functionName: "allowance", args: [owner.account, net.factory] });
      if (allowance < dep) {
        setBusy(`1 of 2 · approve ${deposit} ${b.symbol} for the factory…`);
        const approve = await owner.client.writeContract({ address: b.address, abi: ERC20_ABI, functionName: "approve", args: [net.factory, dep], account: owner.account, chain: chainOf(net) });
        await client.waitForTransactionReceipt({ hash: approve });
      }
      setBusy("2 of 2 · open the governor…");
      const tokens = chosen.map((s) => net.instruments.find((i) => i.symbol === s)!);
      const hash = await owner.client.writeContract({
        address: net.factory,
        abi: FACTORY_ABI,
        functionName: "createGovernor",
        args: [{
          operator: operator.trim() as Address,
          budgetToken: b.address,
          epochLength: BigInt(epoch),
          perTradeCap: parseUnits(perTrade, b.decimals)!,
          epochCap: parseUnits(epochCap, b.decimals)!,
          venues: net.venues.map((v) => v.router),
          labels: net.venues.map((v) => `0x${Array.from(new TextEncoder().encode(v.label.slice(0, 16))).map((x) => x.toString(16).padStart(2, "0")).join("").padEnd(32, "0")}` as Hex),
          tokens: tokens.map((i) => i.address),
          maxPrices: tokens.map((i) => parseUnits(limits[i.symbol], b.decimals)!),
          guards: tokens.filter((i) => i.feed).map((i) => ({ token: i.address, feed: i.feed!, maxDeviationBps: Math.round(Number(marginPct) * 100), maxStaleness: 3 * 86_400 })),
          deposit: dep,
        }],
        value: parseEther(net.agentGas),
        account: owner.account,
        chain: chainOf(net),
      });
      setBusy("Waiting for the block…");
      const receipt = await client.waitForTransactionReceipt({ hash });
      const created = receipt.logs.map((l) => { try { return decodeEventLog({ abi: FACTORY_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "GovernorCreated");
      if (receipt.status !== "success" || !created) throw new Error(`The transaction did not open a governor (${short(hash)}).`);
      setDone({ governor: (created.args as { governor: Address }).governor, tx: hash });
    } catch (e) {
      setErr(explainWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  // A testnet's own dollar anyone may mint: the owner takes some here instead of hunting a faucet.
  const mintTest = async () => {
    if (!owner) return setErr("Connect your wallet first.");
    setErr(null);
    setBusy(`Minting 100 ${b.symbol}…`);
    try {
      const hash = await owner.client.writeContract({ address: b.address, abi: ERC20_ABI, functionName: "mint", args: [owner.account, 100n * 10n ** BigInt(b.decimals)], account: owner.account, chain: chainOf(net) });
      await createPublicClient({ chain: chainOf(net), transport: http(net.rpcUrl) }).waitForTransactionReceipt({ hash });
    } catch (e) {
      setErr(explainWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  // The command's default is Robinhood Chain's testnet; any other chain is named.
  const netFlag = net.key === "robinhood-testnet" ? "" : ` --network ${net.key}`;
  const agentCommands = [
    `curl -fsSLO ${EVM_CLI_URL} && curl -fsSLO ${EVM_CLI_URL}.sha256`,
    "sha256sum -c quaestor-evm.mjs.sha256",
    `node quaestor-evm.mjs status${netFlag}`,
    `node quaestor-evm.mjs buy --stock ${chosen[0] ?? "AAPL"} --amount 1 --reason "<why this trade>" --dry-run${netFlag}`,
  ].join("\n");

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={explorerHref(`/evm/${net.key}`)}><ArrowLeft size={13} />{net.name}</a>
      <span className="eyebrow">BRING YOUR AGENT · {net.name.toUpperCase()}</span>
      <h1>Open a governor for your agent</h1>
      <p>Your wallet opens a contract of its own: {b.symbol} you fund, caps you set, the {words(net).assets} it may buy at the prices you allow, and one agent key that can buy inside them and do nothing else.</p>
    </div></section>

    <section className="onboard-steps" aria-label="How it works">
      <article><span>01</span><KeyRound size={18} /><h3>Your agent makes its key</h3><p>It downloads <a href={EVM_CLI_URL} target="_blank" rel="noreferrer">one file</a>, checks its hash, runs <code>keygen</code> and keeps the key, then <code>register</code>, and sends you a link to this page.</p></article>
      <article><span>02</span><Wallet size={18} /><h3>You sign it here</h3><p>Any EVM wallet. One approval for the deposit, then one signature: the governor, its caps, its {words(net).assets} and limit prices, Chainlink&rsquo;s checks, the deposit and the agent&rsquo;s gas.</p></article>
      <article><span>03</span><Terminal size={18} /><h3>It buys under your limits</h3><p>It runs <code>buy</code> with a reason, following <a href={EVM_SKILL_URL} target="_blank" rel="noreferrer">the skill</a>. A trade outside your caps, over your price or too far over Chainlink&rsquo;s is refused on chain.</p></article>
    </section>

    <section className="manage-area register-area">
      <div className="manage-notice">
        <ShieldCheck size={22} />
        <div><h2>{net.testnet ? "Testnet, test money" : "Real money, small amounts"}</h2><p>{net.testnet ? "Test tokens with no value." : `This is ${net.name} mainnet: the ${b.symbol} and the shares are real. Keep the deposit small.`} The shares the agent buys stay in the governor until you take them out; its key cannot move them, and nothing in the governor sells them.</p></div>
        <OwnerWallet onError={setErr} />
      </div>

      {done ? (
        <div className="form-card">
          <div className="success-head">✓ Your governor is open on {net.name}.</div>
          <p className="success-sub">Its agent can buy within your limits, and its key has its gas. Hand it these commands, or the skill.</p>
          <pre className="env-block">{agentCommands}</pre>
          <div className="form-actions">
            <a className="btn btn-gold btn-sm" href={explorerHref(`/evm/${net.key}/agents/${done.governor}`)}>Open your governor</a>
            <AddressLink value={done.tx} kind="tx" />
          </div>
        </div>
      ) : (
        <div className="form-card">
          <div className="form-grid">
            {budgetsOf(chain).length > 1 ? (
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>The dollar the governor holds</label>
                <div className="budget-pick" role="radiogroup">
                  {budgetsOf(chain).map((x) => (
                    <label key={x.address} className={`budget-option${x.symbol === b.symbol ? " on" : ""}`}>
                      <input type="radio" name="evm-budget" checked={x.symbol === b.symbol} onChange={() => setBudgetSymbol(x.symbol)} />
                      <strong>{x.symbol}</strong>
                      <span>{x.name ?? (x.mintable ? "A test dollar anyone can mint here" : "")}{x.instruments ? ` · ${x.instruments.join(", ")}` : ""}</span>
                    </label>
                  ))}
                </div>
                <div className="note">
                  {b.faucet ? <>Paxos&rsquo;s own testnet USDG: get 100 a day from <a href={b.faucet} target="_blank" rel="noreferrer">Paxos&rsquo;s faucet</a>. </> : b.mintable ? <>No faucet needed: take 100 with the button below. </> : null}
                  {owner && held !== null ? <>This wallet holds {(Number(held) / 10 ** b.decimals).toLocaleString("en-US", { maximumFractionDigits: 2 })} {b.symbol}.</> : null}
                </div>
              </div>
            ) : null}
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="evm-operator">Agent key</label>
              <input id="evm-operator" value={operator} onChange={(e) => setOperator(e.target.value.trim())} placeholder="0x… the address your agent's keygen printed" />
              {mustConfirm ? (
                <label className="note link-confirm">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  <span>
                    {link.operator ? <>Filled in from a link. Whoever holds this key can spend up to your caps every epoch. It is the key my own agent printed (<code>node quaestor-evm.mjs whoami</code>).</> : null}
                    {raised.length ? <> <strong className="link-raised">The link also sets {raised.join("; ")}.</strong> These are the numbers I agreed with my agent.</> : null}
                  </span>
                </label>
              ) : <div className="note">The agent&rsquo;s key can only buy, inside the limits below. It cannot withdraw or change anything.</div>}
            </div>
            <div className="field"><label htmlFor="evm-deposit">Deposit ({b.symbol})</label><input id="evm-deposit" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" /></div>
            <div className="field"><label htmlFor="evm-epoch">Epoch</label><select id="evm-epoch" value={epoch} onChange={(e) => setEpoch(Number(e.target.value))}>{EPOCHS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></div>
            <div className="field"><label htmlFor="evm-per">Per-trade cap ({b.symbol})</label><input id="evm-per" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} inputMode="decimal" /></div>
            <div className="field"><label htmlFor="evm-cap">Cap per {epochLabel(epoch)} ({b.symbol})</label><input id="evm-cap" value={epochCap} onChange={(e) => setEpochCap(e.target.value)} inputMode="decimal" /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>{words(net).Assets} the agent may buy, and the most it may pay for one {words(net).unit}</label>
              <div className="stock-limits">
                {net.instruments.map((i) => (
                  <div key={i.symbol} className={`stock-limit${chosen.includes(i.symbol) ? " on" : ""}`}>
                    <label className="stock-pick">
                      <input type="checkbox" checked={chosen.includes(i.symbol)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, i.symbol] : c.filter((x) => x !== i.symbol)))} />
                      <strong>{i.symbol}</strong><span>{i.name}</span>
                    </label>
                    <input aria-label={`${i.symbol} limit price`} value={limits[i.symbol] ?? ""} onChange={(e) => setLimits((l) => ({ ...l, [i.symbol]: e.target.value }))} inputMode="decimal" disabled={!chosen.includes(i.symbol)} />
                    <small>{oracle[i.symbol] ? `Chainlink $${oracle[i.symbol].toFixed(2)} · limit ${limits[i.symbol] && oracle[i.symbol] ? `${(((Number(limits[i.symbol]) / oracle[i.symbol]) - 1) * 100).toFixed(1)}% over` : ""}` : i.feed ? "reading Chainlink…" : "no feed"}</small>
                  </div>
                ))}
              </div>
              <div className="note">Checked on what each trade delivered, so an agent talked into overpaying is refused whatever floor it sets.</div>
            </div>
            <div className="field"><label htmlFor="evm-margin">Most over Chainlink (%)</label><input id="evm-margin" value={marginPct} onChange={(e) => setMarginPct(e.target.value)} inputMode="decimal" /><div className="note">A fill further over Chainlink&rsquo;s price than this is refused; so is a price older than three days.</div></div>
            <div className="field"><label>Agent gas</label><input value={`${net.agentGas} ${net.gasSymbol}`} readOnly /><div className="note">Sent to the agent&rsquo;s key with the governor; it pays its own gas.</div></div>
          </div>
          <div className="form-actions">
            {b.mintable ? <button className="btn btn-ghost btn-sm" onClick={() => void mintTest()} disabled={Boolean(busy) || !owner}>Get 100 {b.symbol}</button> : null}
            <button className="btn btn-gold" onClick={() => void register()} disabled={Boolean(busy) || !owner}>{busy ?? "Open the governor"}</button>
            {err ? <span className="form-msg err">{err}</span> : !owner ? <span className="form-msg">Connect a wallet to open a governor.</span> : null}
          </div>
        </div>
      )}
    </section>
  </>;
}
