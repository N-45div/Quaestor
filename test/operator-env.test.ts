import { expect } from "chai";
import { operatorFromEnv } from "../services/operator";

/**
 * Which lanes the hub serves, and with what key, from its environment. Building a Dynamic signer only reads the wallet
 * file's address; nothing here signs or reaches Dynamic.
 */
describe("Operator hub — lanes from the environment", () => {
  const wallet = JSON.stringify({ walletMetadata: { accountAddress: "0xdd7d9fcd4cc600c9dce907cd1b8c8728781e5145" } });
  const base = { DYNAMIC_ENVIRONMENT_ID: "env", DYNAMIC_AUTH_TOKEN: "token" };

  it("lets a lane name another lane's Dynamic wallet, since one EVM wallet serves every chain", () => {
    const cfg = operatorFromEnv({ ...base, OP_NETWORKS: "mezo-testnet,arc-testnet", OP_DYNAMIC_WALLET_MEZO_TESTNET: wallet, OP_DYNAMIC_WALLET_ARC_TESTNET: "@OP_DYNAMIC_WALLET_MEZO_TESTNET" });
    expect(cfg!.lanes.map((l) => [l.network.key, l.dynamic?.address])).to.deep.equal([
      ["mezo-testnet", "0xdD7d9fCD4cC600c9Dce907cd1B8c8728781E5145"],
      ["arc-testnet", "0xdD7d9fCD4cC600c9Dce907cd1B8c8728781E5145"],
    ]);
  });

  it("serves no lane whose named wallet is not there", () => {
    const cfg = operatorFromEnv({ ...base, OP_NETWORKS: "mezo-testnet", OP_DYNAMIC_WALLET_MEZO_TESTNET: "@OP_DYNAMIC_WALLET_NOWHERE" });
    expect(cfg).to.equal(null);
  });

  it("reads the chat's default network", () => {
    const cfg = operatorFromEnv({ ...base, OP_NETWORKS: "mezo-testnet", OP_DYNAMIC_WALLET_MEZO_TESTNET: wallet, OP_CHAT_DEFAULT_NETWORK: "robinhood" });
    expect(cfg!.chatDefaultNetwork).to.equal("robinhood");
  });
});
