/**
 * Governed trades on Monad as they happen, from Alchemy's `monadLogs` stream.
 *
 * Alchemy's Monad WebSocket sends a log when its block is proposed, and again as the block is
 * voted and finalized (`commitState`: Proposed, Voted, Finalized). The hub subscribes to every
 * TradeExecuted event, keeps the ones from governors Quaestor's factory made, and shows each fill
 * the moment its block is proposed, then marks it final. A refused trade emits nothing: it never
 * reaches the tape.
 *
 *   GET /v1/evm/monad-testnet/live    recent governed fills, each with when it was proposed and finalized
 *
 *   MONAD_TAPE_WSS=wss://monad-testnet.g.alchemy.com/v2/…
 */
import type { Express, Request, Response } from "express";
import { ethers } from "ethers";
import { FACTORY_ABI, GOVERNOR_ABI, MONAD_TESTNET, instrumentOf, type Network } from "../sdk/evm-stocks";
import { safeMessage } from "../stocks/redact";

const iface = new ethers.Interface(GOVERNOR_ABI);
export const TRADE_TOPIC = iface.getEvent("TradeExecuted")!.topicHash;

export type Stage = "Proposed" | "Voted" | "Finalized";

export interface Fill {
  key: string;
  governor: string;
  tx: string;
  block: number;
  stock: string;
  spent: string;
  received: string;
  pricePerShare: string;
  decisionHash: string;
  stage: Stage;
  proposedAt?: number;
  votedAt?: number;
  finalizedAt?: number;
}

export interface MonadLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  commitState?: string;
  removed?: boolean;
}

/** The tape: fills keyed by transaction and log, each advanced as its block is voted and finalized. */
export class Tape {
  private readonly fills = new Map<string, Fill>();

  constructor(private readonly network: Network, private readonly isGovernor: (address: string) => Promise<boolean>, private readonly now: () => number = Date.now, private readonly size = 50) {}

  async accept(log: MonadLog): Promise<Fill | null> {
    if (log.topics?.[0]?.toLowerCase() !== TRADE_TOPIC.toLowerCase()) return null;
    const key = `${log.transactionHash}:${log.logIndex}`;
    const stage = (["Proposed", "Voted", "Finalized"].includes(log.commitState ?? "") ? log.commitState : "Finalized") as Stage;
    if (log.removed) {
      this.fills.delete(key); // the proposal did not make it into the chain
      return null;
    }
    let fill = this.fills.get(key);
    if (!fill) {
      if (!(await this.isGovernor(log.address))) return null; // anyone can emit an event with this name
      const e = iface.parseLog({ topics: log.topics, data: log.data })!;
      const inst = instrumentOf(this.network, e.args.tokenOut as string);
      const decimals = inst?.decimals ?? 18;
      const spent = e.args.spent as bigint;
      const received = e.args.received as bigint;
      fill = {
        key,
        governor: ethers.getAddress(log.address),
        tx: log.transactionHash,
        block: Number(log.blockNumber),
        stock: inst?.symbol ?? (e.args.tokenOut as string),
        spent: ethers.formatUnits(spent, this.network.budget.decimals),
        received: ethers.formatUnits(received, decimals),
        pricePerShare: received > 0n ? ethers.formatUnits((spent * 10n ** BigInt(decimals)) / received, this.network.budget.decimals) : "0",
        decisionHash: e.args.decisionHash as string,
        stage,
      };
      this.fills.set(key, fill);
      while (this.fills.size > this.size) this.fills.delete(this.fills.keys().next().value!);
    }
    const at = this.now();
    if (stage === "Proposed") fill.proposedAt ??= at;
    if (stage === "Voted") fill.votedAt ??= at;
    if (stage === "Finalized") fill.finalizedAt ??= at;
    const order: Stage[] = ["Proposed", "Voted", "Finalized"];
    if (order.indexOf(stage) > order.indexOf(fill.stage)) fill.stage = stage;
    return fill;
  }

  recent(): Fill[] {
    return [...this.fills.values()].reverse();
  }
}

/** Governors the factory made, re-read when an unknown address shows up (at most once a minute). */
export function factoryMembership(provider: ethers.Provider, factory: string): (address: string) => Promise<boolean> {
  const f = new ethers.Contract(factory, FACTORY_ABI, provider);
  const known = new Set<string>();
  let readAt = 0;
  let count = 0;
  return async (address) => {
    const a = address.toLowerCase();
    if (known.has(a)) return true;
    if (Date.now() - readAt < 60_000) return false;
    readAt = Date.now();
    const total = Number(await f.governorCount());
    for (let i = count; i < total; i += 1) known.add(String(await f.allGovernors(i)).toLowerCase());
    count = total;
    return known.has(a);
  };
}

export function mountMonadTape(app: Express, wss: string, provider: ethers.Provider): void {
  const network = MONAD_TESTNET;
  const tape = new Tape(network, factoryMembership(provider, network.factory!));
  let connectedAt: number | null = null;
  let retry = 1_000;

  const connect = () => {
    const ws = new WebSocket(wss);
    ws.onopen = () => {
      connectedAt = Date.now();
      retry = 1_000;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["monadLogs", { topics: [TRADE_TOPIC] }] }));
    };
    ws.onmessage = (m) => {
      try {
        const j = JSON.parse(String(m.data)) as { params?: { result?: MonadLog }; error?: { message?: string } };
        if (j.error) console.error(`[monad-tape] ${j.error.message}`);
        const log = j.params?.result;
        if (log?.topics) void tape.accept(log).then((f) => f && f.stage === "Proposed" && console.log(`[monad-tape] proposed: ${f.stock} ${f.spent} at ${f.pricePerShare} (${f.tx})`)).catch(() => undefined);
      } catch (err) {
        console.error(`[monad-tape] bad message: ${safeMessage(err, 120)}`);
      }
    };
    ws.onclose = () => {
      connectedAt = null;
      setTimeout(connect, retry).unref?.();
      retry = Math.min(retry * 2, 60_000);
    };
    ws.onerror = () => undefined; // onclose follows and reconnects
  };
  connect();

  app.get("/v1/evm/monad-testnet/live", (_req: Request, res: Response) => {
    res.json({
      source: "Alchemy monadLogs: each fill appears when its block is proposed, then is marked voted and finalized",
      connected: connectedAt !== null,
      fills: tape.recent(),
    });
  });
}
