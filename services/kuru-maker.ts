/**
 * A market maker for the Kuru order book the governor's agents buy on, anchored
 * to Chainlink: its asks sit a few basis points over Chainlink's price for the
 * token and move when that price moves. This is what makes a market Quaestor
 * brings to Kuru (tETH/tUSDC on Monad testnet) tradable at a price an owner's
 * limit and Chainlink check will accept, rather than a book that goes stale.
 *
 * It re-quotes in one transaction (Kuru's batchUpdate places the new asks and
 * cancels the old ones), and only when Chainlink's price has moved enough to
 * matter or an ask has been filled away, because Monad charges every
 * transaction its whole gas limit. After a restart it finds its own open orders
 * from its OrderCreated events, read from Envio HyperSync, and keeps them if
 * they are all still resting and were placed at today's price: a restart alone
 * costs nothing.
 *
 *   EVM_MAKER_MONAD_TESTNET_KEY=0x…   the maker's key; its tETH sits in Kuru's margin account
 */
import { ethers } from "ethers";
import { FEED_ABI, type Network } from "../sdk/evm-stocks";
import { safeMessage } from "../stocks/redact";

const BOOK_ABI = [
  "function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
];

/** Asks over Chainlink's price: basis points over it, and size in whole tokens. */
export const LEVELS: [number, number][] = [[10, 0.2], [30, 0.5], [60, 1]];
/** Re-quote when Chainlink has moved this far from the price the asks were placed at. */
export const REQUOTE_BPS = 25;

export interface MakerConfig {
  network: Network;
  provider: ethers.JsonRpcProvider;
  makerKey: string;
  market: string;
  feed: string;
  envioToken?: string;
  levels?: [number, number][];
}

/** A price in the book's units, on its tick. */
export function toBookPrice(usd: number, pricePrecision: number, tick: number): number {
  return Math.round((usd * pricePrecision) / tick) * tick;
}

export class KuruMaker {
  private open: bigint[] = [];
  private quotedAt: number | null = null; // Chainlink's price when the asks were placed
  private recovered = false;
  private busy = false;

  constructor(private readonly cfg: MakerConfig) {}

  get maker(): string {
    return new ethers.Wallet(this.cfg.makerKey).address;
  }

  /** The maker's orders still resting on the book, from its OrderCreated events. */
  private async recover(book: ethers.Contract): Promise<void> {
    this.recovered = true;
    const { network, envioToken, market } = this.cfg;
    if (!network.hypersync || !envioToken) return;
    const iface = new ethers.Interface(BOOK_ABI);
    const topic = iface.getEvent("OrderCreated")!.topicHash;
    const res = await fetch(`${network.hypersync}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${envioToken}` },
      body: JSON.stringify({
        from_block: network.factoryBlock,
        logs: [{ address: [market.toLowerCase()], topics: [[topic]] }],
        field_selection: { log: ["data", "topic0"] },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HyperSync answered ${res.status}`);
    const page = (await res.json()) as { data?: { logs?: { data: string; topic0: string }[] }[] };
    const mine: bigint[] = [];
    for (const log of (page.data ?? []).flatMap((d) => d.logs ?? [])) {
      const e = iface.parseLog({ topics: [log.topic0], data: log.data })!;
      if ((e.args.owner as string).toLowerCase() === this.maker.toLowerCase() && !e.args.isBuy) mine.push(e.args.orderId as bigint);
    }
    const alive = await Promise.all(mine.map(async (id) => {
      const o = await book.s_orders(id);
      return (o.ownerAddress as string).toLowerCase() === this.maker.toLowerCase() && (o.size as bigint) > 0n ? { id, price: Number(o.price) } : null;
    }));
    const resting = alive.filter((x): x is { id: bigint; price: number } => x !== null);
    this.open = resting.map((o) => o.id);
    // A full set of asks still resting was placed at a price this far under the lowest one.
    const levels = this.cfg.levels ?? LEVELS;
    if (resting.length === levels.length) {
      const pricePrecision = Number((await book.getMarketParams())[0]);
      const lowest = Math.min(...resting.map((o) => o.price)) / pricePrecision;
      this.quotedAt = lowest / (1 + levels[0][0] / 10_000);
    }
  }

  /** Whether every ask the maker placed is still resting; one filled away leaves the book thinner. */
  private async allResting(book: ethers.Contract): Promise<boolean> {
    const sizes = await Promise.all(this.open.map(async (id) => (await book.s_orders(id)).size as bigint));
    return sizes.length === (this.cfg.levels ?? LEVELS).length && sizes.every((s) => s > 0n);
  }

  /** One pass: re-quote if the price has moved enough (or nothing is quoted). Returns what it did. */
  async tick(): Promise<{ requoted: boolean; price: number; cancelled: number; placed: number; tx?: string }> {
    if (this.busy) return { requoted: false, price: this.quotedAt ?? 0, cancelled: 0, placed: 0 };
    this.busy = true;
    try {
      const { provider, market, feed, makerKey } = this.cfg;
      const wallet = new ethers.Wallet(makerKey, provider);
      const book = new ethers.Contract(market, BOOK_ABI, wallet);
      if (!this.recovered) await this.recover(book);
      const f = new ethers.Contract(feed, FEED_ABI, provider);
      const [dec, round] = await Promise.all([f.decimals(), f.latestRoundData()]);
      const price = Number(round.answer) / 10 ** Number(dec);
      const moved = this.quotedAt === null ? Infinity : (Math.abs(price - this.quotedAt) / this.quotedAt) * 10_000;
      if (moved < REQUOTE_BPS && this.open.length && (await this.allResting(book))) return { requoted: false, price, cancelled: 0, placed: 0 };

      const params = await book.getMarketParams();
      const pricePrecision = Number(params[0]);
      const sizePrecision = params[1] as bigint;
      const tick = Number(params[6]);
      const levels = this.cfg.levels ?? LEVELS;
      const sellPrices = levels.map(([bps]) => toBookPrice(price * (1 + bps / 10_000), pricePrecision, tick));
      const sellSizes = levels.map(([, size]) => BigInt(Math.round(size * Number(sizePrecision))));
      const cancel = this.open;
      const data = book.interface.encodeFunctionData("batchUpdate", [[], [], sellPrices, sellSizes, cancel, true]);
      const estimate = await provider.estimateGas({ from: wallet.address, to: market, data });
      const tx = await wallet.sendTransaction({ to: market, data, gasLimit: (estimate * 115n) / 100n });
      const receipt = await tx.wait(1, 90_000);
      const created = new ethers.Interface(BOOK_ABI);
      this.open = (receipt?.logs ?? [])
        .map((l) => { try { return created.parseLog(l); } catch { return null; } })
        .filter((e) => e?.name === "OrderCreated" && (e.args.owner as string).toLowerCase() === wallet.address.toLowerCase())
        .map((e) => e!.args.orderId as bigint);
      this.quotedAt = price;
      return { requoted: true, price, cancelled: cancel.length, placed: this.open.length, tx: tx.hash };
    } finally {
      this.busy = false;
    }
  }

  /** Re-quote every `everyMs` for as long as the process runs. */
  start(everyMs = 5 * 60_000): void {
    const run = () => this.tick()
      .then((r) => { if (r.requoted) console.log(`[kuru-maker] ${this.cfg.network.name}: ${r.placed} asks over $${r.price.toFixed(2)}, ${r.cancelled} cancelled (${r.tx})`); })
      .catch((e) => console.error(`[kuru-maker] ${this.cfg.network.name}: ${safeMessage(e, 200)}`));
    void run();
    setInterval(run, everyMs).unref?.();
  }
}
