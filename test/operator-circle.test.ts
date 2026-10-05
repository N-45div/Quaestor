import { expect } from "chai";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import type { ethers } from "ethers";
import { CircleClient, CircleSender, type Fetch } from "../operator/circle";

/**
 * The operator's key held by Circle, against a stand-in for Circle's API: the entity secret is
 * encrypted to Circle's key afresh for every request and decrypts back to itself, the call goes
 * out as raw call data from the right wallet, and the sender returns the hash once it is mined,
 * or the reason Circle gives when it is not.
 */
describe("operator circle wallet", () => {
  const secret = "ab".repeat(32);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

  function circle(states: { state: string; txHash?: string; errorReason?: string }[]) {
    const seen: { method: string; path: string; body: Record<string, unknown> | null; auth: string }[] = [];
    const fetchFn: Fetch = async (url, init) => {
      const path = new URL(url).pathname;
      seen.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.authorization ?? "" });
      const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
      if (path === "/v1/w3s/config/entity/publicKey") return reply({ publicKey: pem });
      if (path === "/v1/w3s/wallets/w-1") return reply({ wallet: { id: "w-1", address: "0x00000000000000000000000000000000000000Aa", blockchain: "ARC-TESTNET", state: "LIVE" } });
      if (path === "/v1/w3s/developer/transactions/contractExecution") return reply({ id: "t-1", state: "INITIATED" });
      if (path === "/v1/w3s/transactions/t-1") return reply({ transaction: { id: "t-1", ...(states.shift() ?? { state: "SENT" }) } });
      return { ok: false, status: 404, json: async () => ({ code: 1, message: "not found" }) };
    };
    return { client: new CircleClient({ apiKey: "TEST_API_KEY:id:secret", entitySecret: secret, fetchFn }), seen };
  }
  const mined = { waitForTransaction: async () => ({ status: 1 }) } as unknown as ethers.Provider;
  const decrypt = (b64: string) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(b64, "base64")).toString("hex");

  it("encrypts the entity secret to Circle's key afresh for each request", async () => {
    const { client } = circle([]);
    const a = await client.ciphertext();
    const b = await client.ciphertext();
    expect(a).to.not.equal(b);
    expect(decrypt(a)).to.equal(secret);
    expect(decrypt(b)).to.equal(secret);
  });

  it("sends the governor call from the Circle wallet and returns the hash once mined", async () => {
    const { client, seen } = circle([{ state: "SENT" }, { state: "CONFIRMED", txHash: "0x" + "12".repeat(32) }]);
    const sender = await CircleSender.open(client, "w-1", "ARC-TESTNET", mined);
    expect(sender.address).to.equal("0x00000000000000000000000000000000000000Aa");
    (sender as unknown as { opts: { pollMs: number } }).opts.pollMs = 1;
    expect(await sender.send("0x00000000000000000000000000000000000000Bb", "0xabcdef", 120_000n)).to.equal("0x" + "12".repeat(32));
    const exec = seen.find((s) => s.path.endsWith("/contractExecution"))!;
    expect(exec.body).to.include({ walletId: "w-1", contractAddress: "0x00000000000000000000000000000000000000Bb", callData: "0xabcdef", feeLevel: "MEDIUM", gasLimit: "120000" });
    expect(exec.body!.idempotencyKey).to.match(/^[0-9a-f-]{36}$/);
    expect(decrypt(exec.body!.entitySecretCiphertext as string)).to.equal(secret);
    expect(exec.auth).to.equal("Bearer TEST_API_KEY:id:secret");
  });

  it("refuses a wallet on another chain, and reports the reason Circle gives for a failure", async () => {
    const { client } = circle([{ state: "FAILED", errorReason: "INSUFFICIENT_NATIVE_TOKEN" }]);
    let err: Error | null = null;
    try {
      await CircleSender.open(client, "w-1", "BASE-SEPOLIA", mined);
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).to.contain("on ARC-TESTNET, not BASE-SEPOLIA");
    const sender = new CircleSender(client, "w-1", "0xAa", mined, { pollMs: 1 });
    err = null;
    try {
      await sender.send("0xBb", "0x00", 1n);
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).to.contain("failed: INSUFFICIENT_NATIVE_TOKEN");
  });
});
