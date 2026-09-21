import { useSolana } from "../../lib/solana/store";
import { SolanaTradesTable } from "./common";

/** Every trade any governor on the program has settled. */
export function SolanaTrades() {
  const { trades } = useSolana();
  return <>
    <section className="page-intro compact"><div><span className="eyebrow">SETTLED TRADES · SOLANA DEVNET</span><h1>Trades</h1><p>Every trade a governor settled, as the program recorded it: what it authorised, what it spent, the floor it held the venue to and what arrived. Each record binds the hash of the agent&rsquo;s decision.</p></div></section>
    <SolanaTradesTable rows={trades} title="All settled trades" />
  </>;
}
