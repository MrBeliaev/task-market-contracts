// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TaskMarket is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuard {

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    uint256 public taskCount;
    uint256 public pendingFees;
    address public feeRecipient;
    uint16  public platformFeeBps;

    mapping(uint256 => Task) public tasks;
    mapping(address => uint256) public pendingWithdrawals;

    enum Status {
        Open,
        Assigned,
        InProgress,
        UnderReview,
        Completed,
        Disputed,
        Cancelled
    }

    struct Task {
        uint256 id;
        address client;
        uint96  reward;
        address executor;
        Status  status;
        bool    clientConfirmed;
        bool    executorConfirmed;
        uint32  deadline;
        uint32  createdAt;
        bytes32 metadataHash;
    }

    error NotClient();
    error NotExecutor();
    error NotParticipant();
    error ZeroAddress();
    error DeadlinePassed();
    error DeadlineTooFar();
    error InsufficientReward();
    error RewardTooLarge();
    error InvalidStatus(Status current, Status expected);
    error AlreadyConfirmed();
    error InvalidBps();
    error ExecutorCannotBeClient();
    error TransferFailed();
    error InvalidTaskId();
    error TaskNotResolvable(Status current);
    error NothingToWithdraw();
    error CannotRenounceAdminRole();
    error AdminIsParticipant();

    event TaskCreated(uint256 indexed taskId, address indexed client, uint256 reward, uint256 deadline, bytes32 metadataHash);
    event TaskAssigned(uint256 indexed taskId, address indexed executor);
    event TaskStatusChanged(uint256 indexed taskId, Status oldStatus, Status newStatus);
    event CompletionConfirmed(uint256 indexed taskId, address indexed confirmer, bool clientConfirmed, bool executorConfirmed);
    event TaskCompleted(uint256 indexed taskId, address indexed executor, uint256 payout, uint256 fee);
    event TaskCancelled(uint256 indexed taskId);
    event TaskDisputed(uint256 indexed taskId, address indexed disputedBy);
    event DisputeResolved(uint256 indexed taskId, address indexed resolvedBy, uint256 clientRefund, uint256 executorPayout);
    event FeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event Withdrawn(address indexed recipient, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(uint16 _feeBps, address _feeRecipient) public initializer {
        if (_feeRecipient == address(0)) revert ZeroAddress();

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        platformFeeBps = _feeBps;
        feeRecipient   = _feeRecipient;
        emit FeeBpsUpdated(0, _feeBps);
        emit FeeRecipientUpdated(address(0), _feeRecipient);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    modifier onlyClient(uint256 _taskId) {
        if (tasks[_taskId].client != msg.sender) revert NotClient();
        _;
    }

    modifier onlyExecutor(uint256 _taskId) {
        if (tasks[_taskId].executor != msg.sender) revert NotExecutor();
        _;
    }

    modifier inStatus(uint256 _taskId, Status _expected) {
        Status current = tasks[_taskId].status;
        if (current != _expected) revert InvalidStatus(current, _expected);
        _;
    }

    function createTask(uint256 _deadline, bytes32 _metadataHash) external payable {
        if (msg.value == 0)               revert InsufficientReward();
        if (msg.value > type(uint96).max) revert RewardTooLarge();
        if (_deadline <= block.timestamp) revert DeadlinePassed();
        if (_deadline > type(uint32).max) revert DeadlineTooFar();

        uint256 taskId = ++taskCount;
        tasks[taskId] = Task({
            id:                taskId,
            client:            msg.sender,
            executor:          address(0),
            reward:            uint96(msg.value),
            deadline:          uint32(_deadline),
            createdAt:         uint32(block.timestamp),
            metadataHash:      _metadataHash,
            status:            Status.Open,
            clientConfirmed:   false,
            executorConfirmed: false
        });
        emit TaskCreated(taskId, msg.sender, msg.value, _deadline, _metadataHash);
    }

    function assignExecutor(
        uint256 _taskId,
        address _executor
    ) external onlyClient(_taskId) inStatus(_taskId, Status.Open) {
        if (_executor == address(0)) revert ZeroAddress();
        if (_executor == msg.sender) revert ExecutorCannotBeClient();

        Task storage task = tasks[_taskId];
        Status prev = task.status;
        task.executor = _executor;
        task.status   = Status.Assigned;

        emit TaskAssigned(_taskId, _executor);
        emit TaskStatusChanged(_taskId, prev, Status.Assigned);
    }

    function cancelTask(
        uint256 _taskId
    ) external onlyClient(_taskId) inStatus(_taskId, Status.Open) nonReentrant {
        Task storage task = tasks[_taskId];
        Status prev = task.status;
        task.status = Status.Cancelled;

        emit TaskCancelled(_taskId);
        emit TaskStatusChanged(_taskId, prev, Status.Cancelled);
        _transfer(task.client, task.reward);
    }

    function startWork(
        uint256 _taskId
    ) external onlyExecutor(_taskId) inStatus(_taskId, Status.Assigned) {
        Task storage task = tasks[_taskId];
        Status prev = task.status;
        task.status = Status.InProgress;
        emit TaskStatusChanged(_taskId, prev, Status.InProgress);
    }

    function submitWork(
        uint256 _taskId
    ) external onlyExecutor(_taskId) inStatus(_taskId, Status.InProgress) {
        Task storage task = tasks[_taskId];
        if (block.timestamp > task.deadline) revert DeadlinePassed();
        Status prev = task.status;
        task.status = Status.UnderReview;
        emit TaskStatusChanged(_taskId, prev, Status.UnderReview);
    }

    function confirmCompletion(
        uint256 _taskId
    ) external inStatus(_taskId, Status.UnderReview) nonReentrant {
        Task storage task = tasks[_taskId];

        if (msg.sender == task.client) {
            if (task.clientConfirmed) revert AlreadyConfirmed();
            task.clientConfirmed = true;
        } else if (msg.sender == task.executor) {
            if (task.executorConfirmed) revert AlreadyConfirmed();
            task.executorConfirmed = true;
        } else {
            revert NotParticipant();
        }

        emit CompletionConfirmed(_taskId, msg.sender, task.clientConfirmed, task.executorConfirmed);

        if (task.clientConfirmed && task.executorConfirmed) {
            _releaseFunds(_taskId);
        }
    }

    function raiseDispute(
        uint256 _taskId
    ) external inStatus(_taskId, Status.UnderReview) {
        Task storage task = tasks[_taskId];
        if (msg.sender != task.client && msg.sender != task.executor) revert NotParticipant();

        Status prev = task.status;
        task.status = Status.Disputed;
        emit TaskDisputed(_taskId, msg.sender);
        emit TaskStatusChanged(_taskId, prev, Status.Disputed);
    }

    function resolveDispute(
        uint256 _taskId,
        uint256 _clientBps
    ) external onlyRole(ADMIN_ROLE) inStatus(_taskId, Status.Disputed) nonReentrant {
        if (_clientBps > 10000) revert InvalidBps();

        Task storage task = tasks[_taskId];
        if (msg.sender == task.client || msg.sender == task.executor) revert AdminIsParticipant();

        Status prev = task.status;
        task.status = Status.Completed;

        uint256 clientRefund   = (uint256(task.reward) * _clientBps) / 10000;
        uint256 executorPayout = uint256(task.reward) - clientRefund;

        emit DisputeResolved(_taskId, msg.sender, clientRefund, executorPayout);
        emit TaskStatusChanged(_taskId, prev, Status.Completed);

        if (clientRefund   > 0) pendingWithdrawals[task.client]   += clientRefund;
        if (executorPayout > 0) pendingWithdrawals[task.executor] += executorPayout;
    }

    function forceComplete(uint256 _taskId) external onlyRole(ADMIN_ROLE) nonReentrant {
        Task storage task = tasks[_taskId];
        if (task.status != Status.UnderReview && task.status != Status.Disputed)
            revert TaskNotResolvable(task.status);
        _releaseFunds(_taskId);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        _transfer(msg.sender, amount);
    }

    function setFeeBps(uint16 _feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeBps > 1000) revert InvalidBps();
        uint256 old = platformFeeBps;
        platformFeeBps = _feeBps;
        emit FeeBpsUpdated(old, _feeBps);
    }

    function setFeeRecipient(address _recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_recipient == address(0)) revert ZeroAddress();
        address old = feeRecipient;
        feeRecipient = _recipient;
        emit FeeRecipientUpdated(old, _recipient);
    }

    function withdrawPendingFees() external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        uint256 amount = pendingFees;
        if (amount == 0) return;
        pendingFees = 0;
        _transfer(feeRecipient, amount);
    }

    function renounceRole(bytes32 role, address callerConfirmation) public override {
        if (role == DEFAULT_ADMIN_ROLE) revert CannotRenounceAdminRole();
        super.renounceRole(role, callerConfirmation);
    }

    function getTask(uint256 _taskId) external view returns (Task memory) {
        if (_taskId == 0 || _taskId > taskCount) revert InvalidTaskId();
        return tasks[_taskId];
    }

    function _releaseFunds(uint256 _taskId) internal {
        Task storage task = tasks[_taskId];

        Status prev = task.status;
        task.status = Status.Completed;

        uint256 fee    = (uint256(task.reward) * platformFeeBps) / 10000;
        uint256 payout = uint256(task.reward) - fee;

        emit TaskCompleted(_taskId, task.executor, payout, fee);
        emit TaskStatusChanged(_taskId, prev, Status.Completed);

        if (fee > 0) {
            pendingFees += fee;
        }
        pendingWithdrawals[task.executor] += payout;
    }

    function _transfer(address _to, uint256 _amount) private {
        (bool ok,) = _to.call{value: _amount}("");
        if (!ok) revert TransferFailed();
    }
}
