/**
 * Whether a decision record looks like it carries a credential.
 *
 * A record published to QuaestorLog is permanent: it is event data on a public
 * chain, and nothing can take it back. So before one is published, it is
 * checked for the shapes a secret usually has, and refused if any is there.
 *
 * This is a guard against the obvious, not a guarantee. It deliberately does
 * not flag a bare 0x-prefixed 64-hex string: a private key and a transaction
 * hash look exactly alike, and records legitimately carry hashes. It does not
 * reuse the error redactor's patterns either, which are built to over-redact a
 * message and would refuse Cato's own records for having a field called
 * `tokenOut`.
 */

/** Prefixes that only ever begin a credential. */
const PREFIXES: ReadonlyArray<[string, RegExp]> = [
  ["an OpenAI-style key", /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/],
  ["a Stripe key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["a GitLab token", /\bglpat-[A-Za-z0-9_.-]{16,}/],
  ["a GitHub token", /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Render key", /\brnd_[A-Za-z0-9]{16,}/],
  ["a Dynamic token", /\bdyn_[A-Za-z0-9]{16,}/],
  ["a Bankr key", /\bbk_usr_[A-Za-z0-9_]{16,}/],
  ["a Quaestor service key", /\b(?:qop|qmcp|qpx|dwp)_[A-Za-z0-9_-]{12,}/],
  ["a PEM block", /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/],
];

/** An HTTP credential written out. */
const HEADERS: ReadonlyArray<[string, RegExp]> = [
  ["an Authorization header", /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+\S{8,}/i],
  ["a bearer token", /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ["a key in a URL", /[?&](?:api[-_]?key|access[-_]?token|token|key|secret)=[^&\s"']{8,}/i],
];

/**
 * A JSON field whose name can only mean a secret. The name must be the whole
 * key, so `privateKey` is caught and `tokenOut` or `maxTokens` are not.
 */
const SECRET_FIELD = /["'](?:private[-_]?key|secret(?:[-_]?key)?|client[-_]?secret|password|passphrase|mnemonic|seed[-_]?phrase|api[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?token)["']\s*:\s*["'][^"']{6,}["']/i;

/** What in `text` looks like a credential, or null if nothing does. */
export function credentialIn(text: string): string | null {
  for (const [name, pattern] of [...PREFIXES, ...HEADERS]) {
    if (pattern.test(text)) return name;
  }
  if (SECRET_FIELD.test(text)) return "a field named as a secret";
  return null;
}
