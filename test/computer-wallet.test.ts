import { expect } from "chai";
import { ethers } from "ethers";
import { KURU_ROUTER_ABI, MONAD_TESTNET, ROBINHOOD_TESTNET, exactInputSingle } from "../sdk/evm-stocks";
import { WalletError, handle, intentOf, type WalletState } from "../computer/wallet";

/**
 * Quaestor Wallet, the browser agent's wallet: a page sees the governor as the
 * account, and the only write it can get done is a governed buy read out of its
 * swap. Everything else is refused before the chain is asked.
 */
describe("computer — the agent browser's wallet", () => {
  const governor = "0x45e1703dd5a55b659EF28a7accbb0DF33B69853C";
  const n = MONAD_TESTNET;
  const tusdc = n.budget.address;
  const tsla = n.instruments.find((i) => i.symbol === "tTSLA")!;
  const market = n.venues[0].markets![tsla.address.toLowerCase()].address;
  const kuru = new ethers.Interface(KURU_ROUTER_ABI);
  const swap = (over: Partial<{ debit: string; credit: string; amount: bigint; min: bigint; native: boolean }> = {}) =>
    kuru.encodeFunctionData("anyToAnySwap", [[market], [true], [over.native ?? false], over.debit ?? tusdc, over.credit ?? tsla.address, over.amount ?? 2_000_000n, over.min ?? 5_500_000n]);
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as WalletError).code; } return null; };

  it("reads a Kuru buy's intent out of the page's swap, and keeps nothing of its route", () => {
    const i = intentOf(n, governor, tusdc, { from: governor, to: n.venues[0].router, data: swap(), value: "0x0" });
    expect(i).to.deep.equal({ venue: n.venues[0].router, tokenIn: tusdc, tokenOut: tsla.address, amountIn: 2_000_000n, minOut: 5_500_000n });
  });

  it("reads a Uniswap buy's intent, and refuses one that pays anyone but the governor", () => {
    const r = ROBINHOOD_TESTNET;
    const v = r.venues[0];
    const usd = r.budget.address;
    const stock = r.instruments[0].address;
    const ok = intentOf(r, governor, usd, { from: governor, to: v.router, data: exactInputSingle(v, usd, stock, 3000, governor, 1_000_000n, 10n) });
    expect(ok.amountIn).to.equal(1_000_000n);
    expect(code(() => intentOf(r, governor, usd, { to: v.router, data: exactInputSingle(v, usd, stock, 3000, ethers.Wallet.createRandom().address, 1_000_000n, 10n) }))).to.equal(4001);
  });

  it("refuses everything that is not a governed buy", () => {
    const router = n.venues[0].router;
    const transfer = new ethers.Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [ethers.Wallet.createRandom().address, 1n]);
    expect(code(() => intentOf(n, governor, tusdc, { from: ethers.Wallet.createRandom().address, to: router, data: swap() }))).to.equal(4100); // not the governor
    expect(code(() => intentOf(n, governor, tusdc, { to: tusdc, data: transfer }))).to.equal(4001); // a token transfer
    expect(code(() => intentOf(n, governor, tusdc, { to: router, data: transfer }))).to.equal(4001); // not a swap
    expect(code(() => intentOf(n, governor, tusdc, { to: router, data: swap(), value: "0x1" }))).to.equal(4001); // native value
    expect(code(() => intentOf(n, governor, tusdc, { to: router, data: swap({ native: true }) }))).to.equal(4001);
    expect(code(() => intentOf(n, governor, tusdc, { to: router, data: swap({ debit: tsla.address, credit: tusdc }) }))).to.equal(4001); // a sale
    expect(code(() => intentOf(n, governor, tusdc, { to: router, data: swap({ credit: ethers.Wallet.createRandom().address }) }))).to.equal(4001); // not a stock
    expect(code(() => intentOf(n, governor, tusdc, { to: router, data: swap({ min: 0n }) }))).to.equal(4001); // no floor
  });

  it("answers as the governor, stays on its chain, and signs nothing a page hands it", async () => {
    const state = { ctx: { settings: { network: n }, provider: {} }, governor, budgetToken: tusdc, log: () => undefined } as unknown as WalletState;
    expect(await handle(state, "eth_requestAccounts")).to.deep.equal([governor]);
    expect(await handle(state, "eth_chainId")).to.equal("0x279f");
    expect(await handle(state, "wallet_switchEthereumChain", [{ chainId: "0x279f" }])).to.equal(null);
    for (const [method, params, want] of [
      ["wallet_switchEthereumChain", [{ chainId: "0x1" }], 4902],
      ["personal_sign", ["0xdead", governor], 4200],
      ["eth_signTypedData_v4", [governor, "{}"], 4200],
      ["wallet_sendCalls", [{}], 4200],
      ["eth_sendTransaction", [{ from: governor, to: n.venues[0].router, data: swap() }], 4001], // no reason given
    ] as const) {
      const err = await handle(state, method, params as unknown as unknown[]).then(() => null, (e: WalletError) => e.code);
      expect(err, method).to.equal(want);
    }
  });
});
