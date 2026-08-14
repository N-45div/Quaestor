import { useStore } from "../state";
import { okb } from "../lib/format";

const GITHUB = "https://github.com/N-45div/Quaestor";

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
          <a href="#allowance">The allowance</a>
          <a href="#receipts">Receipts</a>
          <a href="#veto">The veto</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="btn btn-gold btn-sm" href="#/app">
            Open the treasury
          </a>
        </nav>
      </header>

      <section className="hero wrap">
        <div className="eyebrow">Built on X Layer · AI Season MMXXVI</div>
        <h1>
          Your agent doesn&rsquo;t need your wallet. It needs an <em>allowance</em>.
        </h1>
        <p className="sub">
          Quaestor gives your agent a wallet it cannot empty: hard on-chain
          budgets scoped by <i>purpose</i> — data, inference, trades — a receipt
          for every decision, and a watchdog that can stop it but never spend
          it. Enforced by consensus on X Layer, not by a config file the agent
          can read.
        </p>
        <div className="cta-row">
          <a className="btn btn-gold" href="#/app">
            Open the treasury
          </a>
          <a className="btn btn-ghost" href={GITHUB} target="_blank" rel="noreferrer">
            Read the contracts →
          </a>
        </div>
        <div className="fine">
          Live on X Layer testnet · budgets denominated in OKB · your keys never leave you
        </div>
        {ready && agents.length > 0 ? (
          <div className="live-stats">
            <span className="live-dot" /> live now: <b>{agents.length}</b>{" "}
            {agents.length === 1 ? "agent" : "agents"} governed · <b>{receipts.length}</b>{" "}
            receipts on record · <b>{okb(treasury)}</b> OKB under governance
          </div>
        ) : null}

        <div className="hero-console" aria-hidden="true">
          <div className="console-head">
            <span className="t">Agent allowance — current epoch</span>
            <span className="s">illustration</span>
          </div>
          <div className="meter">
            <div className="meter-label">
              <span className="name">
                <span className="dot dot-data" /> Data — paid API calls
              </span>
              <span className="val">epoch cap 0.5 OKB</span>
            </div>
            <div className="track">
              <div className="fill fill-data" />
            </div>
          </div>
          <div className="meter">
            <div className="meter-label">
              <span className="name">
                <span className="dot dot-inference" /> Inference — LLM spend
              </span>
              <span className="val">epoch cap 1 OKB</span>
            </div>
            <div className="track">
              <div className="fill fill-inference" />
            </div>
          </div>
          <div className="meter">
            <div className="meter-label">
              <span className="name">
                <span className="dot dot-execution" /> Execution — DEX trades
              </span>
              <span className="val">epoch cap 3 OKB</span>
            </div>
            <div className="track">
              <div className="fill fill-execution" />
            </div>
          </div>
        </div>
      </section>

      <section className="section wrap" id="problem">
        <div className="numeral">I</div>
        <h2>How much can your agent spend while you&rsquo;re asleep?</h2>
        <p className="lede">
          Today the honest answer is either <i>everything in the wallet</i> or{" "}
          <i>nothing, because you never dared connect one</i>. Autonomy stalls at
          the exact moment money enters the picture. And config-file limits
          don&rsquo;t help — your agent can read its own config, and so can
          whoever compromises it. A limit the spender can edit is a suggestion.
          Quaestor moves the limit somewhere neither of you can reach:
          consensus. And unlike a plain allowance, budgets here are scoped by{" "}
          <i>purpose</i> — an agent trusted to buy data can still be barred from
          trading with it.
        </p>
      </section>

      <section className="section wrap" id="allowance">
        <div className="numeral">II</div>
        <h2>One contract. Three budgets. Zero exceptions.</h2>
        <p className="lede">
          Register an agent, deposit OKB, set caps per epoch and per action.
          From then on, every coin the agent spends passes through the governor
          — or it doesn&rsquo;t move at all.
        </p>
        <div className="grid-3">
          <div className="card">
            <span className="cat-tag">Category · Data</span>
            <h3>
              <span className="dot dot-data" /> It buys its own signals
            </h3>
            <p>
              Paid APIs settled in metered OKB. Our oracle answers HTTP&nbsp;402
              with a price; the agent pays on-chain and redeems the receipt for
              exactly one response. No API keys to leak, nothing to invoice.
            </p>
          </div>
          <div className="card">
            <span className="cat-tag">Category · Inference</span>
            <h3>
              <span className="dot dot-inference" /> Even its thinking is metered
            </h3>
            <p>
              Every LLM call the agent makes is metered to the chain, so
              off-chain thinking still leaves an on-chain paper trail — cost,
              model, and the rationale it produced.
            </p>
          </div>
          <div className="card">
            <span className="cat-tag">Category · Execution</span>
            <h3>
              <span className="dot dot-execution" /> Ambition, capped
            </h3>
            <p>
              Swaps route through the DEX with per-trade and per-epoch
              ceilings. A strategy that wants to bet the treasury discovers it
              mathematically cannot.
            </p>
          </div>
        </div>
      </section>

      <section className="section wrap" id="receipts">
        <div className="numeral">III</div>
        <h2>Every coin tells you why it left.</h2>
        <p className="lede">
          Each spend commits a keccak-256 of the decision behind it — the
          prompt, the signal, the rationale — into a permanent on-chain receipt.
          When you ask <i>&ldquo;why did my agent buy at 3am?&rdquo;</i>, the
          answer isn&rsquo;t a log file someone rotated. It&rsquo;s evidence.
        </p>
        <div className="receipt-strip" aria-hidden="true">
          <div className="strip-head">What a receipt stream looks like</div>
          <div className="receipt-row">
            <span className="chip">
              <span className="dot dot-data" /> DATA
            </span>
            <span>paid oracle 0.001 OKB for momentum signal</span>
            <span className="hash">meta 0x8f2a…c41d</span>
            <span className="hash">epoch 12</span>
          </div>
          <div className="receipt-row">
            <span className="chip">
              <span className="dot dot-inference" /> INFERENCE
            </span>
            <span>metered LLM sizing call — &ldquo;dip vs SMA, lean in&rdquo;</span>
            <span className="hash">meta 0x31be…09aa</span>
            <span className="hash">epoch 12</span>
          </div>
          <div className="receipt-row">
            <span className="chip">
              <span className="dot dot-execution" /> EXECUTION
            </span>
            <span>swapped 0.02 OKB → 1.97 qUSD, within caps</span>
            <span className="hash">meta 0xd7e3…55f0</span>
            <span className="hash">epoch 12</span>
          </div>
        </div>
      </section>

      <section className="section wrap veto" id="veto">
        <div className="numeral">IV</div>
        <h2>Rome gave its treasurers one word for emergencies.</h2>
        <p className="lede">
          One transaction freezes an agent completely — no trades, no calls, no
          drain, no exceptions. Not a feature flag in someone&rsquo;s database: a
          wall in the contract. Resume is one transaction too, when{" "}
          <i>you</i> decide it&rsquo;s earned it.
        </p>
        <div className="seal">VETO</div>
      </section>

      <section className="section wrap" id="how">
        <div className="numeral">V</div>
        <h2>Four moves, then go to bed.</h2>
        <div className="steps">
          <div className="step">
            <h3>Register</h3>
            <p>
              Name the agent, give it a disposable operator key. The key can
              spend only through Quaestor — it is worthless anywhere else.
            </p>
          </div>
          <div className="step">
            <h3>Fund</h3>
            <p>
              Deposit OKB and set the caps: per epoch, per action, per
              category. Change them any time; the change is on-chain too.
            </p>
          </div>
          <div className="step">
            <h3>Delegate</h3>
            <p>
              Point the SDK at your agent id. Pay, meter, swap — three calls,
              receipts included. Any agent framework, any language with an RPC.
            </p>
          </div>
          <div className="step">
            <h3>Sleep</h3>
            <p>
              The watchdog reads the receipt stream and speaks up in plain
              English when spending looks wrong. Worst case, you veto.
            </p>
          </div>
        </div>
      </section>

      <footer className="wrap footer">
        <div>
          <a className="wordmark" href="#/">
            QU<span className="ae">Æ</span>STOR
          </a>
          <div style={{ marginTop: 6 }}>
            An allowance, not a wallet. Built for X Layer AI Season.
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
