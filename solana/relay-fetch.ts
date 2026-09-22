/**
 * A fetch for web3.js's Connection that sends the explorer's reads to the
 * stocks hub's devnet relay, and everything else where web3.js was sending it.
 *
 * The public devnet endpoint throttles, and web3.js answers a 429 by waiting
 * and asking again: half a second, then one, two, four. A page that makes
 * twenty reads spends most of its time waiting. The relay answers the same
 * reads from a keyed endpoint and, for what every viewer reads alike, from a
 * few seconds' memory.
 *
 * It is a detour, never a dependency. A relay that is down, asleep, slow, not
 * deployed or out of budget sends the read back to the public endpoint, and is
 * then left alone for half a minute so a page does not pay for the detour on
 * every call. A wallet's transaction, the blockhash it signs over and the
 * confirmation that follows are never relayed: they go out exactly as before.
 *
 * Shared with the hub (services/devnet-relay.ts), which relays exactly these
 * methods, so the two lists cannot drift apart.
 */

/** The reads the explorer's Solana pages make. Nothing here writes. */
export const RELAYED_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBalance",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
]);

export interface RelayingFetchOptions {
  /** How long to wait for the relay before asking the public endpoint instead. */
  timeoutMs?: number;
  /** How long to leave the relay alone after it failed once. */
  restMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The method names in a JSON-RPC body, or null when it is not one. */
function methodsOf(body: unknown): string[] | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    const methods = (Array.isArray(parsed) ? parsed : [parsed]).map((call) => (call as { method?: unknown } | null)?.method);
    return methods.length && methods.every((m): m is string => typeof m === "string") ? methods : null;
  } catch {
    return null;
  }
}

export function relayingFetch(relayUrl: string, options: RelayingFetchOptions = {}): typeof fetch {
  const { timeoutMs = 8_000, restMs = 30_000, now = Date.now } = options;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let restUntil = 0;
  return async (input, init) => {
    const methods = methodsOf(init?.body);
    if (methods?.every((m) => RELAYED_METHODS.has(m)) && now() >= restUntil) {
      try {
        // text/plain keeps this a simple cross-origin request, with no preflight
        // in front of every read; the relay parses it as JSON either way. The
        // solana-client header web3.js adds would force one, so it is not sent.
        const res = await fetchImpl(relayUrl, {
          method: "POST",
          headers: { "content-type": "text/plain;charset=UTF-8" },
          body: init?.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return res;
      } catch {
        // Down, asleep or slow: the public endpoint answers instead.
      }
      restUntil = now() + restMs;
    }
    return fetchImpl(input, init);
  };
}
