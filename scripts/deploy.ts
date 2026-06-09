import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

async function main() {
  const connection = await hre.network.create();
  const { ethers } = connection;
  const api = await upgrades(hre, connection);

  const [deployer] = await ethers.getSigners();
  console.log("Deploying TaskMarket with account:", deployer.address);

  const feeBps = 250;
  const feeRecipient = deployer.address;

  const TaskMarket = await ethers.getContractFactory("TaskMarket");
  const taskMarket = await api.deployProxy(TaskMarket, [feeBps, feeRecipient], {
    kind: "uups",
    unsafeAllow: ["constructor"],
  });
  await taskMarket.waitForDeployment();

  const proxyAddress = await taskMarket.getAddress();
  const implAddress = await api.erc1967.getImplementationAddress(proxyAddress);

  console.log("TaskMarket proxy deployed to:", proxyAddress);
  console.log("Implementation deployed to:", implAddress);
  console.log("Platform fee:", feeBps, "bps");
  console.log("Fee recipient:", feeRecipient);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
