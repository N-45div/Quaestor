/**
 * Quaestor Wallet: the wallet an agent's browser uses, on the agent's own computer.
 *
 * A browsing agent reads pages it cannot trust, and a page can ask a wallet for
 * anything. So this wallet's account is not the agent's key but the agent's
 * governor: a page sees the governor's dollars, and the only thing it can get
 * done is a governed buy. When a page sends a swap, the wallet does not sign
 * the page's calldata. It reads the intent from it (which stock, how much, the
 * floor), refuses anything that is not a buy of an approved stock with the
 * governor's own dollar through a venue the chain lists, and hands that intent
 * to the same code the agent command runs: the owner's caps, limit price and
 * Chainlink margin checked first, the chain's simulation, then executeTrade,
 * whose own measurements decide. A page's reason, when it gives one, is the
 * reason committed with the trade.
 *
 * Transfers, approvals, message signatures and chain switches are refused: this
 * wallet has no way to do them, because the key it holds can do nothing else.
 *
 * It listens on 127.0.0.1 only; the injected provider (inject.js) is its one client.
 *
 *   QUAESTOR_EVM_NETWORK=monad-testnet QUAESTOR_EVM_KEY_FILE=~/.quaestor/evm-operator.key \
 *   npx ts-node computer/wallet.ts           (QUAESTOR_WALLET_PORT, default 8547)
 */
import * as http from "node:http";
import { ethers } from "ethers";
import {
  CliError,
  buy,
  contextFor,
  fmt,
  governorFor,
  type Context,
} from "../cli/quaestor-evm";
import { KURU_ROUTER_ABI, budgetOf, instrumentOf, withBudget, type Network } from "../sdk/evm-stocks";

const UNISWAP = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const KURU = new ethers.Interface(KURU_ROUTER_ABI);
const GOVERNOR = new ethers.Interface(["function budgetToken() view returns (address)"]);

/** What a page asked for, read out of its swap: nothing of its route is kept. */
export interface Intent {
  venue: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
}

export class WalletError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

/** EIP-1193's codes: 4001 refused, 4100 not this account, 4200 not supported. */
const refuse = (message: string, data?: unknown) => new WalletError(4001, message, data);

/**
 * The buy a page's transaction asks for, or a refusal. Only a swap into a venue
 * the chain lists, from the governor's own dollar, delivered to the governor.
 */
export function intentOf(n: Network, governor: string, budgetToken: string, tx: { from?: string; to?: string; data?: string; value?: string }): Intent {
  if (tx.from && tx.from.toLowerCase() !== governor.toLowerCase()) throw new WalletError(4100, `this wallet sends only as its governor ${governor}`);
  if (tx.value && BigInt(tx.value) !== 0n) throw refuse("this wallet sends no native currency");
  const venue = n.venues.find((v) => v.router.toLowerCase() === (tx.to ?? "").toLowerCase());
  if (!venue) throw refuse(`${tx.to ?? "no address"} is not a venue on ${n.name}: this wallet only buys, through ${n.venues.map((v) => v.label).join(" or ")}`);
  let intent: Intent;
  try {
    if (venue.kind === "uniswap-v3") {
      const [p] = UNISWAP.decodeFunctionData("exactInputSingle", tx.data ?? "0x");
      if ((p.recipient as string).toLowerCase() !== governor.toLowerCase()) throw refuse("the swap pays someone other than the governor");
      intent = { venue: venue.router, tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn, minOut: p.amountOutMinimum };
    } else {
      const a = KURU.decodeFunctionData("anyToAnySwap", tx.data ?? "0x");
      if ((a._nativeSend as boolean[]).some(Boolean)) throw refuse("the swap asks to send native currency");
      intent = { venue: venue.router, tokenIn: a._debitToken, tokenOut: a._creditToken, amountIn: a._amount, minOut: a._minAmountOut };
    }
  } catch (e) {
    if (e instanceof WalletError) throw e;
    throw refuse(`this wallet only buys: the call to ${venue.label} is not a swap it knows`);
  }
  if (intent.tokenIn.toLowerCase() !== budgetToken.toLowerCase()) throw refuse("the swap spends something other than the governor's own dollar");
  if (!instrumentOf(n, intent.tokenOut)) throw refuse(`${intent.tokenOut} is not a stock on ${n.name}`);
  if (intent.minOut === 0n) throw refuse("the swap sets no floor");
  return intent;
}

export interface WalletState {
  ctx: Context;
  governor: string;
  budgetToken: string;
  /** Every request, what it asked for, and what came of it: the wallet's own record. */
  log: (entry: Record<string, unknown>) => void;
}

/** One JSON-RPC request from a page. Reads go to the chain; writes only ever become governed buys. */
export async function handle(state: WalletState, method: string, params: unknown[] = []): Promise<unknown> {
  const n = state.ctx.settings.network;
  switch (method) {
    case "eth_accounts":
    case "eth_requestAccounts":
      return [state.governor];
    case "eth_chainId":
      return ethers.toBeHex(n.chainId);
    case "net_version":
      return String(n.chainId);
    case "wallet_switchEthereumChain": {
      const want = (params[0] as { chainId?: string } | undefined)?.chainId;
      if (want && BigInt(want) === BigInt(n.chainId)) return null;
      throw new WalletError(4902, `this wallet is on ${n.name} only`);
    }
    case "quaestor_info":
      return { wallet: "Quaestor Wallet", network: n.key, chainId: n.chainId, governor: state.governor, operator: state.ctx.address, budgetToken: state.budgetToken };
    case "eth_sendTransaction": {
      const tx = (params[0] ?? {}) as { from?: string; to?: string; data?: string; value?: string; reason?: string };
      const intent = intentOf(n, state.governor, state.budgetToken, tx);
      const view = withBudget(n, state.budgetToken);
      const inst = instrumentOf(view, intent.tokenOut);
      if (!inst) throw refuse(`${intent.tokenOut} has no market against the governor's dollar`);
      const reason = (tx.reason ?? "").trim();
      if (!reason) throw refuse("the page gave no reason; a governed buy commits one");
      const ctx = { ...state.ctx, settings: { ...state.ctx.settings, network: view } };
      const flags = { governor: state.governor, "min-out": fmt(intent.minOut, inst.decimals) };
      const out = await buy(ctx, flags, inst, intent.amountIn, reason.slice(0, 500), 100, false);
      state.log({ method, stock: inst.symbol, amountIn: fmt(intent.amountIn, view.budget.decimals), minOut: flags["min-out"], reason, out });
      if (!out.ok) throw refuse(String(out.detail ?? out.message ?? out.refused ?? out.error ?? "refused"), out);
      const hash = String(out.tx ?? "").split("/tx/")[1];
      if (!hash) throw refuse("the buy settled but its hash was not returned", out);
      return hash;
    }
    case "personal_sign":
    case "eth_sign":
    case "eth_signTransaction":
    case "eth_signTypedData":
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4":
    case "wallet_addEthereumChain":
    case "wallet_watchAsset":
    case "wallet_sendCalls":
      state.log({ method, refused: true });
      throw new WalletError(4200, `${method} is not something this wallet does: its key can only ask the governor to buy`);
    default:
      if (method.startsWith("wallet_") || method.startsWith("eth_sign")) throw new WalletError(4200, `${method} is not supported`);
      // Anything else is a read, and goes to the chain as asked.
      return state.ctx.provider.send(method, params);
  }
}

export async function openWallet(env: NodeJS.ProcessEnv = process.env, log: WalletState["log"] = (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))): Promise<WalletState> {
  const flags: Record<string, string> = {};
  if (env.QUAESTOR_EVM_GOVERNOR) flags.governor = env.QUAESTOR_EVM_GOVERNOR;
  const ctx = await contextFor(flags, true, env);
  const governor = await governorFor(ctx, ctx.address!, flags.governor);
  const budgetToken: string = GOVERNOR.decodeFunctionResult("budgetToken", await ctx.provider.call({ to: governor, data: GOVERNOR.encodeFunctionData("budgetToken") }))[0];
  if (!budgetOf(ctx.settings.network, budgetToken)) throw new CliError("UnknownBudget", `governor ${governor} holds ${budgetToken}, which this wallet does not know`);
  return { ctx, governor, budgetToken, log };
}

export function serve(state: WalletState, port: number): http.Server {
  const server = http.createServer((req, res) => {
    // A page on any origin may ask; the answer is only ever a read or a governed buy.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 64_000) req.destroy(); });
    req.on("end", async () => {
      let id: unknown = null;
      try {
        const msg = JSON.parse(body) as { id?: unknown; method?: string; params?: unknown[] };
        id = msg.id ?? null;
        const result = await handle(state, String(msg.method), msg.params ?? []);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      } catch (e) {
        const err = e instanceof WalletError ? e : new WalletError(-32603, (e as Error).message?.slice(0, 300) ?? "failed");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: err.code, message: err.message, data: err.data } }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      }
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

if (/wallet\.(ts|js|mjs)$/.test(process.argv[1] ?? "")) {
  const port = Number(process.env.QUAESTOR_WALLET_PORT ?? 8547);
  openWallet()
    .then((state) => {
      serve(state, port);
      console.log(`Quaestor Wallet on 127.0.0.1:${port}: account ${state.governor} (governor), key ${state.ctx.address}, ${state.ctx.settings.network.name}`);
    })
    .catch((e) => {
      console.error(`Quaestor Wallet did not start: ${(e as Error).message}`);
      process.exitCode = 1;
    });
}
