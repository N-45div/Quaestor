import { expect } from "chai";
import { ethers } from "ethers";
import { DynamicEvmSigner, dynamicEvmSignerFromEnv, type DynamicEvmClient, type DynamicEvmTransaction } from "../sdk/dynamic-evm-signer";

/**
 * The EVM agent's Dynamic MPC key, with Dynamic stood in by a local key: the transaction handed to
 * Dynamic is the one ethers populated, the signed bytes recover to the wallet's address (and are
 * refused when they do not), a lapsed session is renewed once, and an environment that names a
 * wallet without Dynamic's settings is an error, not a quiet fallback.
 */
describe("Dynamic EVM signer", () => {
  const key = ethers.Wallet.createRandom();
  const wallet = { walletMetadata: { accountAddress: key.address, walletId: "w-1" }, externalServerKeyShares: [{ share: "s" }] };

  function fake(opts: { signer?: ethers.BaseWallet; failFirst?: boolean } = {}) {
    const seen: { tx: DynamicEvmTransaction; password?: string; shares?: unknown[] }[] = [];
    let signIns = 0;
    let fails = opts.failFirst ? 1 : 0;
    const client: DynamicEvmClient = {
      authenticateApiToken: async () => { signIns += 1; },
      signTransaction: async ({ transaction, password, externalServerKeyShares }) => {
        seen.push({ tx: transaction, password, shares: externalServerKeyShares });
        if (fails-- > 0) throw new Error("session expired");
        const t = ethers.Transaction.from({ ...transaction, type: 2, gasLimit: transaction.gas });
        t.signature = (opts.signer ?? key).signingKey.sign(t.unsignedHash);
        return t.serialized;
      },
      signMessage: async ({ message }) => key.signMessage(message),
      signTypedData: async () => "0x",
    };
    return { client, seen, signIns: () => signIns };
  }

  const provider = {
    getNetwork: async () => new ethers.Network("monad-testnet", 10143n),
    getTransactionCount: async () => 7,
    estimateGas: async () => 21_000n,
    getFeeData: async () => new ethers.FeeData(null, 60_000_000_000n, 2_000_000_000n),
    resolveName: async (n: string) => n,
  } as unknown as ethers.Provider;

  it("hands Dynamic the transaction ethers populated, and returns bytes that recover to the wallet", async () => {
    const f = fake();
    const signer = new DynamicEvmSigner({ environmentId: "env", authToken: "tok", wallet, password: "pw", createClient: () => f.client }, provider);
    const raw = await signer.signTransaction({ to: "0x00000000000000000000000000000000000000bb", data: "0xabcdef", gasLimit: 120_000n, maxFeePerGas: 70_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
    expect(ethers.Transaction.from(raw).from).to.equal(key.address);
    expect(f.seen[0].tx).to.deep.include({ chainId: 10143, type: "eip1559", to: ethers.getAddress("0x00000000000000000000000000000000000000bb"), data: "0xabcdef", nonce: 7, gas: 120_000n, value: 0n });
    expect(f.seen[0]).to.include({ password: "pw" });
    expect(f.seen[0].shares).to.deep.equal([{ share: "s" }]);
    expect(await signer.signMessage("hello")).to.equal(await key.signMessage("hello"));
  });

  it("refuses a signature from another key, and renews a lapsed session once", async () => {
    const wrong = fake({ signer: ethers.Wallet.createRandom() });
    const bad = new DynamicEvmSigner({ environmentId: "env", authToken: "tok", wallet, createClient: () => wrong.client }, provider);
    let err: Error | null = null;
    try {
      await bad.signTransaction({ to: key.address, gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).to.contain("recovers to another address");

    const lapsed = fake({ failFirst: true });
    const signer = new DynamicEvmSigner({ environmentId: "env", authToken: "tok", wallet, createClient: () => lapsed.client }, provider);
    await signer.signTransaction({ to: key.address, gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(lapsed.signIns()).to.equal(2);
  });

  it("is off without a wallet, and an error with a wallet but no Dynamic settings", () => {
    expect(dynamicEvmSignerFromEnv("DYNAMIC_MONAD_AGENT_WALLET", {})).to.equal(null);
    expect(() => dynamicEvmSignerFromEnv("DYNAMIC_MONAD_AGENT_WALLET", { DYNAMIC_MONAD_AGENT_WALLET: JSON.stringify(wallet) })).to.throw("needs DYNAMIC_ENVIRONMENT_ID");
    const s = dynamicEvmSignerFromEnv("DYNAMIC_MONAD_AGENT_WALLET", { DYNAMIC_MONAD_AGENT_WALLET: JSON.stringify(wallet), DYNAMIC_ENVIRONMENT_ID: "e", DYNAMIC_AUTH_TOKEN: "t" });
    expect(s!.address).to.equal(key.address);
  });
});
