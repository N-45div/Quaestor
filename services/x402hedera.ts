import type { Express, Request, Response } from "express";
import { paymentMiddleware, x402ResourceServer, type Network } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPRequestContext, type RoutesConfig } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { HEDERA_TESTNET_CAIP2 } from "@x402/hedera";
import { ethers } from "ethers";
import { hbarFromTinybars, hbarPrice, meteredPrice, tinybarsFromHbar } from "./pricing";
import type { PermitPricer } from "./permits";
import { normalizeVenue, type ThreatFeed } from "./threatfeed";
import { CATEGORY_NAMES, type AgentBudget, type BudgetSource } from "./graph";

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
  /**
   * Where /v1/policy/evaluate gets the agent's real budget. Without it the
   * route can only price the venue permit — every governor rule reports itself
   * unevaluated and the verdict is a refusal, which is the correct answer to
   * "may I spend?" when nothing can see the budget.
   */
  budgets?: BudgetSource | null;
  /** Agent whose budget is evaluated when the caller names none. */
  defaultAgentId?: string;
  /** A spend may be this multiple of the largest the agent has ever made. */
  burstMultiple?: number;
  /** An epoch may reach this multiple of the agent's heaviest prior epoch. */
  precedentMultiple?: number;
}

/**
 * One rule, with its unit and its provenance attached. Two different questions
 * hide inside "did it pass": did the rule run at all, and did the spend satisfy
 * it. `evaluated: false` means no source could answer — a refusal, not a pass.
 */
interface Rule {
  name: string;
  pass: boolean;
  evaluated: boolean;
  unit: "governor-native" | "tinybar" | "n/a";
  basis: string;
  source: "subgraph" | "governor" | "hub" | "request";
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
          "Evaluate a proposed spend against the agent's real budget. Caps and spend are read from the governor via the subgraph (contract call as fallback), not asserted by the caller. Two rules — no_burst and within_precedent — need the largest single spend and the heaviest prior epoch, which exist only in the event stream; when the subgraph is stale they report unevaluated and the verdict is a refusal. Priced per rule evaluated.",
        mimeType: "application/json",
        serviceName: "Quaestor",
        tags: ["policy", "governance", "agents", "hedera", "the-graph"],
        extensions: declareDiscoveryExtension({
          input: { venue: "quaestor-dex", amount: "0.00025", category: "DATA", agent_id: "1", rules: 7 },
          inputSchema: {
            type: "object",
            properties: {
              venue: { type: "string" },
              amount: { type: "string", description: "Proposed spend in the governor chain's native unit (18dp)" },
              category: { type: "string", enum: ["DATA", "INFERENCE", "EXECUTION"] },
              agent_id: { type: "string", description: "Governed agent id; defaults to the service's own" },
              permit_budget_hbar: { type: "string", description: "HBAR you will spend on a route permit (tinybars, Hedera side)" },
              rules: { type: "integer", minimum: 1, maximum: 50 },
            },
            required: ["venue", "amount", "category"],
          },
          output: {
            example: {
              allowed: true,
              evaluated: 7,
              unevaluated: [],
              rules: [{ name: "no_burst", pass: true, evaluated: true, source: "subgraph" }],
              budget: { source: "subgraph", remaining: "0.00175", indexed_head: { block: 46565978, lag_seconds: 2 } },
            },
          },
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

    /**
     * The route stopped taking the caller's word for it.
     *
     * It used to accept `per_call_cap_hbar` and `epoch_left_hbar` from the
     * query string — the agent asserting its own budget to the thing deciding
     * whether it could spend. Now the caps and the spend come from the
     * governor, read through the subgraph with a direct contract call behind
     * it, and the caller's assertion is echoed back next to the chain's number
     * so the gap is visible rather than load-bearing.
     *
     * Two of the rules have no fallback by construction. `no_burst` and
     * `within_precedent` need the largest single payment and the heaviest
     * epoch this agent has ever had — facts that live in the event stream and
     * nowhere else, because a running total erases them. When the subgraph is
     * stale those rules report `evaluated: false` and the verdict is a
     * refusal. Stale data blocks; it does not quietly wave a spend through.
     *
     * Units never cross. Governor rules are in the governor chain's native
     * unit (18dp); the permit rule is in tinybars, because the permit is
     * bought on Hedera. Each rule says which it used.
     */
    app.get("/v1/policy/evaluate", async (req, res) => {
      const venue = venueOf(req);
      if (!venue) return badVenue(res);

      const categoryName = queryStr(req, "category").toUpperCase() || "EXECUTION";
      const category = CATEGORY_NAMES.indexOf(categoryName as (typeof CATEGORY_NAMES)[number]);
      const agentId = queryStr(req, "agent_id") || opts.defaultAgentId || "1";

      // Governor side, 18dp. `amount_hbar` is the legacy spelling of the same
      // field and is read as the same decimal number, not as tinybars.
      const amountRaw = queryStr(req, "amount") || queryStr(req, "amount_hbar");
      // Permit side, tinybars — genuinely the caller's to set: there is no
      // governor on Hedera, so nothing on-chain can supply this ceiling.
      const permitBudgetRaw =
        queryStr(req, "permit_budget_hbar") || queryStr(req, "per_call_cap_hbar") || "0.05";

      let amountWei: bigint | null = null;
      let amountErr: string | null = null;
      try {
        amountWei = ethers.parseEther(amountRaw || "0");
      } catch {
        amountErr = `amount ${JSON.stringify(amountRaw)} is not a decimal number`;
      }
      let permitBudgetT: bigint;
      try {
        permitBudgetT = tinybarsFromHbar(permitBudgetRaw);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }

      // Read the budget once; every governor rule below is a view onto it.
      let budget: AgentBudget | null = null;
      let budgetErr: string | null = null;
      if (!opts.budgets) {
        budgetErr = "no budget source configured (set SUBGRAPH_URL or QUAESTOR_ADDRESS)";
      } else if (category < 0) {
        budgetErr = `category ${JSON.stringify(categoryName)} is not one of ${CATEGORY_NAMES.join(", ")}`;
      } else {
        try {
          budget = await opts.budgets.budget(agentId, category);
        } catch (err) {
          budgetErr = (err as Error).message;
        }
      }

      const from = budget?.source === "subgraph" ? "subgraph" : "governor";
      const gov = (name: string, pass: boolean, basis: string): Rule => ({
        name,
        pass,
        evaluated: true,
        unit: "governor-native",
        basis,
        source: from,
      });
      const blocked = (name: string, why: string): Rule => ({
        name,
        pass: false,
        evaluated: false,
        unit: "governor-native",
        basis: why,
        source: from,
      });
      const native = (v: bigint) => ethers.formatEther(v);

      const rules: Rule[] = [
        {
          name: "category_known",
          pass: category >= 0,
          evaluated: true,
          unit: "n/a",
          basis: `${categoryName} ∈ {${CATEGORY_NAMES.join(", ")}}`,
          source: "request",
        },
      ];

      if (!budget) {
        const why = budgetErr ?? "budget unavailable";
        for (const name of ["not_suspended", "per_call_cap", "epoch_cap"]) {
          rules.push(blocked(name, why));
        }
      } else if (amountWei === null) {
        for (const name of ["not_suspended", "per_call_cap", "epoch_cap"]) {
          rules.push(blocked(name, amountErr!));
        }
      } else {
        rules.push(
          gov("not_suspended", !budget.suspended, `agent #${agentId} suspended=${budget.suspended}`),
          gov(
            "per_call_cap",
            amountWei <= budget.perCallCap,
            `${amountRaw} ≤ ${native(budget.perCallCap)} (the owner's cap, read from chain)`,
          ),
          gov(
            "epoch_cap",
            amountWei <= budget.remaining,
            `${amountRaw} ≤ ${native(budget.remaining)} left in epoch ${budget.currentEpoch}`,
          ),
        );
      }

      // --- the two rules only an indexer can answer -------------------------
      const shape = budget?.shape ?? null;
      if (!shape || amountWei === null) {
        const why =
          amountWei === null
            ? amountErr!
            : budget
              ? `${budget.source} source cannot see spend shape — burst and frequency exist only in the event stream`
              : (budgetErr ?? "budget unavailable");
        rules.push(
          { ...blocked("no_burst", why), source: "subgraph" },
          { ...blocked("within_precedent", why), source: "subgraph" },
        );
      } else {
        const burstX = opts.burstMultiple ?? 3;
        const precX = opts.precedentMultiple ?? 3;

        // A brand-new agent has no precedent to break. The rule ran and found
        // nothing to object to — which is not the same as being unable to run.
        if (shape.maxPriorReceipt === 0n) {
          rules.push({
            name: "no_burst",
            pass: true,
            evaluated: true,
            unit: "governor-native",
            basis: "no completed epoch indexed yet — the per-call cap is the only bound",
            source: "subgraph",
          });
        } else {
          const ceiling = shape.maxPriorReceipt * BigInt(burstX);
          rules.push({
            name: "no_burst",
            pass: amountWei <= ceiling,
            evaluated: true,
            unit: "governor-native",
            basis: `${amountRaw} ≤ ${burstX}× largest ever single spend ${native(shape.maxPriorReceipt)} = ${native(ceiling)}`,
            source: "subgraph",
          });
        }

        if (shape.maxPriorEpochSpend === 0n) {
          rules.push({
            name: "within_precedent",
            pass: true,
            evaluated: true,
            unit: "governor-native",
            basis: "no completed epoch indexed yet — the epoch cap is the only bound",
            source: "subgraph",
          });
        } else {
          const ceiling = shape.maxPriorEpochSpend * BigInt(precX);
          const wouldBe = budget!.spentThisEpoch + amountWei;
          rules.push({
            name: "within_precedent",
            pass: wouldBe <= ceiling,
            evaluated: true,
            unit: "governor-native",
            basis: `epoch would reach ${native(wouldBe)} ≤ ${precX}× heaviest prior epoch ${native(shape.maxPriorEpochSpend)} = ${native(ceiling)}`,
            source: "subgraph",
          });
        }
      }

      // --- the herd's price, on the Hedera side ----------------------------
      const reporters = await opts.feed.distinctReporters(venue, windowMs);
      const permit = await pricer.quote(venue);
      rules.push({
        name: "venue_permit_affordable",
        pass: permit.tinybars <= permitBudgetT,
        evaluated: true,
        unit: "tinybar",
        basis: `permit ${hbarFromTinybars(permit.tinybars)} ≤ ${permitBudgetRaw} HBAR you set aside for permits`,
        source: "hub",
      });

      const unevaluated = rules.filter((r) => !r.evaluated).map((r) => r.name);
      const allowed = rules.every((r) => r.evaluated && r.pass);

      res.setHeader("X-Quaestor-Rules-Evaluated", String(rules.length));
      res.setHeader("X-Quaestor-Budget-Source", budget?.source ?? "none");
      res.json({
        allowed,
        rules,
        evaluated: rules.length,
        unevaluated,
        // The whole point of the change, in one field: if a rule could not
        // run, the refusal is because of that, not because a cap was hit.
        denied_because: allowed
          ? null
          : unevaluated.length > 0
            ? `could not evaluate ${unevaluated.join(", ")} — refusing rather than assuming`
            : rules.filter((r) => !r.pass).map((r) => r.name).join(", "),
        venue,
        reporters,
        budget: budget && {
          agent_id: budget.agentId,
          category: budget.categoryName,
          source: budget.source,
          epoch: budget.currentEpoch,
          epoch_length_s: budget.epochLength,
          per_call_cap: native(budget.perCallCap),
          epoch_cap: native(budget.epochCap),
          spent_this_epoch: native(budget.spentThisEpoch),
          remaining: native(budget.remaining),
          indexed_head: budget.head && {
            block: budget.head.block,
            lag_seconds: budget.head.lagSeconds,
            indexing_errors: budget.head.hasIndexingErrors,
          },
          shape: budget.shape && {
            epochs_indexed: budget.shape.epochsSeen,
            truncated: budget.shape.truncated,
            receipts_this_epoch: budget.shape.receiptCountThisEpoch,
            largest_this_epoch: native(budget.shape.maxReceiptThisEpoch),
            largest_ever: native(budget.shape.maxPriorReceipt),
            busiest_prior_epoch: budget.shape.maxPriorReceiptCount,
            heaviest_prior_epoch: native(budget.shape.maxPriorEpochSpend),
            note: "none of this exists on-chain — a running total erases it",
          },
        },
        // Show the caller what their old self-assertion would have claimed.
        superseded: queryStr(req, "epoch_left_hbar")
          ? {
              epoch_left_hbar: queryStr(req, "epoch_left_hbar"),
              used_instead: budget ? native(budget.remaining) : null,
              note: "ignored — epoch headroom now comes from the governor, not from the caller",
            }
          : undefined,
        error: budgetErr ?? amountErr ?? undefined,
      });
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
