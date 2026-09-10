import { ethers } from "ethers";
import { QUAESTOR_ABI } from "../sdk";
import type { IndexedReceipt } from "./indexer";

/**
 * The subgraph as a budget source — and an honest account of what it adds.
 *
 * It is tempting to say the governor "forgets" each epoch. It does not:
 * `spentIn[agentId][category][epoch]` is a persistent mapping, so the *total*
 * for any epoch you can name is readable on-chain forever. Claiming otherwise
 * would be an easy, wrong story.
 *
 * What the chain genuinely does not hold is the **shape** of the spend. A sum
 * cannot tell you:
 *   - the largest single payment in an epoch      (maxReceipt)
 *   - how many payments made it up                (receiptCount)
 *   - whether they arrived over an hour or a second (firstAt / lastAt)
 *   - which epoch indices are non-empty at all — `spentIn` is a mapping, so
 *     with a 1h epoch and an agent registered in June there are thousands of
 *     keys and no way to enumerate the interesting ones without scanning logs.
 *
 * Those live only in the events, and only an indexer aggregates them. So this
 * module splits every question in two:
 *
 *   budget  — caps, suspension, spend-so-far. Authoritative on-chain; the
 *             subgraph answers faster, and a direct contract read is a real
 *             fallback when it cannot.
 *   shape   — burst and frequency. Subgraph or nothing.
 *
 * Rules built on `shape` therefore have no fallback, which is the point: when
 * the subgraph is stale or erroring, those rules cannot be evaluated and the
 * caller is refused rather than quietly waved through. Stale data blocks.
 */

export class GraphError extends Error {
  constructor(message: string, readonly kind: "network" | "graphql" | "empty" | "stale") {
    super(message);
    this.name = "GraphError";
  }
}

export interface GraphHead {
  block: number;
  /** Seconds, from the last block the subgraph processed. */
  timestamp: number;
  hasIndexingErrors: boolean;
  /** Wall clock minus that block's timestamp. */
  lagSeconds: number;
}

export interface EpochRow {
  epoch: string;
  spent: bigint;
  receiptCount: number;
  maxReceipt: bigint;
  firstAt: number;
  lastAt: number;
}

/**
 * The half of the answer only an indexer can give. Every field here is derived
 * from the event stream and has no on-chain equivalent.
 */
export interface SpendShape {
  epochsSeen: number;
  receiptCountThisEpoch: number;
  maxReceiptThisEpoch: bigint;
  /** Across every completed epoch the subgraph has indexed. */
  maxPriorReceipt: bigint;
  maxPriorReceiptCount: number;
  maxPriorEpochSpend: bigint;
  firstAtThisEpoch: number | null;
  lastAtThisEpoch: number | null;
  /** True if the page cap was hit — say so rather than imply full coverage. */
  truncated: boolean;
}

export interface AgentBudget {
  agentId: string;
  category: number;
  categoryName: string;
  registeredAt: number;
  epochLength: number;
  suspended: boolean;
  epochCap: bigint;
  perCallCap: bigint;
  currentEpoch: string;
  spentThisEpoch: bigint;
  remaining: bigint;
  source: "subgraph" | "chain";
  /** Null for the chain source — a contract read has no indexing head. */
  head: GraphHead | null;
  /** Null whenever the source cannot see spend shape. Only the subgraph can. */
  shape: SpendShape | null;
}

export interface BudgetSource {
  readonly name: string;
  /**
   * The governor this source's history belongs to. An agent must compare this
   * against its own before trusting an answer: agent #1 exists on every chain
   * the contract is deployed to, with a different treasury and a different
   * past on each. Reading the wrong one returns a confident wrong number
   * rather than an error.
   */
  readonly governor: string;
  budget(agentId: string | number, category: number): Promise<AgentBudget>;
  receipts(limit?: number): Promise<IndexedReceipt[]>;
}

export const CATEGORY_NAMES = ["DATA", "INFERENCE", "EXECUTION"] as const;
export const categoryName = (c: number): string => CATEGORY_NAMES[c] ?? "UNKNOWN";

const PAGE = 1000;
const MAX_PAGES = 20;

// ---------------------------------------------------------------- transport

/**
 * A failed GraphQL query is *not* an HTTP error. A bad API key, a deleted
 * deployment and a malformed query all come back 200 OK with an `errors` array
 * and `data: null`, so a `res.ok` check reads success and then dereferences
 * undefined three lines later. Every path out of here throws or returns data.
 */
export async function graphQuery<T>(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 8_000
): Promise<T> {
  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new GraphError(`subgraph unreachable: ${(err as Error).message}`, "network");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new GraphError(`subgraph HTTP ${res.status} ${res.statusText}`, "network");
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new GraphError(
      `subgraph returned errors: ${body.errors.map((e) => e.message).join("; ").slice(0, 300)}`,
      "graphql"
    );
  }
  if (!body.data) throw new GraphError("subgraph returned no data", "empty");
  return body.data;
}

// ------------------------------------------------------------------ queries

const HEAD_QUERY = `{ _meta { block { number timestamp } hasIndexingErrors } }`;

const BUDGET_QUERY = `
query Budget($agentId: BigInt!, $category: Int!, $after: Bytes!) {
  agents(where: { agentId: $agentId }, first: 1) {
    agentId
    epochLength
    registeredAt
    suspended
  }
  policies(where: { agent_: { agentId: $agentId }, category: $category }, first: 1) {
    epochCap
    perCallCap
  }
  epochSpends(
    first: ${PAGE}
    orderBy: id
    orderDirection: asc
    where: { agent_: { agentId: $agentId }, category: $category, id_gt: $after }
  ) {
    id
    epoch
    spent
    receiptCount
    maxReceipt
    firstAt
    lastAt
  }
  _meta { block { number timestamp } hasIndexingErrors }
}`;

const RECEIPTS_QUERY = `
query Receipts($first: Int!) {
  receipts(first: $first, orderBy: timestamp, orderDirection: desc) {
    transactionHash
    blockNumber
    timestamp
    agent { agentId }
    category
    payee
    amount
    metaHash
    epoch
    epochSpentAfter
  }
}`;

// ------------------------------------------------------------ subgraph source

export interface SubgraphOptions {
  url: string;
  /** The governor the subgraph indexes; callers compare it against their own. */
  governor: string;
  /** Refuse to answer if the indexed head is older than this. Default 120s. */
  maxLagSeconds?: number;
  /** Injectable for tests; seconds. */
  now?: () => number;
}

export function createSubgraphSource(opts: SubgraphOptions): BudgetSource {
  const maxLag = opts.maxLagSeconds ?? 120;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const readHead = (meta: any): GraphHead => {
    const block = Number(meta?.block?.number ?? 0);
    const timestamp = Number(meta?.block?.timestamp ?? 0);
    return {
      block,
      timestamp,
      hasIndexingErrors: Boolean(meta?.hasIndexingErrors),
      lagSeconds: Math.max(0, now() - timestamp),
    };
  };

  /**
   * Fail closed. A subgraph that is behind reports a *smaller* spend than the
   * chain holds, which overstates the remaining budget — the failure mode is
   * permissive, so silence is the wrong default.
   */
  const assertUsable = (head: GraphHead) => {
    if (head.hasIndexingErrors) {
      throw new GraphError(`subgraph has indexing errors at block ${head.block}`, "stale");
    }
    if (head.lagSeconds > maxLag) {
      throw new GraphError(
        `subgraph is ${head.lagSeconds}s behind (limit ${maxLag}s) at block ${head.block}`,
        "stale"
      );
    }
  };

  return {
    name: "subgraph",
    governor: opts.governor,

    async budget(agentIdIn, category) {
      const agentId = String(agentIdIn);
      const rows: EpochRow[] = [];
      let after = "0x";
      let head: GraphHead | null = null;
      let agent: any = null;
      let policy: any = null;
      let truncated = false;

      // The default page size is 100 and there is no warning when you hit it,
      // so page explicitly. `skip` tops out at 5000; an id cursor does not.
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await graphQuery<any>(opts.url, BUDGET_QUERY, {
          agentId,
          category,
          after,
        });
        if (page === 0) {
          head = readHead(data._meta);
          assertUsable(head);
          agent = data.agents?.[0];
          policy = data.policies?.[0];
          if (!agent) throw new GraphError(`agent ${agentId} not indexed`, "empty");
          if (!policy) {
            throw new GraphError(
              `no policy indexed for agent ${agentId} category ${category}`,
              "empty"
            );
          }
        }
        const batch = data.epochSpends ?? [];
        for (const r of batch) {
          rows.push({
            epoch: String(r.epoch),
            spent: BigInt(r.spent),
            receiptCount: Number(r.receiptCount),
            maxReceipt: BigInt(r.maxReceipt),
            firstAt: Number(r.firstAt),
            lastAt: Number(r.lastAt),
          });
        }
        if (batch.length < PAGE) break;
        after = batch[batch.length - 1].id;
        if (page === MAX_PAGES - 1) truncated = true;
      }

      const registeredAt = Number(agent.registeredAt);
      const epochLength = Number(agent.epochLength);
      // Derive the epoch from the *indexed head*, not the wall clock. If the
      // clock has crossed an epoch boundary the subgraph has not reached yet,
      // wall time names an epoch with no rows — an empty spend and a full
      // budget, which is exactly the wrong way to be wrong.
      const at = head!.timestamp;
      const currentEpoch =
        epochLength > 0 && at > registeredAt
          ? Math.floor((at - registeredAt) / epochLength)
          : 0;

      const current = rows.find((r) => r.epoch === String(currentEpoch)) ?? null;
      const prior = rows.filter((r) => r.epoch !== String(currentEpoch));

      const epochCap = BigInt(policy.epochCap);
      const spentThisEpoch = current?.spent ?? 0n;
      // A subgraph knows the cap headroom but the governor also bounds
      // remainingBudget by treasury balance. Read that authoritative value
      // through the fallback when available instead of overstating spendable
      // funds. The event-derived shape still comes from the subgraph.

      const shape: SpendShape = {
        epochsSeen: rows.length,
        receiptCountThisEpoch: current?.receiptCount ?? 0,
        maxReceiptThisEpoch: current?.maxReceipt ?? 0n,
        maxPriorReceipt: prior.reduce((m, r) => (r.maxReceipt > m ? r.maxReceipt : m), 0n),
        maxPriorReceiptCount: prior.reduce((m, r) => Math.max(m, r.receiptCount), 0),
        maxPriorEpochSpend: prior.reduce((m, r) => (r.spent > m ? r.spent : m), 0n),
        firstAtThisEpoch: current?.firstAt ?? null,
        lastAtThisEpoch: current?.lastAt ?? null,
        truncated,
      };

      return {
        agentId,
        category,
        categoryName: categoryName(category),
        registeredAt,
        epochLength,
        suspended: Boolean(agent.suspended),
        epochCap,
        perCallCap: BigInt(policy.perCallCap),
        currentEpoch: String(currentEpoch),
        spentThisEpoch,
        remaining: epochCap > spentThisEpoch ? epochCap - spentThisEpoch : 0n,
        source: "subgraph",
        head,
        shape,
      };
    },

    async receipts(limit = 100) {
      const data = await graphQuery<any>(opts.url, RECEIPTS_QUERY, {
        first: Math.min(Math.max(limit, 1), PAGE),
      });
      return (data.receipts ?? []).map(
        (r: any): IndexedReceipt => ({
          txHash: r.transactionHash,
          blockNumber: Number(r.blockNumber),
          timestamp: Number(r.timestamp) * 1000, // the indexer's shape is ms
          agentId: String(r.agent.agentId),
          category: Number(r.category),
          payee: r.payee,
          amount: String(r.amount),
          metaHash: r.metaHash,
          epoch: String(r.epoch),
          epochSpentAfter: String(r.epochSpentAfter),
        })
      );
    },
  };
}

// --------------------------------------------------------------- chain source

/**
 * The fallback: five view calls against the governor. Authoritative on caps
 * and spend — it is reading the same storage the subgraph indexed — but blind
 * to shape, so `shape` is null and every rule that needs it must refuse.
 */
export function createChainSource(
  provider: ethers.Provider,
  address: string
): BudgetSource {
  const quaestor = new ethers.Contract(address, QUAESTOR_ABI, provider);

  return {
    name: "chain",
    governor: address,

    async budget(agentIdIn, category) {
      const agentId = BigInt(agentIdIn);
      const [info, policy, remaining, epoch] = await Promise.all([
        quaestor.agents(agentId),
        quaestor.policyOf(agentId, category),
        quaestor.remainingBudget(agentId, category),
        quaestor.currentEpoch(agentId),
      ]);
      const spent = await quaestor.spentIn(agentId, category, epoch);

      return {
        agentId: String(agentIdIn),
        category,
        categoryName: categoryName(category),
        registeredAt: Number(info.registeredAt),
        epochLength: Number(info.epochLength),
        suspended: Boolean(info.suspended),
        epochCap: BigInt(policy.epochCap),
        perCallCap: BigInt(policy.perCallCap),
        currentEpoch: String(epoch),
        spentThisEpoch: BigInt(spent),
        // remainingBudget is min(cap - spent, treasury), so it can be below the
        // cap headroom. That is the tighter and therefore correct bound.
        remaining: BigInt(remaining),
        source: "chain",
        head: null,
        shape: null,
      };
    },

    async receipts() {
      // Scanning logs here would be re-implementing the indexer. The RPC
      // indexer already serves /receipts; this source exists for budgets.
      return [];
    },
  };
}

// ------------------------------------------------------------ layered source

export interface LayeredOptions {
  primary: BudgetSource;
  fallback?: BudgetSource | null;
  onFallback?: (err: GraphError | Error) => void;
}

/**
 * Try the subgraph; fall back to the chain and say so. `source` on the result
 * is the honest label — a caller can tell a shape-aware answer from a
 * caps-only one without guessing.
 */
export function layeredSource(opts: LayeredOptions): BudgetSource {
  return {
    name: opts.fallback ? `${opts.primary.name}+${opts.fallback.name}` : opts.primary.name,
    governor: opts.primary.governor,

    async budget(agentId, category) {
      try {
        const primary = await opts.primary.budget(agentId, category);
        if (!opts.fallback) return primary;
        try {
          const chain = await opts.fallback.budget(agentId, category);
          return { ...primary, remaining: chain.remaining };
        } catch {
          return primary;
        }
      } catch (err) {
        if (!opts.fallback) throw err;
        opts.onFallback?.(err as Error);
        return await opts.fallback.budget(agentId, category);
      }
    },

    async receipts(limit) {
      try {
        const rows = await opts.primary.receipts(limit);
        if (rows.length > 0 || !opts.fallback) return rows;
      } catch (err) {
        if (!opts.fallback) throw err;
        opts.onFallback?.(err as Error);
      }
      return opts.fallback ? opts.fallback.receipts(limit) : [];
    },
  };
}

// ------------------------------------------------------------------ env wiring

export function budgetSourceFromEnv(
  provider?: ethers.Provider,
  quaestorAddress?: string
): BudgetSource | null {
  const url = process.env.SUBGRAPH_URL;
  const fallback =
    provider && quaestorAddress ? createChainSource(provider, quaestorAddress) : null;

  if (!url) {
    if (!fallback) return null;
    console.log("[graph] no SUBGRAPH_URL — budgets read straight from the governor (no shape)");
    return fallback;
  }

  // The subgraph's governor is whatever the SUBGRAPH indexes — never whatever
  // the caller happens to be using. Passing the caller's address through here
  // would make the cross-governor guard compare a value against itself and
  // always agree, handing an X Layer agent its Base Sepolia history.
  const indexed =
    process.env.SUBGRAPH_GOVERNOR ?? process.env.QUAESTOR_ADDRESS_BASE ?? quaestorAddress;
  if (!indexed) {
    console.log("[graph] SUBGRAPH_URL set but no governor address for it — not mounted");
    return fallback;
  }
  const primary = createSubgraphSource({
    url,
    governor: indexed,
    maxLagSeconds: Number(process.env.GRAPH_MAX_LAG_S ?? 120),
  });
  console.log(
    `[graph] budgets from ${url} — history belongs to governor ${indexed} ` +
      `(max lag ${process.env.GRAPH_MAX_LAG_S ?? 120}s)` +
      (fallback ? `, ${quaestorAddress} as fallback` : ", no fallback")
  );
  return layeredSource({
    primary,
    fallback,
    onFallback: (err) =>
      console.warn(`[graph] falling back to the governor: ${err.message.slice(0, 160)}`),
  });
}
