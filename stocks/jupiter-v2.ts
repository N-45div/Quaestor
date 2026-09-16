import { createHash } from "node:crypto";
import { z } from "zod";
import type { JupiterQuoteFetcher } from "./jupiter";
import type { JupiterQuote } from "./types";

const accountSchema = z.object({
  pubkey: z.string().min(32),
  isWritable: z.boolean(),
  isSigner: z.boolean(),
});

const instructionSchema = z.object({
  programId: z.string().min(32),
  accounts: z.array(accountSchema),
  data: z.string().min(1),
});

const buildSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: z.string().regex(/^\d+$/),
  outAmount: z.string().regex(/^\d+$/),
  otherAmountThreshold: z.string().regex(/^\d+$/),
  routePlan: z.array(z.object({
    swapInfo: z.object({ label: z.string().optional(), ammKey: z.string() }).passthrough(),
  }).passthrough()).min(1),
  swapInstruction: instructionSchema,
  setupInstructions: z.array(instructionSchema).default([]),
  cleanupInstruction: instructionSchema.nullable().optional(),
  addressesByLookupTableAddress: z.record(z.string(), z.array(z.string())).nullable().optional(),
}).passthrough();

export type JupiterV2Build = z.infer<typeof buildSchema>;
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export interface JupiterV2Config {
  /** PDA or signer Jupiter should place in user-transfer-authority accounts. */
  taker: string;
  apiKey?: string;
  endpoint?: string;
  slippageBps?: number;
  maxAccounts?: number;
  quoteTtlSeconds?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

/** Current Jupiter Router adapter: GET /swap/v2/build, with strict parsing. */
export class JupiterV2QuoteProvider implements JupiterQuoteFetcher {
  private readonly builds = new Map<string, JupiterV2Build>();
  private readonly now: () => number;
  private quoteSequence = 0;

  constructor(private readonly cfg: JupiterV2Config) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote> {
    if (amount <= 0n) throw new Error("quote amount must be positive");
    const url = new URL(this.cfg.endpoint ?? "https://api.jup.ag/swap/v2/build");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("taker", this.cfg.taker);
    url.searchParams.set("slippageBps", String(this.cfg.slippageBps ?? 50));
    url.searchParams.set("maxAccounts", String(this.cfg.maxAccounts ?? 48));
    url.searchParams.set("wrapAndUnwrapSol", "false");

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.apiKey) headers["x-api-key"] = this.cfg.apiKey;
    const response = await (this.cfg.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(15_000) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? String(body.error) : response.statusText;
      throw new Error(`Jupiter build failed (${response.status}): ${message}`);
    }
    const build = buildSchema.parse(body);
    if (build.inputMint !== inputMint || build.outputMint !== outputMint || BigInt(build.inAmount) !== amount) {
      throw new Error("Jupiter returned a route for different mints or amount");
    }
    if (build.swapInstruction.programId !== JUPITER_V6_PROGRAM) {
      throw new Error("Jupiter returned an instruction for an unapproved program");
    }
    if (!build.swapInstruction.accounts.some((account) => account.pubkey === this.cfg.taker && account.isSigner)) {
      throw new Error("Jupiter swap instruction does not bind the configured taker as signer");
    }
    const outAmount = BigInt(build.outAmount);
    const minimumOutput = BigInt(build.otherAmountThreshold);
    if (minimumOutput <= 0n || minimumOutput > outAmount) {
      throw new Error("Jupiter returned an invalid minimum output");
    }
    const issuedAt = this.now();
    const quoteId = createHash("sha256")
      .update(JSON.stringify({
        inputMint: build.inputMint,
        outputMint: build.outputMint,
        inAmount: build.inAmount,
        outAmount: build.outAmount,
        otherAmountThreshold: build.otherAmountThreshold,
        routePlan: build.routePlan,
        swapInstruction: build.swapInstruction,
        issuedAt,
        issuance: ++this.quoteSequence,
      }))
      .digest("hex");
    this.builds.set(quoteId, build);
    return Object.freeze({
      quoteId,
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount,
      minimumOutput,
      route: build.routePlan.map((leg) => leg.swapInfo.label ?? leg.swapInfo.ammKey).join(" -> "),
      expiresAt: issuedAt + (this.cfg.quoteTtlSeconds ?? 20),
    });
  }

  buildFor(quoteId: string): JupiterV2Build | undefined {
    return this.builds.get(quoteId);
  }
}
