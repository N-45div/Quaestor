/**
 * Meteora's Dynamic Bonding Curve as a venue the governor can buy from.
 *
 * A curve is unlike an aggregator in the one way that matters here: it needs
 * nobody's signature but the buyer's. The buyer is the governor's vault, whose
 * authority is a PDA, so the swap is built with that PDA as DBC's `payer`, the
 * vault as its input and the instrument's own position account as its output.
 * The governor lends the PDA's signature for exactly that call and measures the
 * vault and the position either side of it. Nothing in this process signs for
 * the pool, which is what made the stub a test venue and makes this a real one.
 *
 * Three pieces, all reading the same pool:
 *
 *   quotes   what the curve would pay right now, from its own state and its own
 *            fee schedule: a guaranteed floor, not an expected fill
 *   route    the swap instruction, with the one signer flag the outer
 *            transaction cannot carry removed, and any other refused
 *   price    the pool's spot price, on the tape as the token's own market, so
 *            the gate can ask how far the curve sits from the share it tracks
 *
 * A curve ends. Once it has taken in its threshold it migrates to a DAMM v2
 * pool and stops filling, so every piece here fails closed on a graduated
 * curve: no quote, no route, no price. Trading the graduated pool is a
 * different venue with a different allowlist entry, and the owner's to approve.
 */
import { randomUUID } from "node:crypto";
import BN from "bn.js";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountMeta, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ActivationType,
  DynamicBondingCurveClient,
  TokenDecimal,
  deriveDbcEventAuthority,
  deriveDbcPoolAuthority,
  getPriceFromSqrtPrice,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { JupiterQuoteFetcher } from "./jupiter";
import type { LiveSample, TapeSource } from "./prices";
import type { RouteRequest, SolanaRouteBuilder, SolanaVenueRoute } from "./solana-executor";
import type { JupiterQuote, StockInstrument } from "./types";
import { NoRouteError, type VenueId } from "./venues";

export const DBC_VENUE: VenueId = "meteora-dbc";

/** What a buy of `amountIn` would do, read from the curve at one moment. */
export interface DbcBuyQuote {
  outAmount: bigint;
  minimumOutput: bigint;
  /** Spot price before the buy, in USD per token. */
  priceUsd: number;
  /** Share of the graduation threshold already taken in, 0..1. */
  progress: number;
}

export interface DbcSwapAccounts {
  /** DBC's `payer`: whoever owns the input account. Here, the vault's PDA. */
  payer: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
}

/**
 * One curve, as the venue needs to see it. An interface rather than the SDK
 * client so the logic around it can be tested against a pool that graduates,
 * moves or disappears on demand.
 */
export interface DbcPool {
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly programId: PublicKey;
  /** Throws `NoRouteError` once the curve has graduated. */
  quoteBuy(amountIn: bigint, slippageBps: number): Promise<DbcBuyQuote>;
  /** Undefined once graduated: a curve that no longer trades has no price to offer. */
  spot(): Promise<{ priceUsd: number; progress: number } | undefined>;
  swapInstruction(accounts: DbcSwapAccounts, amountIn: bigint, minimumOut: bigint): Promise<{ keys: AccountMeta[]; data: Buffer }>;
}

// ------------------------------------------------------------------ the pool

/**
 * The point on DBC's clock, which its fee schedule is measured from: a slot or
 * a unix time, depending on how the curve was configured.
 *
 * Read from the Clock sysvar, which is what the program itself reads. The SDK's
 * helper asks for the latest slot and then for that slot's block time, and on a
 * cluster that skips slots the second question often has no answer, because a
 * skipped slot has no block. One account read cannot fail that way.
 */
export async function dbcCurrentPoint(connection: Connection, activationType: number): Promise<BN> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!clock || clock.data.length < 40) throw new Error("the cluster clock could not be read");
  // Clock: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64.
  return activationType === ActivationType.Slot
    ? new BN(clock.data.readBigUInt64LE(0).toString())
    : new BN(clock.data.readBigInt64LE(32).toString());
}

type PoolAccount = {
  poolState: { sqrtPrice: BN; quoteReserve: BN; config: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; isMigrated: number };
};
type PoolConfig = NonNullable<Awaited<ReturnType<DynamicBondingCurveClient["state"]["getPoolConfig"]>>>;

/** The curve on chain, through Meteora's SDK. Base and quote are both six-decimal SPL tokens. */
export class MeteoraDbcPool implements DbcPool {
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly programId: PublicKey;
  private readonly client: DynamicBondingCurveClient;
  private readonly pool: PublicKey;
  private config_: Promise<PoolConfig> | undefined;

  constructor(private readonly connection: Connection, cfg: { pool: string; baseMint: string; quoteMint: string }) {
    this.client = new DynamicBondingCurveClient(connection, "confirmed");
    this.programId = this.client.state.getProgram().programId;
    this.pool = new PublicKey(cfg.pool);
    this.baseMint = cfg.baseMint;
    this.quoteMint = cfg.quoteMint;
  }

  private async read(): Promise<PoolAccount> {
    // A virtual pool decodes as `{ poolState: { ... } }`.
    const account = (await this.client.state.getPool(this.pool)) as unknown as PoolAccount | null;
    if (!account) throw new Error("the DBC pool account could not be read");
    return account;
  }

  /**
   * A curve's config is fixed when the pool is created, so it is read once. The
   * price tick runs every few seconds for as long as the hub is up, and reading
   * an immutable account each time would triple what it asks of the RPC.
   */
  private config(account: PoolAccount): Promise<PoolConfig> {
    this.config_ ??= this.client.state.getPoolConfig(account.poolState.config).then((config) => {
      if (!config) throw new Error("the DBC pool's config could not be read");
      return config;
    });
    // A failed read is not remembered: the next caller asks again.
    this.config_.catch(() => { this.config_ = undefined; });
    return this.config_;
  }

  private priceOf(account: PoolAccount): number {
    return Number(getPriceFromSqrtPrice(account.poolState.sqrtPrice, TokenDecimal.SIX, TokenDecimal.SIX).toString());
  }

  /** Share of the graduation threshold already taken in. */
  private progressOf(account: PoolAccount, config: PoolConfig): number {
    const threshold = Number(config.migrationQuoteThreshold.toString());
    if (!(threshold > 0)) return 0;
    return Math.min(1, Math.max(0, Number(account.poolState.quoteReserve.toString()) / threshold));
  }

  async spot(): Promise<{ priceUsd: number; progress: number } | undefined> {
    const account = await this.read();
    if (account.poolState.isMigrated !== 0) return undefined;
    return { priceUsd: this.priceOf(account), progress: this.progressOf(account, await this.config(account)) };
  }

  async quoteBuy(amountIn: bigint, slippageBps: number): Promise<DbcBuyQuote> {
    const account = await this.read();
    if (account.poolState.isMigrated !== 0) {
      throw new NoRouteError("this curve has graduated to a DAMM v2 pool and no longer fills");
    }
    const config = await this.config(account);
    // Read outside the guard below: an RPC that cannot be reached is an outage,
    // and must not be reported as a curve that will not fill.
    const currentPoint = await dbcCurrentPoint(this.connection, config.activationType);
    let quote: { outputAmount: BN; minimumAmountOut: BN };
    try {
      quote = this.client.pool.swapQuote({
        virtualPool: account as never,
        config,
        swapBaseForQuote: false,
        amountIn: new BN(amountIn.toString()),
        slippageBps,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint,
      });
    } catch (error) {
      // Pure arithmetic from here, so a throw is the curve's own answer: the
      // buy is larger than what is left on it.
      throw new NoRouteError(`the curve cannot fill this buy: ${String((error as Error).message ?? error).slice(0, 120)}`);
    }
    return {
      outAmount: BigInt(quote.outputAmount.toString()),
      minimumOutput: BigInt(quote.minimumAmountOut.toString()),
      priceUsd: this.priceOf(account),
      progress: this.progressOf(account, config),
    };
  }

  async swapInstruction(accounts: DbcSwapAccounts, amountIn: bigint, minimumOut: bigint): Promise<{ keys: AccountMeta[]; data: Buffer }> {
    const account = await this.read();
    // Built from the program's own interface rather than the SDK's `swap()`,
    // which assumes the buyer is a wallet and derives its token accounts.
    const instruction = await this.client.state.getProgram().methods
      .swap({ amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(minimumOut.toString()) })
      .accountsPartial({
        poolAuthority: deriveDbcPoolAuthority(),
        config: account.poolState.config,
        pool: this.pool,
        inputTokenAccount: accounts.inputTokenAccount,
        outputTokenAccount: accounts.outputTokenAccount,
        baseVault: account.poolState.baseVault,
        quoteVault: account.poolState.quoteVault,
        baseMint: new PublicKey(this.baseMint),
        quoteMint: new PublicKey(this.quoteMint),
        payer: accounts.payer,
        tokenBaseProgram: TOKEN_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        eventAuthority: deriveDbcEventAuthority(),
        program: this.programId,
      } as never)
      .instruction();
    return { keys: instruction.keys, data: instruction.data };
  }
}

// ---------------------------------------------------------------- the quotes

export interface DbcQuoteConfig {
  pool: DbcPool;
  slippageBps?: number;
  quoteTtlSeconds?: number;
  now?: () => number;
}

export class DbcQuoteProvider implements JupiterQuoteFetcher {
  private readonly now: () => number;

  constructor(private readonly cfg: DbcQuoteConfig) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async quote(inputMint: string, outputMint: string, amount: bigint): Promise<JupiterQuote> {
    if (amount <= 0n) throw new Error("quote amount must be positive");
    // A curve sells one token for one other. Asked for anything else, the
    // answer is "no route", which is a fact about the venue and not an outage.
    if (inputMint !== this.cfg.pool.quoteMint || outputMint !== this.cfg.pool.baseMint) {
      throw new NoRouteError("this curve sells one token for USDC and nothing else");
    }
    const buy = await this.cfg.pool.quoteBuy(amount, this.cfg.slippageBps ?? 50);
    if (buy.outAmount <= 0n || buy.minimumOutput <= 0n) {
      throw new NoRouteError("the amount is too small for the curve to pay anything it could guarantee");
    }
    return Object.freeze({
      quoteId: randomUUID(),
      venue: DBC_VENUE,
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount: buy.outAmount,
      minimumOutput: buy.minimumOutput,
      route: `${DBC_VENUE} / bonding curve @ $${buy.priceUsd.toFixed(4)}, ${(buy.progress * 100).toFixed(2)}% to graduation`,
      expiresAt: this.now() + (this.cfg.quoteTtlSeconds ?? 30),
    });
  }
}

// ----------------------------------------------------------------- the route

export interface DbcRouteConfig {
  pool: DbcPool;
  /** The governor's vault authority PDA: the only signature the governor lends. */
  vaultAuthority: PublicKey;
  vault: PublicKey;
  /** The position account for this curve's token, owned by its per-instrument authority. */
  stockAccount: PublicKey;
}

export class DbcRouteBuilder implements SolanaRouteBuilder {
  readonly venue = DBC_VENUE;

  constructor(private readonly cfg: DbcRouteConfig) {}

  async build({ intent, amountIn, minOutput }: RouteRequest): Promise<SolanaVenueRoute> {
    if (intent.instrumentMint !== this.cfg.pool.baseMint) {
      throw new Error("this curve does not sell the instrument the intent names");
    }
    // The venue is told the same floor the governor is. The governor's is the
    // one that binds, since it measures; this one only makes DBC fail sooner
    // and cheaper when the curve has moved.
    const { keys, data } = await this.cfg.pool.swapInstruction(
      { payer: this.cfg.vaultAuthority, inputTokenAccount: this.cfg.vault, outputTokenAccount: this.cfg.stockAccount },
      amountIn,
      minOutput,
    );
    const accounts = keys.map((key) => {
      if (!key.isSigner) return key;
      // The outer transaction cannot carry a PDA's signature; the governor adds
      // it when it calls DBC. It adds no other, so a route asking for one would
      // be asking this process to sign for a venue, and that is refused here
      // rather than discovered on chain.
      if (!key.pubkey.equals(this.cfg.vaultAuthority)) {
        throw new Error("the DBC route asks for a signature other than the vault authority's");
      }
      return { ...key, isSigner: false };
    });
    return { programId: this.cfg.pool.programId, accounts, data };
  }
}

// ----------------------------------------------------------------- the price

/**
 * The curve's spot price, as the token's own market.
 *
 * It goes on the tokenized side because that is what it is: the price this
 * token changes hands at. The reference side stays what it was, the share's
 * price from sources that have never heard of this pool, and the gap between
 * the two is the premium the gate judges.
 */
export class DbcPoolPriceSource implements TapeSource {
  readonly id = "meteora-dbc-pool";
  readonly side = "tokenized" as const;

  constructor(private readonly pool: DbcPool, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async sample(instruments: readonly StockInstrument[]): Promise<LiveSample[]> {
    if (!instruments.some((instrument) => instrument.mint === this.pool.baseMint)) return [];
    const spot = await this.pool.spot();
    // Graduated: say nothing, and let the price already on the tape age out.
    if (!spot) return [];
    return [{ mint: this.pool.baseMint, side: this.side, point: { t: this.now(), price: spot.priceUsd, source: this.id } }];
  }
}
