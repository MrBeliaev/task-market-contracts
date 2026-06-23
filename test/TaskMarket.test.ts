import { expect } from "chai";
import hre from "hardhat";
import { upgrades, type HardhatUpgrades } from "@openzeppelin/hardhat-upgrades";
import { keccak256, parseEther, toUtf8Bytes, ZeroAddress } from "ethers";
import { type TaskMarket, TaskMarket__factory } from "../typechain-types/index.js";
import type { HardhatEthersSigner, HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import type { EthereumProvider } from "hardhat/types/providers";

const FEE_BPS = 250n;
const ONE_ETH = parseEther("1");
const METADATA_HASH = keccak256(toUtf8Bytes("test metadata"));

describe("TaskMarket", function () {
  let taskMarket: TaskMarket;
  let owner: HardhatEthersSigner;
  let client: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let ethers: HardhatEthers;
  let provider: EthereumProvider;
  let api: HardhatUpgrades;

  before(async function () {
    const connection = await hre.network.create();
    ({ ethers, provider } = connection);
    api = await upgrades(hre, connection);
  });

  beforeEach(async function () {
    [owner, client, executor, other] = await ethers.getSigners();
    taskMarket = (await api.deployProxy(new TaskMarket__factory(owner), [FEE_BPS, owner.address], {
      kind: "uups",
      unsafeAllow: ["constructor"],
    })) as unknown as TaskMarket;
    await taskMarket.waitForDeployment();
  });

  describe("Initialization", function () {
    it("should revert deployment with zero fee recipient", async function () {
      await expect(
        api.deployProxy(new TaskMarket__factory(owner), [FEE_BPS, ZeroAddress], { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.revertedWithCustomError(taskMarket, "ZeroAddress");
    });
  });

  describe("Task Creation", function () {
    it("should create a task with correct params", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;

      await expect(
        taskMarket.connect(client).createTask(deadline, METADATA_HASH, {
          value: ONE_ETH,
        })
      )
        .to.emit(taskMarket, "TaskCreated")
        .withArgs(1, client.address, ONE_ETH, deadline, METADATA_HASH);

      const task = await taskMarket.getTask(1);
      expect(task.client).to.equal(client.address);
      expect(task.reward).to.equal(ONE_ETH);
      expect(task.status).to.equal(0);
    });

    it("should revert if no ETH sent", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await expect(
        taskMarket.connect(client).createTask(deadline, METADATA_HASH)
      ).to.be.revertedWithCustomError(taskMarket, "InsufficientReward");
    });

    it("should revert if deadline is in the past", async function () {
      const pastDeadline = Math.floor(Date.now() / 1000) - 1000;
      await expect(
        taskMarket.connect(client).createTask(pastDeadline, METADATA_HASH, { value: ONE_ETH })
      ).to.be.revertedWithCustomError(taskMarket, "DeadlinePassed");
    });
  });

  describe("Task Assignment", function () {
    let deadline: number;

    beforeEach(async function () {
      deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
    });

    it("should assign executor", async function () {
      await expect(taskMarket.connect(client).assignExecutor(1, executor.address))
        .to.emit(taskMarket, "TaskAssigned")
        .withArgs(1, executor.address);

      const task = await taskMarket.getTask(1);
      expect(task.executor).to.equal(executor.address);
      expect(task.status).to.equal(1);
    });

    it("should revert if non-client tries to assign", async function () {
      await expect(
        taskMarket.connect(other).assignExecutor(1, executor.address)
      ).to.be.revertedWithCustomError(taskMarket, "NotClient");
    });
  });

  describe("Task Lifecycle", function () {
    let deadline: number;

    beforeEach(async function () {
      deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
    });

    it("should progress through statuses", async function () {
      await taskMarket.connect(executor).startWork(1);
      expect((await taskMarket.getTask(1)).status).to.equal(2);

      await taskMarket.connect(executor).submitWork(1);
      expect((await taskMarket.getTask(1)).status).to.equal(3);
    });

    it("should not allow non-executor to start work", async function () {
      await expect(taskMarket.connect(other).startWork(1))
        .to.be.revertedWithCustomError(taskMarket, "NotExecutor");
    });

    it("should revert startWork if deadline has passed", async function () {
      const snapshotId = (await provider.request({ method: "evm_snapshot", params: [] })) as string;
      await provider.request({ method: "evm_increaseTime", params: [86401] });
      await provider.request({ method: "evm_mine", params: [] });

      await expect(taskMarket.connect(executor).startWork(1))
        .to.be.revertedWithCustomError(taskMarket, "DeadlinePassed");

      await provider.request({ method: "evm_revert", params: [snapshotId] });
    });

    it("should revert submitWork if deadline has passed", async function () {
      await taskMarket.connect(executor).startWork(1);

      const snapshotId = (await provider.request({ method: "evm_snapshot", params: [] })) as string;
      await provider.request({ method: "evm_increaseTime", params: [86401] });
      await provider.request({ method: "evm_mine", params: [] });

      await expect(taskMarket.connect(executor).submitWork(1))
        .to.be.revertedWithCustomError(taskMarket, "DeadlinePassed");

      await provider.request({ method: "evm_revert", params: [snapshotId] });
    });
  });

  describe("Multi-Sig Completion", function () {
    let deadline: number;

    beforeEach(async function () {
      deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
    });

    it("should release funds after both confirmations", async function () {
      await taskMarket.connect(client).confirmCompletion(1);

      let task = await taskMarket.getTask(1);
      expect(task.clientConfirmed).to.be.true;
      expect(task.executorConfirmed).to.be.false;
      expect(task.status).to.equal(3);

      await taskMarket.connect(executor).confirmCompletion(1);
      task = await taskMarket.getTask(1);
      expect(task.status).to.equal(4);

      const expectedFee = (ONE_ETH * FEE_BPS) / 10000n;
      const expectedPayout = ONE_ETH - expectedFee;

      expect(await taskMarket.pendingWithdrawals(executor.address)).to.equal(expectedPayout);

      const executorBalBefore = await ethers.provider.getBalance(executor.address);
      const wtx = await taskMarket.connect(executor).withdraw();
      const wreceipt = await wtx.wait();
      const wGasUsed = BigInt(wreceipt!.gasUsed * wreceipt!.gasPrice);
      const executorBalAfter = await ethers.provider.getBalance(executor.address);
      expect(executorBalAfter - executorBalBefore + wGasUsed).to.equal(expectedPayout);
    });

    it("should revert if non-participant tries to confirm", async function () {
      await expect(taskMarket.connect(other).confirmCompletion(1))
        .to.be.revertedWithCustomError(taskMarket, "NotParticipant");
    });
  });

  describe("Cancellation", function () {
    it("should credit pendingWithdrawals on cancellation (pull-payment)", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });

      await taskMarket.connect(client).cancelTask(1);
      expect(await taskMarket.pendingWithdrawals(client.address)).to.equal(ONE_ETH);
      expect((await taskMarket.getTask(1)).status).to.equal(6);

      // client can then withdraw
      const balBefore = await ethers.provider.getBalance(client.address);
      const tx = await taskMarket.connect(client).withdraw();
      const receipt = await tx.wait();
      const gasUsed = BigInt(receipt!.gasUsed * receipt!.gasPrice);
      const balAfter = await ethers.provider.getBalance(client.address);
      expect(balAfter - balBefore + gasUsed).to.equal(ONE_ETH);
    });
  });

  describe("Disputes", function () {
    beforeEach(async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
    });

    it("should allow dispute raising", async function () {
      await expect(taskMarket.connect(client).raiseDispute(1))
        .to.emit(taskMarket, "TaskDisputed")
        .withArgs(1, client.address);

      expect((await taskMarket.getTask(1)).status).to.equal(5);
    });

    it("should allow owner to resolve dispute", async function () {
      await taskMarket.connect(client).raiseDispute(1);
      await taskMarket.connect(owner).resolveDispute(1, 7000);
      expect((await taskMarket.getTask(1)).status).to.equal(4);
    });

    it("should revert dispute if non-participant", async function () {
      await expect(taskMarket.connect(other).raiseDispute(1))
        .to.be.revertedWithCustomError(taskMarket, "NotParticipant");
    });

    it("should revert resolveDispute if not admin", async function () {
      await taskMarket.connect(client).raiseDispute(1);
      await expect(taskMarket.connect(client).resolveDispute(1, 5000))
        .to.be.revertedWithCustomError(taskMarket, "AccessControlUnauthorizedAccount");
    });

    it("should revert resolveDispute with invalid bps", async function () {
      await taskMarket.connect(client).raiseDispute(1);
      await expect(taskMarket.connect(owner).resolveDispute(1, 10001))
        .to.be.revertedWithCustomError(taskMarket, "InvalidBps");
    });

    it("should correctly split funds on dispute resolution", async function () {
      await taskMarket.connect(executor).raiseDispute(1);
      await taskMarket.connect(owner).resolveDispute(1, 6000);

      const fee = (ONE_ETH * FEE_BPS) / 10000n;
      const remainder = ONE_ETH - fee;
      const expectedClientRefund = (remainder * 6000n) / 10000n;
      const expectedExecutorPayout = remainder - expectedClientRefund;

      expect(await taskMarket.pendingWithdrawals(client.address)).to.equal(expectedClientRefund);
      expect(await taskMarket.pendingWithdrawals(executor.address)).to.equal(expectedExecutorPayout);

      const clientBalBefore = await ethers.provider.getBalance(client.address);
      const clientTx = await taskMarket.connect(client).withdraw();
      const clientReceipt = await clientTx.wait();
      const clientGas = BigInt(clientReceipt!.gasUsed * clientReceipt!.gasPrice);
      const clientBalAfter = await ethers.provider.getBalance(client.address);
      expect(clientBalAfter - clientBalBefore + clientGas).to.equal(expectedClientRefund);

      const execBalBefore = await ethers.provider.getBalance(executor.address);
      const execTx = await taskMarket.connect(executor).withdraw();
      const execReceipt = await execTx.wait();
      const execGas = BigInt(execReceipt!.gasUsed * execReceipt!.gasPrice);
      const execBalAfter = await ethers.provider.getBalance(executor.address);
      expect(execBalAfter - execBalBefore + execGas).to.equal(expectedExecutorPayout);
    });

    it("should handle 100% client refund on dispute", async function () {
      await taskMarket.connect(client).raiseDispute(1);
      await taskMarket.connect(owner).resolveDispute(1, 10000);
      expect((await taskMarket.getTask(1)).status).to.equal(4);
    });

    it("should handle 0% client refund on dispute", async function () {
      await taskMarket.connect(client).raiseDispute(1);
      await taskMarket.connect(owner).resolveDispute(1, 0);
      expect((await taskMarket.getTask(1)).status).to.equal(4);
    });
  });

  describe("Admin Functions", function () {
    it("should allow owner to change fee", async function () {
      await taskMarket.connect(owner).setFeeBps(500);
      expect(await taskMarket.platformFeeBps()).to.equal(500);
    });

    it("should revert setFeeBps if too high", async function () {
      await expect(taskMarket.connect(owner).setFeeBps(1001))
        .to.be.revertedWithCustomError(taskMarket, "InvalidBps");
    });

    it("should revert setFeeBps if not owner", async function () {
      await expect(taskMarket.connect(other).setFeeBps(100))
        .to.be.revertedWithCustomError(taskMarket, "AccessControlUnauthorizedAccount");
    });

    it("should allow owner to change fee recipient", async function () {
      await taskMarket.connect(owner).setFeeRecipient(other.address);
      expect(await taskMarket.feeRecipient()).to.equal(other.address);
    });

    it("should revert setFeeRecipient with zero address", async function () {
      await expect(taskMarket.connect(owner).setFeeRecipient(ZeroAddress))
        .to.be.revertedWithCustomError(taskMarket, "ZeroAddress");
    });

    it("should revert setFeeRecipient if not owner", async function () {
      await expect(taskMarket.connect(other).setFeeRecipient(other.address))
        .to.be.revertedWithCustomError(taskMarket, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Gas Optimization — Struct Packing", function () {
    it("should reject reward larger than uint96 max", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      const tooLarge = BigInt("0x10000000000000000000000000");

      await provider.request({
        method: "hardhat_setBalance",
        params: [client.address, "0x" + (tooLarge + parseEther("1")).toString(16)],
      });

      await expect(
        taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: tooLarge })
      ).to.be.revertedWithCustomError(taskMarket, "RewardTooLarge");
    });

    it("should reject deadline beyond 2-year cap", async function () {
      const block = await ethers.provider.getBlock("latest");
      const threeYears = Number(block!.timestamp) + 3 * 365 * 86400;
      await expect(
        taskMarket.connect(client).createTask(threeYears, METADATA_HASH, { value: ONE_ETH })
      ).to.be.revertedWithCustomError(taskMarket, "DeadlineTooFar");
    });
  });

  describe("ExecutorCannotBeClient guard", function () {
    it("should revert when client tries to assign themselves as executor", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await expect(taskMarket.connect(client).assignExecutor(1, client.address))
        .to.be.revertedWithCustomError(taskMarket, "ExecutorCannotBeClient");
    });
  });

  describe("Pending fees — feeRecipient failure recovery", function () {
    it("should accumulate fees in pendingFees if feeRecipient reverts", async function () {
      const RejectETH = await ethers.deployContract("RejectETH");
      await taskMarket.connect(owner).setFeeRecipient(await RejectETH.getAddress());

      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(client).confirmCompletion(1);
      await taskMarket.connect(executor).confirmCompletion(1);

      const expectedFee = (ONE_ETH * FEE_BPS) / 10000n;
      expect(await taskMarket.pendingFees()).to.equal(expectedFee);
      expect((await taskMarket.getTask(1)).status).to.equal(4);
    });

    it("should no-op when withdrawing pending fees with zero balance", async function () {
      const balBefore = await ethers.provider.getBalance(owner.address);
      const tx = await taskMarket.connect(owner).withdrawPendingFees();
      const receipt = await tx.wait();
      const gasUsed = BigInt(receipt!.gasUsed * receipt!.gasPrice);
      const balAfter = await ethers.provider.getBalance(owner.address);

      expect(await taskMarket.pendingFees()).to.equal(0);
      expect(balBefore - balAfter).to.equal(gasUsed);
    });

    it("should allow owner to withdraw accumulated pending fees", async function () {
      const RejectETH = await ethers.deployContract("RejectETH");
      await taskMarket.connect(owner).setFeeRecipient(await RejectETH.getAddress());

      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(client).confirmCompletion(1);
      await taskMarket.connect(executor).confirmCompletion(1);

      await taskMarket.connect(owner).setFeeRecipient(owner.address);
      const balBefore = await ethers.provider.getBalance(owner.address);
      const tx = await taskMarket.connect(owner).withdrawPendingFees();
      const receipt = await tx.wait();
      const gasUsed = BigInt(receipt!.gasUsed * receipt!.gasPrice);
      const balAfter = await ethers.provider.getBalance(owner.address);

      const expectedFee = (ONE_ETH * FEE_BPS) / 10000n;
      expect(balAfter - balBefore + gasUsed).to.equal(expectedFee);
      expect(await taskMarket.pendingFees()).to.equal(0);
    });
  });

  describe("Edge Cases", function () {
    let deadline: number;

    beforeEach(async function () {
      deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
    });

    it("should revert assigning zero address as executor", async function () {
      const d = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(d, METADATA_HASH, { value: ONE_ETH });
      await expect(taskMarket.connect(client).assignExecutor(2, ZeroAddress))
        .to.be.revertedWithCustomError(taskMarket, "ZeroAddress");
    });

    it("should not allow cancellation in UnderReview (not expired)", async function () {
      await expect(taskMarket.connect(client).cancelTask(1))
        .to.be.revertedWithCustomError(taskMarket, "DeadlineNotExpired");
    });

    it("should not allow startWork if not Assigned", async function () {
      await expect(taskMarket.connect(executor).startWork(1))
        .to.be.revertedWithCustomError(taskMarket, "InvalidStatus");
    });

    it("should not allow submitWork if not InProgress", async function () {
      await expect(taskMarket.connect(executor).submitWork(1))
        .to.be.revertedWithCustomError(taskMarket, "InvalidStatus");
    });

    it("should not allow double confirmation by same party (client)", async function () {
      await taskMarket.connect(client).confirmCompletion(1);
      await expect(taskMarket.connect(client).confirmCompletion(1))
        .to.be.revertedWithCustomError(taskMarket, "AlreadyConfirmed");
    });

    it("should not allow double confirmation by same party (executor)", async function () {
      await taskMarket.connect(executor).confirmCompletion(1);
      await expect(taskMarket.connect(executor).confirmCompletion(1))
        .to.be.revertedWithCustomError(taskMarket, "AlreadyConfirmed");
    });

    it("should accumulate fee in pendingFees on completion (pull-payment)", async function () {
      const expectedFee = (ONE_ETH * FEE_BPS) / 10000n;
      await taskMarket.connect(client).confirmCompletion(1);
      await taskMarket.connect(executor).confirmCompletion(1);
      expect(await taskMarket.pendingFees()).to.equal(expectedFee);

      // feeRecipient balance unchanged until withdrawPendingFees is called
      const balBefore = await ethers.provider.getBalance(owner.address);
      const tx = await taskMarket.connect(owner).withdrawPendingFees();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(owner.address);
      expect(balAfter - balBefore + gasCost).to.equal(expectedFee);
      expect(await taskMarket.pendingFees()).to.equal(0n);
    });

    it("should handle zero-fee scenario", async function () {
      await taskMarket.connect(owner).setFeeBps(0);

      const d = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(d, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(2, executor.address);
      await taskMarket.connect(executor).startWork(2);
      await taskMarket.connect(executor).submitWork(2);

      await taskMarket.connect(client).confirmCompletion(2);
      await taskMarket.connect(executor).confirmCompletion(2);

      expect(await taskMarket.pendingWithdrawals(executor.address)).to.equal(ONE_ETH);

      const executorBal = await ethers.provider.getBalance(executor.address);
      const tx = await taskMarket.connect(executor).withdraw();
      const receipt = await tx.wait();
      const gasUsed = BigInt(receipt!.gasUsed * receipt!.gasPrice);
      const executorBalAfter = await ethers.provider.getBalance(executor.address);
      expect(executorBalAfter - executorBal + gasUsed).to.equal(ONE_ETH);
    });

    it("should not allow raiseDispute if task not UnderReview", async function () {
      const d = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(d, METADATA_HASH, { value: ONE_ETH });
      await expect(taskMarket.connect(client).raiseDispute(2))
        .to.be.revertedWithCustomError(taskMarket, "InvalidStatus");
    });

    it("should credit pendingWithdrawals for contract client on cancel (pull-payment)", async function () {
      const RejectETH = await ethers.deployContract("RejectETH");
      const rejectAddress = await RejectETH.getAddress();
      const marketAddress = await taskMarket.getAddress();

      const d = Math.floor(Date.now() / 1000) + 86400;
      await RejectETH.connect(client).createTask(marketAddress, d, METADATA_HASH, { value: ONE_ETH });

      const newTaskId = await taskMarket.taskCount();
      expect((await taskMarket.getTask(newTaskId)).client).to.equal(rejectAddress);

      await RejectETH.connect(client).cancelTask(marketAddress, newTaskId);
      expect(await taskMarket.pendingWithdrawals(rejectAddress)).to.equal(ONE_ETH);
    });

    it("executor confirms first, then client triggers payout", async function () {
      await taskMarket.connect(executor).confirmCompletion(1);

      let task = await taskMarket.getTask(1);
      expect(task.executorConfirmed).to.be.true;
      expect(task.clientConfirmed).to.be.false;
      expect(task.status).to.equal(3);

      await taskMarket.connect(client).confirmCompletion(1);
      task = await taskMarket.getTask(1);
      expect(task.status).to.equal(4);
    });
  });

  describe("Multi-Admin system", function () {
    let ADMIN_ROLE: string;
    let DEFAULT_ADMIN_ROLE: string;

    beforeEach(async function () {
      ADMIN_ROLE         = await taskMarket.ADMIN_ROLE();
      DEFAULT_ADMIN_ROLE = await taskMarket.DEFAULT_ADMIN_ROLE();
    });

    it("deployer has DEFAULT_ADMIN_ROLE and ADMIN_ROLE", async function () {
      expect(await taskMarket.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
      expect(await taskMarket.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("non-owner has no roles by default", async function () {
      expect(await taskMarket.hasRole(ADMIN_ROLE, other.address)).to.be.false;
      expect(await taskMarket.hasRole(DEFAULT_ADMIN_ROLE, other.address)).to.be.false;
    });

    it("owner can grant ADMIN_ROLE", async function () {
      await expect(taskMarket.connect(owner).grantRole(ADMIN_ROLE, other.address))
        .to.emit(taskMarket, "RoleGranted")
        .withArgs(ADMIN_ROLE, other.address, owner.address);
      expect(await taskMarket.hasRole(ADMIN_ROLE, other.address)).to.be.true;
    });

    it("owner can revoke ADMIN_ROLE", async function () {
      await taskMarket.connect(owner).grantRole(ADMIN_ROLE, other.address);
      await expect(taskMarket.connect(owner).revokeRole(ADMIN_ROLE, other.address))
        .to.emit(taskMarket, "RoleRevoked")
        .withArgs(ADMIN_ROLE, other.address, owner.address);
      expect(await taskMarket.hasRole(ADMIN_ROLE, other.address)).to.be.false;
    });

    it("non-owner cannot grant roles", async function () {
      await expect(taskMarket.connect(other).grantRole(ADMIN_ROLE, client.address))
        .to.be.revertedWithCustomError(taskMarket, "AccessControlUnauthorizedAccount");
    });

    it("assigned admin can resolve disputes", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(client).raiseDispute(1);

      await taskMarket.connect(owner).grantRole(ADMIN_ROLE, other.address);

      await expect(taskMarket.connect(other).resolveDispute(1, 5000))
        .to.emit(taskMarket, "DisputeResolved");
      expect((await taskMarket.getTask(1)).status).to.equal(4);
    });

    it("assigned admin can force-complete a task", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);

      await taskMarket.connect(owner).grantRole(ADMIN_ROLE, other.address);

      await expect(taskMarket.connect(other).forceComplete(1))
        .to.emit(taskMarket, "TaskCompleted");
      expect((await taskMarket.getTask(1)).status).to.equal(4);
    });

    it("should revert forceComplete if task is not UnderReview/Disputed", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);

      await expect(taskMarket.connect(owner).forceComplete(1))
        .to.be.revertedWithCustomError(taskMarket, "TaskNotResolvable");
    });

    it("non-admin cannot call resolveDispute", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(client).raiseDispute(1);

      await expect(taskMarket.connect(other).resolveDispute(1, 5000))
        .to.be.revertedWithCustomError(taskMarket, "AccessControlUnauthorizedAccount");
    });

    it("DEFAULT_ADMIN_ROLE can be transferred", async function () {
      await taskMarket.connect(owner).grantRole(DEFAULT_ADMIN_ROLE, other.address);
      await taskMarket.connect(owner).revokeRole(DEFAULT_ADMIN_ROLE, owner.address);

      expect(await taskMarket.hasRole(DEFAULT_ADMIN_ROLE, other.address)).to.be.true;
      expect(await taskMarket.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;
    });

    it("should revert resolveDispute if admin is the task client", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(owner).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(owner).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(executor).raiseDispute(1);

      await expect(taskMarket.connect(owner).resolveDispute(1, 5000))
        .to.be.revertedWithCustomError(taskMarket, "AdminIsParticipant");
    });

    it("should revert renounceRole for DEFAULT_ADMIN_ROLE", async function () {
      await expect(taskMarket.connect(owner).renounceRole(DEFAULT_ADMIN_ROLE, owner.address))
        .to.be.revertedWithCustomError(taskMarket, "CannotRenounceAdminRole");
    });

    it("should allow renouncing ADMIN_ROLE", async function () {
      await expect(taskMarket.connect(owner).renounceRole(ADMIN_ROLE, owner.address))
        .to.emit(taskMarket, "RoleRevoked")
        .withArgs(ADMIN_ROLE, owner.address, owner.address);
      expect(await taskMarket.hasRole(ADMIN_ROLE, owner.address)).to.be.false;
    });
  });

  describe("getTask bounds", function () {
    it("should revert getTask with InvalidTaskId for task ID 0", async function () {
      await expect(taskMarket.getTask(0))
        .to.be.revertedWithCustomError(taskMarket, "InvalidTaskId");
    });

    it("should revert getTask with InvalidTaskId for non-existent task", async function () {
      await expect(taskMarket.getTask(999))
        .to.be.revertedWithCustomError(taskMarket, "InvalidTaskId");
    });
  });

  describe("Withdraw (pull-payment)", function () {
    it("should revert withdraw when no pending funds", async function () {
      await expect(taskMarket.connect(executor).withdraw())
        .to.be.revertedWithCustomError(taskMarket, "NothingToWithdraw");
    });

    it("should emit Withdrawn event and clear pendingWithdrawals", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(client).confirmCompletion(1);
      await taskMarket.connect(executor).confirmCompletion(1);

      const expectedFee = (ONE_ETH * FEE_BPS) / 10000n;
      const expectedPayout = ONE_ETH - expectedFee;

      await expect(taskMarket.connect(executor).withdraw())
        .to.emit(taskMarket, "Withdrawn")
        .withArgs(executor.address, expectedPayout);

      expect(await taskMarket.pendingWithdrawals(executor.address)).to.equal(0);
    });

    it("should revert second withdraw after funds already claimed", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(client).confirmCompletion(1);
      await taskMarket.connect(executor).confirmCompletion(1);

      await taskMarket.connect(executor).withdraw();
      await expect(taskMarket.connect(executor).withdraw())
        .to.be.revertedWithCustomError(taskMarket, "NothingToWithdraw");
    });
  });

  describe("Upgradeability (UUPS)", function () {
    it("cannot be re-initialized after deployment", async function () {
      await expect(taskMarket.initialize(FEE_BPS, owner.address))
        .to.be.revertedWithCustomError(taskMarket, "InvalidInitialization");
    });

    it("admin (DEFAULT_ADMIN_ROLE) can upgrade to a new implementation and state is preserved", async function () {
      const proxyAddress = await taskMarket.getAddress();
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });

      const TaskMarketV2 = await ethers.getContractFactory("TaskMarketV2Mock", owner);
      const upgraded = (await api.upgradeProxy(proxyAddress, TaskMarketV2, { unsafeAllow: ["constructor"] })) as unknown as TaskMarket &
        { initializeV2: (minReward: bigint) => Promise<unknown>; version: () => Promise<string>; minReward: () => Promise<bigint> };

      expect(await upgraded.getAddress()).to.equal(proxyAddress);
      expect(await upgraded.version()).to.equal("v2");

      // Pre-existing state survives the upgrade
      const task = await upgraded.getTask(1);
      expect(task.client).to.equal(client.address);
      expect(task.reward).to.equal(ONE_ETH);

      // New storage can be initialized via reinitializer without clobbering old state
      await upgraded.initializeV2(ONE_ETH);
      expect(await upgraded.minReward()).to.equal(ONE_ETH);
      expect(await upgraded.taskCount()).to.equal(1n);
    });

    it("non-admin cannot authorize an upgrade", async function () {
      const TaskMarketV2 = await ethers.getContractFactory("TaskMarketV2Mock", owner);
      const newImpl = await TaskMarketV2.deploy();
      await newImpl.waitForDeployment();

      await expect(
        taskMarket.connect(other).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(taskMarket, "AccessControlUnauthorizedAccount");
    });

    it("implementation contract cannot be initialized directly", async function () {
      const implAddress = await api.erc1967.getImplementationAddress(await taskMarket.getAddress());
      const implementation = TaskMarket__factory.connect(implAddress, owner);

      await expect(implementation.initialize(FEE_BPS, owner.address))
        .to.be.revertedWithCustomError(implementation, "InvalidInitialization");
    });
  });

  describe("cancelTask — expired active tasks", function () {
    const DAY = 86400;
    let snapshotId: string;

    beforeEach(async function () {
      snapshotId = (await provider.request({ method: "evm_snapshot", params: [] })) as string;
    });

    afterEach(async function () {
      await provider.request({ method: "evm_revert", params: [snapshotId] });
    });

    async function blockDeadline(days = 1) {
      const block = await ethers.provider.getBlock("latest");
      return Number(block!.timestamp) + days * DAY + 60;
    }

    it("should cancel and credit pendingWithdrawals for an expired ASSIGNED task", async function () {
      const deadline = await blockDeadline();
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);

      await provider.request({ method: "evm_increaseTime", params: [DAY + 120] });
      await provider.request({ method: "evm_mine", params: [] });

      await taskMarket.connect(client).cancelTask(1);
      expect(await taskMarket.pendingWithdrawals(client.address)).to.equal(ONE_ETH);
      expect((await taskMarket.getTask(1)).status).to.equal(6n); // Cancelled
    });

    it("should cancel and credit pendingWithdrawals for an expired IN_PROGRESS task", async function () {
      const deadline = await blockDeadline();
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);

      await provider.request({ method: "evm_increaseTime", params: [DAY + 120] });
      await provider.request({ method: "evm_mine", params: [] });

      await taskMarket.connect(client).cancelTask(1);
      expect(await taskMarket.pendingWithdrawals(client.address)).to.equal(ONE_ETH);
      expect((await taskMarket.getTask(1)).status).to.equal(6n);
    });

    it("should emit TaskCancelled and TaskStatusChanged on expired ASSIGNED cancel", async function () {
      const deadline = await blockDeadline();
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);

      await provider.request({ method: "evm_increaseTime", params: [DAY + 120] });
      await provider.request({ method: "evm_mine", params: [] });

      await expect(taskMarket.connect(client).cancelTask(1))
        .to.emit(taskMarket, "TaskCancelled").withArgs(1)
        .and.to.emit(taskMarket, "TaskStatusChanged").withArgs(1, 1n, 6n); // Assigned → Cancelled
    });

    it("should revert cancelTask on non-expired ASSIGNED task", async function () {
      const deadline = await blockDeadline();
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);

      await expect(taskMarket.connect(client).cancelTask(1))
        .to.be.revertedWithCustomError(taskMarket, "DeadlineNotExpired");
    });

    it("should revert cancelTask on non-expired IN_PROGRESS task", async function () {
      const deadline = await blockDeadline();
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);

      await expect(taskMarket.connect(client).cancelTask(1))
        .to.be.revertedWithCustomError(taskMarket, "DeadlineNotExpired");
    });

    it("should revert cancelTask from non-client on expired ASSIGNED task", async function () {
      const deadline = await blockDeadline();
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);

      await provider.request({ method: "evm_increaseTime", params: [DAY + 120] });
      await provider.request({ method: "evm_mine", params: [] });

      await expect(taskMarket.connect(executor).cancelTask(1))
        .to.be.revertedWithCustomError(taskMarket, "NotClient");
    });

    it("should revert cancelTask on UnderReview status even after deadline", async function () {
      const deadline = await blockDeadline();
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1); // transitions before deadline passes

      await provider.request({ method: "evm_increaseTime", params: [DAY + 120] });
      await provider.request({ method: "evm_mine", params: [] });

      await expect(taskMarket.connect(client).cancelTask(1))
        .to.be.revertedWithCustomError(taskMarket, "DeadlineNotExpired");
    });
  });

  describe("extendDeadline", function () {
    const DAY = 86400;
    let snapshotId: string;
    let deadline: number;

    beforeEach(async function () {
      snapshotId = (await provider.request({ method: "evm_snapshot", params: [] })) as string;
      const block = await ethers.provider.getBlock("latest");
      deadline = Number(block!.timestamp) + DAY + 60;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
    });

    afterEach(async function () {
      await provider.request({ method: "evm_revert", params: [snapshotId] });
    });

    it("should extend deadline on an OPEN task and emit event", async function () {
      const newDeadline = deadline + DAY;
      await expect(taskMarket.connect(client).extendDeadline(1, newDeadline))
        .to.emit(taskMarket, "DeadlineExtended")
        .withArgs(1, deadline, newDeadline);
      expect((await taskMarket.getTask(1)).deadline).to.equal(newDeadline);
    });

    it("should extend deadline on an ASSIGNED task", async function () {
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      const newDeadline = deadline + DAY * 3;
      await taskMarket.connect(client).extendDeadline(1, newDeadline);
      expect((await taskMarket.getTask(1)).deadline).to.equal(newDeadline);
    });

    it("should extend deadline on an IN_PROGRESS task", async function () {
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      const newDeadline = deadline + DAY * 2;
      await taskMarket.connect(client).extendDeadline(1, newDeadline);
      expect((await taskMarket.getTask(1)).deadline).to.equal(newDeadline);
    });

    it("should extend deadline on an UNDER_REVIEW task", async function () {
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      const newDeadline = deadline + DAY * 5;
      await taskMarket.connect(client).extendDeadline(1, newDeadline);
      expect((await taskMarket.getTask(1)).deadline).to.equal(newDeadline);
    });

    it("should revert if called by non-client", async function () {
      await expect(taskMarket.connect(executor).extendDeadline(1, deadline + DAY))
        .to.be.revertedWithCustomError(taskMarket, "NotClient");
    });

    it("should revert if new deadline equals current deadline", async function () {
      await expect(taskMarket.connect(client).extendDeadline(1, deadline))
        .to.be.revertedWithCustomError(taskMarket, "NewDeadlineTooEarly");
    });

    it("should revert if new deadline is before current deadline", async function () {
      await expect(taskMarket.connect(client).extendDeadline(1, deadline - 1))
        .to.be.revertedWithCustomError(taskMarket, "NewDeadlineTooEarly");
    });

    it("should revert if new deadline exceeds 2-year cap from current block", async function () {
      const block = await ethers.provider.getBlock("latest");
      // 3 years: clearly over the 2-year (730 days) MAX_DEADLINE_EXTENSION
      const threeYears = Number(block!.timestamp) + 3 * 365 * DAY;
      await expect(taskMarket.connect(client).extendDeadline(1, threeYears))
        .to.be.revertedWithCustomError(taskMarket, "DeadlineTooFar");
    });

    it("should revert extendDeadline on COMPLETED task", async function () {
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(client).confirmCompletion(1);
      await taskMarket.connect(executor).confirmCompletion(1);
      await expect(taskMarket.connect(client).extendDeadline(1, deadline + DAY))
        .to.be.revertedWithCustomError(taskMarket, "InvalidStatus");
    });

    it("should revert extendDeadline on CANCELLED task", async function () {
      await taskMarket.connect(client).cancelTask(1);
      await expect(taskMarket.connect(client).extendDeadline(1, deadline + DAY))
        .to.be.revertedWithCustomError(taskMarket, "InvalidStatus");
    });

    it("should revert extendDeadline on DISPUTED task", async function () {
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      await taskMarket.connect(executor).submitWork(1);
      await taskMarket.connect(client).raiseDispute(1);
      await expect(taskMarket.connect(client).extendDeadline(1, deadline + DAY))
        .to.be.revertedWithCustomError(taskMarket, "InvalidStatus");
    });

    it("extended deadline enables executor to submit previously-missed work", async function () {
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);

      // advance past original deadline
      await provider.request({ method: "evm_increaseTime", params: [DAY + 120] });
      await provider.request({ method: "evm_mine", params: [] });

      await expect(taskMarket.connect(executor).submitWork(1))
        .to.be.revertedWithCustomError(taskMarket, "DeadlinePassed");

      // client extends by 2 more days from current block
      const block = await ethers.provider.getBlock("latest");
      const newDeadline = Number(block!.timestamp) + DAY * 2;
      await taskMarket.connect(client).extendDeadline(1, newDeadline);

      await expect(taskMarket.connect(executor).submitWork(1))
        .to.emit(taskMarket, "TaskStatusChanged");
    });
  });

  describe("raiseDispute from expired IN_PROGRESS", function () {
    const DAY = 86400;
    let snapshotId: string;

    beforeEach(async function () {
      snapshotId = (await provider.request({ method: "evm_snapshot", params: [] })) as string;
    });

    afterEach(async function () {
      await provider.request({ method: "evm_revert", params: [snapshotId] });
    });

    async function setupExpiredInProgress() {
      const block = await ethers.provider.getBlock("latest");
      const deadline = Number(block!.timestamp) + DAY + 60;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      // advance past deadline
      await provider.request({ method: "evm_increaseTime", params: [DAY + 120] });
      await provider.request({ method: "evm_mine", params: [] });
    }

    it("executor can raise dispute from expired IN_PROGRESS", async function () {
      await setupExpiredInProgress();
      await expect(taskMarket.connect(executor).raiseDispute(1))
        .to.emit(taskMarket, "TaskDisputed").withArgs(1, executor.address);
      expect((await taskMarket.getTask(1)).status).to.equal(5n); // Disputed
    });

    it("client can raise dispute from expired IN_PROGRESS", async function () {
      await setupExpiredInProgress();
      await expect(taskMarket.connect(client).raiseDispute(1))
        .to.emit(taskMarket, "TaskDisputed").withArgs(1, client.address);
      expect((await taskMarket.getTask(1)).status).to.equal(5n);
    });

    it("non-participant cannot raise dispute from expired IN_PROGRESS", async function () {
      await setupExpiredInProgress();
      await expect(taskMarket.connect(other).raiseDispute(1))
        .to.be.revertedWithCustomError(taskMarket, "NotParticipant");
    });

    it("should revert raiseDispute from expired ASSIGNED (not InProgress)", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = Number(block!.timestamp) + DAY + 60;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      // advance past deadline (still ASSIGNED, not IN_PROGRESS)
      await provider.request({ method: "evm_increaseTime", params: [DAY + 120] });
      await provider.request({ method: "evm_mine", params: [] });

      await expect(taskMarket.connect(executor).raiseDispute(1))
        .to.be.revertedWithCustomError(taskMarket, "InvalidStatus");
    });

    it("after raiseDispute, cancelTask reverts (task is DISPUTED)", async function () {
      await setupExpiredInProgress();
      await taskMarket.connect(executor).raiseDispute(1);
      // task is now DISPUTED → cancelTask sees neither Open nor expiredActive
      await expect(taskMarket.connect(client).cancelTask(1))
        .to.be.revertedWithCustomError(taskMarket, "DeadlineNotExpired");
    });

    it("non-expired IN_PROGRESS cannot raise dispute", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = Number(block!.timestamp) + DAY + 60;
      await taskMarket.connect(client).createTask(deadline, METADATA_HASH, { value: ONE_ETH });
      await taskMarket.connect(client).assignExecutor(1, executor.address);
      await taskMarket.connect(executor).startWork(1);
      // deadline has NOT passed yet
      await expect(taskMarket.connect(executor).raiseDispute(1))
        .to.be.revertedWithCustomError(taskMarket, "InvalidStatus");
    });
  });
});
