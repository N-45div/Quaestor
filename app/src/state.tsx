import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  parseEther,
  parseEventLogs,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { loadConfig, type AppConfig } from "./lib/config";
import { QUAESTOR_ABI, TOKEN_ABI } from "./lib/abi";
import { connectWallet, makePublicClient, viemChainOf } from "./lib/wallet";

export interface CategoryState {
  cap: bigint;
  perCall: bigint;
  spent: bigint;
}

export interface AgentView {
  id: bigint;
  owner: Address;
  operator: Address;
  guardian: Address;
  suspended: boolean;
  registeredAt: number;
  epochLength: number;
  metadataURI: string;
  balance: bigint;
  epoch: bigint;
  categories: CategoryState[]; // [DATA, INFERENCE, EXECUTION]
}

export interface ReceiptView {
  txHash: string;
  blockNumber: bigint;
  timestamp: number; // ms
  agentId: bigint;
  category: number;
  payee: Address;
  amount: bigint;
  metaHash: string;
  epoch: bigint;
  epochSpentAfter: bigint;
}

interface RegisterInput {
  name: string;
  operator: Address;
  epochLength: number;
  deposit: string; // OKB
  caps: { epochCap: string; perCallCap: string }[]; // 3, in OKB
}

interface Store {
  cfg: AppConfig | null;
  ready: boolean;
  error: string | null;
  agents: AgentView[];
  receipts: ReceiptView[];
  account: Address | null;
  connect: () => Promise<void>;
  registerAgent: (input: RegisterInput) => Promise<bigint | null>;
  deposit: (agentId: bigint, amountOkb: string) => Promise<void>;
  withdraw: (agentId: bigint, amountOkb: string) => Promise<void>;
  suspend: (agentId: bigint) => Promise<void>;
  resume: (agentId: bigint) => Promise<void>;
  setPolicy: (
    agentId: bigint,
    category: number,
    epochCapOkb: string,
    perCallCapOkb: string
  ) => Promise<void>;
  setGuardian: (agentId: bigint, guardian: Address) => Promise<void>;
  faucet: (token: Address) => Promise<void>;
  toast: string | null;
  notify: (msg: string) => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(Ctx);
  if (!store) throw new Error("useStore outside provider");
  return store;
}

const POLL_MS = 5000;
// X Layer's public RPC caps eth_getLogs at 100 blocks per request; the
// fallback scanner stays under it and bounds its backfill.
const LOG_CHUNK = 90n;
const MAX_BACKFILL = 1800n;
const MAX_RECEIPTS = 300;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [receipts, setReceipts] = useState<ReceiptView[]>([]);
  const [account, setAccount] = useState<Address | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const publicRef = useRef<PublicClient | null>(null);
  const walletRef = useRef<WalletClient | null>(null);
  const scannedTo = useRef<bigint | null>(null);
  const blockTimes = useRef<Map<bigint, number>>(new Map());

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  // ---- boot ---------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const c = await loadConfig();
        if (!c.contracts.Quaestor) {
          setError(
            "Not deployed yet: app/public/config.json has no contract addresses."
          );
          setCfg(c);
          return;
        }
        publicRef.current = makePublicClient(c);
        setCfg(c);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  // ---- poller -------------------------------------------------------------
  useEffect(() => {
    if (!cfg || !publicRef.current || !cfg.contracts.Quaestor) return;
    let stop = false;

    const tick = async () => {
      const pc = publicRef.current!;
      try {
        const head = await pc.getBlockNumber();

        // 1. receipts — prefer the services indexer; it scans continuously
        // server-side, which the 100-block getLogs cap makes impractical here
        if (cfg.decisionLedgerUrl) {
          try {
            const res = await fetch(`${cfg.decisionLedgerUrl}/receipts`);
            if (res.ok) {
              const body = (await res.json()) as { receipts: any[] };
              const rows: ReceiptView[] = (body.receipts ?? []).map((r) => ({
                txHash: r.txHash,
                blockNumber: BigInt(r.blockNumber),
                timestamp: r.timestamp,
                agentId: BigInt(r.agentId),
                category: r.category,
                payee: r.payee,
                amount: BigInt(r.amount),
                metaHash: r.metaHash,
                epoch: BigInt(r.epoch),
                epochSpentAfter: BigInt(r.epochSpentAfter),
              }));
              setReceipts(rows.slice(0, MAX_RECEIPTS));
            }
          } catch {
            /* indexer briefly down — keep the current list */
          }
        } else {
          await scanReceiptsDirect(pc, head);
        }

        // 2. hydrate agents
        await hydrateAgents(pc);
      } catch (e) {
        if (!stop) {
          setError(`RPC unreachable: ${(e as Error).message.slice(0, 120)}`);
        }
      }
    };

    const scanReceiptsDirect = async (pc: PublicClient, head: bigint) => {
        let from = scannedTo.current !== null
          ? scannedTo.current + 1n
          : head > BigInt(cfg.startBlock) + MAX_BACKFILL
            ? head - MAX_BACKFILL
            : BigInt(cfg.startBlock);
        const fresh: ReceiptView[] = [];
        while (from <= head) {
          const to = from + LOG_CHUNK > head ? head : from + LOG_CHUNK;
          const logs = await pc.getLogs({
            address: cfg.contracts.Quaestor,
            events: QUAESTOR_ABI.filter((x) => x.type === "event"),
            fromBlock: from,
            toBlock: to,
          });
          for (const log of logs) {
            if (log.eventName !== "Receipt") continue;
            const args = log.args as any;
            let ts = blockTimes.current.get(log.blockNumber!);
            if (ts === undefined) {
              const block = await pc.getBlock({ blockNumber: log.blockNumber! });
              ts = Number(block.timestamp) * 1000;
              blockTimes.current.set(log.blockNumber!, ts);
            }
            fresh.push({
              txHash: log.transactionHash!,
              blockNumber: log.blockNumber!,
              timestamp: ts,
              agentId: args.agentId,
              category: Number(args.category),
              payee: args.payee,
              amount: args.amount,
              metaHash: args.metaHash,
              epoch: args.epoch,
              epochSpentAfter: args.epochSpentAfter,
            });
          }
          from = to + 1n;
        }
        scannedTo.current = head;
        if (fresh.length) {
          setReceipts((prev) => {
            const seen = new Set(prev.map((r) => r.txHash + r.metaHash));
            const add = fresh.filter((r) => !seen.has(r.txHash + r.metaHash));
            return [...add.reverse(), ...prev].slice(0, MAX_RECEIPTS);
          });
        }
    };

    const hydrateAgents = async (pc: PublicClient) => {
        const nextId = (await pc.readContract({
          address: cfg.contracts.Quaestor,
          abi: QUAESTOR_ABI,
          functionName: "nextAgentId",
        })) as bigint;

        const views: AgentView[] = await Promise.all(
          Array.from({ length: Number(nextId - 1n) }, (_, i) => BigInt(i + 1)).map(
            async (id) => {
              const q = { address: cfg.contracts.Quaestor, abi: QUAESTOR_ABI } as const;
              const [info, balance, epoch, guardian] = await Promise.all([
                pc.readContract({ ...q, functionName: "agents", args: [id] }),
                pc.readContract({ ...q, functionName: "balanceOf", args: [id] }),
                pc.readContract({ ...q, functionName: "currentEpoch", args: [id] }),
                pc.readContract({ ...q, functionName: "guardianOf", args: [id] }),
              ]);
              const categories = await Promise.all(
                [0, 1, 2].map(async (cat) => {
                  const [policy, spent] = await Promise.all([
                    pc.readContract({
                      ...q,
                      functionName: "policyOf",
                      args: [id, cat],
                    }),
                    pc.readContract({
                      ...q,
                      functionName: "spentIn",
                      args: [id, cat, epoch as bigint],
                    }),
                  ]);
                  const p = policy as { epochCap: bigint; perCallCap: bigint };
                  return {
                    cap: p.epochCap,
                    perCall: p.perCallCap,
                    spent: spent as bigint,
                  };
                })
              );
              const [owner, operator, suspended, registeredAt, epochLength, metadataURI] =
                info as unknown as [Address, Address, boolean, number, number, string];
              return {
                id,
                owner,
                operator,
                guardian: guardian as Address,
                suspended,
                registeredAt: Number(registeredAt),
                epochLength: Number(epochLength),
                metadataURI,
                balance: balance as bigint,
                epoch: epoch as bigint,
                categories,
              };
            }
          )
        );
        if (!stop) {
          setAgents(views);
          setReady(true);
          setError(null);
        }
    };

    tick();
    const h = window.setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(h);
    };
  }, [cfg]);

  // ---- wallet + writes ----------------------------------------------------
  const connect = useCallback(async () => {
    if (!cfg) return;
    const { client, account } = await connectWallet(cfg);
    walletRef.current = client;
    setAccount(account);
    notify(`Connected ${account.slice(0, 6)}…${account.slice(-4)}`);
  }, [cfg, notify]);

  const write = useCallback(
    async (
      fn: string,
      args: unknown[],
      value?: bigint,
      target?: Address,
      abi?: any
    ) => {
      if (!cfg) throw new Error("no config");
      if (!walletRef.current || !account) throw new Error("Connect a wallet first.");
      const hash = await walletRef.current.writeContract({
        address: target ?? cfg.contracts.Quaestor,
        abi: abi ?? QUAESTOR_ABI,
        functionName: fn as any,
        args: args as any,
        value,
        account,
        chain: viemChainOf(cfg),
      });
      return publicRef.current!.waitForTransactionReceipt({ hash });
    },
    [cfg, account]
  );

  const registerAgent = useCallback(
    async (input: RegisterInput): Promise<bigint | null> => {
      const caps = input.caps.map((c) => ({
        epochCap: parseEther(c.epochCap || "0"),
        perCallCap: parseEther(c.perCallCap || "0"),
      }));
      const rcpt = await write(
        "registerAgent",
        [
          input.operator,
          input.epochLength,
          JSON.stringify({ name: input.name }),
          caps[0],
          caps[1],
          caps[2],
        ],
        parseEther(input.deposit || "0")
      );
      const events = parseEventLogs({
        abi: QUAESTOR_ABI,
        logs: rcpt.logs,
        eventName: "AgentRegistered",
      });
      const agentId = events[0]?.args.agentId ?? null;
      notify(`Agent "${input.name}" registered${agentId !== null ? ` as #${agentId}` : ""}.`);
      return agentId;
    },
    [write, notify]
  );

  const deposit = useCallback(
    async (agentId: bigint, amountOkb: string) => {
      await write("deposit", [agentId], parseEther(amountOkb));
      notify(`Deposited ${amountOkb} OKB into agent #${agentId}.`);
    },
    [write, notify]
  );

  const withdraw = useCallback(
    async (agentId: bigint, amountOkb: string) => {
      if (!account) throw new Error("Connect a wallet first.");
      await write("withdraw", [agentId, parseEther(amountOkb), account]);
      notify(`Withdrew ${amountOkb} OKB from agent #${agentId}.`);
    },
    [write, notify, account]
  );

  const setPolicy = useCallback(
    async (
      agentId: bigint,
      category: number,
      epochCapOkb: string,
      perCallCapOkb: string
    ) => {
      await write("setPolicy", [
        agentId,
        category,
        {
          epochCap: parseEther(epochCapOkb || "0"),
          perCallCap: parseEther(perCallCapOkb || "0"),
        },
      ]);
      notify(`Policy updated for agent #${agentId}.`);
    },
    [write, notify]
  );

  const setGuardian = useCallback(
    async (agentId: bigint, guardian: Address) => {
      await write("setGuardian", [agentId, guardian]);
      notify(
        guardian === "0x0000000000000000000000000000000000000000"
          ? `Guardian disarmed for agent #${agentId}.`
          : `Guardian armed for agent #${agentId}.`
      );
    },
    [write, notify]
  );

  const suspend = useCallback(
    async (agentId: bigint) => {
      await write("suspend", [agentId]);
      notify(`Agent #${agentId} suspended — spending frozen.`);
    },
    [write, notify]
  );

  const resume = useCallback(
    async (agentId: bigint) => {
      await write("resume", [agentId]);
      notify(`Agent #${agentId} resumed.`);
    },
    [write, notify]
  );

  const faucet = useCallback(
    async (token: Address) => {
      await write("faucet", [], undefined, token, TOKEN_ABI);
      notify("Faucet claimed.");
    },
    [write, notify]
  );

  return (
    <Ctx.Provider
      value={{
        cfg,
        ready,
        error,
        agents,
        receipts,
        account,
        connect,
        registerAgent,
        deposit,
        withdraw,
        suspend,
        resume,
        setPolicy,
        setGuardian,
        faucet,
        toast,
        notify,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
