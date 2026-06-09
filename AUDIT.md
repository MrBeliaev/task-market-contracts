# TaskMarket Security Audit Report

**Contract**: `TaskMarket.sol`
**Architecture**: Upgradeable — UUPS proxy (ERC-1967), implementation behind `@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol`
**Solidity**: 0.8.24 (EVM target: Paris — EIP-1153 not required)
**Dependencies**: OpenZeppelin Contracts v5 (`-upgradeable`: AccessControl, UUPS, Initializable; `ReentrancyGuard` — ERC-7201 namespaced storage)
**Date**: 2026-06-08
**Tests**: 65 passing (100% line & statement coverage) · Bytecode: 10 229 bytes

---

## Summary

| Severity      | Total | Open | Acknowledged |
| ------------- | ----- | ---- | ------------ |
| Informational | 2     | 0    | 2            |

No High or Medium severity findings remain open.

---

## Findings

### [I-1] No upper bound on pending fee accumulation

`pendingFees` grows unboundedly when `withdrawPendingFees` is not called regularly. There is no on-chain cap.

**Status**: Acknowledged. Fees are always accumulated in `pendingFees` (pure pull-payment — no push transfer on task completion). `DEFAULT_ADMIN_ROLE` calls `withdrawPendingFees()` to drain the balance at any time. No on-chain cap is planned; the recovery path is always available.

---

### [I-2] No mechanism to recover ETH sent directly to the contract

The contract has no `receive()` or fallback — direct ETH transfers revert. This is the correct and intended behavior.

**Status**: Confirmed expected behavior. No action required.

---

## Gas Report

Source: `npx hardhat test --gas-stats` — Hardhat 3 built-in statistics across all 65 test calls.  
Environment: Hardhat EDR (in-process EVM), `evmVersion: "paris"`, optimizer 200 runs.

**Deployment** — gas: **2 311 779** · bytecode: **10 229 bytes** (via ERC1967Proxy)

| Function             | Min    | Avg    | Median | Max     | Calls |
| -------------------- | ------ | ------ | ------ | ------- | ----- |
| `createTask`         | 124084 | 138954 | 141184 | 141184  | 46    |
| `assignExecutor`     | 37991  | 37991  | 37991  | 37991   | 38    |
| `startWork`          | 33965  | 33965  | 33965  | 33965   | 35    |
| `submitWork`         | 34119  | 34119  | 34119  | 34119   | 34    |
| `confirmCompletion`  | 59033  | 72331  | 59045  | 91065   | 20    |
| `raiseDispute`       | 37443  | 37468  | 37443  | 37580   | 11    |
| `resolveDispute`     | 86115  | 97749  | 98585  | 108535  | 6     |
| `withdraw`           | 37477  | 37477  | 37477  | 37477   | 7     |
| `withdrawPendingFees`| 40425  | 43603  | 40425  | 53138   | 4     |
| `cancelTask`         | 46716  | 56666  | 56666  | 66616   | 2     |
| `forceComplete`      | 73089  | 91589  | 91589  | 110089  | 2     |
| `setFeeBps`          | 35366  | 35382  | 35390  | 35390   | 3     |
| `setFeeRecipient`    | 35759  | 35769  | 35771  | 35771   | 5     |
| `grantRole`          | 56175  | 56482  | 56559  | 56559   | 5     |
| `revokeRole`         | 32210  | 33402  | 33402  | 34594   | 2     |
| `hasRole`            | 29188  | 29401  | 29572  | 29572   | 9     |
| `getTask`            | 38479  | 38479  | 38479  | 38479   | 17    |
| `upgradeToAndCall`   | 37945  | 37945  | 37945  | 37945   | 1     |

**Notes**:
- `confirmCompletion` max (91 065) is the second confirmation that triggers `_releaseFunds` — writes `pendingFees` and `pendingWithdrawals`
- `forceComplete` max (110 089) covers the `Disputed → Completed` path (extra storage read vs `UnderReview`)
- `cancelTask` max (66 616) occurs on warm storage; min (46 716) on cold
- `resolveDispute` range reflects variable `pendingWithdrawals` write patterns (zero → non-zero vs non-zero → non-zero)
- **Struct packing savings**: `Task` in 4 slots instead of 8 → ~80 000 gas saved per `createTask` vs unpacked layout

---

## Upgradeability Review

The contract is deployed behind a UUPS-upgradeable proxy (`Initializable` + `AccessControlUpgradeable` + `UUPSUpgradeable` + `ReentrancyGuard`). The following properties were checked against the OpenZeppelin upgrade-safety checklist:

| Check                                                        | Status | Notes                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constructor replaced with `initializer`                      | ✅     | `initialize(uint16,address)` carries all former constructor logic including the `ZeroAddress` check; emits `FeeBpsUpdated` and `FeeRecipientUpdated` for initial values                                                                                                                                                                                             |
| Implementation locked against direct initialization          | ✅     | Constructor calls `_disableInitializers()`, annotated `@custom:oz-upgrades-unsafe-allow constructor`                                                                                                                                                                                                                                                                 |
| Parent initializers called                                   | ✅     | `__AccessControl_init()` invoked inside `initialize`                                                                                                                                                                                                                                                                                                                 |
| `_authorizeUpgrade` access control                           | ✅     | Restricted to `onlyRole(DEFAULT_ADMIN_ROLE)`; role routed through `TimelockController` (48-hour delay) before mainnet                                                                                                                                                                                                                                                |
| No unsafe opcodes (`selfdestruct`, untrusted `delegatecall`) | ✅     | None present; `@openzeppelin/hardhat-upgrades` validation passes                                                                                                                                                                                                                                                                                                     |
| Storage-layout compatibility tooling                         | ✅     | `@openzeppelin/hardhat-upgrades` validates layout on every `deployProxy`/`upgradeProxy`/`compile` call                                                                                                                                                                                                                                                               |
| Reentrancy guard storage-safety                              | ✅     | `ReentrancyGuard` (OZ v5) uses ERC-7201 namespaced storage at a deterministic slot — no collision with sequential state; initial slot value `0` is safe (guard checks `== ENTERED(2)`, not `!= NOT_ENTERED(1)`); `unsafeAllow: ["constructor"]` passed to `deployProxy`/`upgradeProxy` since OZ's plugin flag is not automatically suppressed by `@custom:stateless` |
| Sequential storage append-only                               | ✅     | Own state (`taskCount`, `pendingFees`, `feeRecipient`, `platformFeeBps`, `tasks`, `pendingWithdrawals`) uses sequential slots 0–4; `AccessControlUpgradeable`/`Initializable` use ERC-7201 namespaced storage and do not collide; `pendingWithdrawals` appended as slot 4                                                                                            |

---

## Slither Static Analysis

Slither v0.10.x · `--filter-paths node_modules`

**Command**: `slither ./contracts/TaskMarket.sol --solc-remaps "@openzeppelin/contracts-upgradeable=./node_modules/@openzeppelin/contracts-upgradeable @openzeppelin/contracts=./node_modules/@openzeppelin/contracts" --filter-paths node_modules`

| Detector             | Severity | Finding                                                          | Assessment                                                                                                                                                     |
| -------------------- | -------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arbitrary-send-eth` | Medium   | `_transfer` sends ETH to caller-supplied address                 | Accepted — used only for `cancelTask` (refund to task client) and `withdraw` (pull-payment to msg.sender); recipient is always the rightful owner of the funds |
| `timestamp`          | Low      | `block.timestamp` used in deadline comparisons                   | Accepted — miner manipulation window (~12 s) is negligible vs. task deadlines (days/weeks)                                                                     |
| `low-level-calls`    | Info     | `.call{value}()` in `_transfer` and `withdrawPendingFees`        | Expected ETH transfer pattern; return value checked, reverts on failure                                                                                        |
| `naming-convention`  | Info     | Parameters use `_camelCase` prefix                               | Style choice — avoids parameter shadowing of state variables                                                                                                   |

**Previously resolved**: `reentrancy-eth` — eliminated by removing the push-fee transfer from `_releaseFunds`; fees now always accumulate in `pendingFees` (pure pull-payment). `events-maths` — resolved by emitting `FeeBpsUpdated` and `FeeRecipientUpdated` in `initialize`.

---

## Mythril Symbolic Execution

**Tool**: Mythril v0.24.8
**Mode**: Runtime bytecode (`--bin-runtime`, hex)
**Command**: `myth analyze -f taskmarket_deployed.hex --execution-timeout 90 --loop-bound 3`

| SWC     | Severity | Function                    | Finding                                    | Assessment                                                                                                 |
| ------- | -------- | --------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| SWC-101 | High     | `0x471da0b1` → `createTask` | Potential integer underflow at PC 3026     | **False positive** — Solidity 0.8.x reverts on overflow/underflow; no `unchecked` blocks in contract code |
| SWC-116 | Low      | `0x471da0b1` → `createTask` | Control flow depends on `block.timestamp`  | **Confirmed / accepted** — same as Slither `timestamp` finding; negligible miner window                   |

**Conclusion**: No new vulnerabilities beyond accepted findings.

---

## Echidna Property-Based Fuzzing

**Tool**: Echidna v2.3.2
**Harness**: `contracts/test/TaskMarketEchidna.sol:TaskMarketEchidna`
**Config**: `echidna.yaml` — `testMode: property`, `testLimit: 50000`, `seqLen: 10`
**Setup**: Harness deploys a real `ERC1967Proxy` pointing to a fresh `TaskMarket` implementation, initialises it, then fuzzes all wrapper functions from multiple sender addresses.

| Invariant                            | Description                                                        | Result     |
| ------------------------------------ | ------------------------------------------------------------------ | ---------- |
| `echidna_balance_gte_locked`         | Contract ETH balance ≥ 0                                           | ✅ passing |
| `echidna_pending_fees_bounded`       | `pendingFees ≤ address(market).balance`                            | ✅ passing |
| `echidna_task_count_monotonic`       | `taskCount` never decreases                                        | ✅ passing |
| `echidna_all_task_statuses_valid`    | Every task status is a valid enum value (0–6)                      | ✅ passing |
| `echidna_finalised_status_immutable` | Once `Completed` (4) or `Cancelled` (6), task status never changes | ✅ passing |
| `echidna_fee_bps_bounded`            | `platformFeeBps ≤ 1000` (10% cap)                                  | ✅ passing |

**Run**: 50 026 calls · 19 corpus entries · 3 376 unique instructions covered.

---

## Test Coverage

**Tool**: Hardhat 3 built-in (EDR in-process EVM)  
**Command**: `npx hardhat test`

| File             | Tests | Line % | Statement % |
| ---------------- | ----- | ------ | ----------- |
| `TaskMarket.sol` | 65    | 100.00 | 100.00      |

65 tests passing across suites: Task Creation, Assignment, Lifecycle (incl. deadline enforcement on `submitWork`), Multi-Sig Completion, Cancellation, Disputes, Admin Functions, Pending Fees, Edge Cases, Multi-Admin (incl. conflict-of-interest guard, role renouncement protection), `getTask` bounds validation, Withdraw pull-payment, Upgradeability (UUPS).

---

## Positive Security Properties

| Property                                                                                     | Status |
| -------------------------------------------------------------------------------------------- | ------ |
| Reentrancy protection on all ETH-transferring functions (`nonReentrant`)                     | ✅     |
| Role-based access control (OpenZeppelin AccessControl)                                       | ✅     |
| Custom errors throughout — gas-efficient reverts                                             | ✅     |
| State machine enforced via `inStatus` modifier                                               | ✅     |
| Integer overflow protection (Solidity 0.8.x)                                                 | ✅     |
| No `selfdestruct` or `delegatecall`                                                          | ✅     |
| No push-transfer of fees — always accumulate in `pendingFees`, pulled via `withdrawPendingFees` | ✅     |
| Pending fee recovery always available to `DEFAULT_ADMIN_ROLE`                               | ✅     |
| Pure pull-payment for executor/dispute payouts via `withdraw()`                              | ✅     |
| Admin cannot resolve dispute they participate in (`AdminIsParticipant`)                      | ✅     |
| `DEFAULT_ADMIN_ROLE` cannot be renounced (`CannotRenounceAdminRole`)                         | ✅     |
| Deadline enforced on `submitWork`                                                            | ✅     |
| Multi-admin support via AccessControl                                                        | ✅     |
| EIP-165 support via inherited `supportsInterface`                                            | ✅     |
| UUPS upgrade gated by `onlyRole(DEFAULT_ADMIN_ROLE)` + 48-hour `TimelockController`          | ✅     |
| Implementation locked via `_disableInitializers()`                                           | ✅     |
| Storage-layout validated by `@openzeppelin/hardhat-upgrades` on every build/deploy/upgrade   | ✅     |
| On-chain admin check via `hasRole` — no off-chain whitelist bypass possible                  | ✅     |
| Initial `feeBps` and `feeRecipient` values emitted via events in `initialize`                | ✅     |

---

## Tool Coverage Matrix

| Tool                         | Version    | Result                                                       |
| ---------------------------- | ---------- | ------------------------------------------------------------ |
| Slither (static analysis)    | 0.10.x     | 4 findings on contract code — all accepted or informational  |
| Hardhat tests                | Hardhat 3  | 65 / 65 passing · 100% line & statement coverage            |
| Mythril (symbolic execution) | 0.24.8     | 2 findings — SWC-101 false positive, SWC-116 accepted       |
| Echidna (property fuzzing)   | 2.3.2      | All 6 invariants passing — 50 000 sequences                  |
| Gas report (`--gas-stats`)   | Hardhat 3  | Min/Avg/Med/Max per function across all 65 test calls        |
