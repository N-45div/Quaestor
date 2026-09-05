import { permitPrice, tinybarsFromHbar, type PermitQuote } from "./pricing";
import { DEFAULT_WINDOW_MS, normalizeVenue, type ThreatFeed } from "./threatfeed";

/**
 * One price function shared by everything that quotes a route permit — the
 * x402 lane that sells it, the hub that reports into it, the dashboard that
 * shows it — so the number is the same everywhere it appears.
 *
 * `k` is the tighten-only scalar. The autopsy harness may call `tighten()`;
 * nothing in this process can lower it. Loosening is a human action that
 * lands as a new process configuration, never as a method call here.
 */
export interface PermitPricer {
  readonly base: bigint;
  readonly windowMs: number;
  k(): number;
  /** Raise k. Returns the new value. A no-op if `next` is not strictly higher. */
  tighten(next: number): number;
  quote(venue: string): Promise<PermitQuote>;
  reporters(venue: string): Promise<number>;
}

export interface PermitPricerOptions {
  feed: ThreatFeed;
  /** Base permit price in HBAR, default "0.005". */
  baseHbar?: string;
  /** Initial k, default 1. */
  k?: number;
  windowMs?: number;
}

export function createPermitPricer(opts: PermitPricerOptions): PermitPricer {
  const base = tinybarsFromHbar(opts.baseHbar ?? "0.005");
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  let k = opts.k ?? 1;
  if (!(k >= 0)) throw new Error("PERMIT_K must be >= 0");

  const reporters = (venue: string) =>
    opts.feed.distinctReporters(normalizeVenue(venue), windowMs);

  return {
    base,
    windowMs,
    k: () => k,
    tighten(next: number) {
      if (Number.isFinite(next) && next > k) k = next;
      return k;
    },
    reporters,
    async quote(venue: string) {
      return permitPrice(base, k, await reporters(venue));
    },
  };
}
