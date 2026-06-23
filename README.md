# TaskMarket — Smart Contract

Decentralized task marketplace on EVM. Clients lock ETH in escrow; both parties must confirm completion before funds are released. Admins resolve disputes.

The contract is **upgradeable** — deployed behind a UUPS (ERC-1967) proxy, so the logic can evolve without migrating escrowed funds or task data to a new address.

## Stack

- Solidity 0.8.24 (EVM target: Paris)
- Hardhat 3 + TypeScript (ESM)
- OpenZeppelin Contracts v5 (`-upgradeable`: AccessControl, UUPS, Initializable; `ReentrancyGuard` from the base package — ERC-7201 namespaced storage)
- `@openzeppelin/hardhat-upgrades` for proxy deployment, upgrades and storage-layout validation
- TypeChain for typed contract bindings

## Setup

```bash
npm install
npx hardhat compile
npx hardhat test             # 91 tests, 100% line/statement coverage
npx hardhat test --gas-stats # same + per-function gas breakdown
```

## Deploy

Deployment publishes the implementation contract and an ERC-1967 (UUPS) proxy in front of it, then calls `initialize(feeBps, feeRecipient)` through the proxy. Always interact with the **proxy address** — that's the contract's permanent address.

```bash
# Local node
npx hardhat node
npx hardhat run scripts/deploy.ts --network localhost

# Sepolia testnet (requires .env)
npx hardhat run scripts/deploy.ts --network sepolia
```

**.env**:
```
SEPOLIA_RPC_URL=https://...
DEPLOYER_PRIVATE_KEY=0x...
ETHERSCAN_API_KEY=...
```

## Upgrading

Only an account holding `DEFAULT_ADMIN_ROLE` can authorize an upgrade (`_authorizeUpgrade` is gated by `onlyRole(DEFAULT_ADMIN_ROLE)`).

```ts
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

const connection = await hre.network.create();
const api = await upgrades(hre, connection);

const TaskMarketV2 = await connection.ethers.getContractFactory("TaskMarketV2");
await api.upgradeProxy(PROXY_ADDRESS, TaskMarketV2);
```

The `@openzeppelin/hardhat-upgrades` plugin validates the new implementation for storage-layout compatibility and unsafe patterns (constructors, `selfdestruct`, `delegatecall`) before deploying it. Rules to keep in mind for any `V2`:

- Never reorder, remove, or change the type of existing state variables — only **append** new ones at the end.
- Replace constructor logic with an `initializer`/`reinitializer(n)` function; never set initial values in field declarations.
- If `V2` needs new initialization logic, expose it via `reinitializer(2)` (the original `initialize` can only run once).

## Task Lifecycle

```
Open ──► Assigned ──► InProgress ──► UnderReview ──► Completed
 │                                        │
 └─► Cancelled (full refund)         Disputed ──► Completed (admin arbitration)
```

## Roles

| Role | Assigned to | Capabilities |
|------|-------------|-------------|
| `DEFAULT_ADMIN_ROLE` | Deployer | Manage roles, update fees, withdraw pending fees, **authorize contract upgrades** |
| `ADMIN_ROLE` | Deployer + granted accounts | Resolve disputes, force-complete stuck tasks |

Roles are managed via OpenZeppelin `AccessControl` (`grantRole` / `revokeRole`).

## Functions

### Client

| Function | Description |
|----------|-------------|
| `createTask(deadline, metadataHash)` | Create task, lock ETH in escrow |
| `assignExecutor(taskId, executor)` | Assign executor to open task |
| `cancelTask(taskId)` | Cancel open task, refund ETH |
| `confirmCompletion(taskId)` | Confirm work is done (both parties must confirm) |
| `raiseDispute(taskId)` | Raise dispute on `UnderReview` task, or on expired `InProgress` task |

### Executor / Dispute Participant

| Function | Description |
|----------|-------------|
| `startWork(taskId)` | Mark task as in progress (reverts if deadline passed) |
| `submitWork(taskId)` | Submit work for review (reverts if deadline passed) |
| `confirmCompletion(taskId)` | Confirm completion (triggers payout credit when both confirmed) |
| `raiseDispute(taskId)` | Raise dispute on `UnderReview` task, or on expired `InProgress` task |
| `withdraw()` | Pull pending payout from `pendingWithdrawals` (pull-payment pattern) |

### Admin (`ADMIN_ROLE`)

| Function | Description |
|----------|-------------|
| `resolveDispute(taskId, clientBps)` | Split escrowed ETH by basis points (0–10000) |
| `forceComplete(taskId)` | Force-complete a stuck task, pay executor in full |

### Owner (`DEFAULT_ADMIN_ROLE`)

| Function | Description |
|----------|-------------|
| `setFeeBps(bps)` | Set platform fee (max 1000 = 10%) |
| `setFeeRecipient(address)` | Set fee recipient address |
| `withdrawPendingFees()` | Withdraw accumulated fees from failed transfers |
| `upgradeToAndCall(newImplementation, data)` | Upgrade the proxy's implementation (UUPS, inherited from `UUPSUpgradeable`) |

## Fee Mechanism

On task completion a platform fee (default 2.5%) is deducted from the payout.

If the fee transfer to `feeRecipient` fails (e.g. the recipient is a contract that rejects ETH), the fee accumulates in `pendingFees` and can be recovered via `withdrawPendingFees()`. The executor's payout is never blocked by a fee transfer failure.

## Storage Layout

The `Task` struct is packed into 4 EVM slots (down from 8 unpacked):

```
Slot 1  id                              uint256 (32 B)
Slot 2  client (20 B) + reward (12 B)   address + uint96
Slot 3  executor (20 B) + status (1 B) + clientConfirmed (1 B)
        + executorConfirmed (1 B) + feeBps (2 B) + deadline (4 B)
Slot 4  metadataHash                    bytes32 (32 B)
```

## Security

See [AUDIT.md](./AUDIT.md) for the full security audit report including Slither static analysis results.

Key properties:
- All ETH-transferring functions protected by `nonReentrant`
- State updated before external calls (CEI pattern)
- Custom errors throughout for gas-efficient reverts
- `inStatus` modifier enforces valid state transitions
- Pull-payment pattern for executor/dispute payouts — no push-transfer failure can lock a task
- Deadline enforced on both `startWork` and `submitWork`; admin cannot resolve a dispute they participate in
- Implementation contract is locked via `_disableInitializers()` in its constructor — only the proxy can be initialized
- Upgrades are gated behind `_authorizeUpgrade` with `onlyRole(DEFAULT_ADMIN_ROLE)`
- `DEFAULT_ADMIN_ROLE` cannot be renounced (override blocks it); transfer to a new account is still possible

## Security Analysis

```bash
# Slither static analysis
slither ./contracts/TaskMarket.sol \
  --solc-remaps "@openzeppelin/contracts-upgradeable=./node_modules/@openzeppelin/contracts-upgradeable @openzeppelin/contracts=./node_modules/@openzeppelin/contracts" \
  --solc-args "--evm-version cancun --include-path ./node_modules --base-path ."

# Mythril symbolic execution (runtime bytecode — EIP-1153 opcodes not supported by Laser EVM)
# First export runtime bytecode: python3 -c "import json; print(json.load(open('artifacts/contracts/TaskMarket.sol/TaskMarket.json'))['deployedBytecode'].lstrip('0x'))" > taskmarket.bin
myth analyze -f taskmarket.bin --bin-runtime --execution-timeout 180

# Echidna property-based fuzzing (requires echidna v2.3.2+)
echidna . --contract TaskMarketEchidna --config echidna.yaml \
  --crytic-args "--compile-force-framework hardhat"
```
