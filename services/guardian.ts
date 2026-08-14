import { ethers } from "ethers";
import { QUAESTOR_ABI } from "../sdk";

/**
 * The guardian watchdog: same deterministic checks the dashboard shows, but
 * armed. Holds a guardian key that the chain permits to do exactly one thing —
 * suspend. It can never spend, withdraw, resume, or change policy, so running
 * it is safe by construction.
 *
 * Default trigger: burst spending (>= BURST_N receipts inside BURST_WINDOW_S).
 */

export interface GuardianConfig {
  provider: ethers.JsonRpcProvider;
  quaestorAddress: string;
  guardianKey: string;
  pollMs: number;
  burstN: number;
  burstWindowS: number;
}

export function guardianConfigFromEnv(
  provider: ethers.JsonRpcProvider
): GuardianConfig | null {
  if (!process.env.GUARDIAN_KEY) return null;
  const quaestorAddress = process.env.QUAESTOR_ADDRESS;
  if (!quaestorAddress) throw new Error("GUARDIAN_KEY set but QUAESTOR_ADDRESS missing");
  return {
    provider,
    quaestorAddress,
    guardianKey: process.env.GUARDIAN_KEY,
    pollMs: Number(process.env.GUARDIAN_POLL_MS ?? 15_000),
    burstN: Number(process.env.GUARDIAN_BURST_N ?? 6),
    burstWindowS: Number(process.env.GUARDIAN_BURST_WINDOW_S ?? 60),
  };
}

export function startGuardian(cfg: GuardianConfig): { stop: () => void } {
  const signer = new ethers.NonceManager(
    new ethers.Wallet(cfg.guardianKey, cfg.provider)
  );
  const quaestor = new ethers.Contract(cfg.quaestorAddress, QUAESTOR_ABI, signer);
  const reader = quaestor.connect(cfg.provider) as ethers.Contract;
  const guardianAddress = (signer.signer as ethers.Wallet).address;

  /** agentId -> recent receipt timestamps (ms) */
  const recent = new Map<string, number[]>();
  let lastBlock: bigint | null = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const head = BigInt(await cfg.provider.getBlockNumber());
      const from = lastBlock !== null ? lastBlock + 1n : head - 50n > 0n ? head - 50n : 0n;
      if (from <= head) {
        const logs = await cfg.provider.getLogs({
          address: cfg.quaestorAddress,
          topics: [quaestor.interface.getEvent("Receipt")!.topicHash],
          fromBlock: from,
          toBlock: head,
        });
        const now = Date.now();
        for (const log of logs) {
          const parsed = quaestor.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (!parsed) continue;
          const id = (parsed.args.agentId as bigint).toString();
          const arr = recent.get(id) ?? [];
          arr.push(now);
          recent.set(id, arr);
        }
        lastBlock = head;
      }

      const cutoff = Date.now() - cfg.burstWindowS * 1000;
      for (const [id, stamps] of recent) {
        const alive = stamps.filter((t) => t >= cutoff);
        recent.set(id, alive);
        if (alive.length < cfg.burstN) continue;

        const agentId = BigInt(id);
        const [guardian, info] = await Promise.all([
          reader.guardianOf(agentId),
          reader.agents(agentId),
        ]);
        if ((guardian as string).toLowerCase() !== guardianAddress.toLowerCase()) continue;
        if (info.suspended) continue;

        console.log(
          `[guardian] agent #${id}: ${alive.length} receipts in ${cfg.burstWindowS}s — SUSPENDING`
        );
        const tx = await quaestor.suspend(agentId);
        await tx.wait();
        console.log(`[guardian] agent #${id} suspended (${tx.hash})`);
        recent.set(id, []);
      }
    } catch (err) {
      console.error("[guardian] tick failed:", (err as Error).message.slice(0, 160));
    } finally {
      busy = false;
    }
  };

  void tick();
  const timer = setInterval(tick, cfg.pollMs);
  console.log(
    `[guardian] armed as ${guardianAddress} — burst rule: ${cfg.burstN} receipts / ${cfg.burstWindowS}s`
  );
  return { stop: () => clearInterval(timer) };
}
