import { type CommandIO, type InputSchema, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { check } from "../../../../../cli/quaestor-evm";
import { agentAddress, common, flagsOf, quaestorContext, rethrow, settle } from "../../quaestor";

const inputs = { network: common.network, rpc: common.rpc } satisfies InputSchema;

export default class QuaestorCheck extends PluginCommand<Record<string, unknown>> {
  static override description = "Settle a buy that was sent but not confirmed; run it before any new buy";
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "quaestor:check";

  async execute(io: CommandIO) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const address = agentAddress(this.ctx.walletStateManager);
      return settle(await check(await quaestorContext(flags, address)));
    } catch (err) {
      rethrow(err);
    }
  }
}
