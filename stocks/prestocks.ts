import { z } from "zod";
import { SOLANA_USDC_MINT, TOKEN_2022_PROGRAM } from "./instruments";
import type { StockInstrument, StockInstrumentCatalogSource } from "./types";
import type { LiveSample, TapeSource } from "./prices";
import type { InstrumentRoutability, MintRoutability, VenueId } from "./venues";
import { plainText } from "./redact";

const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), "HTTPS URL required");

/**
 * This registry's words end up in front of a language model, as the name and
 * description of something it might be asked to buy. So they are decided here,
 * at the door: a name is a short label, a symbol is a ticker, a description is
 * a sentence or two of plain text. A provider can still say something untrue;
 * it cannot say something long, hidden or shaped like an instruction block.
 */
const preStockSchema = z.object({
  name: z.string().min(1).max(200).transform((value) => plainText(value, 64)).pipe(z.string().min(1)),
  symbol: z.string().regex(/^[A-Za-z0-9.]{1,16}$/),
  description: z.string().min(1).max(4_000).transform((value) => plainText(value, 280)),
  image: httpsUrl.max(256),
  external_url: httpsUrl.max(256),
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
  /** In the units a wallet shows: raw supply times the scaled-UI multiplier, as the issuer reports it. */
  displaySupply: string;
  /** Token-2022's scaled-UI multiplier in force now; 1 when the mint has none. */
  uiMultiplier: number;
  /** The newest configured transfer fee, in basis points; null when the mint charges none. */
  transferFeeBps: number | null;
  /** What the issuer can do to holders, in plain words, from the mint's own extensions. */
  issuerControls: string[];
}

type MintExtension = { extension?: unknown; state?: Record<string, unknown> };

/**
 * What a Token-2022 mint lets its issuer do, read from its extensions rather
 * than from the issuer's page. PreStocks mints carry most of them: a transfer
 * fee, a pause switch, a permanent delegate, freeze and mint authorities, a
 * transfer hook slot and a scaled-UI multiplier. An agent about to hold one
 * should be told, in words, before it buys.
 */
export function mintFacts(info: Record<string, unknown>, nowSeconds: number): Pick<SolanaMintMetadata, "uiMultiplier" | "transferFeeBps" | "issuerControls"> {
  const extensions = Array.isArray(info.extensions) ? (info.extensions as MintExtension[]) : [];
  const state = (name: string) => extensions.find((e) => e.extension === name)?.state;
  const num = (value: unknown) => (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value)) ? Number(value) : undefined;
  const controls: string[] = [];

  let uiMultiplier = 1;
  const scaled = state("scaledUiAmountConfig");
  if (scaled) {
    const current = num(scaled.multiplier) ?? 1;
    const next = num(scaled.newMultiplier);
    const at = num(scaled.newMultiplierEffectiveTimestamp);
    uiMultiplier = next !== undefined && at !== undefined && nowSeconds >= at ? next : current;
    if (uiMultiplier !== 1) {
      controls.push(`Balances and prices display at ${uiMultiplier}× the raw amount (a scaled-UI multiplier the issuer can change).`);
    }
  }

  let transferFeeBps: number | null = null;
  const fee = state("transferFeeConfig");
  if (fee) {
    const newer = fee.newerTransferFee as Record<string, unknown> | undefined;
    const older = fee.olderTransferFee as Record<string, unknown> | undefined;
    transferFeeBps = num(newer?.transferFeeBasisPoints) ?? null;
    const was = num(older?.transferFeeBasisPoints);
    if (transferFeeBps) {
      const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
      controls.push(`Every transfer pays a ${pct(transferFeeBps)} fee to the issuer, with no cap${was !== undefined && was !== transferFeeBps ? ` (it was ${pct(was)})` : ""}; the issuer can change it.`);
    }
  }
  const pausable = state("pausableConfig");
  if (pausable) controls.push(`The issuer can pause every transfer${pausable.paused === true ? ", and has: it is paused now" : " (not paused now)"}.`);
  if (state("permanentDelegate")?.delegate) controls.push("A permanent delegate can move or burn tokens from any holder's account.");
  if (typeof info.freezeAuthority === "string") controls.push("The issuer can freeze any holder's account.");
  if (typeof info.mintAuthority === "string") controls.push("The issuer can mint more.");
  const hook = state("transferHook");
  if (hook && typeof hook.authority === "string") {
    controls.push(hook.programId ? "Every transfer runs a program the issuer chose (a transfer hook)." : "The issuer can attach a program to every transfer (a transfer hook, not active now).");
  }
  return { uiMultiplier, transferFeeBps, issuerControls: controls };
}

/** A raw amount in display units, multiplied without floating-point surprises for a whole multiplier. */
function scaledAmount(raw: string, decimals: number, multiplier: number): string {
  if (multiplier === 1) return formatTokenAmount(raw, decimals);
  const value = (Number(raw) / 10 ** decimals) * multiplier;
  return String(Number(value.toFixed(Math.min(decimals, 6))));
}

export interface SolanaMintVerifier {
  verify(mints: readonly string[]): Promise<Map<string, SolanaMintMetadata>>;
}

export class SolanaRpcMintVerifier implements SolanaMintVerifier {
  constructor(
    private readonly endpoint = "https://api.mainnet-beta.solana.com",
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
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
      const facts = mintFacts(account.data.parsed.info as Record<string, unknown>, this.now());
      result.set(mint, {
        mint,
        tokenProgram: account.owner,
        parsedProgram: account.data.program,
        decimals,
        rawSupply: supply,
        displaySupply: scaledAmount(supply, decimals, facts.uiMultiplier),
        ...facts,
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
    if (!response.ok) throw new Error(`PreStocks discovery failed (${response.status})`);
    // Read as text first so a provider cannot hand this process an unbounded
    // document to parse, and judge rows one at a time so one bad row costs that
    // row rather than the whole catalogue.
    const text = await response.text();
    if (text.length > 512_000) throw new Error("PreStocks response is too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("PreStocks response is not JSON");
    }
    const rows = z.array(z.unknown()).min(1).max(100).parse(body);
    const assets = rows
      .map((row) => preStockSchema.safeParse(row))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    if (assets.length === 0) throw new Error("PreStocks returned no usable instruments");
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
      // Absent when nothing probed, empty when a probe came back with nothing.
      // Writing [] either way tells a later reader that every venue was asked
      // and none would fill it, which is a claim no unprobed catalogue can make.
      const routing = this.cfg.routability ? routes.get(asset.contract_address) : undefined;
      return Object.freeze({
        symbol: asset.symbol,
        name: asset.name,
        provider: "prestocks",
        assetClass: "private-company-exposure",
        executionStatus: "discovery-only",
        tradableVenues: routing ? Object.freeze([...routing.venues]) : undefined,
        routabilityUnknownVenues: routing ? Object.freeze([...routing.undetermined]) : undefined,
        issuer: "PreStocks",
        mint: asset.contract_address,
        usdcMint: SOLANA_USDC_MINT,
        decimals: mint.decimals,
        enabled: false,
        network: "solana-mainnet",
        tokenProgram: mint.tokenProgram,
        transferRules: Object.freeze([...mint.issuerControls]),
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

/**
 * PreStocks on the price tape.
 *
 * A listed share has an exchange behind it, so its token can be checked against
 * an index. A pre-IPO token has nothing of the kind. What exists is the issuer's
 * *mark*: what it says a unit of exposure is worth, from the company's last
 * priced round. That is the reference side here, and it is the only one there
 * is, which the evidence says by naming its source.
 *
 * The token side comes from the Jupiter source, once these mints are on the
 * sampler's list: what the token actually trades at on chain. The provider also
 * reports a token price, and it is deliberately NOT recorded. Measured live, it
 * matched Jupiter's to the last digit: it is Jupiter's number passed along, and
 * writing it down as a second source would make one observation look like two
 * parties agreeing.
 *
 * Nor is the mark independent of anything. Jupiter's feed carries an issuer
 * price for these tokens as well, and it is the same mark by another route. Two
 * routes to one party's word check the delivery, not the valuation. For a
 * private company there is no second valuation to be had, and the evidence
 * names its sources so that a reader can see that for themselves.
 *
 * It reads through the registry rather than fetching again: the registry has
 * already bounded the response, judged it row by row and verified every mint on
 * chain, and its cache makes this one request a minute however often the
 * sampler ticks. A point carries the moment the registry observed it, not the
 * moment it was read here, so when the provider goes quiet the price ages and
 * the gate calls it stale instead of trusting a number from an hour ago.
 */
export class PreStocksMarkSource implements TapeSource {
  readonly id = "prestocks-mark";
  readonly side = "reference" as const;
  private seen: StockInstrument[] = [];

  constructor(private readonly registry: Pick<StockInstrumentCatalogSource, "instruments">) {}

  /** What the registry last listed, so the rest of the sampler can price the same mints. */
  known(): readonly StockInstrument[] {
    return this.seen;
  }

  async sample(): Promise<LiveSample[]> {
    const listed = await this.registry.instruments();
    this.seen = listed;
    const out: LiveSample[] = [];
    for (const instrument of listed) {
      const data = instrument.referenceData;
      if (!data) continue;
      const t = Math.floor(Date.parse(String(data.observedAt ?? "")) / 1000);
      if (!Number.isFinite(t)) continue;
      const mark = Number(data.markPriceUsd);
      if (Number.isFinite(mark) && mark > 0) {
        out.push({ mint: instrument.mint, side: "reference", point: { t, price: mark, source: this.id } });
      }
    }
    return out;
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
