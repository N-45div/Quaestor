import { ethers } from "ethers";

/**
 * The Stock Token governor (contracts/QuaestorStocks.sol) on EVM chains:
 * where it is deployed, what it trades, and how to talk to it.
 *
 * One table per network. Everything the agent's command, the hub and the app
 * need to know about a chain lives here, so adding a chain is adding a row.
 * Every address was checked on its chain (eth_getCode, symbol(), decimals())
 * on the date beside it.
 */

export interface Instrument {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  /** A Chainlink AggregatorV3 proxy priced in USD, where the chain has one. */
  feed?: string;
  /** Uniswap v3 fee tiers with a pool against the budget token. */
  fees: number[];
}

export interface Venue {
  kind: "uniswap-v3" | "kuru";
  label: string;
  /** The address the governor approves and calls: SwapRouter02, or Kuru's Router. */
  router: string;
  /** Uniswap v3 only. */
  quoter?: string;
  factory?: string;
  /** Kuru only: the order book for each instrument, by the instrument's address. */
  markets?: Record<string, { address: string; pricePrecision: number }>;
}

export interface Network {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  /** The QuaestorStocks factory; empty until it is deployed there. */
  factory: string;
  /** The block the factory was deployed at, where log reads start. */
  factoryBlock: number;
  /** The most blocks one eth_getLogs may span on the public RPC, where it is small. */
  logRange?: number;
  /** `mintable`: a test token anyone may mint (tUSDG on a testnet), so the app offers some. */
  budget: { symbol: string; address: string; decimals: number; feed?: string; mintable?: boolean };
  venues: Venue[];
  instruments: Instrument[];
  gasSymbol: string;
  /** What one unit of an instrument is called on the page: a share of a stock, or a token. */
  assetNoun?: "share" | "token";
  /** Gas the owner sends the agent's key with the governor, in ether. */
  agentGas: string;
  /** Monad charges the gas limit, not the gas used, so the limit is kept tight there. */
  gasLimitIsCharged?: boolean;
  testnet: boolean;
}

/** Robinhood Chain mainnet (4663). Checked 28 Sep 2026. */
export const ROBINHOOD: Network = {
  key: "robinhood",
  name: "Robinhood Chain",
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  factory: "",
  factoryBlock: 0,
  budget: { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, feed: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2" },
  venues: [{
    kind: "uniswap-v3",
    label: "uniswap-v3",
    router: "0xcaf681a66d020601342297493863e78c959e5cb2",
    quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  }],
  instruments: [
    // Chainlink "Robinhood <TICKER> / USD" feeds, 8 decimals, 24/5 hours (feeds-robinhood-mainnet.json).
    { symbol: "AAPL", name: "Apple", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18, feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", fees: [500, 3000, 10000] },
    { symbol: "NVDA", name: "NVIDIA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", fees: [500, 3000] },
    { symbol: "TSLA", name: "Tesla", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, feed: "0x4A1166a659A55625345e9515b32adECea5547C38", fees: [500, 3000, 10000] },
    { symbol: "SPY", name: "SPDR S&P 500 ETF", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", fees: [500, 3000] },
  ],
  gasSymbol: "ETH",
  agentGas: "0.0003",
  testnet: false,
};

/**
 * Robinhood Chain testnet (46630), live since 28 Sep 2026 (deployments/stocks-robinhoodTestnet.json).
 * The Stock Tokens are Robinhood's own testnet tokens from its faucet. The testnet
 * has no USDG, Uniswap or Chainlink, so tUSDG is a test dollar anyone may mint,
 * Uniswap v3 is Uniswap's own bytecode deployed here, and each feed is a
 * MirrorFeed the hub keeps within ten minutes of Chainlink's mainnet feed.
 */
export const ROBINHOOD_TESTNET: Network = {
  key: "robinhood-testnet",
  name: "Robinhood Chain testnet",
  chainId: 46630,
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  factory: "0x2B295A9DeAf3f91bCE7223294883fD55016D8580",
  factoryBlock: 125629536,
  budget: { symbol: "tUSDG", address: "0xF2fa4cF4209C7FC4a42E309CE01a6716b6a51B64", decimals: 6, mintable: true },
  venues: [{
    kind: "uniswap-v3",
    label: "uniswap-v3",
    router: "0x7D428Ea2B371DFB7f97B6541F785c29bb0963A81",
    quoter: "0x7C8772fbdF1A1d9Ded219E51D3147d7C04475921",
    factory: "0x99D7fcf0153b1CB171F0de432D8aC159Abc63b24",
  }],
  instruments: [
    // Robinhood's testnet Stock Tokens; feeds are MirrorFeeds of Chainlink's mainnet Robinhood feeds.
    { symbol: "TSLA", name: "Tesla", address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", decimals: 18, feed: "0xA8371e91c0c434920AF06adcF03967679Dd971e1", fees: [3000] },
    { symbol: "AMZN", name: "Amazon", address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02", decimals: 18, feed: "0x9EeFFDE01e462c478530Eb363d8D5e08A80bb213", fees: [3000] },
    { symbol: "PLTR", name: "Palantir", address: "0x1fbe1a0e43594b3455993b5de5fd0a7a266298d0", decimals: 18, feed: "0x81f967771e0e2c7fcf712B904698B182E3e49284", fees: [3000] },
    { symbol: "AMD", name: "AMD", address: "0x71178BAc73cBeb415514eB542a8995b82669778d", decimals: 18, feed: "0x0566d5D04ACBC30F2453c8f1dEE7A510a6D87544", fees: [3000] },
  ],
  gasSymbol: "ETH",
  agentGas: "0.0005",
  testnet: true,
};

/**
 * Monad testnet (10143), live since 28 Sep 2026 (deployments/stocks-monadTestnet*.json).
 * Kuru's only testnet market delivers native MON in lots of 200, so the governor
 * trades a tETH/tUSDC Kuru market of its own, priced off Chainlink's real ETH/USD
 * feed on Monad testnet; the same feed is each governor's price guard.
 */
export const MONAD_TESTNET: Network = {
  key: "monad-testnet",
  name: "Monad testnet",
  chainId: 10143,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorer: "https://testnet.monadscan.com",
  factory: "0x2e91d035D622d2ECa36B7836CBcf9651711B2D10",
  factoryBlock: 66361992,
  logRange: 100,
  assetNoun: "token",
  budget: { symbol: "tUSDC", address: "0x7cf23d5D7A49ca4113ed4b72e465b227E7978c12", decimals: 6, mintable: true },
  venues: [{
    kind: "kuru",
    label: "kuru",
    router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630",
    markets: { "0xf2fa4cf4209c7fc4a42e309ce01a6716b6a51b64": { address: "0xf923eE198091D33630442a757060850363596773", pricePrecision: 10000 } },
  }],
  instruments: [
    // Chainlink ETH/USD on Monad testnet, 8 decimals, 24h heartbeat.
    { symbol: "tETH", name: "Test ETH", address: "0xF2fa4cF4209C7FC4a42E309CE01a6716b6a51B64", decimals: 18, feed: "0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31", fees: [] },
  ],
  gasSymbol: "MON",
  // A trade is about 0.03 MON at testnet's 102 gwei, charged on its limit.
  agentGas: "0.3",
  gasLimitIsCharged: true,
  testnet: true,
};

export const NETWORKS: Record<string, Network> = {
  [ROBINHOOD.key]: ROBINHOOD,
  [ROBINHOOD_TESTNET.key]: ROBINHOOD_TESTNET,
  [MONAD_TESTNET.key]: MONAD_TESTNET,
};

export const explorerTx = (n: Network, hash: string) => `${n.explorer}/tx/${hash}`;
export const explorerAddress = (n: Network, address: string) => `${n.explorer}/address/${address}`;

export function instrumentOf(n: Network, symbolOrAddress: string): Instrument | undefined {
  const s = symbolOrAddress.toLowerCase();
  return n.instruments.find((i) => i.symbol.toLowerCase() === s || i.address.toLowerCase() === s);
}

// ------------------------------------------------------------------ the contracts

export const GOVERNOR_ABI = [
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function guardian() view returns (address)",
  "function budgetToken() view returns (address)",
  "function budgetDecimals() view returns (uint8)",
  "function suspended() view returns (bool)",
  "function epochLength() view returns (uint64)",
  "function perTradeCap() view returns (uint128)",
  "function epochCap() view returns (uint128)",
  "function currentEpoch() view returns (uint64)",
  "function spentInEpoch() view returns (uint128)",
  "function remainingBudget() view returns (uint256)",
  "function venueAllowed(address) view returns (bool)",
  "function venueLabel(address) view returns (bytes16)",
  "function instruments(address) view returns (bool allowed, uint8 decimals, uint128 maxPrice)",
  "function priceGuards(address) view returns (address feed, uint8 feedDecimals, uint16 maxDeviationBps, uint32 maxStaleness)",
  "function intentExecuted(bytes32) view returns (bool)",
  "function executeTrade((bytes32 intentId,address venue,address tokenOut,uint256 amountIn,uint256 minOut,bytes32 decisionHash,bytes swapData) t) returns (uint256 spent, uint256 received)",
  "function setPolicy(uint128 perTradeCap, uint128 epochCap, uint64 epochLength)",
  "function setOperator(address operator)",
  "function setGuardian(address guardian)",
  "function setSuspended(bool suspended)",
  "function setVenue(address venue, bool allowed, bytes16 label)",
  "function setInstrument(address token, bool allowed, uint128 maxPrice)",
  "function setPriceLimit(address token, uint128 maxPrice)",
  "function setPriceGuard(address token, address feed, uint16 maxDeviationBps, uint32 maxStaleness)",
  "function withdraw(address token, uint256 amount, address to)",
  "event TradeExecuted(bytes32 indexed intentId, address indexed venue, address indexed tokenOut, uint256 spent, uint256 received, bytes32 decisionHash, uint64 epoch, uint128 spentInEpoch)",
  "event PolicySet(uint128 perTradeCap, uint128 epochCap, uint64 epochLength)",
  "event SuspendedSet(bool suspended, address indexed by)",
  "event VenueSet(address indexed venue, bool allowed, bytes16 label)",
  "event InstrumentSet(address indexed token, bool allowed, uint8 decimals)",
  "event PriceLimitSet(address indexed token, uint128 maxPrice)",
  "event PriceGuardSet(address indexed token, address indexed feed, uint16 maxDeviationBps, uint32 maxStaleness)",
  "event Withdrawn(address indexed token, address indexed to, uint256 amount)",
  "error AlreadyInitialized()",
  "error NotOwner()",
  "error NotOperator()",
  "error NotGuardianOrOwner()",
  "error Suspended()",
  "error InvalidPolicy()",
  "error InvalidAmount()",
  "error InvalidMinimumOutput()",
  "error PerTradeCapExceeded(uint256 amount, uint256 cap)",
  "error EpochCapExceeded(uint256 spent, uint256 cap)",
  "error InsufficientBudget(uint256 amount, uint256 balance)",
  "error IntentAlreadyExecuted(bytes32 intentId)",
  "error VenueNotAllowed(address venue)",
  "error InvalidVenue(address venue)",
  "error InstrumentNotAllowed(address token)",
  "error InvalidInstrument(address token)",
  "error InvalidRecipient()",
  "error VenueCallFailed(bytes reason)",
  "error VaultBalanceIncreased(uint256 before, uint256 afterCall)",
  "error RouteOverspent(uint256 spent, uint256 authorized)",
  "error StockBalanceDecreased(uint256 before, uint256 afterCall)",
  "error MinimumOutputNotMet(uint256 received, uint256 minimum)",
  "error PriceAboveLimit(uint256 spent, uint256 received, uint256 maxPrice)",
  "error AllowanceLeftBehind(uint256 allowance)",
  "error Reentrancy()",
  "error InvalidPriceGuard()",
  "error OracleStale(uint256 updatedAt, uint256 maxStaleness)",
  "error OracleInvalid(int256 answer)",
  "error FillAboveOracle(uint256 fillPrice, uint256 oraclePrice, uint16 maxDeviationBps)",
];

export const FACTORY_ABI = [
  "function implementation() view returns (address)",
  "function governorsOf(address owner) view returns (address[])",
  "function governorsForOperator(address operator) view returns (address[])",
  "function governorCount() view returns (uint256)",
  "function allGovernors(uint256) view returns (address)",
  "function createGovernor((address operator,address budgetToken,uint64 epochLength,uint128 perTradeCap,uint128 epochCap,address[] venues,bytes16[] labels,address[] tokens,uint128[] maxPrices,(address token,address feed,uint16 maxDeviationBps,uint32 maxStaleness)[] guards,uint256 deposit) s) payable returns (address governor)",
  "event GovernorCreated(address indexed governor, address indexed owner, address indexed operator, address budgetToken, uint256 deposit)",
  "event OperatorFunded(address indexed governor, address indexed operator, uint256 amount)",
  "error GasTransferFailed()",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

/** What each refusal means. Facts only; what to do next is the skill's to say. */
export const EVM_REFUSALS: Record<string, string> = {
  PerTradeCapExceeded: "Larger than the owner's per-trade cap. Only the owner can raise it.",
  EpochCapExceeded: "This epoch's budget is used up. It resets when the epoch ends; only the owner can raise it.",
  InsufficientBudget: "The governor holds less than this. Only the owner can deposit.",
  Suspended: "The owner has suspended this governor.",
  NotOperator: "This key is not the governor's operator.",
  InstrumentNotAllowed: "The owner has not approved this Stock Token.",
  VenueNotAllowed: "The owner has not approved this venue.",
  IntentAlreadyExecuted: "This intent id already traded; a retry never trades twice.",
  InvalidMinimumOutput: "The floor came out as zero; the amount is too small.",
  MinimumOutputNotMet: "Less than the floor reached the governor; the whole trade was undone.",
  RouteOverspent: "The venue took more than the amount authorised; the whole trade was undone.",
  StockBalanceDecreased: "The route took shares out of the governor; the whole trade was undone.",
  VaultBalanceIncreased: "The governor gained budget during the swap; the whole trade was undone.",
  AllowanceLeftBehind: "The budget token kept the venue's approval; the whole trade was undone.",
  VenueCallFailed: "The venue itself failed; nothing was bought.",
  PriceAboveLimit: "The fill cost more per share than the owner's limit price; the whole trade was undone. Only the owner can change the limit.",
  FillAboveOracle: "The fill cost too much more than Chainlink's price for the share; the whole trade was undone.",
  OracleStale: "Chainlink's price for the share is older than the owner allows. No fresh price, no trade.",
  OracleInvalid: "Chainlink reported no usable price for the share.",
  PriceGate: "The quote is too far over Chainlink's price or over the owner's limit. Nothing was sent.",
  NoGas: "This key pays its own gas and holds too little. The owner can send it some; that gas is outside the governor.",
};

export const label16 = (s: string) => ethers.zeroPadBytes(ethers.toUtf8Bytes(s.slice(0, 16)), 16);
export const unlabel16 = (b: string) => ethers.toUtf8String(b).replace(/\0+$/, "");

/** Amounts in the units they are in: budget errors in the stablecoin, output in the share. */
const BUDGET_AMOUNTS = new Set(["PerTradeCapExceeded", "EpochCapExceeded", "InsufficientBudget", "RouteOverspent", "VaultBalanceIncreased", "AllowanceLeftBehind"]);
const PRICE_ERRORS = new Set(["PriceAboveLimit", "FillAboveOracle"]);
const GOVERNOR_ERRORS = new ethers.Interface(GOVERNOR_ABI.filter((l) => l.startsWith("error ")));

export function venueReason(bytes: string): string {
  if (!bytes || bytes === "0x") return "no reason given";
  try {
    if (bytes.startsWith("0x08c379a0")) return String(ethers.AbiCoder.defaultAbiCoder().decode(["string"], ethers.dataSlice(bytes, 4))[0]);
    if (bytes.startsWith("0x4e487b71")) return `panic ${BigInt(ethers.dataSlice(bytes, 4, 36))}`;
    const inner = GOVERNOR_ERRORS.parseError(bytes);
    if (inner) return inner.name;
  } catch {
    // shown raw below
  }
  return `raw ${bytes.slice(0, 74)}`;
}

/** A governor refusal from revert data, with amounts in their own units. */
export function refusalOfData(data: string, budgetDecimals = 6, shareDecimals = 18): { code: string; detail: string } | null {
  let parsed: ethers.ErrorDescription | null = null;
  try {
    parsed = GOVERNOR_ERRORS.parseError(data);
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (parsed.name === "VenueCallFailed") return { code: parsed.name, detail: `VenueCallFailed: ${venueReason(String(parsed.args[0]))}` };
  const fields = parsed.fragment.inputs.map((input, i) => {
    const v = parsed!.args[i];
    if (typeof v !== "bigint") return `${input.name}=${String(v)}`;
    if (BUDGET_AMOUNTS.has(parsed!.name)) return `${input.name}=${ethers.formatUnits(v, budgetDecimals)}`;
    if (parsed!.name === "MinimumOutputNotMet" || parsed!.name === "StockBalanceDecreased") return `${input.name}=${ethers.formatUnits(v, shareDecimals)}`;
    if (PRICE_ERRORS.has(parsed!.name)) {
      if (input.name === "received") return `${input.name}=${ethers.formatUnits(v, shareDecimals)}`;
      if (input.name === "maxDeviationBps") return `${input.name}=${v}`;
      return `${input.name}=${ethers.formatUnits(v, budgetDecimals)}`;
    }
    return `${input.name}=${v}`;
  });
  return { code: parsed.name, detail: fields.length ? `${parsed.name}: ${fields.join(", ")}` : parsed.name };
}

export function refusalOf(err: unknown, budgetDecimals = 6, shareDecimals = 18): { code: string; detail: string } | null {
  const e = err as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  return typeof data === "string" ? refusalOfData(data, budgetDecimals, shareDecimals) : null;
}

// ------------------------------------------------------------------ reading a governor

export interface GovernorStatus {
  address: string;
  owner: string;
  operator: string;
  guardian: string;
  suspended: boolean;
  budgetToken: string;
  budget: bigint;
  perTradeCap: bigint;
  epochCap: bigint;
  epochLength: number;
  spentThisEpoch: bigint;
  remaining: bigint;
  epochEndsAt: number;
  venues: { address: string; label: string; allowed: boolean }[];
  instruments: { symbol: string; address: string; allowed: boolean; held: bigint; limitPrice: bigint; guard: { feed: string; maxDeviationBps: number; maxStaleness: number } | null }[];
}

export async function readGovernor(provider: ethers.Provider, n: Network, address: string, nowSec = Math.floor(Date.now() / 1000)): Promise<GovernorStatus> {
  const g = new ethers.Contract(address, GOVERNOR_ABI, provider);
  const [owner, operator, guardian, suspended, budgetToken, perTradeCap, epochCap, epochLength, currentEpoch, spentInEpoch, remaining] = await Promise.all([
    g.owner(), g.operator(), g.guardian(), g.suspended(), g.budgetToken(), g.perTradeCap(), g.epochCap(), g.epochLength(), g.currentEpoch(), g.spentInEpoch(), g.remainingBudget(),
  ]);
  const budget = await new ethers.Contract(budgetToken, ERC20_ABI, provider).balanceOf(address);
  const len = Number(epochLength);
  const epochNow = Math.floor(nowSec / len);
  const venues = await Promise.all(n.venues.map(async (v) => ({ address: v.router, label: v.label, allowed: Boolean(await g.venueAllowed(v.router)) })));
  const instruments = await Promise.all(n.instruments.map(async (i) => {
    const [inst, guard, held] = await Promise.all([g.instruments(i.address), g.priceGuards(i.address), new ethers.Contract(i.address, ERC20_ABI, provider).balanceOf(address)]);
    return {
      symbol: i.symbol,
      address: i.address,
      allowed: Boolean(inst.allowed),
      held: held as bigint,
      limitPrice: inst.maxPrice as bigint,
      guard: guard.feed === ethers.ZeroAddress ? null : { feed: guard.feed as string, maxDeviationBps: Number(guard.maxDeviationBps), maxStaleness: Number(guard.maxStaleness) },
    };
  }));
  return {
    address,
    owner,
    operator,
    guardian,
    suspended,
    budgetToken,
    budget,
    perTradeCap,
    epochCap,
    epochLength: len,
    spentThisEpoch: BigInt(currentEpoch) === BigInt(epochNow) ? spentInEpoch : 0n,
    remaining,
    epochEndsAt: (epochNow + 1) * len,
    venues,
    instruments,
  };
}

// ------------------------------------------------------------------ Uniswap v3

const ROUTER = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)",
];

/** SwapRouter02 calldata: budget token in, the share out, delivered to the governor. */
export function exactInputSingle(venue: Venue, tokenIn: string, tokenOut: string, fee: number, recipient: string, amountIn: bigint, minOut: bigint): string {
  return ROUTER.encodeFunctionData("exactInputSingle", [{ tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 }]);
}

/**
 * What a venue says `amountIn` buys, and everything the governor needs to try
 * it: the address it approves and calls (`target`), and the calldata for a
 * given recipient and floor. The governor never reads that calldata; it only
 * measures what it did.
 */
export interface Quote {
  venue: Venue;
  target: string;
  label: string;
  amountOut: bigint;
  swapData: (recipient: string, minOut: bigint) => string;
  /** Uniswap v3 only: the fee tier chosen, and what each tier answered. */
  fee?: number;
  tiers?: { fee: number; amountOut: bigint | null }[];
}

async function uniswapQuote(provider: ethers.Provider, n: Network, venue: Venue, instrument: Instrument, amountIn: bigint): Promise<Quote | null> {
  if (!venue.quoter) return null;
  const quoter = new ethers.Contract(venue.quoter, QUOTER_ABI, provider);
  const tiers = await Promise.all(instrument.fees.map(async (fee) => {
    try {
      const [amountOut] = await quoter.quoteExactInputSingle.staticCall({ tokenIn: n.budget.address, tokenOut: instrument.address, amountIn, fee, sqrtPriceLimitX96: 0 });
      return { fee, amountOut: amountOut as bigint };
    } catch {
      return { fee, amountOut: null };
    }
  }));
  const best = tiers.filter((t) => t.amountOut !== null).sort((a, b) => (b.amountOut! > a.amountOut! ? 1 : -1))[0];
  if (!best) return null;
  return {
    venue,
    target: venue.router,
    label: `${venue.label} ${best.fee / 10_000}% pool`,
    amountOut: best.amountOut!,
    fee: best.fee,
    tiers,
    swapData: (recipient, minOut) => exactInputSingle(venue, n.budget.address, instrument.address, best.fee, recipient, amountIn, minOut),
  };
}

// ------------------------------------------------------------------ Kuru (Monad)

export const KURU_ROUTER_ABI = [
  "function anyToAnySwap(address[] _marketAddresses, bool[] _isBuy, bool[] _nativeSend, address _debitToken, address _creditToken, uint256 _amount, uint256 _minAmountOut) payable returns (uint256)",
  "function deployProxy(uint8 _type, address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread) returns (address)",
  "event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)",
];
export const KURU_ORDERBOOK_ABI = [
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function addSellOrder(uint32 _price, uint96 size, bool _postOnly)",
  "function bestBidAsk() view returns (uint256, uint256)",
  "function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)",
];

/**
 * A Kuru order book's fill for `amountIn` of the budget token, the way Kuru's
 * own SDK estimates it: the market buy simulated from the zero address. The
 * quote size is in the book's price precision, not the token's decimals; the
 * trade itself goes through Kuru's Router, which takes token decimals.
 */
async function kuruQuote(provider: ethers.Provider, n: Network, venue: Venue, instrument: Instrument, amountIn: bigint): Promise<Quote | null> {
  const market = venue.markets?.[instrument.address.toLowerCase()] ?? venue.markets?.[instrument.address];
  if (!market) return null;
  const book = new ethers.Contract(market.address, KURU_ORDERBOOK_ABI, provider);
  const quoteSize = (amountIn * BigInt(market.pricePrecision)) / 10n ** BigInt(n.budget.decimals);
  let amountOut: bigint;
  try {
    amountOut = await book.placeAndExecuteMarketBuy.staticCall(quoteSize, 0, false, false, { from: ethers.ZeroAddress });
  } catch {
    return null;
  }
  if (amountOut === 0n) return null;
  const router = new ethers.Interface(KURU_ROUTER_ABI);
  return {
    venue,
    target: venue.router,
    label: `${venue.label} order book`,
    amountOut,
    swapData: (_recipient, minOut) =>
      router.encodeFunctionData("anyToAnySwap", [[market.address], [true], [false], n.budget.address, instrument.address, amountIn, minOut]),
  };
}

/** The best fill for `amountIn` of the budget token across every venue the chain's row lists. */
export async function bestQuote(provider: ethers.Provider, n: Network, instrument: Instrument, amountIn: bigint): Promise<Quote> {
  const quotes = await Promise.all(n.venues.map((v) =>
    v.kind === "uniswap-v3" ? uniswapQuote(provider, n, v, instrument, amountIn)
    : v.kind === "kuru" ? kuruQuote(provider, n, v, instrument, amountIn)
    : Promise.resolve(null)));
  const best = quotes.filter((q): q is Quote => q !== null).sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];
  if (!best) throw new Error(`no venue quotes ${instrument.symbol} for ${n.budget.symbol} on ${n.name}`);
  return best;
}

// ------------------------------------------------------------------ prices

/** Budget units per whole share. */
export const fillPrice = (spent: bigint, received: bigint, shareDecimals: number) => (received === 0n ? 0n : (spent * 10n ** BigInt(shareDecimals)) / received);

export interface OraclePrice {
  price: bigint; // in budget units per whole share
  updatedAt: number;
  answer: bigint;
  feedDecimals: number;
}

export async function oraclePrice(provider: ethers.Provider, feed: string, budgetDecimals: number): Promise<OraclePrice> {
  const f = new ethers.Contract(feed, FEED_ABI, provider);
  const [dec, round] = await Promise.all([f.decimals(), f.latestRoundData()]);
  const answer = round.answer as bigint;
  const feedDecimals = Number(dec);
  return { answer, feedDecimals, updatedAt: Number(round.updatedAt), price: (answer * 10n ** BigInt(budgetDecimals)) / 10n ** BigInt(feedDecimals) };
}

/** The decision a trade commits to: the same scheme on every chain. */
export function commitDecision(record: Record<string, unknown>): { text: string; decisionHash: string } {
  const text = JSON.stringify(record);
  return { text, decisionHash: ethers.keccak256(ethers.toUtf8Bytes(text)) };
}
