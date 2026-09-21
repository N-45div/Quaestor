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
import { DEVNET, VENUE_NAMES } from "./devnet";

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

/** The token a trade delivered. */
export interface TradeToken {
  mint: string;
  decimals: number;
}

/** What a trade's transaction shows that its record does not. */
export interface TradeTx {
  signature: string;
  /** The token that arrived, with its decimals; null if no account grew by exactly the recorded output. */
  mint: string | null;
  decimals: number | null;
  /** The venue program the trade went through, when this deployment knows it. */
  venue: string | null;
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

const tradeTxs = new Map<string, Promise<TradeTx | null>>();

/**
 * The transaction that settled a trade. An IntentRecord names its governor
 * and the amounts but not the token or the venue; the transaction that wrote
 * it shows both. A record is written once, by its trade, so the oldest
 * successful signature on it is that trade. The token is the one whose
 * account grew by exactly the recorded output. Records never change, so each
 * answer is kept for the life of the page; a failed read is not, and is tried
 * again next time.
 */
export function readTradeTx(conn: Connection, trade: Pick<TradeView, "address" | "actualOutput">): Promise<TradeTx | null> {
  const known = tradeTxs.get(trade.address);
  if (known) return known;
  const read = (async (): Promise<TradeTx | null> => {
    const signatures = await conn.getSignaturesForAddress(new PublicKey(trade.address), { limit: 1000 }, "confirmed");
    const first = signatures.filter((s) => !s.err).pop();
    if (!first) return null;
    const tx = await conn.getTransaction(first.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return { signature: first.signature, mint: null, decimals: null, venue: null };
    const before = new Map((tx.meta.preTokenBalances ?? []).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
    const grew = (tx.meta.postTokenBalances ?? []).find((b) =>
      b.mint !== DEVNET.usdcMint && BigInt(b.uiTokenAmount.amount) - (before.get(b.accountIndex) ?? 0n) === trade.actualOutput);
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
    const venue = keys.keySegments().flat().map((k) => k.toBase58()).find((k) => k in VENUE_NAMES) ?? null;
    return { signature: first.signature, mint: grew?.mint ?? null, decimals: grew?.uiTokenAmount.decimals ?? null, venue };
  })();
  tradeTxs.set(trade.address, read);
  read.catch(() => tradeTxs.delete(trade.address));
  return read;
}

type ParsedTokenAccount = { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } };

/**
 * The token each trade delivered, keyed by record, for labelling tables.
 * Every trade credits its governor's position account for its token in the
 * block its settledAt comes from, so the block times of the signatures on each
 * position account name the token of each trade settled then. That is a few
 * reads for each governor and token, however many trades there are; reading
 * every trade's own transaction is two reads a trade, which the public
 * endpoint throttles. A trade the positions do not account for (two tokens
 * credited in one second, or a token not in `mints`) falls back to its own
 * transaction, a few at a time. A trade's own page reads its transaction.
 */
export async function readTradeTokens(conn: Connection, trades: TradeView[], mints: string[], fallbacks = 3): Promise<Record<string, TradeToken>> {
  const credited = new Map<string, Map<number, TradeToken[]>>();
  for (const governor of new Set(trades.map((t) => t.governor))) {
    const at = new Map<number, TradeToken[]>();
    for (const mint of mints) {
      const [authority] = positionAuthorityPda(new PublicKey(governor), new PublicKey(mint));
      const owned = await conn.getParsedTokenAccountsByOwner(authority, { mint: new PublicKey(mint) }, "confirmed");
      for (const { pubkey, account } of owned.value) {
        const decimals = (account.data as ParsedTokenAccount).parsed?.info?.tokenAmount?.decimals;
        if (decimals === undefined) continue;
        for (const s of await conn.getSignaturesForAddress(pubkey, { limit: 1000 }, "confirmed")) {
          if (s.err || !s.blockTime) continue;
          const tokens = at.get(s.blockTime) ?? [];
          if (!tokens.some((x) => x.mint === mint)) tokens.push({ mint, decimals });
          at.set(s.blockTime, tokens);
        }
      }
    }
    credited.set(governor, at);
  }
  const out: Record<string, TradeToken> = {};
  const unmatched: TradeView[] = [];
  for (const t of trades) {
    const tokens = credited.get(t.governor)?.get(Math.floor(t.settledAt / 1000));
    if (tokens?.length === 1) out[t.address] = tokens[0];
    else unmatched.push(t);
  }
  for (const t of unmatched.slice(0, fallbacks)) {
    const tx = await readTradeTx(conn, t).catch(() => null);
    if (tx?.mint && tx.decimals !== null) out[t.address] = { mint: tx.mint, decimals: tx.decimals };
  }
  return out;
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
      const info = (account.data as ParsedTokenAccount).parsed?.info?.tokenAmount;
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
