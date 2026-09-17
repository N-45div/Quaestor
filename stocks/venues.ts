/**
 * The venues a governor may route a trade through.
 *
 * On-chain, permission is an `ApprovedRouter` PDA per program: an owner may
 * hold several at once and the operator picks between them per trade. This is
 * the client-side address book for that allowlist — the mapping from a name a
 * human uses ("meteora-dlmm") to the program id the PDA is derived from.
 *
 * Addresses live here rather than in the program. Compiling a venue into the
 * binary means a redeploy to add one, and it puts an address beyond the reach
 * of the check below, which confirms against the chain that the thing being
 * approved is actually an executable program.
 */

/** Every venue id known to the registry, plus any registered at runtime. */
export type VenueId = "jupiter" | "meteora-dlmm" | "meteora-dbc" | (string & {});

export type VenueKind = "aggregator" | "amm" | "bonding-curve";

export interface Venue {
  id: VenueId;
  /**
   * Written verbatim into the on-chain `ApprovedRouter`, whose label field is a
   * fixed `[u8; 16]`. Longer names cannot be stored, so they are rejected at
   * registration rather than silently truncated on an explorer.
   */
  label: string;
  programId: string;
  kind: VenueKind;
  /**
   * The date this address was last confirmed executable on mainnet. A program
   * id copied from documentation is a claim; this records when it was checked.
   */
  verifiedOn: string;
}

export const VENUE_LABEL_MAX_BYTES = 16;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Verified executable on mainnet-beta under BPFLoaderUpgradeable on 17 Sep 2026.
 *
 * Clawpump is deliberately absent. What it publishes is a token mint, not a
 * swap program, and it appears to launch onto pump.fun rather than run a venue
 * of its own — so there is no address here to approve. Add it with
 * `registerVenue` once its program id is known; an allowlist is the wrong place
 * for a guess.
 */
const BUILT_IN: readonly Venue[] = [
  {
    id: "jupiter",
    label: "jupiter",
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    kind: "aggregator",
    verifiedOn: "2026-09-17",
  },
  {
    id: "meteora-dlmm",
    label: "meteora-dlmm",
    programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    kind: "amm",
    verifiedOn: "2026-09-17",
  },
  {
    id: "meteora-dbc",
    label: "meteora-dbc",
    programId: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    kind: "bonding-curve",
    verifiedOn: "2026-09-17",
  },
];

const registry = new Map<VenueId, Venue>(BUILT_IN.map((v) => [v.id, v]));

export class UnknownVenueError extends Error {
  constructor(id: string) {
    super(`unknown venue "${id}" — known: ${[...registry.keys()].join(", ")}`);
    this.name = "UnknownVenueError";
  }
}

function assertVenue(venue: Venue): void {
  if (!BASE58.test(venue.programId)) {
    throw new Error(`venue "${venue.id}" has a program id that is not base58: ${venue.programId}`);
  }
  const bytes = Buffer.byteLength(venue.label, "utf8");
  if (bytes === 0 || bytes > VENUE_LABEL_MAX_BYTES) {
    throw new Error(
      `venue "${venue.id}" label must be 1..${VENUE_LABEL_MAX_BYTES} bytes on-chain, got ${bytes}`,
    );
  }
}

for (const venue of BUILT_IN) assertVenue(venue);

/**
 * Add a venue the registry did not ship with — a new Meteora pool program, a
 * launchpad whose address we learn later, a devnet deployment standing in for
 * one. Re-registering an id replaces it, so config can override a built-in
 * without the registry having to know it was going to be overridden.
 */
export function registerVenue(venue: Venue): Venue {
  assertVenue(venue);
  registry.set(venue.id, venue);
  return venue;
}

export function resolveVenue(id: VenueId): Venue {
  const venue = registry.get(id);
  if (!venue) throw new UnknownVenueError(id);
  return venue;
}

export function knownVenues(): Venue[] {
  return [...registry.values()];
}

/** The venue a program id belongs to, for reading a receipt back. */
export function venueForProgram(programId: string): Venue | undefined {
  return [...registry.values()].find((v) => v.programId === programId);
}

/**
 * The venue assumed when a quote does not name one.
 *
 * Quotes predate the registry, so an unlabelled quote is a Jupiter quote. This
 * keeps an older caller working while still refusing a venue an owner has not
 * approved: absent is a value, not a wildcard.
 */
export const DEFAULT_VENUE: VenueId = "jupiter";

/**
 * Confirm against the chain that a venue is what it claims to be, before an
 * owner signs a transaction approving it.
 *
 * The on-chain allowlist cannot do this: at approval time the program is only
 * recorded, never called, so a typo would sit in the allowlist until a trade
 * failed against it. Checking here is the difference between discovering a bad
 * address now and discovering it when a route will not settle.
 */
export async function verifyVenueOnChain(
  venue: Venue,
  getAccountInfo: (address: string) => Promise<{ executable: boolean } | null>,
): Promise<void> {
  const info = await getAccountInfo(venue.programId);
  if (!info) throw new Error(`venue "${venue.id}" has no account at ${venue.programId}`);
  if (!info.executable) {
    throw new Error(`venue "${venue.id}" at ${venue.programId} is not an executable program`);
  }
}
