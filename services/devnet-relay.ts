import express, { type Express } from "express";
import { STOCKS_PROGRAM_ID } from "../solana/client";
import { RELAYED_METHODS } from "../solana/relay-fetch";
import { safeMessage } from "../stocks/redact";

/**
 * Solana devnet reads for the explorer, through the keyed RPC this hub
 * already has.
 *
 * The explorer's Solana pages read the chain from the viewer's browser, and
 * the public devnet endpoint throttles hard: the house agent's page took about
 * twenty seconds, most of it web3.js waiting out 429s. This forwards the few
 * read methods those pages make (solana/relay-fetch.ts names them) to
 * SOLANA_DEVNET_RPC_URL, and nothing else: no method that writes, no scan of
 * any program but the governor's. What every viewer reads alike is kept for a
 * few seconds and fetched once, however many ask at the same moment; what a
 * wallet reads about itself is relayed but not kept, so an owner sees a
 * deposit as soon as it lands.
 *
 * The same key signs the devnet lane's trades, so the relay spends from a
 * budget of its own and leaves the rest of the key's rate to them. Past the
 * budget a caller is told 429, and the explorer goes back to the public
 * endpoint: it is never worse off than before the relay existed.
 *
 * The key stays here. An upstream failure reaches the caller as a status and
 * a fixed sentence; an upstream JSON-RPC error, redacted.
 */

export interface DevnetRelayConfig {
  rpcUrl: string;
  /** Upstream credits a minute; Helius prices a program scan at ten and every other read here at one. */
  creditsPerMinute: number;
  /** And a day: the lane's own trades draw on the same key's monthly credits. */
  creditsPerDay: number;
  /** Upstream calls a second, so the relay cannot take the whole key's rate from the lane's trades. */
  callsPerSecond: number;
  /** How long a read waits for the next second's calls before it is refused. */
  paceMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const DEVNET_RELAY_PATH = "/v1/solana/devnet";

const MAX_BATCH = 5;
/** getMultipleAccounts: the explorer asks for one vault per governor, and the RPC itself allows 100. */
const MAX_KEYS = 100;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_KEPT_BYTES = 128_000;
const MAX_KEPT = 256;
const UPSTREAM_TIMEOUT_MS = 5_000;
/** A read waits this long at most for a call a second to come free; with the upstream timeout, under the explorer's 8 s. */
const PACE_MS = 2_000;
const PACE_STEP_MS = 50;
const TTL_MS = 5_000;
const SETTLED_TTL_MS = 10 * 60_000;
/** What a wallet reads about itself: relayed, never kept. */
const UNKEPT = new Set(["getAccountInfo", "getBalance", "getTokenAccountBalance"]);
const CREDITS: Record<string, number> = { getProgramAccounts: 10 };

type RpcId = string | number | null;
interface RpcCall { id: RpcId; method: string; params: unknown[] }
type Outcome = { result: unknown } | { error: { code: number; message: string } };
interface Kept { until: number; outcome: Outcome }

class RelayRefusal extends Error {
  constructor(readonly status: number, readonly code: number, message: string) {
    super(message);
  }
}

export function devnetRelayFromEnv(): DevnetRelayConfig | null {
  const rpcUrl = process.env.SOLANA_DEVNET_RPC_URL;
  if (!rpcUrl || process.env.SOLANA_DEVNET_RELAY === "0") return null;
  return {
    rpcUrl,
    creditsPerMinute: Number(process.env.SOLANA_DEVNET_RELAY_CREDITS_PER_MIN ?? 300),
    // Thirty days of this stays under a free plan's million credits a month,
    // with room for the lane's own reads and the mainnet curve watcher.
    creditsPerDay: Number(process.env.SOLANA_DEVNET_RELAY_CREDITS_PER_DAY ?? 20_000),
    callsPerSecond: Number(process.env.SOLANA_DEVNET_RELAY_CALLS_PER_SEC ?? 5),
  };
}

/** A JSON-RPC body as calls this relay will make, or the reason it will not. */
function parseCalls(body: unknown): RpcCall[] {
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || items.length > MAX_BATCH) throw new RelayRefusal(400, -32600, `a batch here holds 1 to ${MAX_BATCH} calls`);
  return items.map((item) => {
    const { id = null, method, params = [] } = (item ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof method !== "string" || !Array.isArray(params) || !(id === null || typeof id === "string" || typeof id === "number")) {
      throw new RelayRefusal(400, -32600, "each call needs a method, a params array and an id");
    }
    if (!RELAYED_METHODS.has(method)) {
      throw new RelayRefusal(400, -32601, "that method is not relayed: this relay only reads, for the Quaestor explorer");
    }
    if (method === "getProgramAccounts" && params[0] !== STOCKS_PROGRAM_ID.toBase58()) {
      throw new RelayRefusal(400, -32602, "only the Quaestor stocks program's accounts are scanned here");
    }
    if (method === "getMultipleAccounts" && !(Array.isArray(params[0]) && params[0].length <= MAX_KEYS)) {
      throw new RelayRefusal(400, -32602, `at most ${MAX_KEYS} accounts a call`);
    }
    return { id, method, params };
  });
}

/** A fixed window that admits `limit` units every `ms`. */
function fixedWindow(ms: number, limit: number, now: () => number) {
  let start = -Infinity;
  let used = 0;
  return {
    fits(units: number): boolean {
      if (now() - start >= ms) {
        start = now();
        used = 0;
      }
      return used + units <= limit;
    },
    take(units: number): void {
      used += units;
    },
  };
}

/** A body read no further than `max` bytes: an account can be ten megabytes, and this instance has 512. */
async function readCapped(res: globalThis.Response, max: number): Promise<{ text: string; bytes: number }> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new Error("the devnet RPC's answer is too large to relay");
  if (!res.body) return { text: "", bytes: 0 };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > max) throw new Error("the devnet RPC's answer is too large to relay");
    text += decoder.decode(chunk, { stream: true });
  }
  return { text: text + decoder.decode(), bytes };
}

export function mountDevnetRelay(app: Express, cfg: DevnetRelayConfig): void {
  const now = cfg.now ?? Date.now;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const kept = new Map<string, Kept>();
  const inFlight = new Map<string, Promise<Outcome>>();
  const second = fixedWindow(1_000, cfg.callsPerSecond, now);
  const minute = fixedWindow(60_000, cfg.creditsPerMinute, now);
  const day = fixedWindow(86_400_000, cfg.creditsPerDay, now);

  const paceMs = cfg.paceMs ?? PACE_MS;

  /**
   * Take one upstream call's credits. A spent minute or day is refused at once;
   * a full second is waited out, because a page's reads arrive in bursts and a
   * refusal sends the rest of that page to the public endpoint for half a minute.
   */
  const spend = async (credits: number): Promise<boolean> => {
    for (let waited = 0; ; waited += PACE_STEP_MS) {
      if (!minute.fits(credits) || !day.fits(credits)) return false;
      if (second.fits(1)) {
        second.take(1);
        minute.take(credits);
        day.take(credits);
        return true;
      }
      if (waited >= paceMs) return false;
      await new Promise((resolve) => setTimeout(resolve, PACE_STEP_MS));
    }
  };

  const upstream = async (call: RpcCall): Promise<{ outcome: Outcome; bytes: number }> => {
    const res = await fetchImpl(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the devnet RPC answered ${res.status}`);
    const { text, bytes } = await readCapped(res, MAX_RESPONSE_BYTES);
    const body = JSON.parse(text) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (body.error) {
      const code = typeof body.error.code === "number" ? body.error.code : -32000;
      return { outcome: { error: { code, message: safeMessage(body.error.message, 200) } }, bytes };
    }
    if (!("result" in body)) throw new Error("the devnet RPC answered without a result");
    return { outcome: { result: body.result }, bytes };
  };

  const ttlFor = (call: RpcCall, outcome: Outcome): number => {
    if (UNKEPT.has(call.method) || "error" in outcome) return 0;
    // A transaction a minute old is long past finality, about thirteen seconds
    // on devnet: its answer cannot change, and a trade's page asks on every visit.
    const blockTime = (outcome.result as { blockTime?: unknown } | null)?.blockTime;
    if (call.method === "getTransaction" && typeof blockTime === "number" && now() / 1000 - blockTime > 60) return SETTLED_TTL_MS;
    return TTL_MS;
  };

  const answer = async (call: RpcCall): Promise<{ outcome: Outcome; hit: boolean }> => {
    const key = `${call.method}:${JSON.stringify(call.params)}`;
    const found = kept.get(key);
    if (found && found.until > now()) return { outcome: found.outcome, hit: true };
    if (found) kept.delete(key);
    let pending = inFlight.get(key);
    if (!pending) {
      // In flight from the moment it is asked, so a read waiting for its turn
      // is shared too, and so is a refusal.
      pending = (async () => {
        if (!(await spend(CREDITS[call.method] ?? 1))) {
          throw new RelayRefusal(429, -32005, "this relay's devnet budget is spent for the moment; use a public endpoint");
        }
        // Kept from when it was asked, not when it was answered: a read begun
        // before a transaction landed is gone by the page's second refresh.
        const asked = now();
        const { outcome, bytes } = await upstream(call);
        const ttl = ttlFor(call, outcome);
        if (ttl > 0 && bytes <= MAX_KEPT_BYTES) {
          // A map strangers can grow has a ceiling: the oldest entry goes.
          if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value as string);
          kept.set(key, { until: asked + ttl, outcome });
        }
        return outcome;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return { outcome: await pending, hit: false };
  };

  // text/plain as well as JSON: the explorer sends text/plain so a browser
  // makes no preflight request before each read.
  const json = express.json({ limit: "8kb", type: ["application/json", "text/plain"] });
  app.post(DEVNET_RELAY_PATH, json, async (req, res) => {
    const single = !Array.isArray(req.body);
    const id: RpcId = single && (typeof req.body?.id === "string" || typeof req.body?.id === "number") ? req.body.id : null;
    try {
      const calls = parseCalls(req.body);
      const answers = await Promise.all(calls.map(answer));
      const replies = answers.map(({ outcome }, i) => ({ jsonrpc: "2.0", id: calls[i].id, ...outcome }));
      res.setHeader("X-Relay-Cache", answers.every((a) => a.hit) ? "hit" : "miss");
      res.json(single ? replies[0] : replies);
    } catch (error) {
      if (error instanceof RelayRefusal) {
        if (error.status === 429) res.setHeader("Retry-After", "10");
        res.status(error.status).json({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message } });
        return;
      }
      // Whatever this is came from the upstream call, whose URL holds the key.
      // The detail goes to the log, redacted; the caller gets a fixed sentence.
      console.error("[devnet-relay] upstream failure:", safeMessage(error, 200));
      res.status(502).json({ jsonrpc: "2.0", id, error: { code: -32603, message: "the devnet RPC behind this relay did not answer; use a public endpoint" } });
    }
  });

  console.log(`[devnet-relay] mounted at ${DEVNET_RELAY_PATH}: ${RELAYED_METHODS.size} read methods, up to ${cfg.creditsPerMinute} credits a minute and ${cfg.creditsPerDay} a day upstream`);
}
