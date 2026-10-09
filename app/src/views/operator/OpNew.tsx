import { useEffect, useState } from "react";
import { ArrowLeft, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { decodeEventLog, parseEther, type Address, type Hex } from "viem";
import { ERC20_ABI, chainOf, explainWalletError, parseUnits, readClient, short } from "../../lib/evm/stocks";
import { PAYOUTS_FACTORY_ABI, TASK_KINDS, chainRow, opHref, ownerMessage, registerProject, saveSession } from "../../lib/operator";
import { useOp } from "./OperatorPages";
import { ConnectWallet } from "./parts";

interface TaskDraft { kind: string; title: string; done_when: string; rate_min_usd: string; rate_max_usd: string; slots: string }

const FIRST_TASK: TaskDraft = { kind: "x-post", title: "A post about us on X", done_when: "A public post on X that explains, in your own words, one concrete thing the project does, links it, and is marked #ad.", rate_min_usd: "5", rate_max_usd: "20", slots: "10" };
const PERIODS = [{ value: 86_400, label: "Day" }, { value: 604_800, label: "Week" }, { value: 2_592_000, label: "30 days" }];
const GAS = "0.5"; // USDC sent to the operator's key with the budget, for its gas on Arc

export function OpNew() {
  const { index, wallet } = useOp();
  const network = index.networks[0];
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [links, setLinks] = useState("");
  const [deposit, setDeposit] = useState("50");
  const [perDeal, setPerDeal] = useState("20");
  const [periodCap, setPeriodCap] = useState("50");
  const [period, setPeriod] = useState(604_800);
  const [newCap, setNewCap] = useState("10");
  const [newPer, setNewPer] = useState("10");
  const [feePct, setFeePct] = useState("10");
  const [tasks, setTasks] = useState<TaskDraft[]>([FIRST_TASK]);
  const [held, setHeld] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; governor: Address; tx: Hex } | null>(null);

  useEffect(() => {
    if (!wallet || !network) return;
    readClient(chainRow(network)).readContract({ address: network.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.account] }).then(setHeld).catch(() => undefined);
  }, [wallet?.account, network?.key]);

  if (!network) return <div className="not-found"><strong>No network is served for the operator yet.</strong></div>;
  const slug = (id || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

  const problem = (): string | null => {
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) return "A project name of at least three letters.";
    if (brief.trim().length < 40) return "Write the brief: what the project is, who you want to reach, and what good work says. The operator decides from it.";
    const dep = parseUnits(deposit, 6), per = parseUnits(perDeal, 6), cap = parseUnits(periodCap, 6), nc = parseUnits(newCap, 6);
    if (dep === null || per === null || cap === null || nc === null) return "Write amounts like 50 or 2.5, with no commas or units.";
    if (!(nc <= per && per <= cap && per > 0n)) return "The limits must rise: new payee ≤ per deal ≤ per period.";
    if (held !== null && held < dep + parseUnits(GAS, 6)!) return `This wallet holds ${(Number(held) / 1e6).toFixed(2)} USDC; the budget and the operator's gas need ${(Number(dep) / 1e6 + Number(GAS)).toFixed(2)}.`;
    if (!(Number(feePct) >= 0 && Number(feePct) <= 20)) return "The cross-chain fee cap is between 0 and 20%.";
    if (!tasks.length) return "Add at least one task.";
    for (const t of tasks) {
      if (!t.title.trim() || t.done_when.trim().length < 10) return "Each task needs a title and what the delivered link must show.";
      if (!(Number(t.rate_min_usd) > 0 && Number(t.rate_max_usd) >= Number(t.rate_min_usd))) return `"${t.title}": the rate band must be above zero, lowest first.`;
      if (Number(t.rate_max_usd) > Number(perDeal)) return `"${t.title}" pays up to $${t.rate_max_usd}, over the per-deal limit; those deals would all wait for you.`;
    }
    return null;
  };

  const create = async () => {
    setErr(null);
    const why = problem();
    if (why) return setErr(why);
    if (!wallet) return setErr("Connect your wallet first.");
    const chain = chainOf(chainRow(network));
    const client = readClient(chainRow(network));
    const dep = parseUnits(deposit, 6)!;
    try {
      const allowance = await client.readContract({ address: network.usdc, abi: ERC20_ABI, functionName: "allowance", args: [wallet.account, network.factory] });
      if (allowance < dep) {
        setBusy(`1 of 3 · approve ${deposit} USDC for the factory…`);
        const approve = await wallet.client.writeContract({ address: network.usdc, abi: ERC20_ABI, functionName: "approve", args: [network.factory, dep], account: wallet.account, chain });
        await client.waitForTransactionReceipt({ hash: approve });
      }
      setBusy("2 of 3 · open the budget contract…");
      const hash = await wallet.client.writeContract({
        address: network.factory,
        abi: PAYOUTS_FACTORY_ABI,
        functionName: "createGovernor",
        args: [{
          operator: network.operator, token: network.usdc, epochLength: BigInt(period),
          perDealCap: parseUnits(perDeal, 6)!, epochCap: parseUnits(periodCap, 6)!, newPayeeCap: parseUnits(newCap, 6)!, newPayeesPerEpoch: Number(newPer),
          payees: [], payeeCaps: [], tokenMessenger: network.token_messenger ?? "0x0000000000000000000000000000000000000000",
          maxForwardFeeBps: Math.round(Number(feePct) * 100), deposit: dep,
        }],
        value: parseEther(GAS),
        account: wallet.account,
        chain,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      const created = receipt.logs.map((l) => { try { return decodeEventLog({ abi: PAYOUTS_FACTORY_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "GovernorCreated");
      if (receipt.status !== "success" || !created) throw new Error(`The transaction did not open a budget (${short(hash)}).`);
      const governor = (created.args as { governor: Address }).governor;

      setBusy("3 of 3 · sign to hand it to the operator…");
      const expires = Math.floor(Date.now() / 1000) + 86_400;
      const signature = await wallet.client.signMessage({ account: wallet.account, message: ownerMessage(slug, expires) });
      const session = { address: wallet.account, expires, signature };
      await registerProject(session, {
        id: slug, name: name.trim() || slug, brief: brief.trim(), network: network.key, governor,
        links: links.split(/\s+/).map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)),
        tasks: tasks.map((t) => ({ kind: t.kind, title: t.title.trim(), done_when: t.done_when.trim(), rate_min_usd: Number(t.rate_min_usd), rate_max_usd: Number(t.rate_max_usd), slots: Number(t.slots) || 10 })),
      });
      saveSession(slug, session);
      setDone({ id: slug, governor, tx: hash });
    } catch (e) {
      setErr(explainWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  const setTask = (i: number, patch: Partial<TaskDraft>) => setTasks((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return <>
    <section className="page-intro compact"><div>
      <a className="back-link" href={opHref("")}><ArrowLeft size={13} />Quaestor Operator</a>
      <span className="eyebrow">START A PROJECT · {network.name.toUpperCase()}</span>
      <h1>Hand your outreach budget to an operator</h1>
      <p>Your wallet opens a budget contract with your USDC and your limits, names the operator as the only key that may spend it, and keeps every owner power: approve, suspend, change limits, withdraw. Then you sign once to give the operator your brief and tasks.</p>
    </div></section>

    <section className="manage-area register-area">
      <div className="manage-notice">
        <ShieldCheck size={22} />
        <div><h2>{network.testnet ? "Arc testnet, test USDC" : "Arc, real USDC"}</h2><p>{network.testnet ? <>Test USDC from <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Circle&rsquo;s faucet</a> has no value. </> : "Keep the first budget small. "}The operator&rsquo;s key is <span className="mono">{short(network.operator)}</span>; it can open deals and pay inside your limits, and nothing else.</p></div>
        <ConnectWallet network={network} onError={setErr} />
      </div>

      {done ? (
        <div className="form-card">
          <div className="success-head">✓ {name || done.id} is live.</div>
          <p className="success-sub">The operator is reading applications for it now. Share the project page; you will see what needs you on your desk.</p>
          <div className="form-actions">
            <a className="btn btn-gold btn-sm" href={opHref(`/p/${done.id}`)}>Project page</a>
            <a className="btn btn-ghost btn-sm" href={opHref(`/p/${done.id}/owner`)}>Your desk</a>
          </div>
        </div>
      ) : (
        <div className="form-card">
          <div className="form-grid">
            <div className="field"><label htmlFor="op-name">Project</label><input id="op-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your project's name" /><div className="note">Its page: {slug ? opHref(`/p/${slug}`) : "—"}</div></div>
            <div className="field"><label htmlFor="op-id">Short name (optional)</label><input id="op-id" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder={slug || "my-project"} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="op-brief">Brief</label>
              <textarea id="op-brief" rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What the project is. Who you want to reach. What good work says, and what you will not pay for (engagement bait, giveaways)." />
              <div className="note">The operator decides every offer and every payment from this. Be specific.</div></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="op-links">Links</label><input id="op-links" value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://your.site https://github.com/you/repo" /></div>

            <div className="field"><label htmlFor="op-dep">Budget (USDC)</label><input id="op-dep" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
              <div className="note">{held !== null ? `This wallet holds ${(Number(held) / 1e6).toFixed(2)} USDC. ` : ""}Plus {GAS} USDC for the operator&rsquo;s gas.</div></div>
            <div className="field"><label htmlFor="op-period">Period</label><select id="op-period" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></div>
            <div className="field"><label htmlFor="op-per">Most per deal</label><input id="op-per" value={perDeal} onChange={(e) => setPerDeal(e.target.value)} inputMode="decimal" /><div className="note">A bigger deal waits for your signature.</div></div>
            <div className="field"><label htmlFor="op-cap">Most per period</label><input id="op-cap" value={periodCap} onChange={(e) => setPeriodCap(e.target.value)} inputMode="decimal" /></div>
            <div className="field"><label htmlFor="op-new">Most for someone new</label><input id="op-new" value={newCap} onChange={(e) => setNewCap(e.target.value)} inputMode="decimal" /><div className="note">Until you vet them.</div></div>
            <div className="field"><label htmlFor="op-newper">New people per period</label><input id="op-newper" value={newPer} onChange={(e) => setNewPer(e.target.value.replace(/\D/g, ""))} inputMode="numeric" /></div>
            <div className="field"><label htmlFor="op-fee">Cross-chain fee cap (%)</label><input id="op-fee" value={feePct} onChange={(e) => setFeePct(e.target.value)} inputMode="decimal" /><div className="note">Payees may be paid on Base, Arbitrum, Ethereum, OP or Polygon through CCTP; 0 keeps every payment on Arc.</div></div>

            <div className="field" style={{ gridColumn: "1 / -1" }}><label>What you pay for</label>
              <div className="op-task-drafts">
                <div className="op-task-draft-head" aria-hidden="true"><span>Kind</span><span>Title</span><span>From $</span><span>To $</span><span>Places</span><span /></div>
                {tasks.map((t, i) => (
                  <div key={i} className="op-task-draft">
                    <select aria-label="Kind" value={t.kind} onChange={(e) => setTask(i, { kind: e.target.value })}>{TASK_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select>
                    <input aria-label="Title" value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} placeholder="Title" />
                    <input aria-label="Lowest rate" value={t.rate_min_usd} onChange={(e) => setTask(i, { rate_min_usd: e.target.value })} inputMode="decimal" placeholder="$ from" />
                    <input aria-label="Highest rate" value={t.rate_max_usd} onChange={(e) => setTask(i, { rate_max_usd: e.target.value })} inputMode="decimal" placeholder="$ to" />
                    <input aria-label="Places" value={t.slots} onChange={(e) => setTask(i, { slots: e.target.value.replace(/\D/g, "") })} inputMode="numeric" placeholder="places" />
                    <button className="btn btn-ghost btn-sm" aria-label="Remove" onClick={() => setTasks((ts) => ts.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                    <textarea aria-label="Done when" rows={2} value={t.done_when} onChange={(e) => setTask(i, { done_when: e.target.value })} placeholder="Done when: what the delivered link must show" />
                  </div>
                ))}
                <button className="btn btn-ghost btn-sm" onClick={() => setTasks((ts) => [...ts, { ...FIRST_TASK, kind: "pull-request", title: "", done_when: "" }])}><Plus size={14} />Add a task</button>
              </div></div>
          </div>
          <div className="form-actions">
            <button className="btn btn-gold" onClick={() => void create()} disabled={Boolean(busy) || !wallet}>{busy ?? "Open the budget and start"}</button>
            {err ? <span className="form-msg err">{err}</span> : !wallet ? <span className="form-msg">Connect a wallet to start.</span> : null}
          </div>
        </div>
      )}
    </section>
  </>;
}
