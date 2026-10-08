/**
 * An anchored curve's whole life as one instrument: the bonding curve while it
 * fills, the DAMM v2 pool it graduates into after.
 *
 * A route pinned to a curve breaks the moment the curve graduates, and most
 * launchpad integrations end there. Here the token keeps the same mint, the
 * governor keeps the same position account and caps, and only the venue
 * changes. These pieces ask DBC whether the curve has migrated, from the pool's
 * own flag, and send quotes, routes and the tape's price to the curve before
 * and to the pool after. A refused quote is never read as graduation: a buy too
 * large for what is left on the curve is the curve's answer, not a migration.
 */
import type { DammPool } from "./damm-venue";
import { DAMM_VENUE } from "./damm-venue";
import type { DbcPool, DbcPoolSighting } from "./dbc-venue";
import type { JupiterQuoteFetcher } from "./jupiter";
import type { LiveSample, TapeSource } from "./prices";
import type { JupiterQuote, StockInstrument } from "./types";

/** Whether the curve has graduated, from DBC's own migrated flag. */
export async function hasGraduated(curve: DbcPool): Promise<boolean> {
  return (await curve.spot()) === undefined;
}

/** Quotes from the curve while it fills, from the graduated pool after. */
export class LifecycleQuoteProvider implements JupiterQuoteFetcher {
  constructor(private readonly cfg: { curve: DbcPool; curveQuotes: JupiterQuoteFetcher; poolQuotes: JupiterQuoteFetcher }) {}

  async quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote> {
    return (await hasGraduated(this.cfg.curve))
      ? this.cfg.poolQuotes.quote(inputMint, outputMint, amount)
      : this.cfg.curveQuotes.quote(inputMint, outputMint, amount);
  }
}

/**
 * The token's own market for the tape: the curve's spot price while it fills,
 * the graduated pool's after. Either way it goes on the tokenized side, and the
 * gate goes on judging it against the share's price from sources that have
 * never heard of either pool.
 */
export class LifecyclePriceSource implements TapeSource {
  readonly id = "meteora-anchored-curve";
  readonly side = "tokenized" as const;
  private last: DbcPoolSighting | undefined;

  constructor(
    private readonly curve: DbcPool,
    private readonly pool: DammPool,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async sample(instruments: readonly StockInstrument[]): Promise<LiveSample[]> {
    if (!instruments.some((instrument) => instrument.mint === this.curve.baseMint)) return [];
    const t = this.now();
    const onCurve = await this.curve.spot();
    if (onCurve) {
      this.last = { observedAt: t, graduated: false, ...onCurve };
      return [{ mint: this.curve.baseMint, side: this.side, point: { t, price: onCurve.priceUsd, source: this.id } }];
    }
    const graduatedInto = { venue: DAMM_VENUE, pool: this.pool.address };
    const onPool = await this.pool.spot();
    this.last = { observedAt: t, graduated: true, progress: 1, priceUsd: onPool?.priceUsd, graduatedInto };
    // Migrated but the pool not readable yet: say nothing, and let the old price age out.
    if (!onPool) return [];
    return [{ mint: this.curve.baseMint, side: this.side, point: { t, price: onPool.priceUsd, source: this.id } }];
  }

  /** What the last tick saw; a public route reads this rather than the chain. */
  latest(): DbcPoolSighting | undefined {
    return this.last ? { ...this.last } : undefined;
  }
}
