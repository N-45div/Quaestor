import { useStore } from "../state";
import { okb } from "../lib/format";
import { TryIt } from "../components/TryIt";
import { WaveField } from "../components/WaveField";

const GITHUB = "https://github.com/N-45div/Quaestor";
const HUB = "https://quaestor-hub.onrender.com";

/**
 * The landing page.
 *
 * Organising principle: every section ends in something a reader can check
 * without trusting a word of the copy — a curl they can run, a named Solidity
 * revert with both its arguments, a Hedera transaction id on a public mirror
 * node, a JSON response showing a refusal. On a continuity track the honesty
 * is the argument, so where a number could flatter (the diff stat) the page
 * says so out loud.
 *
 * Nothing is asserted here that was not first verified against the live host
 * or the repo.
 */

const CHAINS = [
  { name: "X Layer", note: "home, since August" },
  { name: "Arc", note: "USDC is the gas token" },
  { name: "Base Sepolia", note: "indexed by The Graph" },
  { name: "Hedera", note: "x402 settlement" },
];

export function Landing() {
  const { ready, agents, receipts } = useStore();
  const treasury = agents.reduce((acc, a) => acc + a.balance, 0n);

  return (
    <div className="landing">
      <header className="wrap topbar">
        <a className="wordmark" href="#/">
          QU<span className="ae">Æ</span>STOR
        </a>
        <nav>
          <a href="#governor">The governor</a>
          <a href="#herd">The herd</a>
          <a href="#gate">The gate</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="btn btn-gold btn-sm" href="#/app">
            Open the treasury
          </a>
        </nav>
      </header>

      <section className="hero wrap hero-wave">
        <WaveField />
        <div className="hero-inner">
          <div className="eyebrow">Live on four chains · ETHOnline 2026</div>
          <h1>
            An agent gets an <em>allowance</em>, not a wallet.
          </h1>
          <p className="sub">
            The budget is a struct on-chain, not a rule on a server. Per-call and
            per-epoch caps live in the contract; go over and the transaction
            reverts with a named error anyone can read on the explorer without
            asking us anything. Every section below ends in something you can
            click.
          </p>
          <div className="cta-row">
            <a className="btn btn-gold" href="#/app">
              Open the treasury
            </a>
            <a className="btn btn-ghost" href="#try">
              Spend without a wallet
            </a>
            <a className="btn btn-ghost" href={GITHUB} target="_blank" rel="noreferrer">
              Read the contracts →
            </a>
          </div>

          <ul className="chainstrip">
            {CHAINS.map((c) => (
              <li key={c.name}>
                <b>{c.name}</b>
                <span>{c.note}</span>
              </li>
            ))}
          </ul>

          {ready && agents.length > 0 ? (
            <div className="live-stats">
              <span className="live-dot" /> live now: <b>{agents.length}</b>{" "}
              {agents.length === 1 ? "agent" : "agents"} governed ·{" "}
              <b>{receipts.length}</b> receipts on record · <b>{okb(treasury)}</b>{" "}
              under governance
            </div>
          ) : null}
        </div>
      </section>

      {/* 1 — the cheapest possible proof: one request, no wallet. */}
      <section className="band" id="start">
        <div className="wrap band-grid">
          <div className="band-copy">
            <div className="kicker">Start here</div>
            <h2>One request. No wallet, no signup.</h2>
            <p>
              Pulse is the house agent. It pays the oracle <i>through</i> the
              governor and hands back the receipt, the hash of the decision it
              committed to, the explorer link, and what is left of its budget.
              Drain that budget and the same request starts failing — the refusal
              is the product, not an outage.
            </p>
            <a className="btn btn-ghost btn-sm" href="#try">
              Run it on this page ↓
            </a>
          </div>
          <figure className="artifact">
            <figcaption>a request you can run right now</figcaption>
            <pre>
              <code>
                <span className="c-dim">$</span> curl -s {HUB}/api/heartbeat
                {"\n\n"}
                <span className="c-gold">{"{"}</span>
                {"\n  "}
                <span className="c-key">"receipt"</span>: {"{"}{" "}
                <span className="c-key">"tx"</span>:{" "}
                <span className="c-str">"0x…"</span>,{" "}
                <span className="c-key">"decision_hash"</span>:{" "}
                <span className="c-str">"0x…"</span> {"}"},{"\n  "}
                <span className="c-key">"remaining_budget"</span>: …{"\n"}
                <span className="c-gold">{"}"}</span>
              </code>
            </pre>
            <p className="artifact-note">
              Rate limited to one a minute, and it says so in its own words:{" "}
              <i>“one heartbeat per minute per caller — the governor teaches patience.”</i>
            </p>
          </figure>
        </div>
      </section>

      {/* 2 — the governor. */}
      <section className="band band-alt" id="governor">
        <div className="wrap band-grid">
          <div className="band-copy">
            <div className="kicker">The governor</div>
            <h2>The refusal is a revert, not a 403.</h2>
            <p>
              An owner sets a per-call cap and a per-epoch cap for each of{" "}
              <span className="cat cat-data">DATA</span>,{" "}
              <span className="cat cat-inference">INFERENCE</span> and{" "}
              <span className="cat cat-execution">EXECUTION</span>. The agent
              holds an operator key that cannot withdraw the treasury, cannot
              change policy, and cannot un-suspend itself. A guardian can suspend
              it and can never spend from it.
            </p>
            <p>
              On Arc, USDC <i>is</i> the gas token — so a <code>msg.value</code>{" "}
              cap is a dollar cap, with no change to the contract and no price
              feed to be wrong.
            </p>
          </div>
          <figure className="artifact">
            <figcaption>contracts/Quaestor.sol</figcaption>
            <pre>
              <code>
                <span className="c-kw">error</span>{" "}
                <span className="c-fn">PerCallCapExceeded</span>({"\n  "}
                <span className="c-kw">uint256</span> amount,{"\n  "}
                <span className="c-kw">uint256</span> cap{"\n"});
              </code>
            </pre>
            <p className="artifact-note">
              The revert names both numbers: what was asked for, and what was
              allowed. No server was consulted.
            </p>
          </figure>
        </div>
      </section>

      {/* 3 — receipts. */}
      <section className="band" id="receipts">
        <div className="wrap band-grid">
          <div className="band-copy">
            <div className="kicker">Receipts</div>
            <h2>The reason and the money move in one transaction.</h2>
            <p>
              Every spend emits a <code>Receipt</code> carrying the keccak-256 of
              the decision record — the signal, the rationale, the inputs. The
              operator publishes the record; you re-hash it in your own browser.
              There is no validator to trust and no log file anyone could have
              rotated afterwards.
            </p>
          </div>
          <figure className="artifact">
            <figcaption>the event, in full</figcaption>
            <pre>
              <code>
                <span className="c-kw">event</span>{" "}
                <span className="c-fn">Receipt</span>({"\n"}
                {"  "}uint256 <span className="c-dim">indexed</span> agentId,
                {"\n"}
                {"  "}Category <span className="c-dim">indexed</span> category,
                {"\n"}
                {"  "}address payee,{"\n"}
                {"  "}uint256 amount,{"\n"}
                {"  "}
                <span className="c-gold">bytes32 metaHash</span>,{"\n"}
                {"  "}uint256 epoch,{"\n"}
                {"  "}uint256 epochSpentAfter{"\n"});
              </code>
            </pre>
            <p className="artifact-note">
              Paste the published record into the dashboard — the hash either
              matches the event, or it does not.
            </p>
          </figure>
        </div>
      </section>

      {/* 4 — the herd. The differentiator. */}
      <section className="band band-alt" id="herd">
        <div className="wrap band-grid">
          <div className="band-copy">
            <div className="kicker">The herd</div>
            <h2>Quaestor never blocks a venue. It prices it.</h2>
            <p>
              <code>permit = base × (1 + k · reporters)</code>, counted once per
              onboarded tenant — so an operator who spawns a thousand agents
              still moves the price exactly once. When one tenant reports a
              venue, every other tenant's permit for it costs more on the next
              quote.
            </p>
            <p>
              And when that premium clears the owner's per-call cap, the agent's
              own budget refuses the trade. Nobody was ever told no.{" "}
              <b>k only tightens</b>: the harness can raise it, and a person is
              the only thing that can lower it.
            </p>
          </div>
          <figure className="artifact">
            <figcaption>scripts/herd-demo.ts, against the live hub</figcaption>
            <pre>
              <code>
                <span className="c-dim">08:50:56.798</span> tenant B quotes 0x…dEaD
                {"\n             "}
                <span className="c-gold">0.005 HBAR</span> · 0 reporters{"\n\n"}
                <span className="c-dim">08:50:57.060</span> tenant A reports it
                {"\n             "}→ 201{" "}
                <span className="c-str">
                  {"{"}before:0.005, after:0.01{"}"}
                </span>
                {"\n\n"}
                <span className="c-dim">08:50:57.337</span> tenant B quotes 0x…dEaD
                {"\n             "}
                <span className="c-gold">0.01 HBAR</span> · 1 reporter
              </code>
            </pre>
            <p className="artifact-note">
              Tenant B did nothing. Tenant A was the one attacked. Check the
              quote yourself — it is free:{" "}
              <a
                href={`${HUB}/v1/risk/quote?venue=0x000000000000000000000000000000000000dEaD`}
                target="_blank"
                rel="noreferrer"
              >
                /v1/risk/quote
              </a>
            </p>
          </figure>
        </div>
      </section>

      {/* 5 — the x402 lane. */}
      <section className="band" id="lane">
        <div className="wrap band-grid">
          <div className="band-copy">
            <div className="kicker">Paid per decision</div>
            <h2>Six routes. Two free. The rest settle in HBAR.</h2>
            <p>
              The feed head and the risk quote cost nothing, because the herd
              wants reports and the quote is the same number the paid route puts
              in its 402. The rest are priced per <i>decision</i> rather than per
              request: a policy evaluation per rule, a venue quote per venue, the
              permit at whatever the herd says that venue is worth.
            </p>
            <p>
              The network fee is charged to the facilitator, so an agent needs a
              price — not a gas budget.
            </p>
          </div>
          <figure className="artifact">
            <figcaption>settled on Hedera testnet</figcaption>
            <pre>
              <code>
                <span className="c-key">transaction</span>{"\n  "}
                <span className="c-gold">0.0.7162784@1788858107.062291812</span>
                {"\n"}
                <span className="c-key">status</span>{" "}
                <span className="c-str">SUCCESS</span>
                {"\n"}
                <span className="c-key">amount</span> 0.0005 HBAR{"\n"}
                <span className="c-key">from</span> 0.0.10418423{" "}
                <span className="c-dim">(agent)</span>
                {"\n"}
                <span className="c-key">to</span> 0.0.10419048{" "}
                <span className="c-dim">(hub treasury)</span>
                {"\n"}
                <span className="c-key">fee</span>{" "}
                <span className="c-dim">charged to the facilitator</span>
              </code>
            </pre>
            <p className="artifact-note">
              Readable on the public mirror node. Nothing about it is our word.
            </p>
          </figure>
        </div>
      </section>

      {/* 6 — the fail-closed gate. */}
      <section className="band band-alt" id="gate">
        <div className="wrap band-grid">
          <div className="band-copy">
            <div className="kicker">The gate</div>
            <h2>When it cannot check, it refuses.</h2>
            <p>
              <code>/v1/policy/evaluate</code> runs seven rules against the
              agent's <i>real</i> budget, read from the governor rather than from
              what the caller claims. Two of them need the <b>shape</b> of past
              spending — the largest single payment, how many made up the total,
              the window they arrived in — and a running total erases all of
              that. So a stale index makes them <code>evaluated: false</code> and
              the verdict a refusal.
            </p>
            <p>
              Cato, the example agent, runs the opposite rule on itself and fails{" "}
              <i>open</i>: it stands down above 3× its own largest ever payment,
              because an indexer hiccup should not strand a live agent to protect
              what the governor already enforces.
            </p>
          </div>
          <figure className="artifact">
            <figcaption>a refusal, and what it ignored</figcaption>
            <pre>
              <code>
                <span className="c-key">"name"</span>:{" "}
                <span className="c-str">"no_burst"</span>,{"\n"}
                <span className="c-key">"evaluated"</span>:{" "}
                <span className="c-red">false</span>
                {"\n"}
                <span className="c-key">"allowed"</span>:{" "}
                <span className="c-red">false</span>
                {"\n"}
                <span className="c-key">"denied_because"</span>:{"\n  "}
                <span className="c-str">"could not evaluate no_burst,</span>
                {"\n   "}
                <span className="c-str">within_precedent — refusing</span>
                {"\n   "}
                <span className="c-str">rather than assuming"</span>
                {"\n\n"}
                <span className="c-key">"superseded"</span>: {"{"}
                {"\n  "}
                <span className="c-key">"epoch_left_hbar"</span>:{" "}
                <span className="c-str">"99999"</span>,{"\n  "}
                <span className="c-key">"used_instead"</span>:{" "}
                <span className="c-gold">"0.002"</span>
                {"\n}"}
              </code>
            </pre>
            <p className="artifact-note">
              The caller claimed 99999 of headroom. The chain said 0.002. The
              gate used the chain's.
            </p>
          </figure>
        </div>
      </section>

      <section id="try" className="band band-try">
        <div className="wrap">
          <TryIt />
        </div>
      </section>

      {/* 7 — continuity. The honesty is the argument. */}
      <section className="band" id="continuity">
        <div className="wrap band-grid">
          <div className="band-copy">
            <div className="kicker">Continuity</div>
            <h2>What is eight days old, and what is not.</h2>
            <p>
              The governor, the receipts, the guardian and the X Layer deployment
              were built in August for a different hackathon and have been public
              under MIT since. The tag <code>pre-ethonline</code> is the boundary.
            </p>
            <p>
              The herd, the hub, the x402 lane, the subgraph, the fail-closed
              gate, Cato's self-check and three of the four chains were written
              between 4 and 13 September. The August core is why the September
              work has something real to enforce against.
            </p>
          </div>
          <figure className="artifact">
            <figcaption>git diff --stat pre-ethonline..HEAD</figcaption>
            <pre>
              <code>
                46 commits · 60 files{"\n"}
                <span className="c-gold">+6,649</span> /{" "}
                <span className="c-red">−213</span>
                {"\n"}
                tests <span className="c-dim">23 →</span>{" "}
                <span className="c-gold">64</span>
              </code>
            </pre>
            <p className="artifact-note">
              <code>package-lock.json</code> excluded — on its own it would
              flatter that insertion count by 2.5×. The governor holds the{" "}
              <b>same address</b> on Arc and Base Sepolia:{" "}
              <code>0x99D7fc…3b24</code> — same deployer, same nonce,
              deterministic CREATE.
            </p>
          </figure>
        </div>
      </section>

      <section className="closer">
        <div className="wrap">
          <h2>Nothing here asks to be believed.</h2>
          <p className="sub">Pick a number off this page and go check it.</p>
          <div className="cta-row">
            <a className="btn btn-gold" href="#/app">
              Open the treasury
            </a>
            <a className="btn btn-ghost" href={GITHUB} target="_blank" rel="noreferrer">
              Read the contracts →
            </a>
          </div>
        </div>
      </section>

      <footer className="wrap footer">
        <div>
          <a className="wordmark" href="#/">
            QU<span className="ae">Æ</span>STOR
          </a>
          <div style={{ marginTop: 6 }}>
            Rome gave its treasurers one word for emergencies.
          </div>
        </div>
        <div style={{ display: "flex", gap: 22 }}>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="#/app">Dashboard</a>
        </div>
      </footer>
    </div>
  );
}
