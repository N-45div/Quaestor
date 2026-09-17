import { z } from "zod";
import { SOLANA_USDC_MINT, TOKEN_2022_PROGRAM } from "./instruments";
import type { StockInstrument, StockInstrumentCatalogSource } from "./types";
import type { InstrumentRoutability, MintRoutability, VenueId } from "./venues";

const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), "HTTPS URL required");

const preStockSchema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1).max(32),
  description: z.string().min(1),
  image: httpsUrl,
  external_url: httpsUrl,
  contract_address: z.string().regex(mintPattern),
  markPrice: z.number().finite().positive(),
  markValuation: z.number().finite().positive(),
  tokenPrice: z.number().finite().positive(),
  impliedValuation: z.number().finite().positive(),
  supply: z.number().finite().nonnegative(),
}).passthrough();

const mintAccountSchema = z.object({
  owner: z.string().regex(mintPattern),
  data: z.object({
    program: z.string().min(1),
    parsed: z.object({
      type: z.literal("mint"),
      info: z.object({
        decimals: z.number().int().min(0).max(18),
        supply: z.string().regex(/^\d+$/),
      }).passthrough(),
    }),
  }),
}).passthrough();

const rpcResponseSchema = z.object({
  result: z.object({
    value: z.array(mintAccountSchema.nullable()),
  }),
}).passthrough();

export interface SolanaMintMetadata {
  mint: string;
  tokenProgram: string;
  parsedProgram: string;
  decimals: number;
  rawSupply: string;
  displaySupply: string;
}

export interface SolanaMintVerifier {
  verify(mints: readonly string[]): Promise<Map<string, SolanaMintMetadata>>;
}

export class SolanaRpcMintVerifier implements SolanaMintVerifier {
  constructor(
    private readonly endpoint = "https://api.mainnet-beta.solana.com",
    private readonly request: typeof fetch = fetch,
  ) {}

  async verify(mints: readonly string[]): Promise<Map<string, SolanaMintMetadata>> {
    if (mints.length === 0) return new Map();
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "quaestor-prestocks",
        method: "getMultipleAccounts",
        params: [mints, { encoding: "jsonParsed", commitment: "confirmed" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Solana mint verification failed (${response.status})`);
    const parsed = rpcResponseSchema.parse(body);
    if (parsed.result.value.length !== mints.length) throw new Error("Solana returned the wrong number of mint accounts");
    const result = new Map<string, SolanaMintMetadata>();
    parsed.result.value.forEach((account, index) => {
      const mint = mints[index];
      if (!account) throw new Error(`Solana mint account does not exist: ${mint}`);
      if (account.owner !== TOKEN_2022_PROGRAM) {
        throw new Error(`PreStocks mint is not owned by Token-2022: ${mint}`);
      }
      const { decimals, supply } = account.data.parsed.info;
      result.set(mint, {
        mint,
        tokenProgram: account.owner,
        parsedProgram: account.data.program,
        decimals,
        rawSupply: supply,
        displaySupply: formatTokenAmount(supply, decimals),
      });
    });
    return result;
  }
}

export interface PreStocksRegistryConfig {
  endpoint?: string;
  cacheMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /**
   * Decides which of these instruments can actually be executed.
   *
   * Without it every instrument stays discovery-only. That is the safe default:
   * a pre-IPO token that no venue can fill should not be quotable, and the
   * absence of a probe is not evidence that a route exists.
   */
  routability?: InstrumentRoutability;
}

/** Live PreStocks discovery with independent Solana mint-account verification. */
export class PreStocksRegistry implements StockInstrumentCatalogSource {
  readonly provider = "prestocks";
  private cache: { expiresAt: number; value: StockInstrument[] } | null = null;
  private readonly request: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly mintVerifier: SolanaMintVerifier,
    private readonly cfg: PreStocksRegistryConfig = {},
  ) {
    this.request = cfg.fetch ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  async instruments(): Promise<StockInstrument[]> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value.map(cloneInstrument);
    const response = await this.request(this.cfg.endpoint ?? "https://prestocks.com/api/prestocks", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`PreStocks discovery failed (${response.status})`);
    const assets = z.array(preStockSchema).min(1).parse(body);
    const uniqueMints = new Set(assets.map((asset) => asset.contract_address));
    if (uniqueMints.size !== assets.length) throw new Error("PreStocks returned a duplicate mint");
    const [metadata, routes] = await Promise.all([
      this.mintVerifier.verify([...uniqueMints]),
      this.cfg.routability?.routable([...uniqueMints], SOLANA_USDC_MINT)
        ?? Promise.resolve(new Map<string, MintRoutability>()),
    ]);
    const observedAt = new Date(now).toISOString();
    const value = assets.map((asset): StockInstrument => {
      const mint = metadata.get(asset.contract_address);
      if (!mint) throw new Error(`PreStocks mint was not verified: ${asset.contract_address}`);
      // Routable and tradeable are different facts. A probe can show that a
      // venue will fill this mint; only the owner can permit buying it, and a
      // catalogue fetched from a provider's API must never be able to grant
      // that — otherwise a compromised endpoint makes its own tokens tradeable.
      // So this reports the liquidity and leaves the permission alone.
      const routing = routes.get(asset.contract_address);
      const tradableVenues = routing?.venues ?? [];
      return Object.freeze({
        symbol: asset.symbol,
        name: asset.name,
        provider: "prestocks",
        assetClass: "private-company-exposure",
        executionStatus: "discovery-only",
        tradableVenues: Object.freeze([...tradableVenues]),
        routabilityUnknownVenues: Object.freeze([...(routing?.undetermined ?? [])]),
        issuer: "PreStocks",
        mint: asset.contract_address,
        usdcMint: SOLANA_USDC_MINT,
        decimals: mint.decimals,
        enabled: false,
        network: "solana-mainnet",
        tokenProgram: mint.tokenProgram,
        transferRules: Object.freeze([]),
        sourceUrl: this.cfg.endpoint ?? "https://prestocks.com/api/prestocks",
        legalUrl: "https://prestocks.com/",
        externalUrl: asset.external_url,
        imageUrl: asset.image,
        description: asset.description,
        rightsNotice: "Economic exposure only; no ownership, voting, dividend or information rights in the referenced company. Product terms and redemption rules come from PreStocks.",
        jurisdictionNotice: "Not available to US persons and other ineligible jurisdictions; eligibility is determined by the provider's current terms.",
        lifecycleNotice: "Check the provider product page before use because corporate actions can require migration, swaps or expiry.",
        referenceData: Object.freeze({
          observedAt,
          markPriceUsd: decimal(asset.markPrice),
          tokenPriceUsd: decimal(asset.tokenPrice),
          premiumBps: Math.round(((asset.tokenPrice - asset.markPrice) / asset.markPrice) * 10_000),
          markValuationUsd: decimal(asset.markValuation),
          impliedValuationUsd: decimal(asset.impliedValuation),
          providerReportedSupply: decimal(asset.supply),
          onchainMintSupply: mint.displaySupply,
        }),
      });
    });
    this.cache = { expiresAt: now + (this.cfg.cacheMs ?? 60_000), value };
    return value.map(cloneInstrument);
  }
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error("PreStocks returned a non-finite decimal");
  return value.toString();
}

function formatTokenAmount(raw: string, decimals: number): string {
  const padded = raw.padStart(decimals + 1, "0");
  if (decimals === 0) return padded;
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function cloneInstrument(instrument: StockInstrument): StockInstrument {
  return {
    ...instrument,
    transferRules: [...(instrument.transferRules ?? [])],
    tradableVenues: instrument.tradableVenues ? [...instrument.tradableVenues] : undefined,
    routabilityUnknownVenues: instrument.routabilityUnknownVenues
      ? [...instrument.routabilityUnknownVenues]
      : undefined,
    referenceData: instrument.referenceData ? { ...instrument.referenceData } : undefined,
  };
}
