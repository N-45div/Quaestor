import express, { type Express, type Request } from "express";
import { hbarFromTinybars } from "./pricing";
import type { PermitPricer } from "./permits";
import { normalizeVenue, type ThreatFeed } from "./threatfeed";

/**
 * The hub's write path. A tenant's agent that was attacked through a venue
 * reports it here; every other tenant's permit price for that venue moves on
 * the next quote. Reporting is free — the herd wants reports — but it is
 * gated, because a shared feed's only real attack is poisoning.
 *
 * Two write tiers, either admits a report:
 *   1. a verified human behind the agent (World ID / AgentBook humanId), set on
 *      `req.humanId` by the identity middleware when present, or
 *   2. an allowlisted tenant key (`X-Quaestor-Tenant` + `X-Quaestor-Tenant-Key`),
 *      for tenants the operator has onboarded directly.
 *
 * Reports from tier 2 carry `humanId = "tenant:<id>"` so they count as one
 * reporter per tenant, never one per agent — the same anti-sybil rule the
 * human tier enforces by construction.
 */

export interface HubOptions {
  feed: ThreatFeed;
  pricer: PermitPricer;
  /** tenantId -> shared secret. Parsed from TENANT_KEYS="alpha:s3cret,beta:..." */
  tenantKeys: Map<string, string>;
}

export const PATTERNS = new Set([
  "prompt-injection",
  "honeypot",
  "sandwich",
  "rug",
  "fake-quote",
  "phishing",
  "drain",
  "other",
]);

export function tenantKeysFromEnv(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const id = pair.slice(0, i).trim();
    const key = pair.slice(i + 1).trim();
    if (id && key.length >= 8) m.set(id, key);
  }
  return m;
}

export type ReportingIdentity =
  | { tier: "human"; humanId: string; tenantId: string }
  | { tier: "tenant"; humanId: string; tenantId: string };

/** Who is allowed to write to the feed, and under which identity. Exported for tests. */
export function identify(req: Request, tenantKeys: Map<string, string>): ReportingIdentity | null {
  // Tier 1: the identity middleware (AgentKit) has already resolved a human.
  const human = (req as Request & { humanId?: string }).humanId;
  const tenantHeader = String(req.header("x-quaestor-tenant") ?? "").trim();
  if (human) return { tier: "human", humanId: human, tenantId: tenantHeader || "anon" };

  // Tier 2: an onboarded tenant with its shared key.
  const key = String(req.header("x-quaestor-tenant-key") ?? "");
  if (tenantHeader && key && tenantKeys.get(tenantHeader) === key) {
    return { tier: "tenant", humanId: `tenant:${tenantHeader}`, tenantId: tenantHeader };
  }
  return null;
}

export function mountHub(app: Express, opts: HubOptions): void {
  const json = express.json({ limit: "16kb" });

  app.post("/v1/threat/report", json, async (req, res) => {
    const who = identify(req, opts.tenantKeys);
    if (!who) {
      return res.status(401).json({
        error: "reporting requires a verified human (AgentKit) or an onboarded tenant key",
        how: "send X-Quaestor-Tenant and X-Quaestor-Tenant-Key, or authenticate the agent through World AgentKit",
      });
    }

    const body = (req.body ?? {}) as { venue?: unknown; pattern?: unknown; evidence?: unknown };
    const venue = normalizeVenue(String(body.venue ?? ""));
    const pattern = String(body.pattern ?? "").toLowerCase();
    if (venue.length < 3) return res.status(400).json({ error: "venue is required (≥3 chars)" });
    if (!PATTERNS.has(pattern)) {
      return res.status(400).json({ error: `pattern must be one of ${[...PATTERNS].join(", ")}` });
    }

    const before = await opts.pricer.quote(venue);
    const rec = await opts.feed.report({
      venue,
      pattern,
      humanId: who.humanId,
      tenantId: who.tenantId,
    });
    const after = await opts.pricer.quote(venue);

    res.status(201).json({
      report: {
        venue: rec.venue,
        pattern: rec.pattern,
        tenant: rec.tenantId,
        reporter_tier: who.tier,
        observed_at: rec.observedAt,
        consensus_timestamp: rec.consensusTimestamp ?? null,
        sequence: rec.sequenceNumber ?? null,
      },
      permit_for_everyone: {
        before_hbar: hbarFromTinybars(before.tinybars),
        after_hbar: hbarFromTinybars(after.tinybars),
        reporters: after.reporters,
        multiplier: after.multiplier,
        k: after.k,
      },
      note:
        after.reporters === before.reporters
          ? "your report was recorded but you had already reported this venue; one human counts once"
          : "every tenant's permit for this venue now costs more — nobody was told 'no'",
    });
  });

  // Read the tighten-only scalar. There is deliberately no route to lower it.
  app.get("/v1/policy/k", (_req, res) => {
    res.json({ k: opts.pricer.k(), base_hbar: hbarFromTinybars(opts.pricer.base), window_ms: opts.pricer.windowMs });
  });

  console.log(
    `[hub] mounted — POST /v1/threat/report (${opts.tenantKeys.size} tenant key${opts.tenantKeys.size === 1 ? "" : "s"} onboarded), GET /v1/policy/k`
  );
}
