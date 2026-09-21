import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "hardhat";
import type { InterfaceAbi } from "ethers";

/**
 * The app's copy of the V2 ABI is the contract's, or this fails: a stale copy
 * decodes silently wrong. The app is an ES module the test runner cannot
 * import, and the ABI in it is plain JSON, so it is read as text.
 */
describe("app — the V2 ABI it ships", () => {
  it("matches the compiled QuaestorV2 exactly", async () => {
    const source = readFileSync(join(__dirname, "..", "app", "src", "lib", "abi-v2.ts"), "utf8");
    const json = source.slice(source.indexOf("= [") + 2, source.lastIndexOf("] as const") + 1);
    const shipped = new ethers.Interface(JSON.parse(json) as InterfaceAbi).format(false).sort();
    const compiled = (await ethers.getContractFactory("QuaestorV2")).interface.format(false).sort();
    expect(shipped).to.deep.equal(compiled);
  });
});
