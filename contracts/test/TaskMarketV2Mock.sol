// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TaskMarket} from "../TaskMarket.sol";

/// @custom:oz-upgrades-from TaskMarket
/// @dev Mock V2 used only in tests to exercise the UUPS upgrade path:
/// appends a new storage variable and a new function on top of TaskMarket.
contract TaskMarketV2Mock is TaskMarket {
    uint256 public minReward;

    function initializeV2(uint256 _minReward) public reinitializer(2) {
        minReward = _minReward;
    }

    function version() external pure returns (string memory) {
        return "v2";
    }
}
