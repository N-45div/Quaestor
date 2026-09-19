/**
 * Text that crosses a trust boundary, in either direction.
 *
 * Two different problems share one fix. Going *out*: an error from an RPC
 * client or `fetch` carries the URL it was calling, and an RPC URL carries its
 * API key in the query string — so an error message returned verbatim hands a
 * stranger the key. Coming *in*: names, descriptions and route labels from
 * third-party providers end up in front of a language model, where a sentence
 * is not just a sentence.
 *
 * Neither is solved by trusting the source. Both are solved by deciding, at the
 * boundary, what a string is allowed to be.
 */

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;
/** `api-key=...`, `token: ...`: a named credential with an explicit separator. */
const CREDENTIAL_PATTERN = /\b(api[-_]?key|access[-_]?token|token|secret|password|authorization)\s*[=:]\s*[^\s&"',;)]+/gi;
/** `Bearer <opaque>`: the one credential shape that is separated by a space. */
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Control characters, zero-width and bidirectional overrides: invisible to a reader, not to a model. */
const INVISIBLE_PATTERN = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/** A URL reduced to where it points, without the path or query that may hold a key. */
function originOnly(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "[url]";
  }
}

/**
 * An error message fit to show a stranger: URLs reduced to their origin,
 * anything shaped like a credential removed, invisible characters stripped,
 * and a length that cannot be used to smuggle a document.
 */
export function safeMessage(input: unknown, maxLength = 240): string {
  const text = input instanceof Error ? input.message : String(input ?? "");
  const cleaned = text
    .replace(URL_PATTERN, (url) => originOnly(url))
    .replace(CREDENTIAL_PATTERN, (_match, name: string) => `${name}=[redacted]`)
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(INVISIBLE_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/**
 * Third-party display text, bounded. Letters, digits and ordinary punctuation
 * survive; markup, invisible characters and anything past `maxLength` do not.
 * This does not make the text *true* — it makes it short and inert.
 */
export function plainText(input: unknown, maxLength: number): string {
  return String(input ?? "")
    .replace(INVISIBLE_PATTERN, "")
    .replace(/[^\p{L}\p{N}\p{Sc} .,;:%&'()\-+/#@!?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Deep-clean a value on its way into a model's context. */
export function inert(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested too deeply]";
  if (typeof value === "string") {
    const stripped = value.replace(INVISIBLE_PATTERN, "");
    return stripped.length > 1_200 ? `${stripped.slice(0, 1_199)}…` : stripped;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => inert(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, inert(item, depth + 1)]),
    );
  }
  return value;
}
