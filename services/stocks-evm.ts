/**
 * The Stock Token governor's EVM lane on the hub: what the app reads, and the
 * three trades anyone can send to see the governor refuse them.
 *
 *   GET  /v1/evm                                  the chains, their factory, budget, stocks, venues
 *   GET  /v1/evm/:network/governors               every governor the factory made
 *   GET  /v1/evm/:network/governors/:address      one governor: caps, spend, holdings, prices
 *   GET  /v1/evm/:network/trades?governor=0x…     trades the governors settled, newest first
 *   GET  /v1/evm/:network/trades/:tx              one trade, decoded from its receipt
 *   POST /v1/evm/:network/demo/refusal {kind}     short | over-cap | overpay, sent for real
 *
 * Reads go to the chain on each request, with a short cache; trades come from
 * the governors' own TradeExecuted logs. Nothing here holds an owner's key.
 * The demonstration uses a house governor whose operator key the hub holds,
 * whose caps are a few dollars, and every trade it sends is one the governor
 * must refuse: it is sent with a fixed gas limit, so it lands on chain as a
 * failed transaction anyone can open, and the budget it leaves untouched is
 * read back before and after.
 *
 *   EVM_STOCKS_NETWORKS=robinhood                  which rows of sdk/evm-stocks.ts to serve
 *   EVM_RPC_ROBINHOOD=https://…                    optional RPC override per network
 *   EVM_NETWORK_FILE_ROBINHOOD=path.json           optional: the whole row from a file
 *   EVM_DEMO_ROBINHOOD_GOVERNOR=0x…                the house governor
 *   EVM_DEMO_ROBINHOOD_OPERATOR_KEY=0x…            its operator key (never logged)
 *   EVM_DEMO_ROBINHOOD_ATTACKER_FEE=100            the fee tier of the attacker's own pool
 */
import express, { type Express, type Request, type Response } from "express";
import { ethers } from "ethers";
import * as fs from "node:fs";
import {
  ERC20_ABI,
  EVM_REFUSALS,
  FACTORY_ABI,
  GOVERNOR_ABI,
  NETWORKS,
  bestQuote,
  exactInputSingle,
  explorerTx,
  fillPrice,
  instrumentOf,
  oraclePrice,
  readGovernor,
  refusalOf,
  type Network,
} from "../sdk/evm-stocks";
import { safeMessage } from "../stocks/redact";

export const EVM_REFUSAL_KINDS = ["short", "over-cap", "overpay"] as const;
export type EvmRefusalKind = (typeof EVM_REFUSAL_KINDS)[number];

export interface EvmDemo {
  governor: string;
  operatorKey: string;
  attackerFee?: number;
  stock: string;
}

export interface EvmLane {
  network: Network;
  provider: ethers.JsonRpcProvider;
  demo?: EvmDemo;
}

export interface EvmStocksConfig {
  lanes: EvmLane[];
  /** Blocks per eth_getLogs call; public RPCs cap the range. */
  logChunk?: number;
}

const envKey = (key: string) => key.toUpperCase().replace(/-/g, "_");

export function evmStocksFromEnv(env: NodeJS.ProcessEnv = process.env): EvmStocksConfig | null {
  const keys = (env.EVM_STOCKS_NETWORKS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!keys.length) return null;
  const lanes: EvmLane[] = [];
  for (const key of keys) {
    const k = envKey(key);
    // A row can come from a file: a fresh deployment, or a local fork.
    const file = env[`EVM_NETWORK_FILE_${k}`];
    const network: Network | undefined = file ? (JSON.parse(fs.readFileSync(file, "utf8")) as Network) : NETWORKS[key];
    if (!network) {
      console.error(`[evm-stocks] unknown network "${key}"; known: ${Object.keys(NETWORKS).join(", ")}`);
      continue;
    }
    if (!network.factory) {
      console.error(`[evm-stocks] ${network.name} has no factory address yet; not served`);
      continue;
    }
    const provider = new ethers.JsonRpcProvider(env[`EVM_RPC_${k}`] ?? network.rpcUrl, network.chainId, { staticNetwork: true, batchMaxCount: 1 });
    const governor = env[`EVM_DEMO_${k}_GOVERNOR`];
    const operatorKey = env[`EVM_DEMO_${k}_OPERATOR_KEY`];
    const demo = governor && operatorKey && ethers.isAddress(governor) && /^0x[0-9a-fA-F]{64}$/.test(operatorKey)
      ? { governor: ethers.getAddress(governor), operatorKey, attackerFee: env[`EVM_DEMO_${k}_ATTACKER_FEE`] ? Number(env[`EVM_DEMO_${k}_ATTACKER_FEE`]) : undefined, stock: env[`EVM_DEMO_${k}_STOCK`] ?? "AAPL" }
      : undefined;
    lanes.push({ network, provider, demo });
  }
  return lanes.length ? { lanes } : null;
}

// ------------------------------------------------------------------ reads, cached

class TtlCache {
  private entries = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(private readonly ttlMs: number) {}
  get<T>(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = make();
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => this.entries.delete(key));
    return value;
  }
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

export interface TradeRow {
  tx: string;
  block: number;
  at?: number;
  governor: string;
  intentId: string;
  venue: string;
  stock: string;
  token: string;
  spent: string;
  received: string;
  pricePerShare: string;
  decisionHash: string;
  epochSpent: string;
}

/**
 * Every governor's TradeExecuted logs, read forward from the factory's block in
 * chunks and kept, so a request after the first reads only new blocks.
 */
class TradeIndex {
  private rows: TradeRow[] = [];
  private nextBlock: number;
  private running: Promise<void> | null = null;
  private readonly topic = new ethers.Interface(GOVERNOR_ABI).getEvent("TradeExecuted")!.topicHash;

  constructor(private readonly lane: EvmLane, private readonly chunk: number) {
    this.nextBlock = lane.network.factoryBlock;
  }

  async all(): Promise<TradeRow[]> {
    if (!this.running) this.running = this.catchUp().finally(() => { this.running = null; });
    await this.running;
    return this.rows;
  }

  private async catchUp(): Promise<void> {
    const { network, provider } = this.lane;
    const factory = new ethers.Contract(network.factory, FACTORY_ABI, provider);
    const count = Number(await factory.governorCount());
    const governors = await Promise.all(Array.from({ length: count }, (_, i) => factory.allGovernors(i) as Promise<string>));
    if (!governors.length) return;
    const head = await provider.getBlockNumber();
    const iface = new ethers.Interface(GOVERNOR_ABI);
    for (let from = this.nextBlock; from <= head; from += this.chunk) {
      const to = Math.min(head, from + this.chunk - 1);
      const logs = await provider.getLogs({ address: governors, topics: [this.topic], fromBlock: from, toBlock: to });
      for (const log of logs) {
        const e = iface.parseLog(log)!;
        const inst = instrumentOf(network, e.args.tokenOut);
        const decimals = inst?.decimals ?? 18;
        this.rows.unshift({
          tx: log.transactionHash,
          block: log.blockNumber,
          governor: ethers.getAddress(log.address),
          intentId: e.args.intentId,
          venue: e.args.venue,
          stock: inst?.symbol ?? e.args.tokenOut,
          token: e.args.tokenOut,
          spent: ethers.formatUnits(e.args.spent, network.budget.decimals),
          received: ethers.formatUnits(e.args.received, decimals),
          pricePerShare: ethers.formatUnits(fillPrice(e.args.spent, e.args.received, decimals), network.budget.decimals),
          decisionHash: e.args.decisionHash,
          epochSpent: ethers.formatUnits(e.args.spentInEpoch, network.budget.decimals),
        });
      }
      this.nextBlock = to + 1;
    }
  }
}

// ------------------------------------------------------------------ the demonstration

export interface EvmRefusalResult {
  kind: EvmRefusalKind;
  network: string;
  governor: string;
  tx: string;
  explorer: string;
  refused: string;
  detail: string;
  meaning: string;
  budgetBefore: string;
  budgetAfter: string;
  sharesBefore: string;
  sharesAfter: string;
  what: string;
  /** For a hijacked agent's fill: the price per share it paid, in words. */
  plain?: string;
}

/** Sends one trade the house governor must refuse, and proves it refused and moved nothing. */
async function refuse(lane: EvmLane, kind: EvmRefusalKind): Promise<EvmRefusalResult> {
  const { network, provider, demo } = lane;
  if (!demo) throw Object.assign(new Error(`${network.name} has no demonstration governor`), { status: 503 });
  const inst = instrumentOf(network, demo.stock);
  if (!inst) throw Object.assign(new Error(`${demo.stock} is not a known Stock Token on ${network.name}`), { status: 503 });
  const wallet = new ethers.Wallet(demo.operatorKey, provider);
  const governor = new ethers.Contract(demo.governor, GOVERNOR_ABI, wallet);
  const budget = new ethers.Contract(network.budget.address, ERC20_ABI, provider);
  const shares = new ethers.Contract(inst.address, ERC20_ABI, provider);
  const perTradeCap: bigint = await governor.perTradeCap();
  const one = 10n ** BigInt(network.budget.decimals);
  const venue = network.venues[0];

  let trade: { amountIn: bigint; minOut: bigint; swapData: string };
  let what: string;
  if (kind === "over-cap") {
    const amountIn = perTradeCap + one;
    trade = { amountIn, minOut: 1n, swapData: exactInputSingle(venue, network.budget.address, inst.address, inst.fees[0], demo.governor, amountIn, 1n) };
    what = `Asked to spend ${ethers.formatUnits(amountIn, network.budget.decimals)} ${network.budget.symbol}, one more than the owner's per-trade cap.`;
  } else if (kind === "short") {
    const q = await bestQuote(provider, network, inst, one);
    // The router is told to accept anything; only the governor's own measurement holds the floor.
    trade = { amountIn: one, minOut: q.amountOut * 2n, swapData: exactInputSingle(venue, network.budget.address, inst.address, q.fee, demo.governor, one, 0n) };
    what = `Asked for twice what the pool gives for 1 ${network.budget.symbol}, and told Uniswap's router to accept anything: the governor measures what arrived.`;
  } else {
    if (!demo.attackerFee) throw Object.assign(new Error(`${network.name} has no attacker pool configured`), { status: 503 });
    trade = { amountIn: one, minOut: 1n, swapData: exactInputSingle(venue, network.budget.address, inst.address, demo.attackerFee, demo.governor, one, 1n) };
    what = `A hijacked agent: a floor of one wei, routed through the owner's approved Uniswap router into a pool its attacker opened at a price it chose.`;
  }

  const [budgetBefore, sharesBefore] = await Promise.all([budget.balanceOf(demo.governor), shares.balanceOf(demo.governor)]);
  const call = {
    intentId: ethers.hexlify(ethers.randomBytes(32)),
    venue: venue.router,
    tokenOut: inst.address,
    amountIn: trade.amountIn,
    minOut: trade.minOut,
    decisionHash: ethers.id(`refusal-demo:${kind}`),
    swapData: trade.swapData,
  };
  // A fixed limit skips estimation, which would stop a trade that reverts
  // before it is sent; this one is meant to reach the chain and fail there.
  // Signed here, so its hash is known whether or not the node's answer to the
  // broadcast says it reverted (a development node does; a real one does not).
  const data = governor.interface.encodeFunctionData("executeTrade", [call]);
  const populated = await wallet.populateTransaction({ to: demo.governor, data, gasLimit: 700_000n });
  const raw = await wallet.signTransaction(populated);
  const hash = ethers.keccak256(raw);
  try {
    await provider.broadcastTransaction(raw);
  } catch (err) {
    if (!(await provider.getTransaction(hash).catch(() => null))) throw err;
  }
  const receipt = await provider.waitForTransaction(hash, 1, 90_000);
  if (!receipt) throw new Error("the refusal was sent but not mined in time");
  if (receipt.status === 1) throw new Error(`the governor settled a trade it should have refused (${receipt.hash})`);

  let refusal = { code: "Reverted", detail: "the governor reverted the trade" };
  let plain: string | undefined;
  try {
    await provider.call({ to: demo.governor, from: wallet.address, data, blockTag: receipt.blockNumber - 1 });
  } catch (err) {
    refusal = refusalOf(err, network.budget.decimals, inst.decimals) ?? refusal;
    // The overpaying fill in words: what one share cost against what the owner allows.
    const raw = (err as { data?: string; info?: { error?: { data?: string } } }).data ?? (err as { info?: { error?: { data?: string } } }).info?.error?.data;
    const parsed = typeof raw === "string" ? (() => { try { return governor.interface.parseError(raw); } catch { return null; } })() : null;
    if (parsed?.name === "PriceAboveLimit") {
      const [spent, received, maxPrice] = parsed.args as unknown as [bigint, bigint, bigint];
      const perShare = fillPrice(spent, received, inst.decimals);
      const usd = (v: bigint) => Number(ethers.formatUnits(v, network.budget.decimals)).toLocaleString("en-US", { maximumFractionDigits: 0 });
      plain = `It paid ${ethers.formatUnits(spent, network.budget.decimals)} ${network.budget.symbol} for ${ethers.formatUnits(received, inst.decimals)} ${inst.symbol}: about $${usd(perShare)} a share, against the owner's limit of $${usd(maxPrice)}. Uniswap's swap itself succeeded; the governor measured the fill and reverted it.`;
    }
  }
  const [budgetAfter, sharesAfter] = await Promise.all([budget.balanceOf(demo.governor), shares.balanceOf(demo.governor)]);
  return {
    kind,
    network: network.key,
    governor: demo.governor,
    tx: receipt.hash,
    explorer: explorerTx(network, receipt.hash),
    refused: refusal.code,
    detail: refusal.detail,
    meaning: EVM_REFUSALS[refusal.code] ?? "The governor refused it.",
    budgetBefore: ethers.formatUnits(budgetBefore, network.budget.decimals),
    budgetAfter: ethers.formatUnits(budgetAfter, network.budget.decimals),
    sharesBefore: ethers.formatUnits(sharesBefore, inst.decimals),
    sharesAfter: ethers.formatUnits(sharesAfter, inst.decimals),
    what,
    plain,
  };
}

// ------------------------------------------------------------------ routes

export function mountEvmStocks(app: Express, cfg: EvmStocksConfig): void {
  const lanes = new Map(cfg.lanes.map((l) => [l.network.key, l]));
  const cache = new TtlCache(20_000);
  const indexes = new Map(cfg.lanes.map((l) => [l.network.key, new TradeIndex(l, cfg.logChunk ?? 50_000)]));
  // One refusal at a time per chain: they share a key, and so a nonce.
  const queues = new Map<string, Promise<unknown>>();

  const laneOf = (req: Request, res: Response): EvmLane | null => {
    const lane = lanes.get(String(req.params.network));
    if (!lane) res.status(404).json({ error: "UNKNOWN_NETWORK", networks: [...lanes.keys()] });
    return lane ?? null;
  };
  const fail = (res: Response, err: unknown) => {
    const status = (err as { status?: number }).status ?? 502;
    res.status(status).json({ error: status === 503 ? "UNAVAILABLE" : "CHAIN_FAILED", message: safeMessage(err, 200) });
  };

  app.get("/v1/evm", (_req, res) => {
    res.json({
      networks: cfg.lanes.map(({ network: n, demo }) => ({
        key: n.key, name: n.name, chainId: n.chainId, rpcUrl: n.rpcUrl, explorer: n.explorer, testnet: n.testnet,
        factory: n.factory, factoryBlock: n.factoryBlock, budget: n.budget, venues: n.venues, instruments: n.instruments,
        gasSymbol: n.gasSymbol, agentGas: n.agentGas,
        demo: demo ? { governor: demo.governor, stock: demo.stock, kinds: EVM_REFUSAL_KINDS.filter((k) => k !== "overpay" || demo.attackerFee) } : null,
      })),
    });
  });

  app.get("/v1/evm/:network/governors", async (req, res) => {
    const lane = laneOf(req, res);
    if (!lane) return;
    try {
      const rows = await cache.get(`${lane.network.key}:governors`, async () => {
        const factory = new ethers.Contract(lane.network.factory, FACTORY_ABI, lane.provider);
        const count = Number(await factory.governorCount());
        const addresses: string[] = await Promise.all(Array.from({ length: count }, (_, i) => factory.allGovernors(i)));
        return Promise.all(addresses.map(async (address) => {
          const g = new ethers.Contract(address, GOVERNOR_ABI, lane.provider);
          const [owner, operator, suspended] = await Promise.all([g.owner(), g.operator(), g.suspended()]);
          return { address, owner, operator, suspended, demo: lane.demo?.governor === address };
        }));
      });
      res.json({ network: lane.network.key, governors: rows });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/v1/evm/:network/governors/:address", async (req, res) => {
    const lane = laneOf(req, res);
    if (!lane) return;
    const address = String(req.params.address);
    if (!ethers.isAddress(address)) return void res.status(400).json({ error: "INVALID_REQUEST", message: "address must be an address" });
    try {
      const view = await cache.get(`${lane.network.key}:g:${address.toLowerCase()}`, async () => {
        const n = lane.network;
        const g = await readGovernor(lane.provider, n, ethers.getAddress(address));
        // Every amount in its own units, as decimal strings: the budget's for money, each share's for holdings.
        const money = (v: bigint) => ethers.formatUnits(v, n.budget.decimals);
        const prices = await Promise.all(n.instruments.map(async (i) => {
          const c = i.feed ? await oraclePrice(lane.provider, i.feed, n.budget.decimals).catch(() => null) : null;
          return { stock: i.symbol, chainlink: c ? { price: money(c.price), updatedAt: c.updatedAt } : null };
        }));
        return {
          address: g.address, owner: g.owner, operator: g.operator, guardian: g.guardian, suspended: g.suspended, budgetToken: g.budgetToken,
          budget: money(g.budget), perTradeCap: money(g.perTradeCap), epochCap: money(g.epochCap), epochLength: g.epochLength,
          spentThisEpoch: money(g.spentThisEpoch), remaining: money(g.remaining), epochEndsAt: g.epochEndsAt,
          venues: g.venues,
          instruments: g.instruments.map((i) => ({
            symbol: i.symbol, address: i.address, allowed: i.allowed,
            held: ethers.formatUnits(i.held, instrumentOf(n, i.address)?.decimals ?? 18),
            limitPrice: money(i.limitPrice), guard: i.guard,
          })),
          prices,
          demo: lane.demo?.governor === ethers.getAddress(address),
        };
      });
      res.json(json(view));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/v1/evm/:network/trades", async (req, res) => {
    const lane = laneOf(req, res);
    if (!lane) return;
    try {
      const all = await indexes.get(lane.network.key)!.all();
      const governor = typeof req.query.governor === "string" ? req.query.governor.toLowerCase() : null;
      const rows = governor ? all.filter((r) => r.governor.toLowerCase() === governor) : all;
      res.json({ network: lane.network.key, trades: rows.slice(0, Math.min(200, Number(req.query.limit ?? 50) || 50)) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/v1/evm/:network/trades/:tx", async (req, res) => {
    const lane = laneOf(req, res);
    if (!lane) return;
    const hash = String(req.params.tx);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return void res.status(400).json({ error: "INVALID_REQUEST", message: "tx must be a transaction hash" });
    try {
      const view = await cache.get(`${lane.network.key}:t:${hash}`, async () => {
        const receipt = await lane.provider.getTransactionReceipt(hash);
        if (!receipt) return null;
        const iface = new ethers.Interface(GOVERNOR_ABI);
        const log = receipt.logs.find((l) => { try { return iface.parseLog(l)?.name === "TradeExecuted"; } catch { return false; } });
        const block = await lane.provider.getBlock(receipt.blockNumber);
        if (!log) return { tx: hash, status: receipt.status, block: receipt.blockNumber, at: block?.timestamp, governor: receipt.to, trade: null };
        const e = iface.parseLog(log)!;
        const inst = instrumentOf(lane.network, e.args.tokenOut);
        const decimals = inst?.decimals ?? 18;
        return {
          tx: hash,
          status: receipt.status,
          block: receipt.blockNumber,
          at: block?.timestamp,
          governor: ethers.getAddress(log.address),
          operator: receipt.from,
          trade: {
            intentId: e.args.intentId,
            venue: e.args.venue,
            stock: inst?.symbol ?? e.args.tokenOut,
            token: e.args.tokenOut,
            spent: ethers.formatUnits(e.args.spent, lane.network.budget.decimals),
            received: ethers.formatUnits(e.args.received, decimals),
            pricePerShare: ethers.formatUnits(fillPrice(e.args.spent, e.args.received, decimals), lane.network.budget.decimals),
            decisionHash: e.args.decisionHash,
            epochSpent: ethers.formatUnits(e.args.spentInEpoch, lane.network.budget.decimals),
          },
        };
      });
      if (!view) return void res.status(404).json({ error: "NOT_FOUND", message: "no such transaction on this chain" });
      res.json(json(view));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/v1/evm/:network/demo/refusal", express.json({ limit: "1kb" }), async (req, res) => {
    const lane = laneOf(req, res);
    if (!lane) return;
    const kind = EVM_REFUSAL_KINDS.find((k) => k === (req.body as { kind?: unknown } | undefined)?.kind);
    if (!kind) return void res.status(400).json({ error: "INVALID_REQUEST", message: `kind must be one of ${EVM_REFUSAL_KINDS.map((k) => `"${k}"`).join(", ")}` });
    const prev = queues.get(lane.network.key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => refuse(lane, kind));
    queues.set(lane.network.key, run);
    try {
      res.json(await run);
    } catch (err) {
      fail(res, err);
    }
  });
}
