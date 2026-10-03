import { createRequire as __cr } from 'node:module';
import { fileURLToPath as __fu } from 'node:url';
import { dirname as __dn } from 'node:path';
const require = __cr(import.meta.url);
const __filename = __fu(import.meta.url);
const __dirname = __dn(__filename);
import {
  agentAddress,
  check,
  common,
  flagsOf,
  quaestorContext,
  rethrow,
  settle
} from "../../lib/chunk-SROCC7SQ.js";

// src/commands/quaestor/check.ts
import { PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
var inputs = { network: common.network, rpc: common.rpc };
var QuaestorCheck = class extends PluginCommand {
  static description = "Settle a buy that was sent but not confirmed; run it before any new buy";
  static flags = schemaToFlags(inputs);
  pluginCommandId = "quaestor:check";
  async execute(io) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const address = agentAddress(this.ctx.walletStateManager);
      return settle(await check(await quaestorContext(flags, address)));
    } catch (err) {
      rethrow(err);
    }
  }
};
export {
  QuaestorCheck as default
};
