// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Re-export so Hardhat compiles TimelockController and generates its artifact,
// enabling `ethers.getContractFactory("TimelockController")` in deploy scripts.
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
