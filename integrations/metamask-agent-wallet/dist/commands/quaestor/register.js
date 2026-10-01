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
  registerUrl,
  rethrow,
  settingsFrom
} from "../../lib/chunk-5BDKBPEE.js";

// src/commands/quaestor/register.ts
import { InputFieldType, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
var text = (flag, message) => ({ type: InputFieldType.Text, flag, message, required: false, prompt: false });
var inputs = {
  budget: text("budget", "The dollar the governor holds, such as tUSDC"),
  deposit: text("deposit", "Dollars the owner deposits"),
  "per-trade": text("per-trade", "Most one trade may spend"),
  "epoch-cap": text("epoch-cap", "Most spent per epoch"),
  epoch: text("epoch", "hour, day or week"),
  stocks: text("stocks", "Tokens the agent may buy, such as tTSLA,tETH"),
  limit: text("limit", "Most the owner pays per token, such as tTSLA=400"),
  network: common.network
};
var QuaestorRegister = class extends PluginCommand {
  static description = "The link the owner opens to fund a Quaestor governor that names this wallet as its agent";
  static examples = ["mm quaestor register --deposit 20 --per-trade 5 --epoch-cap 10 --epoch day --stocks tTSLA --limit tTSLA=400"];
  static flags = schemaToFlags(inputs);
  pluginCommandId = "quaestor:register";
  async execute(io) {
    try {
      const flags = flagsOf(await io.resolveInputs(inputs));
      const operator = agentAddress(this.ctx.walletStateManager);
      const s = settingsFrom(flags);
      return {
        ok: true,
        network: s.network.name,
        operator,
        registerUrl: registerUrl(s, operator, flags),
        next: "Send the owner this link. They check every number and sign once in their own wallet; the governor holds the money, this wallet only signs trades and pays gas."
      };
    } catch (err) {
      rethrow(err);
    }
  }
};
export {
  QuaestorRegister as default
};
