import { expect } from "chai";
import { ethers } from "ethers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BASE,
  MAX_SLIPPAGE_BPS,
  agentIdOf,
  ethOf,
  keygen,
  loadKey,
  minOutOf,
  parseArgs,
  reasonOf,
  refusalOf,
  registerUrl,
  run,
  settingsFrom,
  slippageOf,
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
    const made = keygen(keyFile);
    expect(ethers.isAddress(made.address)).to.equal(true);
    const key = loadKey(keyFile, {});
    expect(new ethers.Wallet(key).address).to.equal(made.address);
    if (process.platform !== "win32") expect(fs.statSync(keyFile).mode & 0o777).to.equal(0o600);
    expect(() => keygen(keyFile)).to.throw(/not replaced/);
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
});
