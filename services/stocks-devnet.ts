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
  StockPlatformError,
  registerVenue,
  SolanaStockExecutor,
  StubRouteBuilder,
  VERIFIED_XSTOCKS,
  type JupiterQuoteFetcher,
  type PriceTape,
  type RefusalDemoResult,
  type RefusalKind,
  type SolanaInstrumentAccounts,
  type SolanaRouteBuilder,
  type StockChainExecutor,
  type StockCurveView,
  type StockInstrument,
  type StockTradeIntent,
  type TapeSource,
  type VenueId,
} from "../stocks";
import { ethers } from "ethers";
import { DBC_VENUE, DbcQuoteProvider, DbcRouteBuilder, MeteoraDbcPool } from "../stocks/dbc-venue";
import { DAMM_VENUE, DammQuoteProvider, DammRouteBuilder, MeteoraDammV2Pool, dammPoolFor } from "../stocks/damm-venue";
import { LifecyclePriceSource, LifecycleQuoteProvider } from "../stocks/curve-lifecycle";
import { SolanaChainLedger } from "../stocks/solana-ledger";
import { curveView } from "../stocks/dbc-watch";
import { decodePriceLimit, fetchGovernor, instrumentPda, type RemoteSigner } from "../solana/client";
import { dynamicOperatorFromEnv, type DynamicOperatorSigner } from "../solana/dynamic-signer";
import { safeMessage } from "../stocks/redact";

/** Where the operator's key is: whole in this process, or split with an MPC co-signer. */
export type OperatorCustody = "local-keypair" | "dynamic-mpc";

/**
 * A bonding curve the lane can buy from: a second instrument, on the curve while
 * it fills and on the DAMM v2 pool it graduates into after.
 */
export interface DevnetCurve {
  instrument: StockInstrument;
  venue: VenueId;
  /** Quotes from whichever of the two the token trades on now. */
  quotes: JupiterQuoteFetcher;
  /** Every venue this token can fill on over its life, for the owner's allowlist. */
  venues: VenueId[];
  /** The graduated pool's own quotes, for a caller that names that venue. */
  poolQuotes: JupiterQuoteFetcher;
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
  /**
   * Sends a trade the program must refuse, for the public demonstration. Only
   * with a governed curve: its refusal is the one where the venue's own swap
   * succeeds and the governor still reverts.
   */
  refusals?: (kind: RefusalKind) => Promise<RefusalDemoResult>;
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
    /** Written when the curve graduates (solana/scripts/dbc-graduate.ts). Derived until then. */
    graduation?: { damm_pool?: string };
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
    refusals: curve ? refusalDemo({ executor, curve, quotes, connection, state }) : undefined,
  };
}

/**
 * Trades sent to be refused, one at a time. Each asks for a real quote and
 * then breaks one rule with it: demanding twice what the curve pays (while
 * telling the venue to accept anything), spending one USDC over the governor's
 * on-chain per-trade cap, or, as a hijacked agent would, setting the floor to
 * one base unit and routing a USDC through a pool that hands back one base
 * unit of the token. They go straight to the program, past every check this
 * hub makes, so what refuses them is the program. A refused transaction moves
 * nothing and writes no record; the vault and the position are read before and
 * after to show it.
 */
function refusalDemo(cfg: { executor: SolanaStockExecutor; curve: DevnetCurve; quotes: DevnetQuoteProvider; connection: Connection; state: DevnetState }) {
  const vault = new PublicKey(cfg.state.vault);
  const governorAddress = new PublicKey(cfg.state.governor);
  const balance = (account: PublicKey) => cfg.connection.getTokenAccountBalance(account, "confirmed").then((b) => BigInt(b.value.amount));
  const run = async (kind: RefusalKind): Promise<RefusalDemoResult> => {
    const governor = await fetchGovernor(cfg.connection, governorAddress);
    // The hijacked agent's trade goes through the test venue, which pays what
    // it is told to: here, one base unit of dAAPLx for a whole USDC.
    const overpay = kind === "overpay";
    const mint = overpay ? cfg.state.stockMint : cfg.curve.instrument.mint;
    const position = new PublicKey(overpay ? cfg.state.stockAccount : cfg.state.dbc!.governed!.position);
    const amountIn = kind === "over-cap" ? governor.perTradeCap + 1_000_000n : 1_000_000n;
    let limit: bigint | undefined;
    if (overpay) {
      // Without a limit price this trade would settle, and the vault would pay
      // for it. It is only sent where the owner has set one.
      const approval = await cfg.connection.getAccountInfo(instrumentPda(governorAddress, new PublicKey(mint))[0], "confirmed");
      limit = approval ? decodePriceLimit(approval.data) : 0n;
      if (limit === 0n) throw new StockPlatformError("DEMO_UNAVAILABLE", "the house governor has no limit price on this token, so this trade would settle", 503);
    }
    const fair = overpay
      ? await cfg.quotes.quote(cfg.state.usdcMint, mint, amountIn)
      : await cfg.curve.quotes.quote(cfg.state.usdcMint, mint, amountIn);
    const quote = overpay ? { ...fair, outAmount: 1n, minimumOutput: 1n } : fair;
    const floor = kind === "short" ? quote.outAmount * 2n : (quote.minimumOutput ?? quote.outAmount);
    const intentId = `refusal-demo-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // A record like any other, so the trade is well formed; it names itself a demonstration.
    const recordHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ action: "refusal-demo", kind, intentId })));
    const intent: StockTradeIntent = {
      intentId,
      agentId: "refusal-demo",
      operator: cfg.state.operator,
      instrumentMint: mint,
      inputMint: cfg.state.usdcMint,
      amountInUsdc: amountIn,
      minOutput: floor,
      quoteId: quote.quoteId,
      quoteExpiresAt: quote.expiresAt,
      intentExpiresAt: Math.floor(Date.now() / 1000) + 60,
      decisionRecordHash: recordHash,
      decisionHash: ethers.keccak256(ethers.toUtf8Bytes(`${intentId}:${recordHash}`)),
    };
    const [vaultBefore, positionBefore] = await Promise.all([balance(vault), balance(position)]);
    const sent = await cfg.executor.sendRefusal(intent, quote, kind === "short" ? 0n : undefined);
    const [vaultAfter, positionAfter] = await Promise.all([balance(vault), balance(position)]);
    return {
      kind,
      signature: sent.signature,
      explorer: cfg.executor.explorer(sent.signature),
      code: sent.code,
      venue_succeeded: sent.venueSucceeded,
      amount_in_usdc: amountIn.toString(),
      floor: floor.toString(),
      curve_pays: quote.outAmount.toString(),
      per_trade_cap_usdc: governor.perTradeCap.toString(),
      ...(overpay ? { limit_price_usdc: limit!.toString(), fair_output: fair.outAmount.toString() } : {}),
      vault_before: vaultBefore.toString(),
      vault_after: vaultAfter.toString(),
      position_before: positionBefore.toString(),
      position_after: positionAfter.toString(),
    };
  };
  let queue: Promise<unknown> = Promise.resolve();
  return (kind: RefusalKind): Promise<RefusalDemoResult> => {
    const next = queue.then(() => run(kind));
    queue = next.catch(() => undefined);
    return next;
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
  // Where the curve graduates is known before it does: the DAMM v2 pool's
  // address follows from the curve's migration config and the two mints.
  const graduatedPool = new MeteoraDammV2Pool(connection, {
    pool: dbc.graduation?.damm_pool ?? dammPoolFor(dbc.baseMint, state.usdcMint),
    baseMint: dbc.baseMint,
    quoteMint: state.usdcMint,
  });
  // The same position account: graduation changes the venue, not the instrument.
  routes.set(DAMM_VENUE, new DammRouteBuilder({
    pool: graduatedPool,
    vaultAuthority: new PublicKey(state.vaultAuthority),
    vault: new PublicKey(state.vault),
    stockAccount,
  }));
  const priceSource = new LifecyclePriceSource(pool, graduatedPool);
  const slippageBps = Number(process.env.SOLANA_STOCK_SLIPPAGE_BPS ?? 50);
  const quoteTtlSeconds = Number(process.env.SOLANA_STOCK_QUOTE_TTL_SECONDS ?? 90);
  const poolQuotes = new DammQuoteProvider({ pool: graduatedPool, slippageBps, quoteTtlSeconds });
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
    tradableVenues: Object.freeze([DBC_VENUE, DAMM_VENUE]),
    routabilityUnknownVenues: Object.freeze([]),
    rightsNotice:
      "A devnet demo token sold on a Meteora bonding curve anchored to AAPL's price. It carries no claim on anything and is not issued by or affiliated with Apple. The curve, the venue program and the transaction are real.",
    lifecycleNotice:
      `Sold on a curve that opens ${dbc.plan.band_bps} bps under the price it was anchored to and graduates ${dbc.plan.band_bps} bps over it, after ${Math.round(dbc.plan.graduation_usdc).toLocaleString("en-US")} USDC. Once it graduates, its liquidity is a Meteora DAMM v2 pool and the token trades there, through the same governor.`,
  });
  return {
    instrument,
    venue: DBC_VENUE,
    venues: [DBC_VENUE, DAMM_VENUE],
    quotes: new LifecycleQuoteProvider({
      curve: pool,
      curveQuotes: new DbcQuoteProvider({ pool, slippageBps, quoteTtlSeconds }),
      poolQuotes,
    }),
    poolQuotes,
    priceSource,
    bandBps: dbc.plan.band_bps,
    anchoredToUsd: dbc.anchored_to.price_usd,
    monitor: (referenceUsd) => curveView({
      cluster: "devnet",
      pool: dbc.pool,
      baseMint: dbc.baseMint,
      symbol: instrument.symbol,
      anchoredToUsd: dbc.anchored_to.price_usd,
      bandBps: dbc.plan.band_bps,
      openingPriceUsd: dbc.plan.opening_price_usd,
      graduationPriceUsd: dbc.plan.graduation_price_usd,
      graduationUsdc: dbc.plan.graduation_usdc,
    }, priceSource.latest(), referenceUsd),
  };
}
