import { explorerHref } from "../components/ExplorerShell";

/**
 * What runs where, end to end, from the deployment files in /deployments. The landing page's matrix and the
 * networks page both read this, so a chain is described once. Mainnet is labelled mainnet; everything else
 * is labelled with its testnet or devnet.
 */

export type Scene = "base" | "solana" | "monad" | "arc" | "mezo" | "robinhood";

export interface Contract { label: string; address: string; href: string }

export interface Chain {
  key: Scene;
  name: string;
  icon: string;
  status: string;          // "mainnet", "testnet", "devnet + mainnet"
  mainnet: boolean;
  product: "Governor" | "Operator" | "Governor + curve";
  summary: string;
  budget: { label: string; icons: string[] };
  venue: string;
  prices: string;
  signer: string;
  decides: string;
  app: string;
  contracts: Contract[];
  /** Where the Operator chain also runs a trading governor: how the trading page shows it. */
  trading?: Pick<Chain, "summary" | "budget" | "venue" | "prices" | "signer" | "decides" | "app" | "contracts">;
}

const basescan = (a: string) => `https://basescan.org/address/${a}`;
const monadscan = (a: string) => `https://testnet.monadscan.com/address/${a}`;
const arcscan = (a: string) => `https://explorer.testnet.arc.io/address/${a}`;
const mezoscan = (a: string) => `https://explorer.test.mezo.org/address/${a}`;
const rhTest = (a: string) => `https://explorer.testnet.chain.robinhood.com/address/${a}`;
const rhMain = (a: string) => `https://robinhoodchain.blockscout.com/address/${a}`;
const solscan = (a: string, cluster?: string) => `https://explorer.solana.com/address/${a}${cluster ? `?cluster=${cluster}` : ""}`;

export const brand = (name: string) => `/brand/${name}`;

export const CHAINS: Chain[] = [
  {
    key: "base", name: "Base", icon: brand("base.svg"), status: "mainnet", mainnet: true, product: "Governor",
    summary: "The spend governor on mainnet. Cato, the house agent, trades ETH for USDC on the real Uniswap v3, inside its caps.",
    budget: { label: "ETH → USDC", icons: [brand("ethereum.svg"), brand("usdc.svg")] },
    venue: "Uniswap v3", prices: "Limit price per trade", signer: "Agent key, buy-only", decides: "Cato",
    app: "/" + explorerHref("/", "base"),
    contracts: [
      { label: "Governor", address: "0x2e91d035D622d2ECa36B7836CBcf9651711B2D10", href: basescan("0x2e91d035D622d2ECa36B7836CBcf9651711B2D10") },
      { label: "Decision log", address: "0x1219c62A56771CdCE7bb1f6e6a5ac05701DDF961", href: basescan("0x1219c62A56771CdCE7bb1f6e6a5ac05701DDF961") },
    ],
  },
  {
    key: "mezo", name: "Mezo", icon: brand("mezo.svg"), status: "testnet", mainnet: false, product: "Operator",
    summary: "The Operator pays creators in MUSD, the stablecoin a holder borrows against their Bitcoin instead of selling it. A business opens a campaign in the chat without connecting a wallet and funds it by sending MUSD to its address; the agent's key is a Dynamic MPC wallet that can only pay creators. The house budget is MUSD borrowed against BTC.",
    budget: { label: "MUSD, borrowed against BTC", icons: [brand("musd.svg"), brand("btc.svg")] },
    venue: "Escrow per deal", prices: "Rate bands set by the owner", signer: "Dynamic MPC wallet, gas in BTC", decides: "Kimi",
    app: "/#/app/operator/p/quaestor-mezo",
    contracts: [
      { label: "Payouts factory", address: "0xC609f4c276DD36C96bCAf96a8E6e62914359a849", href: mezoscan("0xC609f4c276DD36C96bCAf96a8E6e62914359a849") },
      { label: "House budget", address: "0xBaEFcC4C57eeE6769fA37C3205b07ea2D1a22466", href: mezoscan("0xBaEFcC4C57eeE6769fA37C3205b07ea2D1a22466") },
      { label: "MUSD", address: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503", href: mezoscan("0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503") },
      { label: "Trading governor factory", address: "0x81f967771e0e2c7fcf712B904698B182E3e49284", href: mezoscan("0x81f967771e0e2c7fcf712B904698B182E3e49284") },
      { label: "House agent's governor", address: "0x6AfE12C70724cdFfbDCD87F96612157b83DBf5a3", href: mezoscan("0x6AfE12C70724cdFfbDCD87F96612157b83DBf5a3") },
    ],
    trading: {
      summary: "The house agent buys BTC with MUSD through Mezo's pools, and the governor checks every fill against Mezo's own oracle, read seconds before. Kimi decides; a Dynamic MPC wallet signs.",
      budget: { label: "MUSD → BTC", icons: [brand("musd.svg"), brand("btc.svg")] },
      venue: "Mezo's pools", prices: "Mezo's oracle", signer: "Dynamic MPC wallet", decides: "Kimi",
      app: "/#/app/evm/mezo-testnet",
      contracts: [
        { label: "Governor factory", address: "0x81f967771e0e2c7fcf712B904698B182E3e49284", href: mezoscan("0x81f967771e0e2c7fcf712B904698B182E3e49284") },
        { label: "House agent's governor", address: "0x6AfE12C70724cdFfbDCD87F96612157b83DBf5a3", href: mezoscan("0x6AfE12C70724cdFfbDCD87F96612157b83DBf5a3") },
      ],
    },
  },
  {
    key: "arc", name: "Arc", icon: brand("arc.svg"), status: "testnet", mainnet: false, product: "Operator",
    summary: "The Operator pays creators in USDC on proof of work. Its key is a Circle wallet, and a payee can be paid on their own chain over CCTP.",
    budget: { label: "USDC", icons: [brand("usdc.svg")] },
    venue: "Escrow per deal, CCTP out", prices: "Rate bands set by the owner", signer: "Circle developer-controlled wallet", decides: "Kimi",
    app: "/#/app/operator/p/quaestor",
    contracts: [
      { label: "Payouts factory", address: "0xA8371e91c0c434920AF06adcF03967679Dd971e1", href: arcscan("0xA8371e91c0c434920AF06adcF03967679Dd971e1") },
      { label: "House budget", address: "0xa5dF5F1edEfFeFb004DF35b6aB8aAB01aaA8369C", href: arcscan("0xa5dF5F1edEfFeFb004DF35b6aB8aAB01aaA8369C") },
      { label: "Trading governor factory", address: "0x41b49BFE3F4DD7FAC639F7fd6DDD8E19BBfe1e19", href: arcscan("0x41b49BFE3F4DD7FAC639F7fd6DDD8E19BBfe1e19") },
      { label: "House agent's governor", address: "0x628A55D12a386bB6577B4D83A83FAC29AcF5FA2A", href: arcscan("0x628A55D12a386bB6577B4D83A83FAC29AcF5FA2A") },
    ],
    trading: {
      summary: "The house agent buys EURC with USDC through Synthra, a Uniswap v3 fork. Arc testnet has no live price feed, so the owner's limit price is the check: the agent skipped cirBTC, quoted at $357k against a $120k limit.",
      budget: { label: "USDC → EURC, cirBTC", icons: [brand("usdc.svg")] },
      venue: "Synthra (Uniswap v3 fork)", prices: "The owner's limit price", signer: "Dynamic MPC wallet", decides: "Kimi",
      app: "/#/app/evm/arc-testnet",
      contracts: [
        { label: "Governor factory", address: "0x41b49BFE3F4DD7FAC639F7fd6DDD8E19BBfe1e19", href: arcscan("0x41b49BFE3F4DD7FAC639F7fd6DDD8E19BBfe1e19") },
        { label: "House agent's governor", address: "0x628A55D12a386bB6577B4D83A83FAC29AcF5FA2A", href: arcscan("0x628A55D12a386bB6577B4D83A83FAC29AcF5FA2A") },
      ],
    },
  },
  {
    key: "monad", name: "Monad", icon: brand("monad.svg"), status: "testnet", mainnet: false, product: "Governor",
    summary: "Tokenized stocks on Kuru's order books. The house agent is decided by Kimi and signed by a Dynamic MPC wallet, with prices from Chainlink through CRE.",
    budget: { label: "tUSDC → tTSLA, tNVDA, tSPY, tAAPL, tETH", icons: [brand("usdc.svg")] },
    venue: "Kuru order books", prices: "Chainlink, via CRE", signer: "Dynamic MPC wallet", decides: "Kimi",
    app: "/#/app/evm/monad-testnet",
    contracts: [
      { label: "Governor factory", address: "0x2e91d035D622d2ECa36B7836CBcf9651711B2D10", href: monadscan("0x2e91d035D622d2ECa36B7836CBcf9651711B2D10") },
      { label: "House agent's governor", address: "0xD64E22Ff0D0dc311d89Bcc5C5113F9e7f149157C", href: monadscan("0xD64E22Ff0D0dc311d89Bcc5C5113F9e7f149157C") },
      { label: "Kuru market, tETH", address: "0xf923eE198091D33630442a757060850363596773", href: monadscan("0xf923eE198091D33630442a757060850363596773") },
    ],
  },
  {
    key: "robinhood", name: "Robinhood Chain", icon: brand("robinhood.svg"), status: "testnet", mainnet: false, product: "Governor",
    summary: "Tokenized stocks on Uniswap, priced by Chainlink. The governor factory is also deployed on Robinhood Chain mainnet.",
    budget: { label: "tUSDG → TSLA, AMZN, PLTR, AMD", icons: [] },
    venue: "Uniswap v3", prices: "Chainlink", signer: "Agent key, buy-only", decides: "Your agent",
    app: "/#/app/evm/robinhood-testnet",
    contracts: [
      { label: "Governor factory", address: "0x2B295A9DeAf3f91bCE7223294883fD55016D8580", href: rhTest("0x2B295A9DeAf3f91bCE7223294883fD55016D8580") },
      { label: "House governor", address: "0xfBf777DC66A408526906955eBf62970d978fa841", href: rhTest("0xfBf777DC66A408526906955eBf62970d978fa841") },
      { label: "Factory on mainnet", address: "0x2e91d035D622d2ECa36B7836CBcf9651711B2D10", href: rhMain("0x2e91d035D622d2ECa36B7836CBcf9651711B2D10") },
    ],
  },
  {
    key: "solana", name: "Solana", icon: brand("solana.svg"), status: "devnet + mainnet", mainnet: true, product: "Governor + curve",
    summary: "A stock governor program on devnet, and on mainnet a Meteora launch curve anchored to a real share price.",
    budget: { label: "USDC", icons: [brand("usdc.svg")] },
    venue: "Test pool (devnet); Meteora DBC (mainnet)", prices: "Curve anchored to a real share price", signer: "Agent key, buy-only", decides: "Your agent",
    app: "/" + explorerHref("/stocks"),
    contracts: [
      { label: "Governor program (devnet)", address: "7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG", href: solscan("7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG", "devnet") },
      { label: "Anchored curve (mainnet)", address: "5cbDfFRGsAUUMGM5XJsKgkzZUJeLuD7H2QtkjkBXmz4N", href: solscan("5cbDfFRGsAUUMGM5XJsKgkzZUJeLuD7H2QtkjkBXmz4N") },
    ],
  },
];

/** Who Quaestor is built with, as marks with names (no endorsement implied). */
export const BUILT_WITH: { name: string; icon: string }[] = [
  { name: "Circle", icon: brand("circle.svg") },
  { name: "Chainlink", icon: brand("chainlink.svg") },
  { name: "Uniswap", icon: brand("uniswap.svg") },
  { name: "Kuru", icon: brand("kuru.png") },
  { name: "Meteora", icon: brand("meteora.svg") },
  { name: "Dynamic", icon: brand("dynamic.png") },
  { name: "MetaMask", icon: brand("metamask.svg") },
  { name: "Alchemy", icon: brand("alchemy.svg") },
  { name: "Envio", icon: brand("envio.png") },
  { name: "Kimi", icon: brand("kimi.png") },
  { name: "Aurora", icon: brand("aurora.svg") },
];

/** The governor's named refusals, as the contracts revert with them. */
export const REFUSALS = ["PerTradeCapExceeded", "EpochCapExceeded", "InstrumentNotAllowed", "VenueNotAllowed", "PriceAboveLimit", "FillAboveOracle", "OracleStale", "MinimumOutputNotMet", "RouteOverspent", "AllowanceLeftBehind", "IntentAlreadyExecuted", "NotOperator"];

export const GITHUB = "https://github.com/N-45div/Quaestor";
export const APP = "/explorer";
