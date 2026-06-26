/**
 * setup-timelock.ts
 *
 * Deploys an OZ TimelockController and transfers DEFAULT_ADMIN_ROLE of a
 * deployed TaskMarket proxy to it, then revokes the deployer's role.
 *
 * Usage:
 *   PROXY_ADDRESS=0x... TIMELOCK_DELAY=172800 npx hardhat run scripts/setup-timelock.ts --network <net>
 *
 * Environment variables:
 *   PROXY_ADDRESS    TaskMarket proxy address (required)
 *   TIMELOCK_DELAY   Minimum delay in seconds (default: 172800 = 48 h)
 *   PROPOSER         Address to add as TimelockController proposer
 *                    (defaults to deployer; replace with Gnosis Safe address for production)
 */

import hre from "hardhat";

const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);

async function main() {
  const connection = await hre.network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();

  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!proxyAddress) throw new Error("PROXY_ADDRESS env var is required");

  const minDelay = process.env.TIMELOCK_DELAY
    ? parseInt(process.env.TIMELOCK_DELAY, 10)
    : 172_800; // 48 hours

  const proposer = process.env.PROPOSER ?? deployer.address;

  console.log("=== TaskMarket Timelock Setup ===");
  console.log("Deployer     :", deployer.address);
  console.log("Proxy        :", proxyAddress);
  console.log("Min delay    :", minDelay, "s (", (minDelay / 3600).toFixed(1), "h)");
  console.log("Proposer     :", proposer);

  // ── 1. Deploy TimelockController ─────────────────────────────────────────────
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(
    minDelay,
    [proposer],       // proposers: who can queue upgrade operations
    [],               // executors: empty array means anyone can execute after delay
    deployer.address, // initial admin (revoked at the end of this script)
  );
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("\nTimelockController deployed to:", timelockAddress);

  // ── 2. Connect to TaskMarket proxy ───────────────────────────────────────────
  const taskMarketAbi = [
    "function grantRole(bytes32 role, address account) external",
    "function revokeRole(bytes32 role, address account) external",
    "function hasRole(bytes32 role, address account) external view returns (bool)",
  ];
  const taskMarket = new ethers.Contract(proxyAddress, taskMarketAbi, deployer);

  // ── 3. Grant DEFAULT_ADMIN_ROLE to TimelockController ────────────────────────
  console.log("\nGranting DEFAULT_ADMIN_ROLE to TimelockController…");
  const grantTx = await taskMarket.grantRole(DEFAULT_ADMIN_ROLE, timelockAddress);
  await grantTx.wait();
  const granted = await taskMarket.hasRole(DEFAULT_ADMIN_ROLE, timelockAddress);
  if (!granted) throw new Error("Grant failed, aborting before revoking deployer role");

  // ── 4. Revoke DEFAULT_ADMIN_ROLE from deployer ───────────────────────────────
  console.log("Revoking DEFAULT_ADMIN_ROLE from deployer…");
  const revokeTx = await taskMarket.revokeRole(DEFAULT_ADMIN_ROLE, deployer.address);
  await revokeTx.wait();
  const stillHasRole = await taskMarket.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
  if (stillHasRole) throw new Error("Revoke failed");

  console.log("\n=== Setup complete ===");
  console.log("TimelockController :", timelockAddress);
  console.log("Min delay          :", minDelay, "s");
  console.log("Proposer           :", proposer);
  console.log("\nFuture upgrades must be queued through the TimelockController");
  console.log("and wait", (minDelay / 3600).toFixed(1), "hour(s) before execution.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
