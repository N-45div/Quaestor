import { type CommandIO, type InputSchema, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { whoami } from "../../../../../cli/quaestor-evm";
import { agentAddress, common, flagsOf, quaestorContext, rethrow } from "../../quaestor";

const inputs = { ...common } satisfies InputSchema;

export default class QuaestorWhoami extends PluginCommand<Record<string, unknown>> {
  static override description = "This wallet as a Quaestor agent: its gas, the governors that name it, and the link its owner signs";
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "quaestor:whoami";

  async execute(io: CommandIO) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const address = agentAddress(this.ctx.walletStateManager);
      return await whoami(await quaestorContext(flags, address));
    } catch (err) {
      rethrow(err);
    }
  }
}
