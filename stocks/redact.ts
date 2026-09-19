/**
 * Text that crosses a trust boundary, in either direction.
 *
 * Two different problems share one fix. Going *out*: an error from an RPC
 * client or `fetch` carries the URL it was calling, and an RPC URL carries its
 * API key — in the query string or in the path — so an error message returned
 * verbatim hands a stranger the key. Coming *in*: names, descriptions and route
 * labels from third-party providers end up in front of a language model, where
 * a sentence is not just a sentence.
 *
 * Neither is solved by trusting the source. Both are solved by deciding, at the
 * boundary, what a string is allowed to be.
 *
 * This is a second line, not the first. The first is never putting a secret in
 * a message to begin with; this exists for the messages this code does not
 * write — the ones that come out of other people's libraries.
 */

/**
 * Characters a reader cannot see and a model can: controls, zero-width and
 * bidirectional marks, variation selectors, the invisible Hangul fillers, and
 * the Unicode tag block, which spells ASCII invisibly and is the usual channel
 * for smuggling instructions past a human reviewer.
 *
 * Built from code points rather than written as a literal, so that the source
 * of the file that removes invisible characters contains none.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x009f],
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xe0000, 0xe0fff],
];
const INVISIBLE_PATTERN = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("")}]`,
  "gu",
);

/** Any URL an RPC or HTTP client might quote, websockets included. Stops at whitespace and brackets, not at an apostrophe. */
const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"<>)\]}]+/gi;

/** `Authorization: Bearer x`, `authorization="Basic x"` — the scheme word is part of the header, not the secret. */
const AUTHORIZATION_PATTERN = /(?<![A-Za-z0-9])(proxy-)?authorization["']?\s*[=:]\s*["']?(?:[A-Za-z][\w-]*\s+)?[^\s"',;)}\]]+/gi;

/** A bare `Bearer x` / `Basic x`. The value must look opaque, so "the bearer certificates" is left alone. */
const SCHEME_PATTERN = /\b(bearer|basic)\s+(?=[^\s]*[\d._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * A credential by name: anything whose name contains key, token, secret,
 * password or credential — `api-key`, `x-api-key`, `client_secret`,
 * `refresh_token`, `privateKey`, a bare `key`.
 *
 * With `=`, or with a JSON-quoted name, it is unambiguous and always removed.
 */
const NAMED_ASSIGNMENT_PATTERN = /(?<![A-Za-z0-9])([\w-]*(?:key|token|secret|passw(?:or)?d|pwd|credential)[\w-]*)(?:["']?\s*=\s*["']?|["']\s*:\s*["']?)[^\s&"',;)}\]]+/gi;

/**
 * The same, written as prose. A name that can only be a credential — `api-key`,
 * `secret`, `password`, `refresh_token` — is removed whatever follows it.
 */
const NAMED_PROSE_STRICT_PATTERN = /(?<![A-Za-z0-9])([\w-]*(?:api[-_]?key|secret|passw(?:or)?d|pwd|credential)[\w-]*|[\w]+[-_](?:token|key)):\s*[^\s&"',;)}\]]+/gi;

/**
 * The bare words `token` and `key` are ordinary English in a product about
 * tokens: "unknown token: AAPLx" names an asset. After those, the value is only
 * removed when it looks like a secret — long, and not just letters.
 */
const NAMED_PROSE_PATTERN = /(?<![A-Za-z0-9])([\w-]*(?:key|token)[\w-]*):\s*(?=[^\s]*\d)[A-Za-z0-9._~+/=-]{12,}/gi;

/** Nothing legitimate here is longer, and the patterns above are not linear. */
const MAX_INPUT = 4_000;

/** A URL reduced to where it points, without the path or query that may hold a key. */
function originOnly(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "[url]";
  }
}

/** Whatever was thrown, as text. Never throws itself: this runs inside error handlers. */
function toText(input: unknown): string {
  try {
    if (input instanceof Error) return String(input.message ?? "");
    if (typeof input === "string") return input;
    if (input === null || input === undefined) return "";
    return String(input);
  } catch {
    return "[unprintable]";
  }
}

/** Cut to `maxLength` code points, never through the middle of one. */
function clip(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const points = Array.from(text);
  if (points.length <= maxLength) return text;
  return `${points.slice(0, Math.max(0, maxLength - 1)).join("").trimEnd()}…`;
}

/**
 * An error message fit to show a stranger: invisible characters removed first
 * (so they cannot hide a credential from the patterns below), URLs reduced to
 * their origin, anything shaped like a credential removed, and a length that
 * cannot be used to smuggle a document.
 */
export function safeMessage(input: unknown, maxLength = 240): string {
  // Bounded before any pattern sees it: the credential patterns backtrack, and
  // an upstream that controls the length of its error controls the cost.
  const cleaned = toText(input)
    .slice(0, MAX_INPUT)
    .replace(INVISIBLE_PATTERN, "")
    .replace(URL_PATTERN, (url) => originOnly(url))
    .replace(AUTHORIZATION_PATTERN, (_match, proxy: string | undefined) => `${proxy ? "Proxy-" : ""}Authorization=[redacted]`)
    .replace(SCHEME_PATTERN, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(NAMED_ASSIGNMENT_PATTERN, (_match, name: string) => `${name}=[redacted]`)
    .replace(NAMED_PROSE_STRICT_PATTERN, (_match, name: string) => `${name}=[redacted]`)
    .replace(NAMED_PROSE_PATTERN, (_match, name: string) => `${name}=[redacted]`)
    .replace(/\s+/g, " ")
    .trim();
  return clip(cleaned, maxLength);
}

/**
 * Third-party display text, bounded. Letters (with their combining marks, so
 * Devanagari and accented Latin survive), digits, currency and ordinary
 * punctuation stay; markup, links, invisible characters and anything past
 * `maxLength` do not. This does not make the text *true* — it makes it short
 * and inert.
 */
export function plainText(input: unknown, maxLength: number): string {
  const cleaned = toText(input)
    .slice(0, MAX_INPUT)
    .normalize("NFC")
    .replace(INVISIBLE_PATTERN, "")
    .replace(URL_PATTERN, " ")
    .replace(/[^\p{L}\p{M}\p{N}\p{Sc} .,;:%&'()\-+/#@!?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLength <= 0) return "";
  return Array.from(cleaned).slice(0, maxLength).join("").trimEnd();
}

const MAX_INERT_STRING = 1_200;
const MAX_INERT_ITEMS = 200;

/** Deep-clean a value on its way into a model's context: keys as well as values. */
export function inert(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested too deeply]";
  if (typeof value === "string") return clip(value.replace(INVISIBLE_PATTERN, ""), MAX_INERT_STRING);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  if (Array.isArray(value)) return value.slice(0, MAX_INERT_ITEMS).map((item) => inert(item, depth + 1));
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Map) return inert(Object.fromEntries([...value].map(([k, v]) => [toText(k), v])), depth);
  if (value instanceof Set) return inert([...value], depth);
  if (value instanceof Error) return safeMessage(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_INERT_ITEMS)
      .map(([key, item]) => [clip(key.replace(INVISIBLE_PATTERN, ""), 120), inert(item, depth + 1)]),
  );
}
