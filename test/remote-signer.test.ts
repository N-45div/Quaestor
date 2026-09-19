import { expect } from "chai";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { base58, type RemoteSigner } from "../solana/client";
import {
  DynamicOperatorSigner,
  dynamicOperatorFromEnv,
  fromBase58,
  type DynamicSvmClient,
} from "../solana/dynamic-signer";
import {
  SolanaStockExecutor,
  type JupiterQuote,
  type SolanaRouteBuilder,
  type StockTradeIntent,
} from "../stocks";

const MINT = "AAbNhnZQhWxU6mN3yBzJJ4NqJ4vPTh8VYs7v6a1pFAKE";
const USDC = "8HcqMLfakeusdcmint1111111111111111111111111";

/** Signs the way a co-signer would: shown the transaction, it returns 64 bytes and nothing else. */
const signatureOf = (tx: Transaction, key: Keypair): Uint8Array => {
  const copy = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  copy.partialSign(key);
  const pair = copy.signatures.find((entry) => entry.publicKey.equals(key.publicKey));
  return Uint8Array.from(pair?.signature as Buffer);
};

describe("an operator whose key is somewhere else", () => {
  const held = Keypair.generate(); // stands in for the key no process holds whole
  const payer = Keypair.generate();
  const owner = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();

  const intent: StockTradeIntent = {
    intentId: "intent-remote-1",
    agentId: "agent-1",
    operator: held.publicKey.toBase58(),
    instrumentMint: MINT,
    inputMint: USDC,
    amountInUsdc: 5_000_000n,
    minOutput: 1_400_000n,
    quoteId: "q1",
    quoteExpiresAt: 0,
    intentExpiresAt: 0,
    decisionRecordHash: `0x${"11".repeat(32)}`,
    decisionHash: `0x${"22".repeat(32)}`,
  };
  const quote = { quoteId: "q1", venue: "router-stub", inputMint: USDC, outputMint: MINT, inAmount: 5_000_000n, outAmount: 1_486_679n, minimumOutput: 1_400_000n, route: "stub", expiresAt: 0 } as JupiterQuote;
  const route: SolanaRouteBuilder = {
    venue: "router-stub",
    build: async () => ({ programId: Keypair.generate().publicKey, accounts: [], data: Buffer.from([1, 2, 3]) }),
  };
  const intentRecord = () => {
    const data = Buffer.alloc(185);
    data.writeBigUInt64LE(1_486_679n, 160);
    return { data, executable: false, lamports: 1, owner: PublicKey.default, rentEpoch: 0 };
  };

  const chain = () => {
    const sent: Buffer[] = [];
    return {
      sent,
      connection: {
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        sendRawTransaction: async (raw: Buffer) => { sent.push(raw); return "ignored"; },
        confirmTransaction: async () => ({ value: { err: null } }),
        getAccountInfo: async () => intentRecord(),
      },
    };
  };

  const executor = (connection: unknown, operator: RemoteSigner) => new SolanaStockExecutor({
    connection: connection as Connection,
    governorOwner: owner,
    vault: Keypair.generate().publicKey,
    operator,
    payer,
    cluster: "devnet",
    instruments: new Map([[MINT, { stockAccount: Keypair.generate().publicKey }]]),
    routes: new Map([["router-stub", route]]),
  });

  it("settles a trade the operator signed remotely, with every signature valid", async () => {
    const { sent, connection } = chain();
    const remote: RemoteSigner = { publicKey: held.publicKey, signTransaction: async (tx) => signatureOf(tx, held) };
    const result = await executor(connection, remote).execute(intent, quote);
    expect(result.outcome).to.equal("settled");
    expect(sent).to.have.length(1);
    const landed = Transaction.from(sent[0]);
    expect(landed.verifySignatures()).to.equal(true);
    expect(landed.signatures.map((entry) => entry.publicKey.toBase58())).to.include.members([
      payer.publicKey.toBase58(), held.publicKey.toBase58(),
    ]);
    // The id is still the fee payer's signature, so reconciliation is unchanged.
    expect(result.txSignature).to.equal(base58(landed.signature as Buffer));
  });

  it("shows the co-signer a transaction nobody could submit yet", async () => {
    const { connection } = chain();
    let payerHadSigned: boolean | undefined;
    const remote: RemoteSigner = {
      publicKey: held.publicKey,
      signTransaction: async (tx) => {
        const shown = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
        payerHadSigned = shown.signatures.some((entry) => entry.publicKey.equals(payer.publicKey) && entry.signature !== null);
        return signatureOf(tx, held);
      },
    };
    await executor(connection, remote).execute(intent, quote);
    expect(payerHadSigned).to.equal(false);
  });

  it("releases the trade when the co-signer refuses, and sends nothing", async () => {
    const { sent, connection } = chain();
    const remote: RemoteSigner = { publicKey: held.publicKey, signTransaction: async () => { throw new Error("policy says no"); } };
    const result = await executor(connection, remote).execute(intent, quote);
    expect(result).to.include({ outcome: "not-executed", txSignature: "not-submitted" });
    expect(sent).to.have.length(0);
  });

  it("does not send a transaction whose remote signature is for something else", async () => {
    const { sent, connection } = chain();
    // A genuine signature by the right key, over a different message.
    const other = new Transaction({ feePayer: held.publicKey, recentBlockhash: blockhash })
      .add(new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([9]) }));
    const remote: RemoteSigner = { publicKey: held.publicKey, signTransaction: async () => signatureOf(other, held) };
    const result = await executor(connection, remote).execute(intent, quote);
    expect(result).to.include({ outcome: "not-executed", txSignature: "not-submitted" });
    expect(sent).to.have.length(0);
  });

  it("does not take a short answer for a signature", async () => {
    const { sent, connection } = chain();
    const remote: RemoteSigner = { publicKey: held.publicKey, signTransaction: async () => new Uint8Array(32) };
    const result = await executor(connection, remote).execute(intent, quote);
    expect(result).to.include({ outcome: "not-executed", txSignature: "not-submitted" });
    expect(sent).to.have.length(0);
  });

  describe("through Dynamic", () => {
    const wallet = { walletMetadata: { accountAddress: held.publicKey.toBase58(), walletId: "w-1" }, externalServerKeyShares: [{ share: "one-of-two" }] };
    const tx = () => new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });

    const fake = (behaviour: { failFirst?: boolean; hang?: boolean; asObject?: boolean } = {}) => {
      const calls = { created: 0, signIns: 0, requests: [] as Array<Record<string, unknown>> };
      let failed = false;
      const client: DynamicSvmClient = {
        authenticateApiToken: async () => { calls.signIns += 1; },
        signTransaction: async (request) => {
          calls.requests.push(request as unknown as Record<string, unknown>);
          if (behaviour.hang) return new Promise<string>(() => undefined);
          if (behaviour.failFirst && !failed) { failed = true; throw new Error("401 session expired"); }
          const text = base58(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
          return behaviour.asObject ? { signature: text } : text;
        },
      };
      return { calls, createClient: () => { calls.created += 1; return client; } };
    };

    it("hands Dynamic the wallet, its share, the password and the cluster, and returns 64 bytes", async () => {
      const { calls, createClient } = fake();
      const signer = new DynamicOperatorSigner({ environmentId: "env", authToken: "token", wallet, password: "pw", createClient });
      const signature = await signer.signTransaction(tx());
      expect(signature).to.have.length(64);
      expect(signature[0]).to.equal(1);
      expect(signer.publicKey.toBase58()).to.equal(held.publicKey.toBase58());
      expect(calls.requests[0]).to.include({ password: "pw", chainId: "103" });
      expect(calls.requests[0].walletMetadata).to.equal(wallet.walletMetadata);
      expect(calls.requests[0].externalServerKeyShares).to.equal(wallet.externalServerKeyShares);
    });

    it("accepts the signature whether it comes bare or wrapped", async () => {
      const { createClient } = fake({ asObject: true });
      const signer = new DynamicOperatorSigner({ environmentId: "env", authToken: "token", wallet, createClient });
      expect(await signer.signTransaction(tx())).to.have.length(64);
    });

    it("signs in once for callers that arrive together, and again once the session is old", async () => {
      const { calls, createClient } = fake();
      let clock = 1_000_000;
      const signer = new DynamicOperatorSigner({ environmentId: "env", authToken: "token", wallet, createClient, sessionMs: 60_000, now: () => clock });
      await Promise.all([signer.signTransaction(tx()), signer.signTransaction(tx()), signer.warm()]);
      expect(calls.signIns).to.equal(1);
      clock += 61_000;
      await signer.signTransaction(tx());
      expect(calls.signIns).to.equal(2);
      expect(calls.created).to.equal(1);
    });

    it("signs in afresh and asks once more when a request fails", async () => {
      const { calls, createClient } = fake({ failFirst: true });
      const signer = new DynamicOperatorSigner({ environmentId: "env", authToken: "token", wallet, createClient });
      expect(await signer.signTransaction(tx())).to.have.length(64);
      expect(calls.signIns).to.equal(2);
      expect(calls.requests).to.have.length(2);
    });

    it("gives up on a co-signer that does not answer", async () => {
      const { createClient } = fake({ hang: true });
      const signer = new DynamicOperatorSigner({ environmentId: "env", authToken: "token", wallet, createClient, timeoutMs: 20 });
      await expect(signer.signTransaction(tx())).to.be.rejectedWith("timed out");
    });

    it("is off unless switched on, and refuses to be half configured", () => {
      const never = () => { throw new Error("the wallet file must not be read"); };
      expect(dynamicOperatorFromEnv(never, {})).to.equal(null);
      expect(() => dynamicOperatorFromEnv(never, { DYNAMIC_OPERATOR: "1" })).to.throw("DYNAMIC_ENVIRONMENT_ID");
      const on = { DYNAMIC_OPERATOR: "1", DYNAMIC_ENVIRONMENT_ID: "env", DYNAMIC_AUTH_TOKEN: "token" };
      expect(() => dynamicOperatorFromEnv(() => "{}", on)).to.throw("no account address");
      // Given inline, as a host gives it, the file is never looked for.
      const signer = dynamicOperatorFromEnv(never, { ...on, DYNAMIC_OPERATOR_WALLET: JSON.stringify(wallet) });
      expect(signer?.publicKey.toBase58()).to.equal(held.publicKey.toBase58());
    });

    it("reads base58 back into the bytes it was made from", () => {
      const bytes = Uint8Array.from([0, 0, 7, 255, 1, 128]);
      expect(Array.from(fromBase58(base58(bytes)))).to.deep.equal(Array.from(bytes));
      expect(() => fromBase58("0OIl")).to.throw("not base58");
    });
  });
});
