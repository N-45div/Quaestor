/**
 * The devnet lane: what turns the hub's order endpoint from a simulation into
 * a transaction.
 *
 * Nobody issues tokenized equities on devnet, so the instrument here is a
 * Token-2022 test mint standing in for AAPL. Everything around it is real: the
 * price comes from the live tape's mainnet reference, the venue is a program
 * deployed on devnet, the governor is the deployed program, and what the agent
 * gets back is a signature.
 *
 * The one thing a mainnet deployment must not copy is the stub venue. It fills
 * at the quoted price and needs its pool side signed by this process, because a
 * test fixture has no liquidity of its own. A real venue needs neither, and the
 * lane carries one: a Meteora bonding curve launched around the same share's
 * price, which the governor buys from with no signature of ours on the pool
 * side. It is mounted when the state file records it (`dbc`, written by
 * solana/scripts/dbc-devnet.ts and dbc-governed.ts).
 *
 * Reads `deployments/solana-devnet.json`, which `npm run stocks:solana:devnet`
 * writes. Keys stay where they were generated, outside the repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DevnetQuoteProvider,
  registerVenue,
  SolanaStockExecutor,
  StubRouteBuilder,
  VERIFIED_XSTOCKS,
  type JupiterQuoteFetcher,
  type PriceTape,
  type SolanaInstrumentAccounts,
  type SolanaRouteBuilder,
  type StockChainExecutor,
  type StockCurveView,
  type StockInstrument,
  type TapeSource,
  type VenueId,
} from "../stocks";
import { DBC_VENUE, DbcPoolPriceSource, DbcQuoteProvider, DbcRouteBuilder, MeteoraDbcPool } from "../stocks/dbc-venue";
import { SolanaChainLedger } from "../stocks/solana-ledger";
import { assessCurve } from "../stocks/dbc-launch";
import type { RemoteSigner } from "../solana/client";
import { dynamicOperatorFromEnv, type DynamicOperatorSigner } from "../solana/dynamic-signer";
import { safeMessage } from "../stocks/redact";

/** Where the operator's key is: whole in this process, or split with an MPC co-signer. */
export type OperatorCustody = "local-keypair" | "dynamic-mpc";

/** A bonding curve the lane can buy from: a second instrument, on a venue of its own. */
export interface DevnetCurve {
  instrument: StockInstrument;
  venue: VenueId;
  quotes: JupiterQuoteFetcher;
  /** The pool's spot price, for the tape: the token's own market. */
  priceSource: TapeSource;
  /** The band the curve was launched inside, around the price it was anchored to. */
  bandBps: number;
  anchoredToUsd: number;
  /**
   * The curve as its issuer would watch it, given the share's price now. Reads
   * what the price tick last saw, never the chain, so it is safe on a public route.
   */
  monitor(referenceUsd: number | undefined): StockCurveView;
}

export interface DevnetLane {
  instrument: StockInstrument;
  venue: VenueId;
  quotes: JupiterQuoteFetcher;
  executor: StockChainExecutor;
  /** The governor's owner and operator on chain; the intent must name this operator. */
  owner: string;
  operator: string;
  operatorCustody: OperatorCustody;
  usdcMint: string;
  governor: string;
  /** Public addresses, so the explorer can link to what the chain recorded. */
  program: string;
  vault: string;
  /**
   * The mainnet mint whose underlying price this instrument borrows. The test
   * mint has no market, so both its quotes and the gate that checks them read
   * the real share's price from here.
   */
  referenceMint?: string;
  /** Present when a curve has been launched and the owner has allowed it. */
  curve?: DevnetCurve;
  /** What the chain remembers: the policy as it really stands, and every settled trade. */
  ledger: SolanaChainLedger;
}

interface DevnetState {
  programs: { quaestor_stocks: string; router_stub: string };
  owner: string;
  operator: string;
  governor: string;
  vaultAuthority: string;
  vault: string;
  usdcMint: string;
  stockMint: string;
  stockAccount: string;
  poolInput: string;
  poolOutput: string;
  poolAuthority: string;
  dbc?: {
    program: string;
    pool: string;
    baseMint: string;
    anchored_to: { price_usd: number };
    plan: { band_bps: number; graduation_usdc: number; opening_price_usd: number; graduation_price_usd: number };
    /** Written once the owner has approved the venue and the mint and opened the position. */
    governed?: { position: string };
  };
}

/**
 * A keypair from an env var holding its JSON byte array, else from a file.
 *
 * A hosted deployment has no WSL home to read from, so it is handed the keys it
 * needs as secrets. It is handed *only* those: the fee payer there is a
 * dedicated low-value key, never the deployer, which is also the programs'
 * upgrade authority and has no business on anyone else's machine.
 */
const loadKeypair = (envName: string, path: string): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env[envName] ?? readFileSync(path, "utf8"))));

export function devnetLaneFromEnv(priceTape: PriceTape): DevnetLane | null {
  if (process.env.SOLANA_STOCKS_CLUSTER !== "devnet") return null;

  const rpcUrl = process.env.SOLANA_DEVNET_RPC_URL;
  if (!rpcUrl) {
    console.error("[stocks] devnet lane needs SOLANA_DEVNET_RPC_URL — the public endpoint throttles trades");
    return null;
  }
  const statePath = process.env.SOLANA_DEVNET_STATE
    ?? join(process.cwd(), "deployments", "solana-devnet.json");
  if (!existsSync(statePath)) {
    console.error(`[stocks] devnet lane needs ${statePath} — run: npm run stocks:solana:devnet`);
    return null;
  }

  const wslHome = process.env.WSL_HOME ?? "//wsl.localhost/Ubuntu-24.04/home/divijn";
  const keysDir = process.env.DEVNET_KEYS_DIR ?? `${wslHome}/quaestor-target/devnet`;
  const payerPath = process.env.DEVNET_DEPLOYER_KEYPAIR ?? `${wslHome}/.config/solana/id.json`;

  let state: DevnetState;
  let payer: Keypair;
  let operator: Keypair | RemoteSigner;
  let poolAuthority: Keypair;
  let dynamic: DynamicOperatorSigner | null = null;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as DevnetState;
    payer = loadKeypair("DEVNET_PAYER_SECRET", payerPath);
    // With DYNAMIC_OPERATOR=1 the operator keypair is not read at all, so a
    // host set up that way need not, and should not, be given it.
    dynamic = dynamicOperatorFromEnv(() => readFileSync(`${keysDir}/dynamic-operator.json`, "utf8"));
    operator = dynamic ?? loadKeypair("DEVNET_OPERATOR_SECRET", `${keysDir}/operator.json`);
    poolAuthority = loadKeypair("DEVNET_POOL_AUTHORITY_SECRET", `${keysDir}/pool-authority.json`);
  } catch {
    // Deliberately not the error's own message: a malformed secret makes
    // JSON.parse quote a fragment of it, and a missing file names its path.
    console.error("[stocks] devnet lane not mounted — the state file, a keypair or the Dynamic wallet settings could not be read or parsed");
    return null;
  }

  if (operator.publicKey.toBase58() !== state.operator) {
    console.error("[stocks] devnet lane not mounted — the operator key does not match the deployed governor");
    return null;
  }

  // The stub is a real program on devnet but a test venue, and the registry
  // says so rather than letting it pass for an aggregator.
  const venue: VenueId = "router-stub";
  registerVenue({
    id: venue,
    label: "router-stub",
    programId: state.programs.router_stub,
    kind: "test",
    verifiedOn: new Date().toISOString().slice(0, 10),
  });

  const instrumentDecimals = 8;
  const instrument: StockInstrument = Object.freeze({
    symbol: "dAAPLx",
    name: "AAPL (devnet test mint)",
    issuer: "Quaestor devnet fixture",
    mint: state.stockMint,
    usdcMint: state.usdcMint,
    decimals: instrumentDecimals,
    enabled: true,
    network: "solana-devnet",
    underlyingSymbol: "AAPL",
    executionStatus: "enabled",
    tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    tradableVenues: Object.freeze([venue]),
    routabilityUnknownVenues: Object.freeze([]),
    rightsNotice:
      "A devnet test mint standing in for AAPL. It carries no claim on anything: nobody issues tokenized equities on devnet. The price, the venue and the transaction are real.",
  });

  // Priced off the live mainnet reference the tape already samples for AAPLx —
  // a real current price for the underlying, not a number invented for devnet.
  const mainnetAapl = VERIFIED_XSTOCKS.find((i) => i.underlyingSymbol === "AAPL");
  const quotes = new DevnetQuoteProvider({
    venue,
    mint: state.stockMint,
    instrumentDecimals,
    slippageBps: Number(process.env.SOLANA_STOCK_SLIPPAGE_BPS ?? 50),
    // A hosted agent thinks between quoting and executing, and thirty seconds
    // is shorter than one turn of some of them. The gate re-reads the market at
    // execution, so a longer-lived quote is not a staler check.
    quoteTtlSeconds: Number(process.env.SOLANA_STOCK_QUOTE_TTL_SECONDS ?? 90),
    priceUsd: async () =>
      mainnetAapl ? priceTape.latest(mainnetAapl.mint, "reference")?.price : undefined,
  });

  const connection = new Connection(rpcUrl, "confirmed");
  const positions = new Map<string, SolanaInstrumentAccounts>([[state.stockMint, { stockAccount: new PublicKey(state.stockAccount) }]]);
  const routes = new Map<VenueId, SolanaRouteBuilder>();
  const curve = process.env.SOLANA_STOCK_DBC === "0" ? undefined : curveFrom(state, connection, positions, routes);
  const executor = new SolanaStockExecutor({
    connection,
    governorOwner: new PublicKey(state.owner),
    vault: new PublicKey(state.vault),
    operator,
    payer,
    cluster: "devnet",
    instruments: positions,
    routes: routes.set(venue, new StubRouteBuilder({
      venue,
      programId: new PublicKey(state.programs.router_stub),
      vaultAuthority: new PublicKey(state.vaultAuthority),
      vault: new PublicKey(state.vault),
      poolInput: new PublicKey(state.poolInput),
      poolOutput: new PublicKey(state.poolOutput),
      poolAuthority,
      usdcMint: new PublicKey(state.usdcMint),
      stockMint: new PublicKey(state.stockMint),
      stockAccount: new PublicKey(state.stockAccount),
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: TOKEN_2022_PROGRAM_ID,
    })),
  });

  // Every position under the token program its own instrument declares, so
  // reading balances costs one call per account and never a guess.
  const ledger = new SolanaChainLedger({
    connection,
    governorOwner: new PublicKey(state.owner),
    vault: new PublicKey(state.vault),
    positions: new Map([...positions].map(([mint, position]) => [mint, {
      stockAccount: position.stockAccount,
      tokenProgram: mint === state.stockMint ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    }])),
  });

  const operatorCustody: OperatorCustody = dynamic ? "dynamic-mpc" : "local-keypair";
  if (dynamic) {
    // Sign in now rather than on the first trade. A failure here is loud but
    // not fatal: each trade tries again, and one that cannot be signed is
    // reported as not submitted, with its reservation released.
    dynamic.warm().then(
      () => console.log("[stocks] operator signs through Dynamic (two-of-two MPC); no operator keypair is loaded in this process"),
      (error) => console.error(`[stocks] Dynamic sign-in failed at boot (${safeMessage(error, 200)}); trades will not execute until it succeeds`),
    );
  }

  console.log(
    `[stocks] devnet lane — ${instrument.symbol} (${state.stockMint.slice(0, 6)}…) through ${venue}, `
    + `governor ${state.governor.slice(0, 6)}…, operator ${state.operator.slice(0, 6)}…`,
  );
  if (curve) {
    console.log(`[stocks] devnet lane — ${curve.instrument.symbol} (${curve.instrument.mint.slice(0, 6)}…) through ${curve.venue}, a curve anchored to $${curve.anchoredToUsd.toFixed(2)}`);
  }
  return {
    instrument,
    venue,
    quotes,
    executor,
    owner: state.owner,
    operator: state.operator,
    operatorCustody,
    usdcMint: state.usdcMint,
    governor: state.governor,
    program: state.programs.quaestor_stocks,
    vault: state.vault,
    referenceMint: mainnetAapl?.mint,
    curve,
    ledger,
  };
}

/**
 * The launched curve as something the lane can trade, or nothing.
 *
 * Nothing unless the owner's part is on record: the venue and the mint allowed
 * on chain, and a position account opened. Listing the token before that would
 * offer quotes whose every trade the program refuses.
 */
function curveFrom(
  state: DevnetState,
  connection: Connection,
  positions: Map<string, SolanaInstrumentAccounts>,
  routes: Map<VenueId, SolanaRouteBuilder>,
): DevnetCurve | undefined {
  const dbc = state.dbc;
  if (!dbc?.governed?.position) return undefined;
  const pool = new MeteoraDbcPool(connection, { pool: dbc.pool, baseMint: dbc.baseMint, quoteMint: state.usdcMint });
  const stockAccount = new PublicKey(dbc.governed.position);
  positions.set(dbc.baseMint, { stockAccount });
  routes.set(DBC_VENUE, new DbcRouteBuilder({
    pool,
    vaultAuthority: new PublicKey(state.vaultAuthority),
    vault: new PublicKey(state.vault),
    stockAccount,
  }));
  const priceSource = new DbcPoolPriceSource(pool);
  const instrument: StockInstrument = Object.freeze({
    symbol: "qAAPLdemo",
    name: "AAPL bonding curve (devnet demo)",
    issuer: "Quaestor devnet fixture",
    mint: dbc.baseMint,
    usdcMint: state.usdcMint,
    decimals: 6,
    enabled: true,
    network: "solana-devnet",
    underlyingSymbol: "AAPL",
    executionStatus: "enabled",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    tradableVenues: Object.freeze([DBC_VENUE]),
    routabilityUnknownVenues: Object.freeze([]),
    rightsNotice:
      "A devnet demo token sold on a Meteora bonding curve anchored to AAPL's price. It carries no claim on anything and is not issued by or affiliated with Apple. The curve, the venue program and the transaction are real.",
    lifecycleNotice:
      `Sold on a curve that opens ${dbc.plan.band_bps} bps under the price it was anchored to and graduates ${dbc.plan.band_bps} bps over it, after ${Math.round(dbc.plan.graduation_usdc).toLocaleString("en-US")} USDC. A graduated curve stops filling, and this venue then answers "no route".`,
  });
  return {
    instrument,
    venue: DBC_VENUE,
    quotes: new DbcQuoteProvider({
      pool,
      slippageBps: Number(process.env.SOLANA_STOCK_SLIPPAGE_BPS ?? 50),
      quoteTtlSeconds: Number(process.env.SOLANA_STOCK_QUOTE_TTL_SECONDS ?? 90),
    }),
    priceSource,
    bandBps: dbc.plan.band_bps,
    anchoredToUsd: dbc.anchored_to.price_usd,
    monitor: (referenceUsd) => {
      const seen = priceSource.latest();
      const judged = assessCurve({
        openingPriceUsd: dbc.plan.opening_price_usd,
        graduationPriceUsd: dbc.plan.graduation_price_usd,
        anchoredToUsd: dbc.anchored_to.price_usd,
        graduated: seen?.graduated ?? false,
        poolPriceUsd: seen?.priceUsd,
        referenceUsd,
      });
      return {
        venue: DBC_VENUE,
        pool: dbc.pool,
        instrument_mint: dbc.baseMint,
        symbol: instrument.symbol,
        anchored_to_usd: dbc.anchored_to.price_usd,
        band_bps: dbc.plan.band_bps,
        opening_price_usd: dbc.plan.opening_price_usd,
        graduation_price_usd: dbc.plan.graduation_price_usd,
        graduation_usdc: dbc.plan.graduation_usdc,
        observed_at: seen ? new Date(seen.observedAt * 1000).toISOString() : undefined,
        graduated: seen?.graduated,
        pool_price_usd: seen?.priceUsd === undefined ? undefined : Number(seen.priceUsd.toFixed(6)),
        progress: seen?.progress === undefined ? undefined : Number(seen.progress.toFixed(6)),
        raised_usdc: seen?.progress === undefined ? undefined : Number((seen.progress * dbc.plan.graduation_usdc).toFixed(2)),
        reference_price_usd: referenceUsd,
        // No sighting yet is not "tracking": the pool has not been read, so nothing is claimed.
        health: seen ? judged.health : undefined,
        premium_bps: judged.premiumBps,
        reference_drift_bps: judged.referenceDriftBps,
        range_position: judged.rangePosition,
        summary: seen ? judged.summary : "The pool has not been read yet; the first price tick is still to come.",
      };
    },
  };
}
