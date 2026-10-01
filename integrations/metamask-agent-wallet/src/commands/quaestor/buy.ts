import { ethers } from "ethers";
import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { budgetAmountOf, chargedChainFees, finish, instrumentFlag, prepareBuy, reasonOf, refuseIfPending, slippageOf, writePending } from "../../../../../cli/quaestor-evm";
import { agentAddress, common, flagsOf, quaestorContext, rethrow, settle } from "../../quaestor";

const inputs = {
  stock: { type: InputFieldType.Text, flag: "stock", message: "Token to buy, such as tTSLA", required: true, prompt: false, index: 0 },
  amount: { type: InputFieldType.Text, flag: "amount", message: "Dollars to spend from the governor, such as 2", required: true, prompt: false, index: 1 },
  reason: { type: InputFieldType.Text, flag: "reason", message: "Why, in a sentence; its hash is committed on-chain with the trade", required: true, prompt: false },
  slippage: { type: InputFieldType.Text, flag: "slippage", message: "Floor below the quote, in basis points (default 100)", required: false, prompt: false },
  "min-out": { type: InputFieldType.Text, flag: "min-out", message: "Exact floor in tokens, instead of --slippage", required: false, prompt: false },
  "dry-run": { type: InputFieldType.Boolean, flag: "dry-run", message: "Check and simulate only; send nothing", required: false, prompt: false },
  ...common,
} satisfies InputSchema;

/** The executor's transaction request, as @metamask/agent-sdk 7 defines it: hex quantities. */
interface Executor {
  (request: {
    kind: "transaction";
    chainId: number;
    transaction: { to: string; data: string; value: string; gas?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
    intent?: { summary: string; action: string; details?: Record<string, string | undefined> };
  }): Promise<{ kind: string; hash?: string; status: string; failureCode?: string; failureDescription?: string; pendingJob?: { pollingId?: string } }>;
}

const hex = (v: bigint) => ethers.toQuantity(v);

export default class QuaestorBuy extends PluginCommand<Record<string, unknown>> {
  static override description = "Buy a token through your Quaestor governor: the owner's caps, limit prices and Chainlink guard are enforced on-chain, and MetaMask signs";
  static override examples = ["mm quaestor buy tTSLA 2 --reason \"TSLA dipped under my entry\"", "mm quaestor buy tTSLA 2 --reason \"test\" --dry-run"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "quaestor:buy";

  async execute(io: CommandIO) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const address = agentAddress(this.ctx.walletStateManager);
      let ctx = await quaestorContext(flags, address);
      const inst = instrumentFlag(ctx.settings.network, flags);
      const { units } = budgetAmountOf(flags, ctx.settings.network);
      const blocked = refuseIfPending(ctx.settings);
      if (blocked) return settle(blocked);

      // Every refusal the governor would make, made before MetaMask is asked for anything.
      const prepared = await prepareBuy(ctx, address, flags, inst, units, reasonOf(flags), slippageOf(flags));
      if ("refusal" in prepared) return settle(prepared.refusal);
      const p = prepared.buy;
      const n = p.network;
      if (flags["dry-run"] === "true") return { ok: true, dryRun: true, wouldSend: true, wallet: address, governor: p.governor, ...p.summary };
      ctx = { ...ctx, settings: { ...ctx.settings, network: n } };

      // Where the limit itself is charged (Monad), the max fee sits just over the base fee, so a
      // wallet funded for a few trades is not refused for gas it will never pay.
      const fees = n.gasLimitIsCharged ? await chargedChainFees(ctx.provider) : {};
      const upfront = p.gasLimit * (fees.maxFeePerGas ?? (await ctx.provider.getFeeData()).maxFeePerGas ?? 0n);
      const gas = await ctx.provider.getBalance(address);
      if (gas < upfront) return settle({ ok: false, refused: "NoGas", detail: `this wallet holds ${ethers.formatEther(gas)} ${n.gasSymbol}; the buy needs up to ${ethers.formatEther(upfront)}`, meaning: `Send ${n.gasSymbol} to ${address} for gas. The governor holds the money; this wallet only pays gas.` });

      const execute = (await this.ctx.walletExecutor(io, this.pluginCommandId)) as unknown as Executor;
      const result = await execute({
        kind: "transaction",
        chainId: n.chainId,
        transaction: {
          to: p.governor,
          data: p.request.data,
          value: "0x0",
          gas: hex(p.gasLimit),
          ...(fees.maxFeePerGas ? { maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas ?? 0n) } : {}),
        },
        intent: {
          summary: `Quaestor: buy ${p.summary.stock} with ${p.summary.spend} from governor ${p.governor}, at least ${p.summary.floor}`,
          action: "custom",
          details: { governor: p.governor, stock: String(p.summary.stock), spend: String(p.summary.spend), floor: String(p.summary.floor), decisionHash: p.decisionHash },
        },
      });
      if (!result.hash) {
        return settle({ ok: false, error: result.failureCode ?? "NOT_SENT", message: `MetaMask did not send it (${result.status}${result.failureDescription ? `: ${result.failureDescription}` : ""}).${result.pendingJob?.pollingId ? ` Watch it with: mm wallet requests watch ${result.pendingJob.pollingId}` : ""}` });
      }
      const sent = await ctx.provider.getTransaction(result.hash).catch(() => null);
      writePending(ctx.settings, { hash: result.hash, raw: "", nonce: sent?.nonce ?? -1, network: n.key, governor: p.governor, record: p.record, decisionHash: p.decisionHash, shareDecimals: p.shareDecimals, sentAt: new Date().toISOString() });
      return settle(await finish(ctx, result.hash, { wallet: address, signedBy: "MetaMask Agent Wallet", ...p.summary }));
    } catch (err) {
      rethrow(err);
    }
  }
}
