/**
 * Route-permit pricing. Pure functions, no I/O, so the number a judge sees on
 * screen can be recomputed by hand from the inputs shown next to it.
 *
 * Quaestor does not block a venue other tenants have been attacked through —
 * it prices it. The permit to route through a venue costs
 *
 *     permit(venue) = base × (1 + k · distinctHumanReporters(venue, window))
 *
 * Reporters are counted per verified human, not per key, so the multiplier
 * cannot be inflated by spawning agents. When the premium exceeds the owner's
 * on-chain per-call cap for INFERENCE, the agent's own budget refuses the
 * purchase — the chain says no, Quaestor never has to.
 *
 * `k` is the single tighten-only scalar: the autopsy harness may raise it,
 * only a human may lower it.
 */

export const TINYBAR_PER_HBAR = 100_000_000n;

/** x402 asset id for native HBAR. */
export const HBAR_ASSET = "0.0.0";

export interface PermitQuote {
  /** Price in tinybars. */
  tinybars: bigint;
  base: bigint;
  k: number;
  reporters: number;
  /** base × multiplier = tinybars; shown so the arithmetic is auditable. */
  multiplier: number;
}

/**
 * Parse an HBAR decimal string ("0.01") into tinybars without floating point.
 * Accepts up to 8 fractional digits; anything finer is rejected, not rounded.
 */
export function tinybarsFromHbar(hbar: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(hbar.trim());
  if (!m) throw new Error(`not an HBAR amount: ${JSON.stringify(hbar)}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(8, "0"));
  return whole * TINYBAR_PER_HBAR + frac;
}

/** Render tinybars as an HBAR decimal string, trailing zeros trimmed. */
export function hbarFromTinybars(tinybars: bigint): string {
  const whole = tinybars / TINYBAR_PER_HBAR;
  const frac = (tinybars % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * The permit price for one venue. `k` is applied with 4 decimals of fixed-point
 * precision so the result is deterministic across machines.
 */
export function permitPrice(base: bigint, k: number, reporters: number): PermitQuote {
  if (base <= 0n) throw new Error("base must be positive");
  if (!(k >= 0)) throw new Error("k must be >= 0");
  if (!Number.isInteger(reporters) || reporters < 0) throw new Error("reporters must be a count");
  const K_SCALE = 10_000n;
  const kFixed = BigInt(Math.round(k * Number(K_SCALE)));
  // multiplier = 1 + k·r, in fixed point
  const multFixed = K_SCALE + kFixed * BigInt(reporters);
  const tinybars = (base * multFixed) / K_SCALE;
  return {
    tinybars,
    base,
    k,
    reporters,
    multiplier: Number(multFixed) / Number(K_SCALE),
  };
}

/** x402 `AssetAmount` for a native-HBAR price. */
export function hbarPrice(tinybars: bigint): { asset: string; amount: string } {
  return { asset: HBAR_ASSET, amount: tinybars.toString() };
}

/**
 * Per-item metering: N items at `unit` each, clamped to [1, max] so a client
 * cannot buy a zero-priced or absurdly large request.
 */
export function meteredPrice(unit: bigint, items: number, max = 50): bigint {
  const n = Math.min(Math.max(Math.floor(items) || 1, 1), max);
  return unit * BigInt(n);
}
