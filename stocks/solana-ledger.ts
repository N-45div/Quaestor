/**
 * What the chain remembers, for a hub that has forgotten.
 *
 * The hub keeps its orders, its spend and its holdings in memory, so a restart
 * loses them. The caps are safe either way — the program enforces its own — but
 * the hub's *answers* are not: a fresh process reports zero spent and a vault
 * balance it was configured with rather than one it owns, so a preview says a
 * trade is affordable that the chain will refuse, and a portfolio shows nothing
 * of what the agent actually holds.
 *
 * None of that needs a database, because the governor already writes the facts
 * down. This reads them back:
 *
 *   state()      the governor account, the vault's balance and every position's
 *                — what the policy really stands at right now
 *   trades()     every `IntentRecord` the program has written for this governor,
 *                which is one per settled trade and cannot be written twice
 *   tradeFor()   one intent by the id the agent used, hashed the same way the
 *                program hashed it
 *
 * What the chain does not hold is the off-chain half: which agent asked, what
 * the model said, which quote it took. Only the *hash* of the decision record
 * is on chain. So a restarted hub can prove what happened and cannot reconstruct
 * why, and it says so rather than inventing the difference.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  accountDiscriminator,
  base58,
  fetchGovernor,
  governorPda,
  id32,
  intentPda,
  STOCKS_PROGRAM_ID,
} from "../solana/client";

/** 8 discriminator + governor + three hashes + four amounts + two timestamps + bump. */
export const INTENT_RECORD_SPACE = 8 + 32 + 32 * 3 + 8 * 4 + 8 * 2 + 1;

export interface ChainHolding {
  mint: string;
  /** Raw base units, as the token account holds them. */
  amount: bigint;
  account: string;
}

export interface ChainGovernorState {
  governor: string;
  owner: string;
  operator: string;
  vault: string;
  usdcMint: string;
  epochCapUsdc: bigint;
  perTradeCapUsdc: bigint;
  epochLengthSeconds: number;
  /** The epoch the chain is in now, not the one the governor account last wrote. */
  epoch: number;
  /** Zero once the epoch has rolled: the program resets on the next trade. */
  spentInEpoch: bigint;
  suspended: boolean;
  vaultUsdc: bigint;
  holdings: ChainHolding[];
  observedAt: number;
}

export interface ChainTrade {
  /** The record's own address, which anyone can open. */
  record: string;
  /** sha256 of the agent's intent id: the program never sees the id itself. */
  intent_hash: string;
  decision_hash: string;
  decision_record_hash: string;
  amount_authorized: string;
  amount_spent: string;
  min_output: string;
  actual_output: string;
  epoch: number;
  settled_at: string;
}

export interface SolanaLedgerConfig {
  connection: Connection;
  /** The owner whose governor PDA this is. */
  governorOwner: PublicKey;
  vault: PublicKey;
  /** Where each instrument's position is held, and under which token program. */
  positions: ReadonlyMap<string, { stockAccount: PublicKey; tokenProgram?: PublicKey }>;
  programId?: PublicKey;
  now?: () => number;
}

const hex = (bytes: Buffer): string => `0x${bytes.toString("hex")}`;

export class SolanaChainLedger {
  private readonly governor: PublicKey;
  private readonly now: () => number;

  constructor(private readonly cfg: SolanaLedgerConfig) {
    this.governor = governorPda(cfg.governorOwner)[0];
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get governorAddress(): string {
    return this.governor.toBase58();
  }

  /** The policy and the balances, as the chain holds them. Throws if it cannot be read. */
  async state(): Promise<ChainGovernorState> {
    const governor = await fetchGovernor(this.cfg.connection, this.governor);
    const epochLength = Number(governor.epochLength);
    if (!(epochLength > 0)) throw new Error("the governor's epoch length is not a positive number of seconds");
    const now = this.now();
    const epoch = Math.floor(now / epochLength);
    const vault = await getAccount(this.cfg.connection, this.cfg.vault, "confirmed", TOKEN_PROGRAM_ID);

    const holdings: ChainHolding[] = [];
    for (const [mint, position] of this.cfg.positions) {
      // Each position account is read under its own token program: the devnet
      // test mint is Token-2022 and the curve's is classic SPL.
      const account = await getAccount(
        this.cfg.connection,
        position.stockAccount,
        "confirmed",
        position.tokenProgram ?? (await this.tokenProgramOf(position.stockAccount)),
      );
      holdings.push({ mint, amount: account.amount, account: position.stockAccount.toBase58() });
    }

    return {
      governor: this.governor.toBase58(),
      owner: governor.owner.toBase58(),
      operator: governor.operator.toBase58(),
      vault: this.cfg.vault.toBase58(),
      usdcMint: governor.usdcMint.toBase58(),
      epochCapUsdc: governor.epochCap,
      perTradeCapUsdc: governor.perTradeCap,
      epochLengthSeconds: epochLength,
      epoch,
      // The account keeps the last epoch it was written in. Reading its spend
      // into a later epoch would carry a stale number into a fresh budget.
      spentInEpoch: Number(governor.currentEpoch) === epoch ? governor.spentInEpoch : 0n,
      suspended: governor.suspended,
      vaultUsdc: vault.amount,
      holdings,
      observedAt: now,
    };
  }

  /** Which token program owns an account, for a position whose mint was not declared. */
  private async tokenProgramOf(account: PublicKey): Promise<PublicKey> {
    const info = await this.cfg.connection.getAccountInfo(account, "confirmed");
    if (!info) throw new Error(`position account ${account.toBase58()} does not exist`);
    return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  }

  /**
   * Every settled trade this governor has made, newest first.
   *
   * One account per intent, created by the trade itself, so this is the
   * complete list and a replay cannot add a second entry to it.
   */
  async trades(limit = 100): Promise<ChainTrade[]> {
    const accounts = await this.cfg.connection.getProgramAccounts(this.cfg.programId ?? STOCKS_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [
        { dataSize: INTENT_RECORD_SPACE },
        { memcmp: { offset: 0, bytes: base58(accountDiscriminator("IntentRecord")) } },
        { memcmp: { offset: 8, bytes: this.governor.toBase58() } },
      ],
    });
    return accounts
      .map(({ pubkey, account }) => decodeTrade(pubkey, account.data))
      .sort((a, b) => b.settled_at.localeCompare(a.settled_at))
      .slice(0, Math.max(1, limit));
  }

  /** One trade, by the intent id the agent used. Null if that intent never settled. */
  async tradeFor(intentId: string): Promise<ChainTrade | null> {
    const [record] = intentPda(this.governor, id32(intentId));
    const info = await this.cfg.connection.getAccountInfo(record, "confirmed");
    return info ? decodeTrade(record, info.data) : null;
  }
}

function decodeTrade(address: PublicKey, data: Buffer): ChainTrade {
  if (data.length < INTENT_RECORD_SPACE) throw new Error("intent record is shorter than its layout");
  let o = 8 + 32;
  const hash = () => hex(Buffer.from(data.subarray(o, (o += 32))));
  const num = () => data.readBigUInt64LE(((o += 8), o - 8));
  const snum = () => data.readBigInt64LE(((o += 8), o - 8));
  const intent_hash = hash();
  const decision_hash = hash();
  const decision_record_hash = hash();
  const amount_authorized = num();
  const amount_spent = num();
  const min_output = num();
  const actual_output = num();
  const epoch = Number(snum());
  const settledAt = Number(snum());
  return {
    record: address.toBase58(),
    intent_hash,
    decision_hash,
    decision_record_hash,
    amount_authorized: amount_authorized.toString(),
    amount_spent: amount_spent.toString(),
    min_output: min_output.toString(),
    actual_output: actual_output.toString(),
    epoch,
    settled_at: new Date(settledAt * 1000).toISOString(),
  };
}
