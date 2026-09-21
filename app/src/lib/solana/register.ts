import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { DEVNET } from "./devnet";
import {
  approveInstrument,
  approveRouter,
  depositUsdc,
  governorPda,
  initializeGovernor,
  positionAuthorityPda,
} from "./program";

/**
 * A governor of one's own, opened in one transaction the owner signs once:
 * create it with the agent's key as operator and the owner's caps, allow the
 * Meteora curve as its venue and the curve's token as its instrument, open
 * the account bought tokens land in, and deposit the test USDC it trades
 * with. Solana runs the five as a unit: all of them, or none.
 */

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** The associated token account of an owner for a mint; the owner may be a program address. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Create that account if it does not exist yet; a no-op if it does. */
export function createAssociatedTokenAccountIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** Where a governor's curve tokens land: derivable, so an agent can find it without being told. */
export function curvePosition(governor: PublicKey): PublicKey {
  const [authority] = positionAuthorityPda(governor, new PublicKey(DEVNET.curveMint));
  return associatedTokenAddress(authority, new PublicKey(DEVNET.curveMint));
}

export interface RegisterInput {
  owner: PublicKey;
  operator: PublicKey;
  /** Test USDC, in base units. */
  deposit: bigint;
  perTradeCap: bigint;
  epochCap: bigint;
  epochSeconds: bigint;
}

export function buildRegisterTransaction(input: RegisterInput): { transaction: Transaction; vault: Keypair; governor: PublicKey } {
  const usdcMint = new PublicKey(DEVNET.usdcMint);
  const curveMint = new PublicKey(DEVNET.curveMint);
  const [governor] = governorPda(input.owner);
  const [positionAuthority] = positionAuthorityPda(governor, curveMint);
  // The vault has no seeds; the program creates it from a fresh keypair,
  // which signs its own creation and is never needed again.
  const vault = Keypair.generate();
  const transaction = new Transaction().add(
    initializeGovernor({
      owner: input.owner,
      operator: input.operator,
      usdcMint,
      vault: vault.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      epochCap: input.epochCap,
      perTradeCap: input.perTradeCap,
      epochLength: input.epochSeconds,
    }),
    approveRouter(input.owner, new PublicKey(DEVNET.dbcProgram), "meteora-dbc"),
    approveInstrument(input.owner, curveMint),
    createAssociatedTokenAccountIdempotent(input.owner, positionAuthority, curveMint),
  );
  if (input.deposit > 0n) {
    transaction.add(depositUsdc({
      depositor: input.owner,
      governorOwner: input.owner,
      vault: vault.publicKey,
      depositorUsdc: associatedTokenAddress(input.owner, usdcMint),
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      amount: input.deposit,
    }));
  }
  return { transaction, vault, governor };
}

/** One wallet owns at most one governor, at an address its key decides. */
export async function existingGovernor(conn: Connection, owner: PublicKey): Promise<PublicKey | null> {
  const [governor] = governorPda(owner);
  return (await conn.getAccountInfo(governor, "confirmed")) ? governor : null;
}

/** Test USDC and SOL the owner's wallet holds, for the deposit and the fees. */
export async function ownerFunds(conn: Connection, owner: PublicKey): Promise<{ usdc: bigint; lamports: number }> {
  const [lamports, usdc] = await Promise.all([
    conn.getBalance(owner, "confirmed"),
    conn.getTokenAccountBalance(associatedTokenAddress(owner, new PublicKey(DEVNET.usdcMint)), "confirmed")
      .then((b) => BigInt(b.value.amount))
      .catch(() => 0n),
  ]);
  return { usdc, lamports };
}
