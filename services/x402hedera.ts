import type { Express, Request, Response } from "express";
import { paymentMiddleware, x402ResourceServer, type Network } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPRequestContext, type RoutesConfig } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { HEDERA_TESTNET_CAIP2 } from "@x402/hedera";
import { hbarFromTinybars, hbarPrice, meteredPrice, tinybarsFromHbar } from "./pricing";
import type { PermitPricer } from "./permits";
import { normalizeVenue, type ThreatFeed } from "./threatfeed";

/**
 * The Hedera lane: Quaestor's decisions, sold one x402 request at a time.
 *
 * Every route here is priced per decision, not per request — a policy
 * evaluation costs per rule, a venue quote per venue, and the route permit
 * costs more the more verified humans have reported the venue. Settlement is
 * native HBAR on Hedera testnet through the Blocky402 facilitator; the feed
 * head is deliberately free so any agent can see the herd is alive before it
 * pays to ask about a venue.
 *
 * Env-gated (X402_HEDERA_ENABLED=1) and fails soft like the OKX lane: if the
 * facilitator is unreachable the governed lane is untouched.
 */

export interface HederaLaneOptions {
  /** Hedera account id (0.0.x) that receives every settlement. */
  payTo: string;
  /** Facilitator base URL, e.g. https://api.testnet.blocky402.com */
  facilitatorUrl: string;
  network?: Network;
  feed: ThreatFeed;
  /** The one permit price function shared with the hub and the dashboard. */
  pricer: PermitPricer;
  /** Cheapest thing on the menu. */
  lookupHbar?: string;
  /** Per-rule and per-venue metering units. */
  perRuleHbar?: string;
  perVenueHbar?: string;
  /** Optional live market signal for /v1/venue/quote. */
  signal?: () => Record<string, unknown> | null;
}

export interface HederaLaneHandle {
  mounted: true;
  network: string;
  routes: Record<string, string>;
}

export async function mountHederaLane(
  app: Express,
  opts: HederaLaneOptions
): Promise<HederaLaneHandle | false> {
  const network = opts.network ?? HEDERA_TESTNET_CAIP2;
  const { pricer } = opts;
  const windowMs = pricer.windowMs;
  const base = pricer.base;
  const lookupUnit = tinybarsFromHbar(opts.lookupHbar ?? "0.0005");
  const ruleUnit = tinybarsFromHbar(opts.perRuleHbar ?? "0.0002");
  const venueUnit = tinybarsFromHbar(opts.perVenueHbar ?? "0.001");

  if (!/^\d+\.\d+\.\d+$/.test(opts.payTo)) {
    console.error(
      `[hedera] lane NOT mounted — HEDERA_PAYTO_ACCOUNT_ID must be a Hedera account id like 0.0.1234 (got ${JSON.stringify(opts.payTo)})`
    );
    return false;
  }

  try {
    const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl });
    const server = new x402ResourceServer(facilitator)
      .register(network, new ExactHederaScheme())
      .registerExtension(bazaarResourceServerExtension);

    // ---- paid routes (the free feed head lives in hub.ts, lane or no lane) -------------------------------------------------------
    const queryStr = (req: Request, name: string): string => {
      const v = req.query[name];
      return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
    };
    const venueOf = (req: Request): string | null => {
      const v = normalizeVenue(queryStr(req, "venue"));
      return v.length >= 3 ? v : null;
    };

    const routes: RoutesConfig = {
      // Cheapest on the menu: what does the herd know about this venue?
      "GET /v1/threat/lookup": {
        accepts: {
          scheme: "exact",
          network,
          payTo: opts.payTo,
          price: hbarPrice(lookupUnit),
        },
        description:
          "Distinct verified-human reports against a venue in the last 24h, with the patterns seen. Priced flat and low: reading the herd should be cheap.",
        mimeType: "application/json",
        serviceName: "Quaestor",
        tags: ["risk", "threat-feed", "agents", "hedera"],
        extensions: declareDiscoveryExtension({
          input: { venue: "0x000000000000000000000000000000000000dEaD" },
          inputSchema: {
            type: "object",
            properties: { venue: { type: "string", description: "Contract address, account id, or host" } },
            required: ["venue"],
          },
          output: { example: { venue: "0x…dead", reporters: 3, flagged: true, patterns: ["prompt-injection"] } },
        }),
      },

      // The route permit. Its price IS the risk signal.
      "GET /v1/risk/check": {
        accepts: {
          scheme: "exact",
          network,
          payTo: opts.payTo,
          price: async (ctx: HTTPRequestContext) => {
            const raw = ctx.adapter.getQueryParam?.("venue");
            const venue = normalizeVenue(Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? ""));
            return hbarPrice((await pricer.quote(venue)).tinybars);
          },
        },
        description:
          "A permit to route through a venue. permit = base × (1 + k · distinctHumanReporters). Quaestor never refuses — when the premium exceeds your on-chain per-call cap, your own budget does.",
        mimeType: "application/json",
        serviceName: "Quaestor",
        tags: ["risk", "routing", "permit", "agents", "hedera"],
        extensions: declareDiscoveryExtension({
          input: { venue: "0x000000000000000000000000000000000000dEaD" },
          inputSchema: {
            type: "object",
            properties: { venue: { type: "string" } },
            required: ["venue"],
          },
          output: {
            example: { venue: "0x…dead", permit: { hbar: "0.0125", base_hbar: "0.005", k: 1, reporters: 1.5, multiplier: 2.5 } },
          },
        }),
      },

      // Per venue quoted.
      "GET /v1/venue/quote": {
        accepts: {
          scheme: "exact",
          network,
          payTo: opts.payTo,
          price: (ctx: HTTPRequestContext) => {
            const raw = ctx.adapter.getQueryParam?.("venues");
            const list = (Array.isArray(raw) ? raw.join(",") : String(raw ?? "")).split(",").filter(Boolean);
            return hbarPrice(meteredPrice(venueUnit, list.length));
          },
        },
        description: "Quotes for a list of venues, priced per venue quoted.",
        mimeType: "application/json",
        serviceName: "Quaestor",
        tags: ["quote", "routing", "hedera"],
        extensions: declareDiscoveryExtension({
          input: { venues: "quaestor-dex,0x000000000000000000000000000000000000dEaD" },
          inputSchema: {
            type: "object",
            properties: { venues: { type: "string", description: "Comma-separated venue ids" } },
            required: ["venues"],
          },
          output: { example: { quotes: [{ venue: "quaestor-dex", spot: "…", reporters: 0 }], priced_for: 2 } },
        }),
      },

      // Per rule evaluated. `rules` is the client's count hint; the response
      // header X-Quaestor-Rules-Evaluated says how many actually ran.
      "GET /v1/policy/evaluate": {
        accepts: {
          scheme: "exact",
          network,
          payTo: opts.payTo,
          price: (ctx: HTTPRequestContext) => {
            const raw = ctx.adapter.getQueryParam?.("rules");
            const n = Number(Array.isArray(raw) ? raw[0] : raw);
            return hbarPrice(meteredPrice(ruleUnit, Number.isFinite(n) ? n : 1));
          },
        },
        description:
          "Evaluate a proposed spend against a policy: per-call cap, epoch cap, venue permit, and category. Priced per rule evaluated.",
        mimeType: "application/json",
        serviceName: "Quaestor",
        tags: ["policy", "governance", "agents", "hedera"],
        extensions: declareDiscoveryExtension({
          input: { venue: "quaestor-dex", amount_hbar: "0.5", category: "EXECUTION", rules: 4 },
          inputSchema: {
            type: "object",
            properties: {
              venue: { type: "string" },
              amount_hbar: { type: "string" },
              category: { type: "string", enum: ["DATA", "INFERENCE", "EXECUTION"] },
              rules: { type: "integer", minimum: 1, maximum: 50 },
            },
            required: ["venue", "amount_hbar", "category"],
          },
          output: { example: { allowed: true, rules: [{ name: "per_call_cap", pass: true }], evaluated: 4 } },
        }),
      },
    };

    app.use(paymentMiddleware(routes, server, undefined, undefined, true));

    // ---- handlers (only reached once the middleware has verified + settled) --
    app.get("/v1/threat/lookup", async (req, res) => {
      const venue = venueOf(req);
      if (!venue) return badVenue(res);
      const reports = await opts.feed.lookup(venue, windowMs);
      const reporters = new Set(reports.map((r) => r.humanId).filter(Boolean)).size;
      res.json({
        venue,
        reporters,
        flagged: reporters > 0,
        patterns: [...new Set(reports.map((r) => r.pattern))],
        reports: reports.slice(0, 20).map((r) => ({
          pattern: r.pattern,
          tenant: r.tenantId,
          observed_at: r.observedAt,
          consensus_timestamp: r.consensusTimestamp ?? null,
          sequence: r.sequenceNumber ?? null,
        })),
        window_ms: windowMs,
        settlement: `x402/exact on ${network} via ${opts.facilitatorUrl}`,
      });
    });

    app.get("/v1/risk/check", async (req, res) => {
      const venue = venueOf(req);
      if (!venue) return badVenue(res);
      const reporters = await opts.feed.distinctReporters(venue, windowMs);
      const q = await pricer.quote(venue);
      res.json({
        venue,
        permit: {
          hbar: hbarFromTinybars(q.tinybars),
          tinybars: q.tinybars.toString(),
          base_hbar: hbarFromTinybars(q.base),
          k: q.k,
          reporters: q.reporters,
          multiplier: q.multiplier,
        },
        note:
          "You paid this permit, so your per-call cap admitted it. A venue the herd has reported prices itself out of reach of a tight cap — that is the refusal.",
      });
    });

    app.get("/v1/venue/quote", async (req, res) => {
      const list = queryStr(req, "venues").split(",").map(normalizeVenue).filter(Boolean);
      if (list.length === 0) return res.status(400).json({ error: "venues= is required" });
      const signal = opts.signal?.() ?? null;
      const quotes = await Promise.all(
        list.map(async (venue) => ({
          venue,
          spot: venue === "quaestor-dex" && signal ? signal.spotTokenPerOkb ?? null : null,
          reporters: await opts.feed.distinctReporters(venue, windowMs),
        }))
      );
      res.json({ quotes, priced_for: Math.min(list.length, 50) });
    });

    app.get("/v1/policy/evaluate", async (req, res) => {
      const venue = venueOf(req);
      if (!venue) return badVenue(res);
      const amount = queryStr(req, "amount_hbar");
      const category = queryStr(req, "category").toUpperCase() || "EXECUTION";
      const perCallCap = queryStr(req, "per_call_cap_hbar") || "0.05";
      const epochLeft = queryStr(req, "epoch_left_hbar") || "1";
      let amountT: bigint, capT: bigint, leftT: bigint;
      try {
        amountT = tinybarsFromHbar(amount);
        capT = tinybarsFromHbar(perCallCap);
        leftT = tinybarsFromHbar(epochLeft);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
      const reporters = await opts.feed.distinctReporters(venue, windowMs);
      const permit = await pricer.quote(venue);
      const rules = [
        { name: "category_known", pass: ["DATA", "INFERENCE", "EXECUTION"].includes(category) },
        { name: "per_call_cap", pass: amountT <= capT, detail: `${amount} ≤ ${perCallCap}` },
        { name: "epoch_cap", pass: amountT <= leftT, detail: `${amount} ≤ ${epochLeft} left` },
        {
          name: "venue_permit_affordable",
          pass: permit.tinybars <= capT,
          detail: `permit ${hbarFromTinybars(permit.tinybars)} vs INFERENCE per-call cap ${perCallCap}`,
        },
      ];
      res.setHeader("X-Quaestor-Rules-Evaluated", String(rules.length));
      res.json({ allowed: rules.every((r) => r.pass), rules, evaluated: rules.length, venue, reporters });
    });

    const handle: HederaLaneHandle = {
      mounted: true,
      network,
      routes: {
        head: "/v1/threat/feed/head (free)",
        lookup: `/v1/threat/lookup?venue= (${hbarFromTinybars(lookupUnit)} HBAR)`,
        permit: `/v1/risk/check?venue= (${hbarFromTinybars(base)} HBAR × (1 + k·reporters))`,
        quote: `/v1/venue/quote?venues= (${hbarFromTinybars(venueUnit)} HBAR per venue)`,
        policy: `/v1/policy/evaluate?… (${hbarFromTinybars(ruleUnit)} HBAR per rule)`,
      },
    };
    console.log(
      `[hedera] lane mounted — ${network} → ${opts.payTo} via ${opts.facilitatorUrl}\n` +
        Object.values(handle.routes)
          .map((r) => `         ${r}`)
          .join("\n")
    );
    return handle;
  } catch (err) {
    console.error(
      "[hedera] lane NOT mounted (governed lane unaffected):",
      ((err as Error).message ?? String(err)).slice(0, 300)
    );
    return false;
  }
}

function badVenue(res: Response) {
  return res.status(400).json({ error: "venue= is required (address, account id, or host; ≥3 chars)" });
}
