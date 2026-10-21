import { parseAbi, type Account, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { receiptOf } from "./evm/stocks";

/**
 * Funding a MUSD budget from BTC on Mezo, from the owner's own wallet: swap BTC for MUSD through Mezo's pools, open a
 * trove (BTC stays the owner's as collateral and MUSD is minted against it), or borrow more on a trove already open.
 * Addresses are Mezo testnet's, from mezo-org/musd's matsnet deployments and Mezo's pools docs. Every write is
 * simulated first, so a call the contracts would refuse never reaches the wallet.
 */
export const MEZO = {
  chainId: 31611,
  musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  btc: "0x7b7C000000000000000000000000000000000000", // native BTC's ERC-20 face
  borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
  troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
  hintHelpers: "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6",
  sortedTroves: "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA",
  router: "0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9",
  poolFactory: "0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A",
} as const satisfies Record<string, string | number>;

const ERC20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const ROUTER = parseAbi([
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[])",
]);
const BORROWER = parseAbi([
  "function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable",
  "function withdrawMUSD(uint256 _amount, address _upperHint, address _lowerHint)",
  "function getBorrowingFee(uint256) view returns (uint256)",
  "function MUSD_GAS_COMPENSATION() view returns (uint256)",
]);
const TROVES = parseAbi(["function getTroveStatus(address) view returns (uint8)", "function getTroveColl(address) view returns (uint256)", "function getTroveDebt(address) view returns (uint256)"]);
const HINTS = parseAbi(["function getApproxHint(uint256 _CR, uint256 _numTrials, uint256 _inputRandomSeed) view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)"]);
const SORTED = parseAbi(["function findInsertPosition(uint256 _NICR, address _prevId, address _nextId) view returns (address, address)"]);

const ROUTE = [{ from: MEZO.btc as Address, to: MEZO.musd as Address, stable: false, factory: MEZO.poolFactory as Address }];

export interface Signer { wallet: WalletClient; account: Address | Account; chain: Chain; reader: PublicClient }
const addr = (a: Address | Account) => (typeof a === "string" ? a : a.address);

/** Mezo asks for a little headroom over the gas estimate. */
async function send(s: Signer, req: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; value?: bigint }, step?: (label: string) => void, label?: string): Promise<Hex> {
  const { request } = await s.reader.simulateContract({ ...req, account: s.account } as never);
  const gas = await s.reader.estimateContractGas({ ...req, account: s.account } as never);
  if (label) step?.(label);
  const hash = await s.wallet.writeContract({ ...(request as object), gas: (gas * 13n) / 10n, account: s.account, chain: s.chain } as never);
  const receipt = await receiptOf(s.reader, hash);
  if (receipt.status !== "success") throw new Error(`Mezo reverted the transaction ${hash}`);
  return hash;
}

export async function balances(reader: PublicClient, who: Address): Promise<{ btc: bigint; musd: bigint }> {
  const [btc, musd] = await Promise.all([reader.getBalance({ address: who }), reader.readContract({ address: MEZO.musd, abi: ERC20, functionName: "balanceOf", args: [who] })]);
  return { btc, musd };
}

export async function troveOf(reader: PublicClient, who: Address): Promise<{ active: boolean; coll: bigint; debt: bigint }> {
  const status = await reader.readContract({ address: MEZO.troveManager, abi: TROVES, functionName: "getTroveStatus", args: [who] });
  if (status !== 1) return { active: false, coll: 0n, debt: 0n };
  const [coll, debt] = await Promise.all([
    reader.readContract({ address: MEZO.troveManager, abi: TROVES, functionName: "getTroveColl", args: [who] }),
    reader.readContract({ address: MEZO.troveManager, abi: TROVES, functionName: "getTroveDebt", args: [who] }),
  ]);
  return { active: true, coll, debt };
}

export async function swapQuote(reader: PublicClient, btcIn: bigint): Promise<bigint> {
  const out = await reader.readContract({ address: MEZO.router, abi: ROUTER, functionName: "getAmountsOut", args: [btcIn, ROUTE] });
  return out[out.length - 1];
}

/** Sell BTC for MUSD through Mezo's pools, accepting no less than minOut. */
export async function swapBtcForMusd(s: Signer, btcIn: bigint, minOut: bigint, step?: (label: string) => void): Promise<Hex> {
  const me = addr(s.account);
  const allowance = await s.reader.readContract({ address: MEZO.btc, abi: ERC20, functionName: "allowance", args: [me, MEZO.router] });
  if (allowance < btcIn) await send(s, { address: MEZO.btc, abi: ERC20, functionName: "approve", args: [MEZO.router, btcIn] }, step, "1 of 2 · let Mezo's router take the BTC…");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  return send(s, { address: MEZO.router, abi: ROUTER, functionName: "swapExactTokensForTokens", args: [btcIn, minOut, ROUTE, me, deadline] }, step, allowance < btcIn ? "2 of 2 · swap BTC for MUSD…" : "Swap BTC for MUSD…");
}

/** Where a trove with this collateral and debt sits in Mezo's sorted list, as the contract wants its hints. */
async function hints(reader: PublicClient, coll: bigint, debt: bigint): Promise<[Address, Address]> {
  const nicr = (coll * 10n ** 20n) / debt;
  const [approx] = await reader.readContract({ address: MEZO.hintHelpers, abi: HINTS, functionName: "getApproxHint", args: [nicr, 15n, 42n] });
  const [upper, lower] = await reader.readContract({ address: MEZO.sortedTroves, abi: SORTED, functionName: "findInsertPosition", args: [nicr, approx, approx] });
  return [upper, lower];
}

/** Open a trove: lock `coll` BTC and borrow `debt` MUSD against it (the minimum loan is enforced by the contract). */
export async function openTrove(s: Signer, debt: bigint, coll: bigint, step?: (label: string) => void): Promise<Hex> {
  const [fee, gasComp] = await Promise.all([
    s.reader.readContract({ address: MEZO.borrowerOperations, abi: BORROWER, functionName: "getBorrowingFee", args: [debt] }),
    s.reader.readContract({ address: MEZO.borrowerOperations, abi: BORROWER, functionName: "MUSD_GAS_COMPENSATION" }),
  ]);
  const [upper, lower] = await hints(s.reader, coll, debt + fee + gasComp);
  return send(s, { address: MEZO.borrowerOperations, abi: BORROWER, functionName: "openTrove", args: [debt, upper, lower], value: coll }, step, "Lock BTC and borrow MUSD…");
}

/** Borrow more MUSD on a trove already open, against the BTC already in it. */
export async function borrowMore(s: Signer, amount: bigint, step?: (label: string) => void): Promise<Hex> {
  const t = await troveOf(s.reader, addr(s.account));
  if (!t.active) throw new Error("this wallet has no open trove on Mezo");
  const fee = await s.reader.readContract({ address: MEZO.borrowerOperations, abi: BORROWER, functionName: "getBorrowingFee", args: [amount] });
  const [upper, lower] = await hints(s.reader, t.coll, t.debt + amount + fee);
  return send(s, { address: MEZO.borrowerOperations, abi: BORROWER, functionName: "withdrawMUSD", args: [amount, upper, lower] }, step, "Borrow more MUSD against your BTC…");
}
