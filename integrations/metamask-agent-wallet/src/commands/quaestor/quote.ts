import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { instrumentOf } from "../../../../../sdk/evm-stocks";
import { budgetAmountOf, budgetNetwork, instrumentFlag, quote, slippageOf } from "../../../../../cli/quaestor-evm";
import { common, flagsOf, quaestorContext, rethrow } from "../../quaestor";

const inputs = {
  stock: { type: InputFieldType.Text, flag: "stock", message: "Token to price, such as tTSLA", required: true, prompt: false, index: 0 },
  amount: { type: InputFieldType.Text, flag: "amount", message: "Dollars to spend, such as 2", required: true, prompt: false, index: 1 },
  budget: { type: InputFieldType.Text, flag: "budget", message: "The dollar, when the chain has several", required: false, prompt: false },
  slippage: { type: InputFieldType.Text, flag: "slippage", message: "Floor below the quote, in basis points (default 100)", required: false, prompt: false },
  network: common.network,
  rpc: common.rpc,
} satisfies InputSchema;

export default class QuaestorQuote extends PluginCommand<Record<string, unknown>> {
  static override description = "Price a buy on the governor's venue against Chainlink, before anything is signed";
  static override examples = ["mm quaestor quote tTSLA 2"];
  // A read of public chain state: no sign-in, no wallet.
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "quaestor:quote";

  async execute(io: CommandIO) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      let ctx = await quaestorContext(flags);
      if (flags.budget) ctx = { ...ctx, settings: { ...ctx.settings, network: budgetNetwork(ctx.settings.network, flags.budget) } };
      const n = ctx.settings.network;
      const inst = instrumentFlag(n, flags);
      if (!instrumentOf(n, inst.address)) throw new Error(`${inst.symbol} has no market against ${n.budget.symbol} on ${n.name}`);
      return await quote(ctx, inst, budgetAmountOf(flags, n).units, slippageOf(flags));
    } catch (err) {
      rethrow(err);
    }
  }
}
