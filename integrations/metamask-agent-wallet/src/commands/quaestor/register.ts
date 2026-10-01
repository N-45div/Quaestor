import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { registerUrl, settingsFrom } from "../../../../../cli/quaestor-evm";
import { agentAddress, common, flagsOf, rethrow } from "../../quaestor";

const text = (flag: string, message: string) => ({ type: InputFieldType.Text, flag, message, required: false, prompt: false }) as const;

const inputs = {
  budget: text("budget", "The dollar the governor holds, such as tUSDC"),
  deposit: text("deposit", "Dollars the owner deposits"),
  "per-trade": text("per-trade", "Most one trade may spend"),
  "epoch-cap": text("epoch-cap", "Most spent per epoch"),
  epoch: text("epoch", "hour, day or week"),
  stocks: text("stocks", "Tokens the agent may buy, such as tTSLA,tETH"),
  limit: text("limit", "Most the owner pays per token, such as tTSLA=400"),
  network: common.network,
} satisfies InputSchema;

export default class QuaestorRegister extends PluginCommand<Record<string, unknown>> {
  static override description = "The link the owner opens to fund a Quaestor governor that names this wallet as its agent";
  static override examples = ["mm quaestor register --deposit 20 --per-trade 5 --epoch-cap 10 --epoch day --stocks tTSLA --limit tTSLA=400"];
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "quaestor:register";

  async execute(io: CommandIO) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const operator = agentAddress(this.ctx.walletStateManager);
      const s = settingsFrom(flags);
      return {
        ok: true,
        network: s.network.name,
        operator,
        registerUrl: registerUrl(s, operator, flags),
        next: "Send the owner this link. They check every number and sign once in their own wallet; the governor holds the money, this wallet only signs trades and pays gas.",
      };
    } catch (err) {
      rethrow(err);
    }
  }
}
