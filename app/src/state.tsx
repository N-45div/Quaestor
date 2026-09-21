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
  encodeFunctionData,
  parseEther,
  parseEventLogs,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { loadConfig, type AppConfig } from "./lib/config";
import { QUAESTOR_ABI, TOKEN_ABI } from "./lib/abi";
import { QUAESTOR_V2_ABI } from "./lib/abi-v2";

/**
 * The ABI of the governor a config points at. The two share their view
 * functions byte for byte, but V2 indexes a Receipt's payee and takes
 * different arguments to register an agent and set a cap, so a write or an
 * event read with the wrong one fails or, worse, decodes wrong.
 */
const abiFor = (cfg: AppConfig) => (cfg.governorVersion === 2 ? QUAESTOR_V2_ABI : QUAESTOR_ABI) as typeof QUAESTOR_ABI;

/** policyOf returns a struct from the original governor and a pair from V2; the same bytes either way. */
function readPolicy(value: unknown): { epochCap: bigint; perCallCap: bigint } {
  if (Array.isArray(value)) return { epochCap: value[0] as bigint, perCallCap: value[1] as bigint };
  return value as { epochCap: bigint; perCallCap: bigint };
}
import { connectWallet, makePublicClient, viemChainOf, watchWallets, type WalletOption } from "./lib/wallet";

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

export interface RegisterInput {
  name: string;
  operator: Address;
  epochLength: number;
  deposit: string; // in the chain's native unit
  caps: { epochCap: string; perCallCap: string }[]; // 3, in the chain's native unit
}

/**
 * A registration that got as far as creating the agent and then stopped: the
 * agent exists and holds the deposit, and some of its setup is not on chain.
 * `finishSetup` completes it; registering again would make and fund a second.
 */
export class RegistrationIncomplete extends Error {
  constructor(readonly agentId: bigint, readonly cause: string) {
    super(`Agent #${agentId} is registered and holds its deposit, but its setup stopped: ${cause}`);
  }
}

interface Store {
  cfg: AppConfig | null;
  ready: boolean;
  error: string | null;
  agents: AgentView[];
  receipts: ReceiptView[];
  receiptStatus: { source: string; checkedAt: string | null; error: string | null; complete: boolean; head: number | null };
  account: Address | null;
  /** Every browser wallet the page found, for the owner to pick from. */
  wallets: WalletOption[];
  connect: (walletId?: string) => Promise<void>;
  registerAgent: (input: RegisterInput) => Promise<bigint | null>;
  finishSetup: (agentId: bigint, caps: RegisterInput["caps"]) => Promise<void>;
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
  const [receiptStatus, setReceiptStatus] = useState({ source: "connecting", checkedAt: null as string | null, error: null as string | null, complete: false, head: null as number | null });
  const [account, setAccount] = useState<Address | null>(null);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  useEffect(() => watchWallets(setWallets), []);
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
    let busy = false;

    const tick = async () => {
      if (busy || stop) return;
      busy = true;
      const pc = publicRef.current!;
      try {
        const head = await pc.getBlockNumber();

        // 1. receipts — prefer the services indexer; it scans continuously
        // server-side, which the 100-block getLogs cap makes impractical here
        if (cfg.decisionLedgerUrl) {
          try {
            const api = import.meta.env.VITE_EXPLORER_API || cfg.decisionLedgerUrl;
            let res = await fetch(`${api}/v1/explorer/${cfg.network}/receipts`, { signal: AbortSignal.timeout(10000) });
            let legacy = false;
            if (res.status === 404 && cfg.chainId === 1952) {
              res = await fetch(`${cfg.decisionLedgerUrl}/receipts`, { signal: AbortSignal.timeout(10000) });
              legacy = true;
            }
            if (res.ok) {
              const body = (await res.json()) as { receipts: any[]; chainId?: number; governor?: string; status?: any };
              if (!legacy && (body.chainId !== cfg.chainId || body.governor?.toLowerCase() !== cfg.contracts.Quaestor.toLowerCase())) throw new Error("Receipt source belongs to a different chain or governor");
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
              // The chain-scoped endpoint may be on its first deployment and
              // still walking backwards. The old endpoint is known to index
              // only X Layer, so it is a truthful warm-start for that chain.
              if (!legacy && rows.length === 0 && cfg.chainId === 1952) {
                const warm = await fetch(`${cfg.decisionLedgerUrl}/receipts`, { signal: AbortSignal.timeout(10000) });
                if (warm.ok) {
                  const warmBody = (await warm.json()) as { receipts?: any[] };
                  for (const r of warmBody.receipts ?? []) rows.push({
                    txHash: r.txHash, blockNumber: BigInt(r.blockNumber), timestamp: r.timestamp,
                    agentId: BigInt(r.agentId), category: r.category, payee: r.payee,
                    amount: BigInt(r.amount), metaHash: r.metaHash, epoch: BigInt(r.epoch),
                    epochSpentAfter: BigInt(r.epochSpentAfter),
                  });
                  if (rows.length) legacy = true;
                }
              }
              if (!stop) {
                setReceipts(rows.slice(0, MAX_RECEIPTS));
                setReceiptStatus({ source: legacy ? "Legacy indexer · limited history" : "RPC indexer", checkedAt: body.status?.checkedAt ?? new Date().toISOString(), error: body.status?.error ?? null, complete: Boolean(body.status?.historyComplete), head: body.status?.indexedHead ?? null });
              }
            } else throw new Error(`History endpoint returned ${res.status}`);
          } catch (e) {
            if (!stop) setReceiptStatus(s => ({ ...s, error: (e as Error).message }));
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
      } finally { busy = false; }
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
            events: abiFor(cfg).filter((x) => x.type === "event"),
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
          abi: abiFor(cfg),
          functionName: "nextAgentId",
        })) as bigint;

        const views: AgentView[] = await Promise.all(
          Array.from({ length: Number(nextId - 1n) }, (_, i) => BigInt(i + 1)).map(
            async (id) => {
              const q = { address: cfg.contracts.Quaestor, abi: abiFor(cfg) } as const;
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
                  const p = readPolicy(policy);
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
  const connect = useCallback(async (walletId?: string) => {
    if (!cfg) return;
    const wallet = walletId ? wallets.find((w) => w.id === walletId) : wallets.length === 1 ? wallets[0] : undefined;
    if (!wallet && wallets.length > 1) throw new Error("Pick which wallet to connect.");
    const { client, account } = await connectWallet(cfg, wallet);
    walletRef.current = client;
    setAccount(account);
    notify(`Connected ${wallet?.name ?? "wallet"} ${account.slice(0, 6)}…${account.slice(-4)}`);
  }, [cfg, notify, wallets]);

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
        abi: abi ?? abiFor(cfg),
        functionName: fn as any,
        args: args as any,
        value,
        account,
        chain: viemChainOf(cfg),
      });
      const receipt = await publicRef.current!.waitForTransactionReceipt({ hash });
      // Mined is not done: a transaction can be mined and revert, and every
      // step after it would then build on something that did not happen.
      if (receipt.status !== "success") throw new Error(`${fn} reverted on chain (${hash})`);
      return receipt;
    },
    [cfg, account]
  );

  /**
   * Everything after registration on QuaestorV2: the three caps, the venues and
   * the instruments. It reads what is already on chain and sends only what is
   * missing, so the same call finishes a setup that stopped half way (a
   * rejected prompt, a dropped connection) without repeating a step, and
   * without registering or funding anything twice.
   */
  const finishSetup = useCallback(
    async (agentId: bigint, capsIn: RegisterInput["caps"]): Promise<void> => {
      if (!cfg || !publicRef.current) throw new Error("no config");
      const caps = capsIn.map((c) => ({ epochCap: parseEther(c.epochCap || "0"), perCallCap: parseEther(c.perCallCap || "0") }));
      const q = { address: cfg.contracts.Quaestor, abi: QUAESTOR_V2_ABI } as const;
      const pc = publicRef.current;
      const names = ["DATA", "INFERENCE", "EXECUTION"];
      for (const [category, cap] of caps.entries()) {
        const current = readPolicy(await pc.readContract({ ...q, functionName: "policyOf", args: [agentId, category] }));
        if (current.epochCap === cap.epochCap && current.perCallCap === cap.perCallCap) continue;
        notify(`Agent #${agentId}: setting the ${names[category]} cap (${category + 1} of 3).`);
        await write("setPolicy", [agentId, category, cap.epochCap, cap.perCallCap]);
      }
      for (const venue of cfg.venues ?? []) {
        if (await pc.readContract({ ...q, functionName: "venueAllowed", args: [agentId, venue.address] })) continue;
        notify(`Agent #${agentId}: allowing ${venue.name} as a venue.`);
        await write("setVenue", [agentId, venue.address, true]);
      }
      for (const instrument of cfg.instruments ?? []) {
        if (await pc.readContract({ ...q, functionName: "instrumentAllowed", args: [agentId, instrument.address] })) continue;
        notify(`Agent #${agentId}: allowing ${instrument.symbol} as an instrument.`);
        await write("setInstrument", [agentId, instrument.address, true]);
      }
      notify(`Agent #${agentId} is capped and allowed to trade.`);
    },
    [cfg, write, notify]
  );

  /**
   * Registering on QuaestorV2 is several transactions, because V2 takes no caps
   * at registration and has an allowlist of venues and instruments besides.
   * Each step is its own wallet prompt and says what it is for. If any step
   * after the registration fails, the agent already exists and holds the
   * deposit, so what comes back is RegistrationIncomplete with its id, for
   * finishSetup to complete, never a plain error that invites registering again.
   */
  /**
   * The whole registration as one wallet prompt, when the wallet can execute a
   * batch atomically (EIP-5792: Coinbase Smart Wallet, MetaMask with a smart
   * account, others as they add it). Returns undefined when it cannot, and the
   * caller falls back to one prompt per step.
   *
   * The setup calls need the agent's id before it exists, so it is read first:
   * the next id the governor will hand out. If someone else registers in
   * between, those calls land on an agent this owner does not own and revert,
   * and because the batch is atomic the registration and the deposit revert
   * with them: nothing is stranded, the owner signs again.
   */
  const registerInOneSignature = useCallback(
    async (input: RegisterInput): Promise<bigint | null | undefined> => {
      if (!cfg || !walletRef.current || !account || !publicRef.current) return undefined;
      const wallet = walletRef.current;
      let atomic = false;
      try {
        const capabilities = (await wallet.getCapabilities({ account })) as Record<string, any>;
        const onChain = capabilities?.[cfg.chainId] ?? capabilities?.[`0x${cfg.chainId.toString(16)}`] ?? {};
        atomic = ["supported", "ready"].includes(onChain?.atomic?.status) || onChain?.atomicBatch?.supported === true;
      } catch {
        return undefined; // the wallet does not speak EIP-5792
      }
      if (!atomic) return undefined;

      const governor = cfg.contracts.Quaestor;
      const predicted = (await publicRef.current.readContract({ address: governor, abi: QUAESTOR_V2_ABI, functionName: "nextAgentId" })) as bigint;
      const call = (functionName: string, args: unknown[], value?: bigint) => ({
        to: governor,
        data: encodeFunctionData({ abi: QUAESTOR_V2_ABI, functionName: functionName as any, args: args as any }),
        ...(value ? { value } : {}),
      });
      const calls = [
        call("registerAgent", [input.operator, input.epochLength, JSON.stringify({ name: input.name })], parseEther(input.deposit || "0")),
        ...input.caps.flatMap((c, category) => {
          const epochCap = parseEther(c.epochCap || "0");
          const perCallCap = parseEther(c.perCallCap || "0");
          return epochCap === 0n && perCallCap === 0n ? [] : [call("setPolicy", [predicted, category, epochCap, perCallCap])];
        }),
        ...(cfg.venues ?? []).map((v) => call("setVenue", [predicted, v.address, true])),
        ...(cfg.instruments ?? []).map((t) => call("setInstrument", [predicted, t.address, true])),
      ];
      notify(`One signature: register, fund, cap and allow agent #${predicted} (${calls.length} steps).`);
      const { id } = await wallet.sendCalls({ account, chain: viemChainOf(cfg), calls, forceAtomic: true });
      const result = await wallet.waitForCallsStatus({ id, timeout: 180_000 });
      const registered = (result.receipts ?? []).flatMap((r) =>
        parseEventLogs({ abi: QUAESTOR_V2_ABI, logs: r.logs as any, eventName: "AgentRegistered" }),
      );
      const agentId = registered[0]?.args.agentId ?? null;
      if (result.status !== "success" || agentId === null) {
        // Atomic means nothing happened. Check rather than assume: a wallet
        // that ran the calls one by one could have registered and stopped.
        const info = (await publicRef.current.readContract({ address: governor, abi: QUAESTOR_V2_ABI, functionName: "agents", args: [predicted] })) as unknown as [Address, Address];
        if (info[0]?.toLowerCase() === account.toLowerCase() && info[1]?.toLowerCase() === input.operator.toLowerCase()) {
          throw new RegistrationIncomplete(predicted, "the wallet ran part of the batch");
        }
        throw new Error("The wallet did not run the registration. Nothing was spent; you can register again.");
      }
      // Confirm from the chain that every step is there; anything missing is sent now.
      await finishSetup(agentId, input.caps);
      notify(`Agent "${input.name}" registered as #${agentId}, capped and allowed to trade, in one signature.`);
      return agentId;
    },
    [cfg, account, notify, finishSetup]
  );

  const registerOnV2 = useCallback(
    async (input: RegisterInput): Promise<bigint | null> => {
      if (!cfg) throw new Error("no config");
      const batched = await registerInOneSignature(input);
      if (batched !== undefined) return batched;
      const rcpt = await write(
        "registerAgent",
        [input.operator, input.epochLength, JSON.stringify({ name: input.name })],
        parseEther(input.deposit || "0")
      );
      const events = parseEventLogs({ abi: QUAESTOR_V2_ABI, logs: rcpt.logs, eventName: "AgentRegistered" });
      const agentId = events[0]?.args.agentId ?? null;
      if (agentId === null) {
        notify("Registered, but the receipt named no agent id; open the Agents list to find it.");
        return null;
      }
      try {
        await finishSetup(agentId, input.caps);
      } catch (err) {
        // viem's own message carries the whole request; its short one says what happened.
        const e = err as { shortMessage?: string; message?: string };
        throw new RegistrationIncomplete(agentId, (e.shortMessage ?? e.message ?? String(err)).split("\n")[0].slice(0, 160));
      }
      notify(`Agent "${input.name}" registered as #${agentId}, capped and allowed to trade.`);
      return agentId;
    },
    [cfg, write, notify, finishSetup, registerInOneSignature]
  );

  const registerAgent = useCallback(
    async (input: RegisterInput): Promise<bigint | null> => {
      const caps = input.caps.map((c) => ({
        epochCap: parseEther(c.epochCap || "0"),
        perCallCap: parseEther(c.perCallCap || "0"),
      }));
      if (cfg?.governorVersion === 2) return registerOnV2(input);
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
    [cfg, write, notify, registerOnV2]
  );

  const deposit = useCallback(
    async (agentId: bigint, amountOkb: string) => {
      await write("deposit", [agentId], parseEther(amountOkb));
      notify(`Deposited ${amountOkb} ${cfg?.symbol ?? "native units"} into agent #${agentId}.`);
    },
    [write, notify, cfg]
  );

  const withdraw = useCallback(
    async (agentId: bigint, amountOkb: string) => {
      if (!account) throw new Error("Connect a wallet first.");
      await write("withdraw", [agentId, parseEther(amountOkb), account]);
      notify(`Withdrew ${amountOkb} ${cfg?.symbol ?? "native units"} from agent #${agentId}.`);
    },
    [write, notify, account, cfg]
  );

  const setPolicy = useCallback(
    async (
      agentId: bigint,
      category: number,
      epochCapOkb: string,
      perCallCapOkb: string
    ) => {
      const epochCap = parseEther(epochCapOkb || "0");
      const perCallCap = parseEther(perCallCapOkb || "0");
      // The original governor takes the pair as a struct, V2 as two arguments.
      await write("setPolicy", cfg?.governorVersion === 2
        ? [agentId, category, epochCap, perCallCap]
        : [agentId, category, { epochCap, perCallCap }]);
      notify(`Policy updated for agent #${agentId}.`);
    },
    [write, notify, cfg]
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
        receiptStatus,
        account,
        wallets,
        connect,
        registerAgent,
        finishSetup,
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
