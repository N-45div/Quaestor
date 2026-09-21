import { expect } from "chai";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROUTER_STUB_PROGRAM_ID,
  STOCKS_PROGRAM_ID,
  accountDiscriminator,
  decodeGovernor,
  discriminator,
  id32,
} from "../solana/client";

/**
 * The Solana client now runs in the browser too, so it no longer reads
 * Anchor.toml or hashes with node:crypto. These pin that nothing it builds
 * changed: the ids are the ones Anchor.toml and declare_id! name, and every
 * hash is byte for byte what node:crypto gave.
 */
describe("solana client — the same bytes in a browser", () => {
  it("names the program ids that Anchor.toml and declare_id! name", () => {
    const toml = readFileSync(join(__dirname, "..", "solana", "Anchor.toml"), "utf8");
    expect(toml).to.contain(`quaestor_stocks = "${STOCKS_PROGRAM_ID.toBase58()}"`);
    expect(toml).to.contain(`router_stub = "${ROUTER_STUB_PROGRAM_ID.toBase58()}"`);
    const lib = readFileSync(join(__dirname, "..", "solana", "programs", "quaestor-stocks", "src", "lib.rs"), "utf8");
    expect(lib).to.contain(`declare_id!("${STOCKS_PROGRAM_ID.toBase58()}")`);
  });

  it("hashes exactly as node:crypto did", () => {
    const node = (text: string) => createHash("sha256").update(text).digest();
    for (const name of ["initialize_governor", "execute_trade", "set_policy", "deposit_usdc", "withdraw_usdc"]) {
      expect(discriminator(name).equals(node(`global:${name}`).subarray(0, 8))).to.equal(true);
    }
    for (const name of ["Governor", "IntentRecord", "ApprovedRouter", "ApprovedInstrument"]) {
      expect(accountDiscriminator(name).equals(node(`account:${name}`).subarray(0, 8))).to.equal(true);
    }
    expect(id32("intent-1").equals(node("intent-1"))).to.equal(true);
  });

  it("decodes a Governor from its bytes", () => {
    const d = Buffer.alloc(179);
    accountDiscriminator("Governor").copy(d, 0);
    STOCKS_PROGRAM_ID.toBuffer().copy(d, 8); // owner
    ROUTER_STUB_PROGRAM_ID.toBuffer().copy(d, 40); // operator
    d.writeBigUInt64LE(25_000_000n, 136); // epoch cap
    d.writeBigUInt64LE(5_000_000n, 144); // per-trade cap
    d.writeBigInt64LE(86_400n, 152); // epoch length
    d.writeBigUInt64LE(2_000_000n, 168); // spent in epoch
    d[176] = 1; // suspended
    const g = decodeGovernor(d);
    expect(g.owner.equals(STOCKS_PROGRAM_ID)).to.equal(true);
    expect(g.operator.equals(ROUTER_STUB_PROGRAM_ID)).to.equal(true);
    expect([g.epochCap, g.perTradeCap, g.epochLength, g.spentInEpoch]).to.deep.equal([25_000_000n, 5_000_000n, 86_400n, 2_000_000n]);
    expect(g.suspended).to.equal(true);
  });
});
