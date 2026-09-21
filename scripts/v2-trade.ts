/**
 * A governed trade on a real exchange, and the refusals around it.
 *
 *   npx hardhat run scripts/v2-trade.ts --network base
 *   TRADE_ETH=0.0001 npx hardhat run scripts/v2-trade.ts --network base
 *   REFUSALS=1 npx hardhat run scripts/v2-trade.ts --network base   # three that must not settle
 *
 * The governor is handed Uniswap's own calldata and never reads it. What bounds
 * the trade is measured here: how much left the treasury, and how much USDC
 * reached the owner. `REFUSALS=1` sends three trades that must fail — over the
 * cap, through a venue the owner never allowed, and one where Uniswap is told
 * to pay someone else and does so happily.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

/** The seven arguments of `swap`, without the overrides slot, so one can be added. */
type SwapArgs = [bigint, string, string, string, bigint, bigint, string];

const EXECUTION = 2;
const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const statePath = join(__dirname, "..", "deployments", `${network.name}.json`);
const eth = (wei: bigint) => `${ethers.formatEther(wei)} ETH`;
const usdc = (raw: bigint) => `${ethers.formatUnits(raw, 6)} USDC`;

const swapData = (venue: { weth: string; usdc: string; fee: number }, recipient: string, amountIn: bigint, minOut: bigint) =>
  new ethers.Interface([
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  ]).encodeFunctionData("exactInputSingle", [{
    tokenIn: venue.weth, tokenOut: venue.usdc, fee: venue.fee, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
  }]);

async function main() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const { venue } = state;
  const agentId = BigInt(state.agent.id);
  const governor = await ethers.getContractAt("QuaestorV2", state.contracts.QuaestorV2);
  const [signer] = await ethers.getSigners();
  const owner = (await governor.agents(agentId)).owner;
  const token = new ethers.Contract(venue.usdc, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  const explorer = (hash: string) => `https://basescan.org/tx/${hash}`;

  const amountIn = ethers.parseEther(process.env.TRADE_ETH ?? "0.0002");
  const [epochCap, perCallCap] = await governor.policyOf(agentId, EXECUTION);
  console.log(`agent ${agentId} on ${network.name}: treasury ${eth(await governor.balanceOf(agentId))}, caps ${eth(perCallCap)} a trade and ${eth(epochCap)} a day`);

  // What Uniswap says it would pay, asked of its own quoter rather than guessed.
  const quoter = new ethers.Contract(QUOTER, [
    "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)",
  ], ethers.provider);
  const [quoted] = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: venue.weth, tokenOut: venue.usdc, amountIn, fee: venue.fee, sqrtPriceLimitX96: 0,
  });
  // The floor the chain will enforce, half a percent under the quote.
  const minOut = (quoted * 995n) / 1000n;
  console.log(`quote: ${eth(amountIn)} -> ${usdc(quoted)}, floor ${usdc(minOut)}\n`);

  if (process.env.REFUSALS === "1") {
    const refusals: Record<string, { error: string; tx: string; explorer: string }> = {};
    /**
     * Refuse it twice: once by asking the node what would happen, which names
     * the error, and once for real, which leaves a reverted transaction anyone
     * can open. The gas limit is given explicitly so the send is not called off
     * by an estimate that already knows it fails.
     */
    const mustFail = async (label: string, args: SwapArgs, expected: string) => {
      let named = "";
      try {
        await governor.swap.staticCall(...args);
        throw new Error(`${label} was expected to fail and did not`);
      } catch (error) {
        const wrapped = error as { data?: string; info?: { error?: { data?: string } } };
        const data = wrapped.data ?? wrapped.info?.error?.data;
        // A public endpoint often returns a bare "execution reverted" with no
        // data to decode, so the name is a bonus and the revert itself is the test.
        named = (data && data !== "0x" ? governor.interface.parseError(data)?.name : "") || "";
        if (named && named !== expected) throw new Error(`${label}: expected ${expected}, the chain said ${named}`);
      }
      const tx = await governor.swap(...args, { gasLimit: 250_000n });
      const receipt = await tx.wait().catch(() => ethers.provider.getTransactionReceipt(tx.hash));
      if (receipt?.status !== 0) throw new Error(`${label}: ${tx.hash} did not revert on chain`);
      console.log(`refused  ${label.padEnd(44)} ${named || expected}   ${explorer(tx.hash)}`);
      refusals[label] = { error: named || expected, tx: tx.hash, explorer: explorer(tx.hash) };
    };

    const overCap = perCallCap + 1n;
    const meta = (name: string) => ethers.id(name);
    await mustFail("over the per-trade cap", [agentId, venue.swapRouter02, swapData(venue, owner, overCap, 1n), venue.usdc, overCap, 1n, meta("over-cap")], "PerCallCapExceeded");
    await mustFail("a venue the owner never allowed", [agentId, QUOTER, swapData(venue, owner, amountIn, 1n), venue.usdc, amountIn, 1n, meta("bad-venue")], "VenueNotAllowed");
    // Uniswap is told to pay a stranger, and does. The governor measures the
    // owner's balance, which did not move, and reverts the whole transaction.
    const stranger = ethers.Wallet.createRandom().address;
    await mustFail("Uniswap paying someone other than the owner", [agentId, venue.swapRouter02, swapData(venue, stranger, amountIn, 1n), venue.usdc, amountIn, minOut, meta("wrong-recipient")], "MinimumOutputNotMet");

    console.log(`\ntreasury still ${eth(await governor.balanceOf(agentId))}; nothing settled`);
    state.refusals = { at: new Date().toISOString(), checked: refusals };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  const before = { treasury: await governor.balanceOf(agentId), usdc: await token.balanceOf(owner), spent: await governor.spentIn(agentId, EXECUTION, await governor.currentEpoch(agentId)) };
  const tx = await governor.connect(signer).swap(agentId, venue.swapRouter02, swapData(venue, owner, amountIn, minOut), venue.usdc, amountIn, minOut, ethers.id(`trade:${Date.now()}`));
  const receipt = await tx.wait();
  // Read from this transaction's own events, not from calls made after it. A
  // public endpoint answers those from whatever block it has caught up to, and
  // it reported a settled trade as though nothing had moved.
  const events = (receipt?.logs ?? [])
    .map((log) => { try { return governor.interface.parseLog(log); } catch { return null; } })
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);
  const executed = events.find((event) => event.name === "SwapExecuted");
  const charged = events.find((event) => event.name === "Receipt");
  if (!executed || !charged) throw new Error(`${tx.hash} confirmed but emitted no settlement; read that transaction before trading again`);
  const spentWei = executed.args.amountIn as bigint;
  const received = executed.args.amountOut as bigint;

  console.log(`settled through Uniswap   ${explorer(tx.hash)}`);
  console.log(`  treasury  ${eth(before.treasury)} -> ${eth(before.treasury - spentWei)}`);
  console.log(`  owner     received ${usdc(received)}, floor was ${usdc(minOut)}`);
  console.log(`  epoch     ${eth(charged.args.epochSpentAfter as bigint)} of ${eth(epochCap)} spent`);
  console.log(`  gas       ${receipt?.gasUsed} units`);

  state.trades = [...(state.trades ?? []), {
    at: new Date().toISOString(), tx: tx.hash, explorer: explorer(tx.hash),
    amountInWei: spentWei.toString(), receivedUsdc: received.toString(), minOutUsdc: minOut.toString(),
    gasUsed: receipt?.gasUsed?.toString(),
  }];
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

main().catch((error) => {
  console.error(String((error as Error).message ?? error).slice(0, 400));
  process.exitCode = 1;
});
