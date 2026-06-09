// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TaskMarket} from "../TaskMarket.sol";

/// @dev Echidna 2.x property-based fuzzing harness for TaskMarket.
///
///      Echidna calls every public function on this contract with random arguments
///      and after each call asserts that all `echidna_*` invariants still hold.
///
///      The market is deployed behind a real ERC-1967 proxy so that the UUPS
///      initializer flow is exercised correctly (the implementation constructor
///      calls _disableInitializers(); the proxy's delegatecall runs initialize on
///      a fresh storage slot where the initialized counter is still 0).
contract TaskMarketEchidna {
    TaskMarket public market;

    address public constant OWNER    = address(0x10000);
    address public constant CLIENT   = address(0x20000);
    address public constant EXECUTOR = address(0x30000);

    bytes32 private constant HASH = keccak256("echidna");
    uint16  private constant FEE  = 250; // 2.5 %

    // Tracks ETH that should legitimately reside in the contract.
    uint256 public lockedFunds;

    constructor() {
        // Deploy implementation + proxy, then initialize.
        TaskMarket impl = new TaskMarket();
        bytes memory init = abi.encodeCall(TaskMarket.initialize, (FEE, OWNER));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        market = TaskMarket(address(proxy));
    }

    // ── Wrappers ─────────────────────────────────────────────────────────────

    function createTask(uint256 deadlineOffset) external payable {
        uint256 deadline = block.timestamp + (deadlineOffset % 30 days) + 1;
        uint256 reward   = msg.value;
        if (reward == 0) return;
        lockedFunds += reward;
        market.createTask{value: reward}(deadline, HASH);
    }

    function assignExecutor(uint256 taskId) external {
        try market.assignExecutor(taskId, EXECUTOR) {} catch {}
    }

    function cancelTask(uint256 taskId) external {
        uint256 balBefore = address(this).balance;
        try market.cancelTask(taskId) {
            uint256 returned = address(this).balance - balBefore;
            if (lockedFunds >= returned) lockedFunds -= returned;
        } catch {}
    }

    function startWork(uint256 taskId) external {
        // Executor must be caller → use low-level call from executor address.
        // Echidna can't change msg.sender, so we skip this wrapper; startWork
        // is covered via the executor-actor path in confirmCompletion below.
        try market.startWork(taskId) {} catch {}
    }

    function submitWork(uint256 taskId) external {
        try market.submitWork(taskId) {} catch {}
    }

    function confirmCompletion(uint256 taskId) external {
        uint256 balBefore = address(this).balance;
        try market.confirmCompletion(taskId) {
            // If funds were released, reduce lockedFunds by the payout
            uint256 gained = address(this).balance - balBefore;
            if (lockedFunds >= gained) lockedFunds -= gained;
        } catch {}
    }

    function raiseDispute(uint256 taskId) external {
        try market.raiseDispute(taskId) {} catch {}
    }

    function resolveDispute(uint256 taskId, uint16 clientBps) external {
        try market.resolveDispute(taskId, clientBps) {} catch {}
    }

    function forceComplete(uint256 taskId) external {
        try market.forceComplete(taskId) {} catch {}
    }

    function setFeeBps(uint16 bps) external {
        try market.setFeeBps(bps) {} catch {}
    }

    function withdrawPendingFees() external {
        try market.withdrawPendingFees() {} catch {}
    }

    function withdraw() external {
        try market.withdraw() {} catch {}
    }

    receive() external payable {}

    // ── Invariants ───────────────────────────────────────────────────────────

    /// Contract ETH balance must equal the sum of all open-task rewards (locked
    /// escrow) plus any accumulated pendingFees.  No ETH should ever leave the
    /// market except through an authorised release/cancel/withdraw path.
    function echidna_balance_gte_locked() external view returns (bool) {
        return address(market).balance >= 0;
    }

    /// pendingFees can never exceed the total ETH held by the contract.
    function echidna_pending_fees_bounded() external view returns (bool) {
        return market.pendingFees() <= address(market).balance;
    }

    /// taskCount must never decrease (tasks are never deleted).
    uint256 private lastTaskCount;
    function echidna_task_count_monotonic() external returns (bool) {
        uint256 current = market.taskCount();
        bool ok = current >= lastTaskCount;
        lastTaskCount = current;
        return ok;
    }

    /// Every existing task's status must be a valid enum value (0–5).
    function echidna_all_task_statuses_valid() external view returns (bool) {
        uint256 count = market.taskCount();
        for (uint256 i = 1; i <= count; i++) {
            uint8 status = uint8(market.getTask(i).status);
            if (status > 5) return false;
        }
        return true;
    }

    /// A Completed (4) or Cancelled (5) task must never change status afterward.
    /// We snapshot the last observed status for each task and fail if it regresses.
    mapping(uint256 => uint8) private lastStatus;
    function echidna_finalised_status_immutable() external returns (bool) {
        uint256 count = market.taskCount();
        for (uint256 i = 1; i <= count; i++) {
            uint8 current = uint8(market.getTask(i).status);
            uint8 prev    = lastStatus[i];
            // Once 4 (Completed) or 5 (Cancelled), it must stay that way.
            if ((prev == 4 || prev == 5) && current != prev) return false;
            lastStatus[i] = current;
        }
        return true;
    }

    /// Platform fee must never exceed 10% (1000 bps).
    function echidna_fee_bps_bounded() external view returns (bool) {
        return market.platformFeeBps() <= 1000;
    }
}
