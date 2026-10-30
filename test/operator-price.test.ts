import { expect } from "chai";
import { ethers } from "ethers";
import { PriceUnavailable, poolSlots, unitsPerMicroUsd } from "../operator/price";

/**
 * The arithmetic that turns a Uniswap v4 pool's sqrtPriceX96 and Chainlink's ETH / USD into the WIF a dollar buys.
 * Against the real pool and feed, see test/quaestor-payouts-wif-fork.test.ts.
 */
describe("Operator price — a budget token that is not a dollar", () => {
  const Q96 = 2n ** 96n;
  // sqrtPriceX96 for a price of `perEth` token units per wei, both 18 decimals: sqrt(perEth) × 2^96.
  const sqrtFor = (tokensPerEth: number) => BigInt(Math.round(Math.sqrt(tokensPerEth) * 1e9)) * Q96 / 10n ** 9n;
  const ETH_USD = 2_236_64181548n; // $2,236.64181548, 8 decimals, as Chainlink answered on 30 Oct 2026

  it("prices WIF from its pool against ETH and ETH in dollars: 1.82M WIF an ETH at $2,236.64 is about 813.8 WIF a dollar", () => {
    const rate = unitsPerMicroUsd(sqrtFor(1_820_209), ETH_USD, true);
    const wifPerUsd = Number(rate) * 1e6 / 1e18;
    expect(wifPerUsd).to.be.closeTo(1_820_209 / 2_236.64181548, 0.01);
    // $5 escrows about 4,069 WIF
    expect(Number(5_000_000n * rate) / 1e18).to.be.closeTo(5 * 1_820_209 / 2_236.64181548, 0.05);
  });

  it("reads the pool the other way round when the token is currency0", () => {
    // 1 token = 2 ETH: the pool's price (ETH per token) is 2, so a dollar at $2,000 an ETH buys 1/4,000 of a token.
    const rate = unitsPerMicroUsd(sqrtFor(2), 2_000_00000000n, false);
    expect(Number(rate) * 1e6 / 1e18).to.be.closeTo(1 / 4_000, 1e-9);
  });

  it("refuses a pool with no price or a feed with no answer", () => {
    expect(() => unitsPerMicroUsd(0n, ETH_USD, true)).to.throw(PriceUnavailable);
    expect(() => unitsPerMicroUsd(sqrtFor(1_000), 0n, true)).to.throw(PriceUnavailable);
  });

  it("finds a v4 pool's state where the PoolManager keeps it: keccak256(poolId, 6), liquidity three words on", () => {
    const poolId = "0xde72ea1422623e6b2ec5c09a8170c9f0d53fd31aacb6d341fc08dc714aba5076";
    const base = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, 6])));
    const s = poolSlots(poolId);
    expect(BigInt(s.slot0)).to.equal(base);
    expect(BigInt(s.liquidity)).to.equal(base + 3n);
  });
});
