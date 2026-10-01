import { createRequire as __cr } from 'node:module';
import { fileURLToPath as __fu } from 'node:url';
import { dirname as __dn } from 'node:path';
const require = __cr(import.meta.url);
const __filename = __fu(import.meta.url);
const __dirname = __dn(__filename);
import {
  agentAddress,
  common,
  flagsOf,
  quaestorContext,
  rethrow,
  status
} from "../../lib/chunk-5BDKBPEE.js";

// src/commands/quaestor/status.ts
import { PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
var inputs = { ...common };
var QuaestorStatus = class extends PluginCommand {
  static description = "Read this wallet's Quaestor governor: budget, caps, what is left this epoch, approved tokens and limits";
  static flags = schemaToFlags(inputs);
  pluginCommandId = "quaestor:status";
  async execute(io) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const address = agentAddress(this.ctx.walletStateManager);
      return await status(await quaestorContext(flags, address), flags, address);
    } catch (err) {
      rethrow(err);
    }
  }
};
export {
  QuaestorStatus as default
};
