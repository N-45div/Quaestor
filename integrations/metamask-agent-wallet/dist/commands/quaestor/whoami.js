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
  whoami
} from "../../lib/chunk-5BDKBPEE.js";

// src/commands/quaestor/whoami.ts
import { PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
var inputs = { ...common };
var QuaestorWhoami = class extends PluginCommand {
  static description = "This wallet as a Quaestor agent: its gas, the governors that name it, and the link its owner signs";
  static flags = schemaToFlags(inputs);
  pluginCommandId = "quaestor:whoami";
  async execute(io) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const address = agentAddress(this.ctx.walletStateManager);
      return await whoami(await quaestorContext(flags, address));
    } catch (err) {
      rethrow(err);
    }
  }
};
export {
  QuaestorWhoami as default
};
