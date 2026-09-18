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

/** "test" is a fixture venue — real on chain, but not a market. */
export type VenueKind = "aggregator" | "amm" | "bonding-curve" | "test";

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
 * A venue earns a place here by being an executable swap program at a known
 * address, checked rather than quoted from documentation. Anything short of
 * that — a launchpad that publishes a token mint instead of a program, an
 * address nobody has confirmed — goes through `registerVenue` once it is known.
 * An allowlist is the wrong place for a guess.
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
 * A venue said there is no route. Distinct from every other failure on purpose.
 *
 * A rate limit, a timeout or an outage all look like "the quote threw", and
 * treating them as "no route" silently marks instruments untradeable whenever
 * an API is busy — which is exactly when a catalogue must not quietly change
 * shape. Only this error means the venue answered and the answer was no.
 */
export class NoRouteError extends Error {
  constructor(message = "no route") {
    super(message);
    this.name = "NoRouteError";
  }
}

export interface MintRoutability {
  /** Venues observed able to fill the mint. */
  venues: VenueId[];
  /** Venues that could not be asked. Not the same as venues that said no. */
  undetermined: VenueId[];
}

/**
 * Which venues can actually fill a given mint against USDC.
 *
 * An instrument being listed and an instrument being tradeable are different
 * facts. A provider's catalogue says what exists; only a venue says what can be
 * bought. Treating the first as the second is how an agent gets a quote for
 * something no route can settle.
 */
export interface InstrumentRoutability {
  routable(mints: readonly string[], usdcMint: string): Promise<Map<string, MintRoutability>>;
}

/** The part of a quote source routability needs: enough to tell a fill from a guess. */
export interface QuoteProbe {
  quote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
  ): Promise<{ minimumOutput?: bigint }>;
}

export interface QuoteProbeOptions {
  probeAmount?: bigint;
  /** Tries per venue before giving up and calling the answer undetermined. */
  attempts?: number;
  /** Pause between requests. Public quote APIs rate-limit well below the rate
   *  a parallel probe of a whole catalogue would otherwise ask at. */
  spacingMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decide routability by asking each venue for a small quote.
 *
 * Probing is sequential and spaced rather than parallel. A catalogue of eight
 * mints across two venues is sixteen requests, and issuing them at once is the
 * fastest way to be rate-limited into concluding that nothing trades.
 */
export function quoteProbeRoutability(
  sources: Partial<Record<VenueId, QuoteProbe>>,
  options: QuoteProbeOptions | bigint = {},
): InstrumentRoutability {
  // A bigint keeps the earlier positional `probeAmount` call working.
  const opts: QuoteProbeOptions = typeof options === "bigint" ? { probeAmount: options } : options;
  const probeAmount = opts.probeAmount ?? 1_000_000n;
  const attempts = Math.max(1, opts.attempts ?? 2);
  const spacingMs = opts.spacingMs ?? 0;
  const entries = Object.entries(sources).filter(([, source]) => source) as Array<[VenueId, QuoteProbe]>;

  /** true = fills it, false = said no, null = could not be asked. */
  async function ask(source: QuoteProbe, mint: string, usdcMint: string): Promise<boolean | null> {
    let undetermined = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(spacingMs * (attempt + 1));
      try {
        const quote = await source.quote(usdcMint, mint, probeAmount);
        // An answer with no guaranteed floor is an opinion, not a fill.
        return quote.minimumOutput !== undefined && quote.minimumOutput > 0n;
      } catch (error) {
        if (error instanceof NoRouteError) return false;
        undetermined = true;
      }
    }
    return undetermined ? null : false;
  }

  return {
    async routable(mints, usdcMint) {
      const found = new Map<string, MintRoutability>();
      for (const mint of mints) {
        const venues: VenueId[] = [];
        const undetermined: VenueId[] = [];
        for (const [id, source] of entries) {
          const answer = await ask(source, mint, usdcMint);
          if (answer === true) venues.push(id);
          else if (answer === null) undetermined.push(id);
          if (spacingMs) await sleep(spacingMs);
        }
        // Sorted, so a catalogue does not reshuffle between refreshes.
        found.set(mint, { venues: venues.sort(), undetermined: undetermined.sort() });
      }
      return found;
    },
  };
}

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
