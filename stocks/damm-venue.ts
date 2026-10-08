/**
 * Meteora DAMM v2 as a venue: the pool an anchored curve graduates into.
 *
 * A DBC curve is a launch. Once it has taken in its threshold it stops filling,
 * and DBC migrates its liquidity into a DAMM v2 pool at the curve's last price.
 * The token goes on trading, now there. This is that pool as a venue the
 * governor can buy from, built the same way as the curve: the swap names the
 * vault's PDA as DAMM v2's `payer`, the vault as its input and the instrument's
 * position account as its output, and the governor lends that one signature
 * and measures the vault and the position either side of the call.
 *
 * Where the curve will graduate is known before it does. A DBC config names the
 * DAMM v2 config it migrates through, and a DAMM v2 pool's address is derived
 * from that config and the two mints, so `dammPoolFor` can name the pool on the
 * day the curve launches. Until the migration creates it, it does not exist,
 * and every piece here says so rather than guessing.
 */
import { randomUUID } from "node:crypto";
import BN from "bn.js";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountMeta, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CpAmm, derivePoolAuthority, getPriceFromSqrtPrice, type PoolState } from "@meteora-ag/cp-amm-sdk";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { JupiterQuoteFetcher } from "./jupiter";
import type { RouteRequest, SolanaRouteBuilder, SolanaVenueRoute } from "./solana-executor";
import type { JupiterQuote } from "./types";
import { NoRouteError, type VenueId } from "./venues";

export const DAMM_VENUE: VenueId = "meteora-damm-v2";
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

/**
 * The DAMM v2 pool a DBC curve graduates into: derived from the DAMM v2 config
 * its migration fee option names and the two mints. The anchored launch uses
 * the customizable option, so that is the default.
 */
export function dammPoolFor(baseMint: string, quoteMint: string, migrationFeeOption: number = MigrationFeeOption.Customizable): string {
  const config = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (!config) throw new Error(`no DAMM v2 config for migration fee option ${migrationFeeOption}`);
  return deriveDammV2PoolAddress(config, new PublicKey(baseMint), new PublicKey(quoteMint)).toBase58();
}

export interface DammBuyQuote {
  outAmount: bigint;
  minimumOutput: bigint;
  /** Spot price before the buy, in USD per token. */
  priceUsd: number;
}

export interface DammSwapAccounts {
  /** DAMM v2's `payer`: whoever owns the input account. Here, the vault's PDA. */
  payer: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
}

/** One pool, as the venue needs to see it. An interface, so a test can hand it a pool that appears on demand. */
export interface DammPool {
  readonly address: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly programId: PublicKey;
  /** Throws `NoRouteError` while the pool does not exist yet. */
  quoteBuy(amountIn: bigint, slippageBps: number): Promise<DammBuyQuote>;
  /** Undefined while the pool does not exist yet. */
  spot(): Promise<{ priceUsd: number } | undefined>;
  swapInstruction(accounts: DammSwapAccounts, amountIn: bigint, minimumOut: bigint): Promise<{ keys: AccountMeta[]; data: Buffer }>;
}

/** The pool on chain, through Meteora's cp-amm SDK. Both tokens are six-decimal SPL tokens. */
export class MeteoraDammV2Pool implements DammPool {
  readonly address: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly programId: PublicKey;
  private readonly amm: CpAmm;
  private readonly pool: PublicKey;

  constructor(private readonly connection: Connection, cfg: { pool: string; baseMint: string; quoteMint: string }) {
    this.amm = new CpAmm(connection);
    this.programId = this.amm._program.programId;
    this.pool = new PublicKey(cfg.pool);
    this.address = cfg.pool;
    this.baseMint = cfg.baseMint;
    this.quoteMint = cfg.quoteMint;
  }

  /** The pool's state, or undefined while the migration has not created it. */
  private async read(): Promise<PoolState | undefined> {
    const info = await this.connection.getAccountInfo(this.pool, "confirmed");
    if (!info) return undefined;
    const state = await this.amm.fetchPoolState(this.pool);
    // A pool at this address pairing anything else is not the one the curve graduated into.
    if (state.tokenAMint.toBase58() !== this.baseMint || state.tokenBMint.toBase58() !== this.quoteMint) {
      throw new Error("the DAMM v2 pool does not pair this token with USDC");
    }
    return state;
  }

  private priceOf(state: PoolState): number {
    return Number(getPriceFromSqrtPrice(state.sqrtPrice, 6, 6).toString());
  }

  async spot(): Promise<{ priceUsd: number } | undefined> {
    const state = await this.read();
    return state ? { priceUsd: this.priceOf(state) } : undefined;
  }

  async quoteBuy(amountIn: bigint, slippageBps: number): Promise<DammBuyQuote> {
    const state = await this.read();
    if (!state) throw new NoRouteError("the curve has not graduated: its DAMM v2 pool does not exist yet");
    // DAMM v2's fees are measured on its own clock, read the way the program reads it.
    const clock = await this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
    if (!clock || clock.data.length < 40) throw new Error("the cluster clock could not be read");
    let quote: { swapOutAmount: BN; minSwapOutAmount: BN };
    try {
      quote = this.amm.getQuote({
        inAmount: new BN(amountIn.toString()),
        inputTokenMint: new PublicKey(this.quoteMint),
        slippage: slippageBps,
        poolState: state,
        currentTime: Number(clock.data.readBigInt64LE(32)),
        currentSlot: Number(clock.data.readBigUInt64LE(0)),
        tokenADecimal: 6,
        tokenBDecimal: 6,
      });
    } catch (error) {
      // Pure arithmetic from here: a throw is the pool's own answer.
      throw new NoRouteError(`the pool cannot fill this buy: ${String((error as Error).message ?? error).slice(0, 120)}`);
    }
    return {
      outAmount: BigInt(quote.swapOutAmount.toString()),
      minimumOutput: BigInt(quote.minSwapOutAmount.toString()),
      priceUsd: this.priceOf(state),
    };
  }

  async swapInstruction(accounts: DammSwapAccounts, amountIn: bigint, minimumOut: bigint): Promise<{ keys: AccountMeta[]; data: Buffer }> {
    const state = await this.read();
    if (!state) throw new NoRouteError("the curve has not graduated: its DAMM v2 pool does not exist yet");
    // Built from the program's own interface rather than the SDK's `swap()`,
    // which assumes the buyer is a wallet and derives its token accounts.
    const instruction = await this.amm._program.methods
      .swap({ amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(minimumOut.toString()) })
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        pool: this.pool,
        inputTokenAccount: accounts.inputTokenAccount,
        outputTokenAccount: accounts.outputTokenAccount,
        tokenAVault: state.tokenAVault,
        tokenBVault: state.tokenBVault,
        tokenAMint: state.tokenAMint,
        tokenBMint: state.tokenBMint,
        payer: accounts.payer,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
      } as never)
      .instruction();
    return { keys: instruction.keys, data: instruction.data };
  }
}

// ---------------------------------------------------------------- the quotes

export interface DammQuoteConfig {
  pool: DammPool;
  slippageBps?: number;
  quoteTtlSeconds?: number;
  now?: () => number;
}

export class DammQuoteProvider implements JupiterQuoteFetcher {
  private readonly now: () => number;

  constructor(private readonly cfg: DammQuoteConfig) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote> {
    if (amount <= 0n) throw new Error("quote amount must be positive");
    if (inputMint !== this.cfg.pool.quoteMint || outputMint !== this.cfg.pool.baseMint) {
      throw new NoRouteError("this pool sells one token for USDC and nothing else");
    }
    const buy = await this.cfg.pool.quoteBuy(amount, this.cfg.slippageBps ?? 50);
    if (buy.outAmount <= 0n || buy.minimumOutput <= 0n) {
      throw new NoRouteError("the amount is too small for the pool to pay anything it could guarantee");
    }
    return Object.freeze({
      quoteId: randomUUID(),
      venue: DAMM_VENUE,
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount: buy.outAmount,
      minimumOutput: buy.minimumOutput,
      route: `${DAMM_VENUE} / graduated pool @ $${buy.priceUsd.toFixed(4)}`,
      expiresAt: this.now() + (this.cfg.quoteTtlSeconds ?? 30),
    });
  }
}

// ----------------------------------------------------------------- the route

export interface DammRouteConfig {
  pool: DammPool;
  /** The governor's vault authority PDA: the only signature the governor lends. */
  vaultAuthority: PublicKey;
  vault: PublicKey;
  /** The position account for this token, owned by its per-instrument authority. The curve's, unchanged. */
  stockAccount: PublicKey;
}

export class DammRouteBuilder implements SolanaRouteBuilder {
  readonly venue = DAMM_VENUE;

  constructor(private readonly cfg: DammRouteConfig) {}

  async build({ intent, amountIn, minOutput, venueMinOutput }: RouteRequest): Promise<SolanaVenueRoute> {
    if (intent.instrumentMint !== this.cfg.pool.baseMint) {
      throw new Error("this pool does not sell the instrument the intent names");
    }
    const { keys, data } = await this.cfg.pool.swapInstruction(
      { payer: this.cfg.vaultAuthority, inputTokenAccount: this.cfg.vault, outputTokenAccount: this.cfg.stockAccount },
      amountIn,
      venueMinOutput ?? minOutput,
    );
    const accounts = keys.map((key) => {
      if (!key.isSigner) return key;
      // The governor adds the PDA's signature when it calls DAMM v2, and no other.
      if (!key.pubkey.equals(this.cfg.vaultAuthority)) {
        throw new Error("the DAMM v2 route asks for a signature other than the vault authority's");
      }
      return { ...key, isSigner: false };
    });
    return { programId: this.cfg.pool.programId, accounts, data };
  }
}
