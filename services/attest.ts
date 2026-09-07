import { ethers } from "ethers";
import { proofProvider, chainInfo } from "@gluwa/usc-sdk";
import { ATTESTED_ABI, QUAESTOR_ABI, RECEIPT_TOPIC, SUSPENDED_TOPIC } from "../sdk";

/**
 * The relayer between a spoke governor and the budget root.
 *
 * A governor on the source chain emits Receipt / Suspended. The relayer waits
 * until the block is attested on Creditcoin, asks the proof builder for the
 * inclusion + continuity proof, and submits it to QuaestorAttested.execute().
 * The root verifies the proof through the BlockProver precompile — the relayer
 * carries bytes, it is not trusted: a forged or replayed proof is rejected
 * on-chain regardless of who submitted it.
 */

export interface AttestConfig {
  sourceRpc: string;
  /** The source chain's key on Creditcoin (Ethereum Sepolia = 1 on CC3 testnet). */
  sourceChainKey: number;
  creditcoinRpc: string;
  creditcoinKey: string;
  attestedAddress: string;
  proofBuilderUrl: string;
  /** Attestation polling. Defaults: every 15 s, give up after 20 min. */
  pollMs?: number;
  waitMs?: number;
}

export function attestConfigFromEnv(): AttestConfig | null {
  const attestedAddress = process.env.ATTESTED_ADDRESS;
  const creditcoinKey = process.env.CREDITCOIN_PRIVATE_KEY;
  if (!attestedAddress || !creditcoinKey) return null;
  return {
    sourceRpc: process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
    sourceChainKey: Number(process.env.SOURCE_CHAIN_KEY ?? 1),
    creditcoinRpc: process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network",
    creditcoinKey,
    attestedAddress,
    proofBuilderUrl: process.env.PROOF_BUILDER_URL ?? "https://proof-gen-api.cc3-testnet.creditcoin.network",
    pollMs: Number(process.env.ATTEST_POLL_MS ?? 15_000),
    waitMs: Number(process.env.ATTEST_WAIT_MS ?? 1_200_000),
  };
}

export type AttestAction = 0 | 1; // SpendAttested | SuspensionAttested

export interface AttestResult {
  sourceTx: string;
  sourceBlock: number;
  action: AttestAction;
  creditcoinTx: string;
  gasUsed: bigint;
  spends: { groupId: bigint; agentId: bigint; amount: bigint; spentInEpoch: bigint }[];
  breached: bigint[];
  suspensions: { agentId: bigint; by: string; total: bigint }[];
}

/** Which root action the transaction's logs call for. */
export function actionForReceipt(rc: ethers.TransactionReceipt): AttestAction {
  if (rc.logs.some((l) => l.topics[0] === RECEIPT_TOPIC)) return 0;
  if (rc.logs.some((l) => l.topics[0] === SUSPENDED_TOPIC)) return 1;
  throw new Error(`transaction ${rc.hash} has neither a Receipt nor a Suspended log`);
}

const log = (...a: unknown[]) => console.log(`[attest ${new Date().toISOString().slice(11, 23)}]`, ...a);

/** Prove one source-chain transaction to the budget root. */
export async function attestTransaction(cfg: AttestConfig, txHash: string): Promise<AttestResult> {
  const source = new ethers.JsonRpcProvider(cfg.sourceRpc);
  const creditcoin = new ethers.JsonRpcProvider(cfg.creditcoinRpc);
  const signer = new ethers.Wallet(cfg.creditcoinKey, creditcoin);
  const root = new ethers.Contract(cfg.attestedAddress, ATTESTED_ABI, signer);

  const rc = await source.waitForTransaction(txHash, 1, 120_000);
  if (!rc) throw new Error(`transaction ${txHash} not found on the source chain`);
  const action = actionForReceipt(rc);
  log(`source tx ${txHash} in block ${rc.blockNumber}; action ${action === 0 ? "SpendAttested" : "SuspensionAttested"}`);

  // Wait for the block to be attested on Creditcoin, then fetch the proof.
  const info = new chainInfo.PrecompileChainInfoProvider(creditcoin);
  const latest = await info.getLatestAttestedHeightAndHash(cfg.sourceChainKey);
  log(`latest attested height for chain key ${cfg.sourceChainKey}: ${latest.height}`);
  const builder = new proofProvider.service.ProofBuilder(cfg.sourceChainKey, cfg.proofBuilderUrl);
  await builder.waitUntilHeightAttested(cfg.sourceChainKey, rc.blockNumber, cfg.pollMs, cfg.waitMs);
  log(`block ${rc.blockNumber} attested; requesting proof`);
  const proof = await builder.getProof(txHash);
  if (!proof.success || !proof.data) throw new Error(`proof builder failed: ${proof.error ?? "no data"}`);
  const d = proof.data;

  // Submit. Gas: the examples' heuristic, with estimateGas first.
  const args = [
    action,
    d.chainKey,
    d.headerNumber,
    d.txBytes,
    d.merkleProof.root,
    d.merkleProof.siblings,
    d.continuityProof.lowerEndpointDigest,
    d.continuityProof.roots,
  ] as const;
  let gasLimit: bigint;
  try {
    gasLimit = ((await root.execute.estimateGas(...args)) * 12n) / 10n;
  } catch {
    gasLimit = BigInt(21_000 + (d.continuityProof.roots?.length ?? 1) * 5_000 + 250_000);
  }
  log(`submitting to ${cfg.attestedAddress} (${d.continuityProof.roots?.length ?? 0} continuity roots, gas ${gasLimit})`);
  const tx = await root.execute(...args, { gasLimit });
  const ccrc = await tx.wait();
  if (!ccrc) throw new Error("no receipt from Creditcoin");

  const result: AttestResult = {
    sourceTx: txHash,
    sourceBlock: rc.blockNumber,
    action,
    creditcoinTx: ccrc.hash,
    gasUsed: ccrc.gasUsed,
    spends: [],
    breached: [],
    suspensions: [],
  };
  const iface = new ethers.Interface(ATTESTED_ABI);
  for (const l of ccrc.logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = iface.parseLog(l);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name === "SpendAttested") {
      result.spends.push({
        groupId: parsed.args.groupId,
        agentId: parsed.args.agentId,
        amount: parsed.args.amount,
        spentInEpoch: parsed.args.spentInEpoch,
      });
    } else if (parsed.name === "GlobalCapBreached") {
      result.breached.push(parsed.args.groupId);
    } else if (parsed.name === "SuspensionAttested") {
      result.suspensions.push({ agentId: parsed.args.agentId, by: parsed.args.by, total: parsed.args.total });
    }
  }
  log(`credited on Creditcoin: ${ccrc.hash} — ${result.spends.length} spend(s), ${result.suspensions.length} suspension(s), ${result.breached.length} breach(es)`);
  return result;
}

/**
 * Follow a governor on the source chain and attest every Receipt / Suspended
 * it emits, in order. Polls (no websocket assumption), remembers the last
 * block it handled, and never attests the same transaction twice in a run —
 * the root's queryId dedupe is the real guard.
 */
export async function watchGovernor(
  cfg: AttestConfig,
  governorAddress: string,
  opts: { fromBlock?: number; pollMs?: number; onResult?: (r: AttestResult) => void; onBreach?: (groupId: bigint) => Promise<void> } = {}
): Promise<never> {
  const source = new ethers.JsonRpcProvider(cfg.sourceRpc);
  const governor = new ethers.Contract(governorAddress, QUAESTOR_ABI, source);
  const seen = new Set<string>();
  let from = opts.fromBlock ?? (await source.getBlockNumber());
  log(`watching governor ${governorAddress} on the source chain from block ${from}`);
  for (;;) {
    try {
      const to = await source.getBlockNumber();
      if (to >= from) {
        const events = [
          ...(await governor.queryFilter(governor.filters.Receipt(), from, to)),
          ...(await governor.queryFilter(governor.filters.Suspended(), from, to)),
        ].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
        for (const ev of events) {
          if (seen.has(ev.transactionHash)) continue;
          seen.add(ev.transactionHash);
          const r = await attestTransaction(cfg, ev.transactionHash);
          opts.onResult?.(r);
          for (const g of r.breached) await opts.onBreach?.(g);
        }
        from = to + 1;
      }
    } catch (err) {
      log("error:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 12_000));
  }
}
