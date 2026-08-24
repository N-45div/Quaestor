import { ethers } from "hardhat";

async function main() {
  const quaestor = await ethers.getContractAt(
    "Quaestor",
    "0x7C8772fbdF1A1d9Ded219E51D3147d7C04475921"
  );
  const [owner] = await ethers.getSigners();
  const guardian = "0xf95C0A574c1E079d2CB9AF2349DC09214Fe55686";
  const current = await quaestor.guardianOf(3);
  if (current.toLowerCase() === guardian.toLowerCase()) {
    console.log("Pulse already guarded");
    return;
  }
  const tx = await quaestor.connect(owner).setGuardian(3, guardian);
  await tx.wait();
  console.log(`Pulse (#3) guardian set to ${guardian} (${tx.hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
