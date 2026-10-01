import { type CommandIO, type InputSchema, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { status } from "../../../../../cli/quaestor-evm";
import { agentAddress, common, flagsOf, quaestorContext, rethrow } from "../../quaestor";

const inputs = { ...common } satisfies InputSchema;

export default class QuaestorStatus extends PluginCommand<Record<string, unknown>> {
  static override description = "Read this wallet's Quaestor governor: budget, caps, what is left this epoch, approved tokens and limits";
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "quaestor:status";

  async execute(io: CommandIO) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const address = agentAddress(this.ctx.walletStateManager);
      return await status(await quaestorContext(flags, address), flags, address);
    } catch (err) {
      rethrow(err);
    }
  }
}
