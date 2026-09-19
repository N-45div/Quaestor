/**
 * The paid tools.
 *
 * Governance is free and stays free: discovering, quoting, previewing, trading
 * and being refused cost an agent nothing, because a refusal it had to pay for
 * would be perverse. What is sold here is judgement that is useful even to an
 * agent that never trades through this hub:
 *
 *   quote-check      "is this quote fair?" — for a quote from ANY venue. The
 *                    same verdict a trade through the governor would get,
 *                    measured against independently observed prices.
 *   market-evidence  what each source says an instrument is worth right now,
 *                    how far they disagree, and how far the token has drifted
 *                    from its underlying.
 *   price-tape       where both have been over a window, summarised for a model.
 *
 * One set of tools, two ways to pay:
 *
 *   /v1/intel/*         x402 on Solana, settled in USDC by PayAI. An agent with
 *                       a Solana wallet pays this hub directly.
 *   /internal/intel/*   no paywall, but a server-to-server key. This is what the
 *                       Bankr x402 Cloud handlers call: Bankr has already
 *                       collected the payment, in USDC on Base, from an agent
 *                       that found the tool in its marketplace.
 *
 * Every answer is served from the price tape already in memory, so a paid call
 * makes no upstream request and one caller cannot be turned into many.
 */
import express, { type Express, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { StockPlatformError, type StockMarketAssessment, type StockPlatform } from "../stocks";
import { safeMessage } from "../stocks/redact";

export const INTEL_TOOLS = [
  {
    id: "quote-check",
    method: "POST",
    path: "/v1/intel/quote-check",
    priceUsd: "0.005",
    summary: "Is this quote fair? Send a tokenized-stock quote from any venue; get the price gate's verdict against independently observed prices.",
  },
  {
    id: "market-evidence",
    method: "GET",
    path: "/v1/intel/market-evidence",
    priceUsd: "0.002",
    summary: "What each independent source says an instrument is worth, how far they disagree, the token's premium to its underlying, and the US session.",
  },
  {
    id: "price-tape",
    method: "GET",
    path: "/v1/intel/price-tape",
    priceUsd: "0.001",
    summary: "Where a tokenized stock and its underlying have traded over a window (5m–24h), summarised for a model, with the premium's trend and a narrative.",
  },
] as const;

const instrumentRef = z.string().trim().min(1).max(64);
const baseUnits = z.string().regex(/^\d{1,30}$/, "an integer string in base units");

const quoteCheckSchema = z.object({
  /** A mint, a symbol ("AAPLx") or the underlying's ticker ("AAPL"). */
  instrument: instrumentRef,
  /** USDC paid, in base units: "5000000" is 5 USDC. */
  usdc_in: baseUnits,
  /** Tokens the venue expects to deliver, in the mint's raw base units. */
  tokens_out: baseUnits,
  /** Tokens the venue guarantees. Omitted, the expected amount is treated as the floor. */
  min_tokens_out: baseUnits.optional(),
  venue: z.string().trim().max(40).optional(),
});

export interface IntelConfig {
  /** Mount the x402-paywalled public routes. Without a payment lane they are not offered at all. */
  paid: boolean;
  /** Enables /internal/intel/* for a trusted proxy that has already taken payment. */
  proxyKey?: string;
}

/** A verdict in one word, for an agent that wants the answer before the evidence. */
function verdict(assessment: StockMarketAssessment): "within-market" | "off-market" | "cannot-vouch" {
  if (assessment.allowed) return "within-market";
  return assessment.refusal?.code === "QUOTE_OFF_MARKET" ? "off-market" : "cannot-vouch";
}

export function mountIntel(app: Express, platform: StockPlatform, cfg: IntelConfig): void {
  const json = express.json({ limit: "8kb" });
  const answer = (work: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      res.json(await work(req));
    } catch (error) {
      if (error instanceof StockPlatformError) {
        res.status(error.httpStatus).json({ error: { code: error.code, message: error.message } });
      } else if (error instanceof z.ZodError) {
        const issue = error.issues[0];
        res.status(400).json({ error: { code: "INVALID_REQUEST", message: safeMessage(`${issue?.path.join(".") ?? "body"}: ${issue?.message ?? "invalid"}`, 160) } });
      } else {
        console.error("[intel] failed:", safeMessage(error, 200));
        res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
      }
    }
  };

  const evidence = answer(async (req) => {
    const assessment = await platform.watchMarket(instrumentRef.parse(req.query.instrument));
    return { verdict: verdict(assessment), ...assessment };
  });
  const tape = answer((req) =>
    platform.watchPrices(instrumentRef.parse(req.query.instrument), z.string().max(8).optional().parse(req.query.window) ?? "1h"));
  const quoteCheck = answer(async (req) => {
    const body = quoteCheckSchema.parse(req.body);
    const assessment = await platform.checkExternalQuote(body.instrument, {
      usdcIn: BigInt(body.usdc_in),
      tokensOut: BigInt(body.tokens_out),
      minimumTokensOut: body.min_tokens_out === undefined ? undefined : BigInt(body.min_tokens_out),
      venue: body.venue,
    });
    return {
      verdict: verdict(assessment),
      reading: assessment.quote
        ? `The floor implies $${assessment.quote.floor_price_usd.toFixed(4)} a share against an observed ${assessment.quote.benchmark_side} price of $${assessment.quote.benchmark_price_usd.toFixed(4)}: ${assessment.quote.deviation_bps}bps ${assessment.quote.deviation_bps >= 0 ? "worse" : "better"} than the market.`
        : "There was no fresh independent price to measure this quote against, so it cannot be vouched for.",
      ...assessment,
    };
  });

  // Free: what is for sale, for how much, and for which instruments.
  app.get("/v1/intel", (_req, res) => res.json({
    about: "Pay-per-call market judgement for tokenized stocks on Solana. Governance through this hub is free; these are for agents that trade anywhere.",
    instruments: platform.watched(),
    tools: INTEL_TOOLS.map((tool) => ({ ...tool, price: `$${tool.priceUsd} per call` })),
    pay_with: {
      solana_usdc: cfg.paid ? "x402 v2, `exact` scheme on Solana, settled by PayAI — call the paths above and answer the 402" : "not offered on this deployment",
      base_usdc: "through Bankr x402 Cloud — search the Bankr x402 marketplace for \"quaestor\"",
    },
    inputs: {
      "quote-check": "POST JSON { instrument, usdc_in, tokens_out, min_tokens_out?, venue? } — amounts are integer base-unit strings",
      "market-evidence": "GET ?instrument=AAPLx",
      "price-tape": "GET ?instrument=AAPLx&window=1h",
    },
  }));

  if (cfg.paid) {
    app.post("/v1/intel/quote-check", json, quoteCheck);
    app.get("/v1/intel/market-evidence", evidence);
    app.get("/v1/intel/price-tape", tape);
  }

  if (cfg.proxyKey) {
    const expected = Buffer.from(cfg.proxyKey);
    const trusted = (req: Request, res: Response, next: express.NextFunction): void => {
      const presented = Buffer.from(String(req.headers["x-quaestor-proxy-key"] ?? ""));
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "this route is for the payment proxy" } });
        return;
      }
      next();
    };
    app.post("/internal/intel/quote-check", trusted, json, quoteCheck);
    app.get("/internal/intel/market-evidence", trusted, evidence);
    app.get("/internal/intel/price-tape", trusted, tape);
  }

  console.log(
    `[intel] mounted — ${INTEL_TOOLS.map((tool) => `${tool.id} $${tool.priceUsd}`).join(", ")}; `
    + `Solana x402 ${cfg.paid ? "on" : "off"}, payment proxy ${cfg.proxyKey ? "on" : "off"}`,
  );
}

export function intelFromEnv(paid: boolean): IntelConfig | null {
  if (process.env.INTEL_ENABLED !== "1") return null;
  const proxyKey = process.env.INTEL_PROXY_KEY?.trim();
  if (proxyKey !== undefined && proxyKey.length < 24) {
    console.error("[intel] INTEL_PROXY_KEY must be at least 24 characters — payment proxy routes not mounted");
    return { paid };
  }
  return { paid, proxyKey };
}
