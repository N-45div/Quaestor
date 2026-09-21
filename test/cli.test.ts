import { expect } from "chai";
import { ethers } from "ethers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import {
  BASE,
  MAX_SLIPPAGE_BPS,
  agentIdOf,
  checkFlags,
  checkPayee,
  ethOf,
  keygen,
  loadKey,
  minOutOf,
  nodeRefused,
  isRateLimit,
  PatientProvider,
  parseArgs,
  reasonOf,
  refuseIfPending,
  refusalOf,
  refusalOfData,
  registerUrl,
  run,
  settingsFrom,
  slippageOf,
  venueReason,
} from "../cli/quaestor";
import { QUAESTOR_V2_ABI } from "../sdk/evm";

/**
 * The command an outside agent runs. What is tested here is what stands
 * between a talked-into agent and a bad trade before the governor is even
 * asked: the floor, the slippage ceiling, a reason that would publish a secret,
 * and a key file that must never be replaced.
 */
describe("cli — the agent's command", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "quaestor-cli-"));

  it("reads flags in both spellings and refuses a stray argument", () => {
    expect(parseArgs(["buy", "--agent", "7", "--eth=0.001", "--dry-run"])).to.deep.equal({
      command: "buy",
      flags: { agent: "7", eth: "0.001", "dry-run": "true" },
    });
    expect(() => parseArgs(["buy", "7"])).to.throw(/unexpected argument/);
  });

  it("takes an agent id and an ETH amount, and nothing that is not one", () => {
    expect(agentIdOf({ agent: "#7" })).to.equal(7n);
    expect(() => agentIdOf({ agent: "0" })).to.throw(/agent id/);
    expect(() => agentIdOf({ agent: "seven" })).to.throw(/agent id/);
    expect(ethOf({ eth: "0.0001" })).to.equal(ethers.parseEther("0.0001"));
    expect(() => ethOf({ eth: "0" })).to.throw(/more than zero/);
    expect(() => ethOf({ eth: "lots" })).to.throw(/amount of ETH/);
    expect(() => ethOf({})).to.throw(/--eth is required/);
  });

  it("will not widen the slippage past the ceiling, however it is asked", () => {
    expect(slippageOf({})).to.equal(100);
    expect(slippageOf({ "slippage-bps": String(MAX_SLIPPAGE_BPS) })).to.equal(MAX_SLIPPAGE_BPS);
    expect(() => slippageOf({ "slippage-bps": String(MAX_SLIPPAGE_BPS + 1) })).to.throw(/at most/);
    expect(() => slippageOf({ "slippage-bps": "10000" })).to.throw(/at most/);
    expect(() => slippageOf({ "slippage-bps": "0.5" })).to.throw(/whole number/);
  });

  it("sets the floor from the quote less the slippage, and never at zero", () => {
    expect(minOutOf(1_000_000n, 100)).to.equal(990_000n);
    expect(minOutOf(1_000_000n, 500)).to.equal(950_000n);
    expect(() => minOutOf(1n, 100)).to.throw(/too small/);
    expect(() => minOutOf(0n, 100)).to.throw(/too small/);
  });

  it("refuses a reason that would publish a credential on chain", () => {
    expect(reasonOf({ reason: "  momentum turned up after a dip  " })).to.equal("momentum turned up after a dip");
    expect(() => reasonOf({ reason: "use key sk-abcdefghijklmnopqrstuvwxyz0123" })).to.throw(/credential|looks like/);
    expect(() => reasonOf({ reason: "x".repeat(501) })).to.throw(/at most 500/);
    expect(() => reasonOf({})).to.throw(/--reason is required/);
  });

  it("writes a new key where only the user reads it, and never replaces one", () => {
    const keyFile = path.join(tmp(), "nested", "operator.key");
    const made = keygen(keyFile, {});
    expect(ethers.isAddress(made.address)).to.equal(true);
    const key = loadKey(keyFile, {});
    expect(new ethers.Wallet(key).address).to.equal(made.address);
    if (process.platform !== "win32") expect(fs.statSync(keyFile).mode & 0o777).to.equal(0o600);
    expect(() => keygen(keyFile, {})).to.throw(/not replaced/);
    expect(loadKey(keyFile, {})).to.equal(key);
  });

  it("prefers the key in the environment, and says what to do when there is none", () => {
    const key = ethers.Wallet.createRandom().privateKey;
    expect(loadKey("/nowhere/operator.key", { QUAESTOR_OPERATOR_KEY: key })).to.equal(key);
    expect(() => loadKey("/nowhere/operator.key", {})).to.throw(/keygen/);
    expect(() => loadKey("/nowhere/operator.key", { QUAESTOR_OPERATOR_KEY: "0x1234" })).to.throw(/32-byte/);
  });

  it("points the owner at the app with the operator filled in", () => {
    expect(registerUrl(BASE.app, "0xabc")).to.equal("https://quaestor-app.onrender.com/#/app/agents/new?chain=base&operator=0xabc");
    const settings = settingsFrom({}, {});
    expect(settings.governor).to.equal(BASE.governor);
    expect(settings.chainId).to.equal(8453);
    expect(settings.rpcUrl).to.equal(BASE.rpcUrl);
  });

  it("reads a refusal in the units it is in: ETH for caps, the token's for a floor", () => {
    const iface = new ethers.Interface(QUAESTOR_V2_ABI);
    const cap = iface.encodeErrorResult("PerCallCapExceeded", [ethers.parseEther("0.0002") + 1n, ethers.parseEther("0.0002")]);
    expect(refusalOf({ data: cap })).to.deep.equal({
      code: "PerCallCapExceeded",
      detail: "PerCallCapExceeded: amount=0.000200000000000001 ETH, cap=0.0002 ETH",
    });
    const floor = iface.encodeErrorResult("MinimumOutputNotMet", [0n, 202_039n]);
    expect(refusalOf({ info: { error: { data: floor } } }, 6)?.detail).to.equal("MinimumOutputNotMet: received=0.0, minimum=0.202039");
    expect(refusalOf({ data: iface.encodeErrorResult("VenueNotAllowed", [BASE.governor]) })?.code).to.equal("VenueNotAllowed");
    expect(refusalOf(new Error("socket hang up"))).to.equal(null);
  });

  it("answers every mistake as JSON with a code, before touching the chain", async () => {
    const env = { QUAESTOR_KEY_FILE: path.join(tmp(), "none.key"), QUAESTOR_RPC_URL: "http://127.0.0.1:9" };
    const wide = await run(["buy", "--agent", "1", "--eth", "0.0001", "--reason", "dip", "--slippage-bps", "9000"], env);
    expect(wide.code).to.equal(1);
    expect(wide.out).to.include({ ok: false, error: "SLIPPAGE_TOO_WIDE" });
    const cat = await run(["pay", "--agent", "1", "--category", "execution", "--to", BASE.governor, "--eth", "0.00001", "--reason", "x"], env);
    expect(cat.out).to.include({ error: "BAD_ARGUMENT" });
    const unknown = await run(["withdraw", "--agent", "1"], env);
    expect(unknown.out).to.include({ error: "UNKNOWN_COMMAND" });
    const help = await run(["help"], env);
    expect(help.out).to.be.a("string").and.contain("buy --agent");
  });

  it("refuses a flag a command does not take, so a misspelt --dry-run never sends a trade", () => {
    expect(() => checkFlags("buy", { agent: "1", dryrun: "true" })).to.throw(/does not take --dryrun/);
    expect(() => checkFlags("buy", { "dry-run": "yes" })).to.throw(/takes no value/);
    expect(() => checkFlags("buy", { "dry-run": "false" })).to.throw(/takes no value/);
    expect(() => checkFlags("quote", { agent: "1" })).to.throw(/does not take --agent/);
    expect(() => checkFlags("withdraw", {})).to.throw(/unknown command/);
    checkFlags("buy", { agent: "1", eth: "0.1", reason: "x", "dry-run": "true", "min-out": "0.27" });
    checkFlags("pay", { agent: "1", category: "data", to: BASE.log, eth: "0.1", reason: "x", "dry-run": "true" });
  });

  it("keeps everything after the first = in a flag's value", () => {
    expect(parseArgs(["buy", "--reason=spread a=b wide", "--rpc=https://x.io/?k=v"]).flags).to.deep.equal({
      reason: "spread a=b wide",
      rpc: "https://x.io/?k=v",
    });
  });

  it("refuses a reason carrying this agent's own key, in any case, with or without 0x", () => {
    const key = ethers.Wallet.createRandom().privateKey;
    const hex = key.slice(2);
    for (const reason of [`audit ${key}`, `audit ${hex}`, `audit ${hex.toUpperCase()}`]) {
      expect(() => reasonOf({ reason }, key)).to.throw(/operator key/);
    }
    // a transaction hash is not the key, and stays allowed
    expect(reasonOf({ reason: `after ${ethers.id("x")}` }, key)).to.contain("after 0x");
  });

  it("will not pay the governor, the log, the operator itself or nobody", () => {
    const settings = settingsFrom({}, {});
    const operator = ethers.Wallet.createRandom().address;
    expect(() => checkPayee(BASE.governor.toLowerCase(), settings, operator)).to.throw(/governor itself/);
    expect(() => checkPayee(BASE.log, settings, operator)).to.throw(/decision log/);
    expect(() => checkPayee(operator, settings, operator)).to.throw(/own operator key/);
    expect(() => checkPayee(ethers.ZeroAddress, settings, operator)).to.throw(/zero address/);
    expect(() => checkPayee("0x123", settings, operator)).to.throw(/must be an address/);
    const payee = "0x000000000000000000000000000000000000dead";
    expect(checkPayee(payee, settings, operator)).to.equal(ethers.getAddress(payee));
  });

  it("will not make a key file while another key is set in the environment", () => {
    const keyFile = path.join(tmp(), "operator.key");
    expect(() => keygen(keyFile, { QUAESTOR_OPERATOR_KEY: ethers.Wallet.createRandom().privateKey })).to.throw(/QUAESTOR_OPERATOR_KEY is set/);
    expect(fs.existsSync(keyFile)).to.equal(false);
  });

  it("shows the venue's own reason when the governor reports that the venue failed", () => {
    const tooLittle = ethers.concat(["0x08c379a0", ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Too little received"])]);
    expect(venueReason(tooLittle)).to.equal("Too little received");
    expect(venueReason(ethers.concat(["0x4e487b71", ethers.toBeHex(17, 32)]))).to.equal("panic 17");
    expect(venueReason("0x")).to.equal("no reason given");
    const iface = new ethers.Interface(QUAESTOR_V2_ABI);
    expect(refusalOfData(iface.encodeErrorResult("VenueCallFailed", [tooLittle]))).to.deep.equal({
      code: "VenueCallFailed",
      detail: "VenueCallFailed: Too little received",
    });
  });

  it("sends no new spend while an earlier one is unsettled", () => {
    const dir = tmp();
    const settings = { ...settingsFrom({}, {}), keyFile: path.join(dir, "operator.key") };
    expect(refuseIfPending({ settings })).to.equal(null);
    fs.writeFileSync(path.join(dir, "pending.json"), JSON.stringify({ hash: "0xabc", kind: "buy" }));
    const blocked = refuseIfPending({ settings });
    expect(blocked).to.include({ ok: false, error: "PENDING_SPEND" });
    expect(String(blocked!.message)).to.contain("check");
  });

  it("tells a node's own refusal of a broadcast from a connection that failed", () => {
    // What ethers throws when the node answered with a JSON-RPC error: nothing was sent.
    expect(nodeRefused({ code: "INSUFFICIENT_FUNDS", shortMessage: "insufficient funds for intrinsic transaction cost" })).to.contain("insufficient funds");
    expect(nodeRefused({ code: "UNKNOWN_ERROR", error: { code: -32000, message: "Sender doesn't have enough funds to send tx." } })).to.contain("enough funds");
    expect(nodeRefused({ code: "SERVER_ERROR", info: { error: { code: -32003, message: "max fee per gas less than block base fee" } } })).to.contain("base fee");
    // No answer at all: the outcome is unknown, and the spend stays pending.
    expect(nodeRefused({ code: "TIMEOUT" })).to.equal(null);
    expect(nodeRefused(new Error("socket hang up"))).to.equal(null);
  });

  it("waits out a rate limit instead of reporting it as missing revert data", async () => {
    expect(isRateLimit({ code: -32016, message: "over rate limit" })).to.equal(true);
    expect(isRateLimit({ code: -32000, message: "Too many requests, slow down" })).to.equal(true);
    expect(isRateLimit({ code: 3, message: "execution reverted" })).to.equal(false);
    expect(isRateLimit(undefined)).to.equal(false);

    // An endpoint that refuses the first two requests the way mainnet.base.org does.
    let seen = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const { id } = JSON.parse(body);
        seen += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(seen <= 2
          ? { jsonrpc: "2.0", id, error: { code: -32016, message: "over rate limit" } }
          : { jsonrpc: "2.0", id, result: "0x2a" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const provider = new PatientProvider(url, 8453, [10, 10, 10]);
      expect(await provider.getBlockNumber()).to.equal(42);
      expect(seen).to.equal(3);
      provider.destroy();
    } finally {
      server.close();
    }
  });
});
