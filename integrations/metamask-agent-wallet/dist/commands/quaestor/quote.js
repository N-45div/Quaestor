import { createRequire as __cr } from 'node:module';
import { fileURLToPath as __fu } from 'node:url';
import { dirname as __dn } from 'node:path';
const require = __cr(import.meta.url);
const __filename = __fu(import.meta.url);
const __dirname = __dn(__filename);
import {
  budgetAmountOf,
  budgetNetwork,
  common,
  flagsOf,
  instrumentFlag,
  instrumentOf,
  quaestorContext,
  quote,
  rethrow,
  slippageOf
} from "../../lib/chunk-SROCC7SQ.js";

// src/commands/quaestor/quote.ts
import { InputFieldType, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
var inputs = {
  stock: { type: InputFieldType.Text, flag: "stock", message: "Token to price, such as tTSLA", required: true, prompt: false, index: 0 },
  amount: { type: InputFieldType.Text, flag: "amount", message: "Dollars to spend, such as 2", required: true, prompt: false, index: 1 },
  budget: { type: InputFieldType.Text, flag: "budget", message: "The dollar, when the chain has several", required: false, prompt: false },
  slippage: { type: InputFieldType.Text, flag: "slippage", message: "Floor below the quote, in basis points (default 100)", required: false, prompt: false },
  network: common.network,
  rpc: common.rpc
};
var QuaestorQuote = class extends PluginCommand {
  static description = "Price a buy on the governor's venue against Chainlink, before anything is signed";
  static examples = ["mm quaestor quote tTSLA 2"];
  // A read of public chain state: no sign-in, no wallet.
  static requiresAuth = false;
  static requiresInit = false;
  static flags = schemaToFlags(inputs);
  static args = schemaToArgs(inputs);
  pluginCommandId = "quaestor:quote";
  async execute(io) {
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
};
export {
  QuaestorQuote as default
};
