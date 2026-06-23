import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

const PROXY_ADDRESS = "0x84c68038f4524C84ECF7c0EB3CF0bceD3ADCB152";

async function main() {
  const connection = await hre.network.create();
  const { ethers } = connection;
  const api = await upgrades(hre, connection);

  const [deployer] = await ethers.getSigners();
  console.log("Upgrading TaskMarket with account:", deployer.address);
  console.log("Proxy address:", PROXY_ADDRESS);

  const TaskMarket = await ethers.getContractFactory("TaskMarket");
  const upgraded = await api.upgradeProxy(PROXY_ADDRESS, TaskMarket, {
    kind: "uups",
    unsafeAllow: ["constructor"],
  });
  await upgraded.waitForDeployment();

  const newImplAddress = await api.erc1967.getImplementationAddress(PROXY_ADDRESS);
  console.log("Upgrade complete. New implementation:", newImplAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
