import { ArrowUpRight } from "lucide-react";
import { explorerHref } from "../../components/ExplorerShell";
import { timeAgo } from "../../lib/format";
import { DEVNET, MINT_NAMES, explorerUrl } from "../../lib/solana/devnet";
import { shortKey, units, type GovernorView, type TradeToken, type TradeView } from "../../lib/solana/chain";
import { useSolana } from "../../lib/solana/store";

/** A governor has no name on chain; it is its agent, known by the operator key it trades with. */
export function agentLabel(g: Pick<GovernorView, "address" | "operator">): string {
  return g.address === DEVNET.houseGovernor ? "Hub house agent" : `Agent ${shortKey(g.operator.toBase58())}`;
}

export const usdc = (amount: bigint | null, digits = 2) => units(amount, DEVNET.usdcDecimals, digits);

/**
 * The spend that counts against this epoch. The program stores the epoch it
 * last traded in and rolls it on the next trade, so a governor that has not
 * traded since the epoch turned still shows the old total; that total no
 * longer limits anything.
 */
export function liveEpoch(g: Pick<GovernorView, "currentEpoch" | "epochLength" | "spentInEpoch">, now = Date.now()) {
  const epoch = BigInt(Math.floor(now / 1000)) / (g.epochLength > 0n ? g.epochLength : 1n);
  return { epoch, spent: epoch === g.currentEpoch ? g.spentInEpoch : 0n };
}

export function KeyLink({ value, kind = "address" }: { value: string; kind?: "address" | "tx" }) {
  return <a className="mono-link" href={explorerUrl(kind, value)} target="_blank" rel="noreferrer" title={value}>{shortKey(value)}<ArrowUpRight size={12} /></a>;
}

/** A token amount in its own decimals once the token is known; in base units until then. */
export function TokenAmount({ amount, token, name = true }: { amount: bigint; token: TradeToken | undefined; name?: boolean }) {
  if (token) return <>{units(amount, token.decimals, 6)}{name && <small>{MINT_NAMES[token.mint] ?? shortKey(token.mint)}</small>}</>;
  return <>{amount.toLocaleString("en-US")}{name && <small>base units</small>}</>;
}

/**
 * Settled trades, as the program recorded them. The record does not name the
 * token; the store reads which one each trade delivered, and the amounts are
 * in base units until it has.
 */
export function SolanaTradesTable({ rows, title = "Latest settled trades", limit }: { rows: TradeView[]; title?: string; limit?: number }) {
  const { governors, tokens } = useSolana();
  const shown = limit ? rows.slice(0, limit) : rows;
  const governorOf = (address: string) => governors.find((g) => g.address === address);
  return (
    <section className="data-section">
      <div className="section-heading"><div><span className="eyebrow">ON-CHAIN ACTIVITY</span><h2>{title}</h2></div><span className="row-count">{rows.length} on chain</span></div>
      <div className="explorer-table-wrap">
        <table className="explorer-table activity-table">
          <thead><tr><th>Status</th><th>Agent</th><th>Spent</th><th>Received</th><th>Floor</th><th>Intent</th><th>Age</th><th>Record</th></tr></thead>
          <tbody>
            {shown.map((t) => {
              const g = governorOf(t.governor);
              return (
                <tr key={t.address}>
                  <td><span className="status-inline"><i />Settled</span></td>
                  <td><a className="table-primary" href={explorerHref(`/sol/agents/${t.governor}`)}>{g ? agentLabel(g) : shortKey(t.governor)}</a><small>{shortKey(t.governor)}</small></td>
                  <td className="numeric">{usdc(t.amountSpent, 6)} USDC</td>
                  <td className="numeric"><TokenAmount amount={t.actualOutput} token={tokens[t.address]} /></td>
                  <td className="numeric"><TokenAmount amount={t.minOutput} token={tokens[t.address]} name={false} /></td>
                  <td><a className="mono-link" href={explorerHref(`/sol/trades/${t.address}`)} title={`${t.intentId}: open the trade and its decision record`}>{t.intentId.slice(0, 10)}…</a></td>
                  <td title={new Date(t.settledAt).toLocaleString()}>{timeAgo(t.settledAt)}</td>
                  <td><KeyLink value={t.address} /></td>
                </tr>
              );
            })}
            {!shown.length && <tr><td className="table-empty" colSpan={8}>No trade has settled on this program yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
