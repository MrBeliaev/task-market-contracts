// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITaskMarket {
    function createTask(uint256 deadline, bytes32 metadataHash) external payable;
    function cancelTask(uint256 taskId) external;
}

/// @dev Helper contract for testing pendingFees accumulation and the
///      `TransferFailed` revert path. Deliberately rejects all incoming ETH transfers,
///      while being able to act as a `client` (create/cancel tasks) so that refunds
///      routed through `_transfer` can be made to fail.
contract RejectETH {
    receive() external payable {
        revert("RejectETH: ETH not accepted");
    }

    function createTask(address market, uint256 deadline, bytes32 metadataHash) external payable {
        ITaskMarket(market).createTask{value: msg.value}(deadline, metadataHash);
    }

    function cancelTask(address market, uint256 taskId) external {
        ITaskMarket(market).cancelTask(taskId);
    }
}
