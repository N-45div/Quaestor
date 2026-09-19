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
 * The one thing a mainnet deployment must not copy is the venue. The stub fills
 * at the quoted price and needs its pool side signed by this process, because a
 * test fixture has no liquidity of its own. A real aggregator needs neither.
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
  type StockChainExecutor,
  type StockInstrument,
  type VenueId,
} from "../stocks";

export interface DevnetLane {
  instrument: StockInstrument;
  venue: VenueId;
  quotes: JupiterQuoteFetcher;
  executor: StockChainExecutor;
  /** The governor's owner and operator on chain; the intent must name this operator. */
  owner: string;
  operator: string;
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
  let operator: Keypair;
  let poolAuthority: Keypair;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as DevnetState;
    payer = loadKeypair("DEVNET_PAYER_SECRET", payerPath);
    operator = loadKeypair("DEVNET_OPERATOR_SECRET", `${keysDir}/operator.json`);
    poolAuthority = loadKeypair("DEVNET_POOL_AUTHORITY_SECRET", `${keysDir}/pool-authority.json`);
  } catch {
    // Deliberately not the error's own message: a malformed secret makes
    // JSON.parse quote a fragment of it, and a missing file names its path.
    console.error("[stocks] devnet lane not mounted — the state file or one of the three keypairs could not be read or parsed");
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
  const executor = new SolanaStockExecutor({
    connection,
    governorOwner: new PublicKey(state.owner),
    vault: new PublicKey(state.vault),
    operator,
    payer,
    cluster: "devnet",
    instruments: new Map([[state.stockMint, { stockAccount: new PublicKey(state.stockAccount) }]]),
    routes: new Map([[venue, new StubRouteBuilder({
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
    })]]),
  });

  console.log(
    `[stocks] devnet lane — ${instrument.symbol} (${state.stockMint.slice(0, 6)}…) through ${venue}, `
    + `governor ${state.governor.slice(0, 6)}…, operator ${state.operator.slice(0, 6)}…`,
  );
  return {
    instrument,
    venue,
    quotes,
    executor,
    owner: state.owner,
    operator: state.operator,
    usdcMint: state.usdcMint,
    governor: state.governor,
    program: state.programs.quaestor_stocks,
    vault: state.vault,
    referenceMint: mainnetAapl?.mint,
  };
}
