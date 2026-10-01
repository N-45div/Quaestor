/**
 * What every `mm quaestor` command shares: the agent wallet's address, the chain, and how a
 * Quaestor result becomes an mm result.
 *
 * The MetaMask Agent Wallet is the agent's key. The money is not in it: it sits in a Quaestor
 * governor the owner funded, which pays only for approved stocks, through approved venues,
 * inside the owner's caps and limit prices, and measures what came back. The wallet holds gas.
 */
import * as os from "node:os";
import * as path from "node:path";
import { ethers } from "ethers";
import { CommandError, InputFieldType, type InputSchema } from "@metamask/agent-wallet/plugin";
import { contextFor, type Context } from "../../../cli/quaestor-evm";

type Result = Record<string, unknown>;

/** Monad testnet, where Quaestor's governor buys on Kuru; `--network` picks another table row. */
export const DEFAULT_NETWORK = "monad-testnet";

export const common = {
  network: { type: InputFieldType.Text, flag: "network", message: "Quaestor network: monad-testnet, robinhood-testnet or robinhood", required: false, prompt: false },
  rpc: { type: InputFieldType.Text, flag: "rpc", message: "RPC for reads (default: the network's public one)", required: false, prompt: false },
  governor: { type: InputFieldType.Text, flag: "governor", message: "Governor address, when more than one names this wallet", required: false, prompt: false },
} satisfies InputSchema;

/** Flags as the Quaestor command reads them: strings, set ones only. */
export function flagsOf(resolved: Record<string, unknown>): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolved)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    flags[k] = v === true ? "true" : String(v);
  }
  flags.network ??= DEFAULT_NETWORK;
  return flags;
}

interface WalletState {
  selectedWallet?: { namespace?: string; ref?: Record<string, unknown> };
  byokWallets?: Record<string, unknown>[];
  remoteWallets?: Record<string, unknown>[];
}

/**
 * The selected EVM wallet's address, read from the host's wallet snapshot (wallet-read).
 * It is the governor's operator: the only key the governor takes trades from.
 */
export function agentAddress(walletStateManager: { read(): unknown }): string {
  const state = walletStateManager.read() as WalletState;
  const evm = [...(state.byokWallets ?? []), ...(state.remoteWallets ?? [])].filter((w) => typeof w.address === "string" && ethers.isAddress(w.address));
  const ref = state.selectedWallet?.ref;
  const selected = ref ? evm.find((w) => Object.entries(ref).every(([k, v]) => w[k] === undefined || w[k] === v)) : undefined;
  const wallet = selected ?? (evm.length === 1 ? evm[0] : undefined);
  if (!wallet) throw new CommandError("WALLET_NOT_FOUND", "No EVM wallet is selected in MetaMask Agent Wallet.", "Run `mm wallet list`, then `mm wallet select`.");
  return ethers.getAddress(wallet.address as string);
}

/**
 * A read-only Quaestor context for this wallet. Buys are signed by MetaMask, not by a key file;
 * the folder only keeps the record of a buy that is still settling, one per wallet.
 */
export async function quaestorContext(flags: Record<string, string>, address?: string): Promise<Context> {
  const folder = path.join(os.homedir(), ".quaestor", "metamask", (address ?? "anyone").toLowerCase());
  const ctx = await contextFor({ ...flags, "key-file": path.join(folder, "operator") }, false);
  return { ...ctx, address };
}

/** A Quaestor result as mm shows it: refusals and failures are errors with the governor's reason. */
export function settle(out: Result): Result {
  if (out.ok) return out;
  // Sent but not settled: not a failure, and the next step is `mm quaestor check`.
  if (out.error === "UNCONFIRMED") return out;
  if (out.refused) throw new CommandError(String(out.refused), String(out.detail ?? out.refused), String(out.meaning ?? "Nothing was spent. Run `mm quaestor status` to see the owner's limits."));
  throw new CommandError(String(out.error ?? "FAILED"), String(out.message ?? "Quaestor could not finish this command."), "Run `mm quaestor status` to see the governor's state.");
}

/** Errors from the Quaestor command (CliError) shown with their own codes. */
export function rethrow(err: unknown): never {
  if (err instanceof CommandError) throw err;
  const e = err as { code?: string; message?: string; shortMessage?: string };
  throw new CommandError(e.code && /^[A-Za-z_]+$/.test(e.code) ? e.code : "FAILED", (e.shortMessage ?? e.message ?? String(err)).slice(0, 300), "Run `mm quaestor status`, or pass --rpc if the network's RPC is not answering.");
}
