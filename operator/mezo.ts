/**
 * Funding an Operator budget on Mezo from Bitcoin, read live from Mezo's own contracts (testnet addresses from
 * mezo-org/musd's matsnet deployments and Mezo's pools docs). Two ways to MUSD:
 *   borrow  open a trove: BTC stays the owner's as collateral, MUSD is minted against it (at least 1,800)
 *   swap    sell BTC for MUSD through Mezo's pools, for budgets too small to borrow
 * Quotes only: the owner's wallet signs whatever it does.
 */
import { ethers } from "ethers";

export const MEZO = {
  musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  btc: "0x7b7C000000000000000000000000000000000000", // native BTC's ERC-20 face
  borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
  troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
  hintHelpers: "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6",
  sortedTroves: "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA",
  priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
  router: "0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9",
  poolFactory: "0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A",
} as const;

/** The collateral ratio a quote aims for: Mezo's critical ratio, well clear of liquidation at 110%. */
export const TARGET_RATIO = 1.5;

export interface FundQuote {
  musd: number;
  btc_usd: number;
  borrow: { debt_musd: number; fee_musd: number; gas_deposit_musd: number; collateral_btc: number; liquidation_ratio: number; target_ratio: number; note: string | null };
  swap: { btc_in: number; musd_out: number } | null;
}

const e18 = (n: bigint) => Number(ethers.formatEther(n));

export async function fundQuote(provider: ethers.Provider, musd: number): Promise<FundQuote> {
  const price = (await new ethers.Contract(MEZO.priceFeed, ["function fetchPrice() returns (uint256)"], provider).fetchPrice.staticCall()) as bigint;
  // The fee, the minimum and the gas deposit all live on BorrowerOperations.
  const ops = new ethers.Contract(MEZO.borrowerOperations, [
    "function minNetDebt() view returns (uint256)", "function MUSD_GAS_COMPENSATION() view returns (uint256)", "function getBorrowingFee(uint256) view returns (uint256)",
  ], provider);
  const [minNet, gasComp] = (await Promise.all([ops.minNetDebt(), ops.MUSD_GAS_COMPENSATION()])) as [bigint, bigint];

  // A trove's debt plus its fee must reach the minimum: a smaller budget still borrows the minimum.
  const want = ethers.parseEther(musd.toFixed(6));
  const fee0 = (await ops.getBorrowingFee(want)) as bigint;
  const debt = want + fee0 >= minNet ? want : (minNet * 1000n) / 1001n + 1n;
  const fee = (await ops.getBorrowingFee(debt)) as bigint;
  const composite = debt + fee + gasComp;
  const collateral = (composite * BigInt(Math.round(TARGET_RATIO * 1000)) * 10n ** 15n) / price;

  let swap: FundQuote["swap"] = null;
  try {
    const router = new ethers.Contract(MEZO.router, ["function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[])"], provider);
    const route = [{ from: MEZO.btc, to: MEZO.musd, stable: false, factory: MEZO.poolFactory }];
    // Price the pool, then correct once for its slippage at this size.
    let btcIn = (want * 10n ** 18n) / price;
    let out = ((await router.getAmountsOut(btcIn, route)) as bigint[]).at(-1)!;
    if (out > 0n) {
      btcIn = (btcIn * want) / out + 1n;
      out = ((await router.getAmountsOut(btcIn, route)) as bigint[]).at(-1)!;
      swap = { btc_in: e18(btcIn), musd_out: e18(out) };
    }
  } catch {
    swap = null; // no pool quote right now; borrowing still stands
  }

  return {
    musd,
    btc_usd: e18(price),
    borrow: {
      debt_musd: e18(debt), fee_musd: e18(fee), gas_deposit_musd: e18(gasComp), collateral_btc: e18(collateral), liquidation_ratio: 1.1, target_ratio: TARGET_RATIO,
      note: debt === want ? null : `A trove borrows at least ${e18(minNet).toLocaleString("en-US")} MUSD; the rest stays in the owner's wallet.`,
    },
    swap,
  };
}
