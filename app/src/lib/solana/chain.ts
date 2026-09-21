import { Connection, PublicKey, type GetProgramAccountsFilter } from "@solana/web3.js";
import {
  STOCKS_PROGRAM_ID,
  accountDiscriminator,
  base58,
  decodeGovernor,
  decodeIntentRecord,
  positionAuthorityPda,
  type GovernorState,
} from "./program";

/**
 * Everything the Solana explorer shows, read straight from the program's
 * accounts on devnet. There is no indexer between the page and the chain:
 * one scan finds every governor, one finds every settled trade.
 */

/** Account sizes the program allocates, which the scans filter on. */
const SIZE = { Governor: 179, IntentRecord: 185, ApprovedInstrument: 73, ApprovedRouter: 89 } as const;

export interface GovernorView extends GovernorState {
  address: string;
  /** Test USDC in the vault, in base units; null if the vault could not be read. */
  vaultBalance: bigint | null;
}

export interface TradeView {
  address: string;
  governor: string;
  intentId: string;
  decisionHash: string;
  decisionRecordHash: string;
  amountAuthorized: bigint;
  amountSpent: bigint;
  minOutput: bigint;
  actualOutput: bigint;
  epoch: bigint;
  /** When the program recorded it, in milliseconds. */
  settledAt: number;
}

export interface ApprovalsView {
  instruments: string[];
  venues: { program: string; label: string }[];
}

export interface PositionView {
  mint: string;
  account: string;
  amount: bigint;
  decimals: number;
}

const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

function scan(conn: Connection, account: keyof typeof SIZE, governorAt8?: PublicKey) {
  const filters: GetProgramAccountsFilter[] = [
    { dataSize: SIZE[account] },
    { memcmp: { offset: 0, bytes: base58(accountDiscriminator(account)) } },
  ];
  if (governorAt8) filters.push({ memcmp: { offset: 8, bytes: governorAt8.toBase58() } });
  return conn.getProgramAccounts(STOCKS_PROGRAM_ID, { commitment: "confirmed", filters });
}

/** A token account's amount: the u64 at byte 64, the same in SPL Token and Token-2022. */
function tokenAmount(data: Uint8Array | undefined): bigint | null {
  if (!data || data.length < 72) return null;
  return new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true);
}

/** Every governor on the program, with what its vault holds. */
export async function readGovernors(conn: Connection): Promise<GovernorView[]> {
  const accounts = await scan(conn, "Governor");
  const governors = accounts.map(({ pubkey, account }) => ({ address: pubkey.toBase58(), ...decodeGovernor(account.data) }));
  const vaults = governors.length ? await conn.getMultipleAccountsInfo(governors.map((g) => g.vault), "confirmed") : [];
  return governors.map((g, i) => ({ ...g, vaultBalance: tokenAmount(vaults[i]?.data) }));
}

/** Every settled trade, newest first; or one governor's, when named. */
export async function readTrades(conn: Connection, governor?: PublicKey): Promise<TradeView[]> {
  const accounts = await scan(conn, "IntentRecord", governor);
  return accounts
    .map(({ pubkey, account }) => {
      const r = decodeIntentRecord(account.data);
      return {
        address: pubkey.toBase58(),
        governor: r.governor.toBase58(),
        intentId: hex(r.intentId),
        decisionHash: hex(r.decisionHash),
        decisionRecordHash: hex(r.decisionRecordHash),
        amountAuthorized: r.amountAuthorized,
        amountSpent: r.amountSpent,
        minOutput: r.minOutput,
        actualOutput: r.actualOutput,
        epoch: r.epoch,
        settledAt: Number(r.settledAt) * 1000,
      };
    })
    .sort((a, b) => b.settledAt - a.settledAt);
}

/** What one governor's owner has allowed: which tokens, through which venues. */
export async function readApprovals(conn: Connection, governor: PublicKey): Promise<ApprovalsView> {
  const [instruments, routers] = await Promise.all([scan(conn, "ApprovedInstrument", governor), scan(conn, "ApprovedRouter", governor)]);
  return {
    instruments: instruments.map(({ account }) => new PublicKey(account.data.subarray(40, 72)).toBase58()),
    venues: routers.map(({ account }) => ({
      program: new PublicKey(account.data.subarray(40, 72)).toBase58(),
      label: new TextDecoder().decode(account.data.subarray(72, 88)).replace(/\0+$/, ""),
    })),
  };
}

/**
 * What the governor has bought: for each allowed token, the account its
 * position authority owns. Bought tokens stay there; the program has no
 * instruction that moves them out.
 */
export async function readPositions(conn: Connection, governor: PublicKey, mints: string[]): Promise<PositionView[]> {
  const out: PositionView[] = [];
  for (const mint of mints) {
    const [authority] = positionAuthorityPda(governor, new PublicKey(mint));
    const owned = await conn.getParsedTokenAccountsByOwner(authority, { mint: new PublicKey(mint) }, "confirmed");
    for (const { pubkey, account } of owned.value) {
      const info = (account.data as { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } }).parsed?.info?.tokenAmount;
      if (info) out.push({ mint, account: pubkey.toBase58(), amount: BigInt(info.amount), decimals: info.decimals });
    }
  }
  return out;
}

/** An amount in base units as a decimal string, without floating point. */
export function units(amount: bigint | null, decimals: number, digits = decimals): string {
  if (amount === null) return "—";
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export const shortKey = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;
