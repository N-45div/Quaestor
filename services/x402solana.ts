/**
 * The Solana payment lane: x402 settled in USDC through PayAI.
 *
 * The paid routes elsewhere in this hub settle HBAR on Hedera, which made sense
 * when the governor lived on EVM chains. The stocks product lives on Solana, so
 * its paid reads settle there too — the agent pays in the currency and on the
 * chain it is already trading on.
 *
 * PayAI is the facilitator: it verifies the agent's signed USDC transfer and
 * submits it, paying the network fee itself. The agent only needs USDC, never
 * SOL, and this server never holds a key. The protocol is the same x402 v2 the
 * Hedera lane speaks; only the scheme (`exact` on SVM) and the facilitator
 * change, which is why this sits beside that lane rather than replacing it.
 *
 * What is charged is judgement, never governance. The price tape and the
 * intelligence tools are useful without being a precondition for trading — so
 * metering them never stands between an agent and a refusal it ought to get
 * for free.
 */
import type { Express } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { INTEL_TOOLS } from "./intel";

export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";

/** Circle's USDC on Solana devnet — what "$0.001" resolves to on that network. */
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export type SolanaNetwork = typeof SOLANA_DEVNET_CAIP2 | typeof SOLANA_MAINNET_CAIP2;

/** What this lane charges for: the tape route the stock tools read, the intelligence tools, or both. */
export type SolanaCharge = "tape" | "intel";

export interface SolanaPaymentLaneOptions {
  /** The Solana address that receives USDC. Its USDC account must already exist. */
  payTo: string;
  network?: SolanaNetwork;
  facilitatorUrl?: string;
  /** Per read of the price tape. */
  pricePerRead?: string;
  /**
   * Which routes are paywalled. A hosted hub whose own MCP tools read the tape
   * over loopback charges for the intelligence tools and leaves the tape free —
   * otherwise its own tools would be answered 402.
   */
  charge?: readonly SolanaCharge[];
}

export interface SolanaPaymentLane {
  network: SolanaNetwork;
  facilitatorUrl: string;
  payTo: string;
  pricePerRead: string;
  paidRoutes: string[];
}

export function solanaPaymentLaneFromEnv(): SolanaPaymentLaneOptions | null {
  if (process.env.X402_SOLANA_ENABLED !== "1") return null;
  const payTo = process.env.X402_SOLANA_PAY_TO;
  if (!payTo) {
    console.error("[solana-x402] X402_SOLANA_ENABLED=1 but X402_SOLANA_PAY_TO is not set — lane not mounted");
    return null;
  }
  const network = (process.env.X402_SOLANA_NETWORK ?? SOLANA_DEVNET_CAIP2) as SolanaNetwork;
  return {
    payTo,
    network,
    facilitatorUrl: process.env.X402_SOLANA_FACILITATOR_URL ?? PAYAI_FACILITATOR_URL,
    pricePerRead: process.env.X402_SOLANA_PRICE ?? "$0.001",
    charge: (process.env.X402_SOLANA_CHARGE ?? "tape")
      .split(",")
      .map((part) => part.trim())
      .filter((part): part is SolanaCharge => part === "tape" || part === "intel"),
  };
}

type Accepts = { scheme: "exact"; network: SolanaNetwork; payTo: string; price: string };

/** The intelligence tools as paid routes, described so an agent can call them without reading docs. */
function intelRoutes(accepts: (price: string) => Accepts): RoutesConfig {
  const tool = (id: (typeof INTEL_TOOLS)[number]["id"]) => INTEL_TOOLS.find((candidate) => candidate.id === id)!;
  const common = {
    mimeType: "application/json",
    serviceName: "Quaestor",
    tags: ["stocks", "tokenized-stocks", "risk", "agents", "solana"],
  };
  const instrument = { type: "string", description: "A mint, a symbol such as AAPLx, or the underlying's ticker such as AAPL" };
  return {
    [`POST ${tool("quote-check").path}`]: {
      accepts: accepts(`$${tool("quote-check").priceUsd}`),
      description: tool("quote-check").summary,
      ...common,
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: { instrument: "AAPLx", usdc_in: "5000000", tokens_out: "1483000", min_tokens_out: "1475585" },
        inputSchema: {
          type: "object",
          required: ["instrument", "usdc_in", "tokens_out"],
          properties: {
            instrument,
            usdc_in: { type: "string", description: "USDC paid, integer base units (6 decimals): 5000000 is 5 USDC" },
            tokens_out: { type: "string", description: "Tokens the venue expects to deliver, raw base units of the mint" },
            min_tokens_out: { type: "string", description: "Tokens the venue guarantees; defaults to tokens_out" },
            venue: { type: "string", description: "Where the quote came from, for the record" },
          },
        },
        output: {
          example: {
            verdict: "within-market",
            allowed: true,
            quote: { floor_price_usd: 338.9, benchmark_price_usd: 337.11, deviation_bps: 53 },
          },
        },
      }),
    },
    [`GET ${tool("market-evidence").path}`]: {
      accepts: accepts(`$${tool("market-evidence").priceUsd}`),
      description: tool("market-evidence").summary,
      ...common,
      extensions: declareDiscoveryExtension({
        input: { instrument: "AAPLx" },
        inputSchema: { type: "object", required: ["instrument"], properties: { instrument } },
        output: {
          example: {
            verdict: "within-market",
            session: "regular",
            premium_bps: -8,
            consensus: { reference: { price: 337.16, sources: ["backpack-index", "jupiter-issuer"], spread_bps: 4 } },
          },
        },
      }),
    },
    [`GET ${tool("price-tape").path}`]: {
      accepts: accepts(`$${tool("price-tape").priceUsd}`),
      description: tool("price-tape").summary,
      ...common,
      extensions: declareDiscoveryExtension({
        input: { instrument: "AAPLx", window: "1h" },
        inputSchema: {
          type: "object",
          required: ["instrument"],
          properties: { instrument, window: { type: "string", description: "5m to 24h, e.g. 15m, 1h, 6h, 24h" } },
        },
        output: {
          example: {
            premium: { now_bps: -8, trend: "narrowing" },
            narrative: "Over the last 1h, AAPLx traded between $336.02 and $337.10 …",
          },
        },
      }),
    },
  };
}

/**
 * Mount before the routes it charges for: the middleware answers 402 itself and
 * only calls through once PayAI has verified and settled the payment.
 */
export function mountSolanaPaymentLane(app: Express, opts: SolanaPaymentLaneOptions): SolanaPaymentLane {
  const network = opts.network ?? SOLANA_DEVNET_CAIP2;
  const facilitatorUrl = opts.facilitatorUrl ?? PAYAI_FACILITATOR_URL;
  const pricePerRead = opts.pricePerRead ?? "$0.001";
  const charge = new Set<SolanaCharge>(opts.charge ?? ["tape"]);
  const accepts = (price: string): Accepts => ({ scheme: "exact", network, payTo: opts.payTo, price });

  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
    .register(network, new ExactSvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  const routes: RoutesConfig = {};
  if (charge.has("intel")) Object.assign(routes, intelRoutes(accepts));
  if (charge.has("tape")) {
    Object.assign(routes, {
      // Named, not a wildcard: Bazaar discovery turns a `*` into "var1", and an
      // agent browsing paid APIs should see what the parameter actually is.
      "GET /v1/stocks/prices/:instrumentMint": {
        accepts: accepts(pricePerRead),
        description:
          "Where a tokenized stock and its underlying have traded over a window, already summarised for an agent: last price, change and range on each side, the premium of the token over its underlying and whether it is widening, the US session, sparklines and a one-paragraph narrative.",
        mimeType: "application/json",
        serviceName: "Quaestor",
        tags: ["stocks", "market-data", "agents", "solana"],
        extensions: declareDiscoveryExtension({
          input: { window: "1h" },
          inputSchema: {
            type: "object",
            properties: { window: { type: "string", description: "5m to 24h, e.g. 15m, 1h, 6h, 24h" } },
          },
          output: {
            example: {
              instrument: { symbol: "AAPLx" },
              premium: { now_bps: -8, trend: "narrowing" },
              narrative: "Over the last 1h, AAPLx traded between $336.02 and $337.10 …",
            },
          },
        }),
      },
    } satisfies RoutesConfig);
  }
  if (Object.keys(routes).length === 0) throw new Error("the payment lane was asked to charge for nothing");

  // syncFacilitatorOnStart: learn PayAI's fee payer for this network up front,
  // so the first 402 an agent sees is already complete.
  app.use(paymentMiddleware(routes, server, undefined, undefined, true));

  const lane: SolanaPaymentLane = {
    network,
    facilitatorUrl,
    payTo: opts.payTo,
    pricePerRead,
    paidRoutes: Object.keys(routes),
  };
  console.log(`[solana-x402] mounted — ${lane.paidRoutes.join(", ")} in USDC on ${network} → ${opts.payTo} via ${facilitatorUrl}`);
  return lane;
}
