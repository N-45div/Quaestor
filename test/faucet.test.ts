import { expect } from "chai";
import express from "express";
import type { Server } from "node:http";
import { Connection, Keypair, PublicKey, SystemProgram, type Transaction } from "@solana/web3.js";
import { mountFaucet } from "../services/faucet";

/**
 * The devnet faucet: one claim per wallet per day, nothing for a wallet that
 * already holds a claim's worth, SOL only for a wallet short of it, and a
 * failed send gives the claim back.
 */
describe("faucet — test USDC for a new governor", () => {
  let server: Server;
  afterEach(() => server?.close());

  async function serve(state: { usdc: bigint; lamports: number; fail?: boolean }, clock = { t: 1_000_000 }) {
    const sent: Transaction[] = [];
    const conn = {
      getTokenAccountBalance: async () => ({ value: { amount: state.usdc.toString() } }),
      getBalance: async () => state.lamports,
    } as unknown as Connection;
    const app = express();
    mountFaucet(app, {
      conn,
      key: Keypair.generate(),
      usdcMint: new PublicKey("8HcqMLJJxoG3fAkgNk8Qm3Uv7oXhXLM8X5xE4FXZe3Cg"),
      usdcDecimals: 6,
      usdcPerClaim: 100_000_000n,
      solPerClaim: 20_000_000,
      now: () => clock.t,
      send: async (tx) => {
        if (state.fail) throw new Error("node refused");
        sent.push(tx);
        return "sig-" + sent.length;
      },
    });
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/stocks/faucet`;
    const claim = async (owner: string) => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { claim, sent, clock };
  }

  it("sends test USDC, and SOL only to a wallet short of it", async () => {
    const { claim, sent } = await serve({ usdc: 0n, lamports: 5_000_000 });
    const owner = Keypair.generate().publicKey.toBase58();
    const first = await claim(owner);
    expect(first.status).to.equal(200);
    expect(first.body).to.include({ signature: "sig-1", usdc: "100000000", lamports: 15_000_000 });
    const tx = sent[0];
    expect(tx.instructions).to.have.length(3); // create the account, transfer the USDC, top up the SOL
    expect(tx.instructions[2].programId.equals(SystemProgram.programId)).to.equal(true);
  });

  it("gives each wallet one claim a day, and none to a wallet that already holds one", async () => {
    const { claim, clock } = await serve({ usdc: 0n, lamports: 50_000_000 });
    const owner = Keypair.generate().publicKey.toBase58();
    expect((await claim(owner)).status).to.equal(200);
    const again = await claim(owner);
    expect(again.status).to.equal(429);
    expect(again.body.error.code).to.equal("ALREADY_CLAIMED");
    clock.t += 86_400_001;
    expect((await claim(owner)).status).to.equal(200);

    const rich = await serve({ usdc: 150_000_000n, lamports: 50_000_000 });
    const funded = await rich.claim(Keypair.generate().publicKey.toBase58());
    expect(funded.status).to.equal(409);
    expect(funded.body.error.code).to.equal("ALREADY_FUNDED");
  });

  it("refuses an address that is not a wallet, and gives the claim back when sending fails", async () => {
    const state = { usdc: 0n, lamports: 50_000_000, fail: true };
    const { claim } = await serve(state);
    expect((await claim("not-a-key")).body.error.code).to.equal("INVALID_OWNER");
    const pda = PublicKey.findProgramAddressSync([Buffer.from("governor")], SystemProgram.programId)[0].toBase58();
    expect((await claim(pda)).body.error.message).to.contain("not a program address");
    const owner = Keypair.generate().publicKey.toBase58();
    expect((await claim(owner)).status).to.equal(502);
    state.fail = false;
    expect((await claim(owner)).status).to.equal(200);
  });
});
