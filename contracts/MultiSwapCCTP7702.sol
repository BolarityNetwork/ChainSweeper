// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface ICCTPv2WithExecutor {
    function depositForBurn(
        uint256 amount,
        uint16 destinationChain,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        ExecutorArgs calldata executorArgs,
        FeeArgs calldata feeArgs
    ) external payable;
}

interface IFeeConfig {
    function feeCollector() external view returns (address);
    function feeBps() external view returns (uint256);
}

struct ExecutorArgs {
    address refundAddress;
    bytes signedQuote;
    bytes instructions;
}

struct FeeArgs {
    uint16 dbps;
    address payee;
}

contract DustCollector7702 is Ownable {
    using SafeERC20 for IERC20;

    IUniversalRouter public immutable router;
    ICCTPv2WithExecutor public immutable cctp;
    IFeeConfig public immutable feeConfig;

    struct SwapParams {
        bytes commands;
        bytes[] inputs;
        uint256 deadline;
        address targetToken;
        uint16 dstChain;
        uint32 dstDomain;
        bytes32 recipient;
        uint256 arbiterFee;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        ExecutorArgs executorArgs;
        FeeArgs feeArgs;
        uint256 estimatedCost;
    }

    event FeeCollected(address indexed token, uint256 amount);
    event Swapped(address indexed user, address indexed token, uint256 amount);
    event Bridged(address indexed user, address indexed token, uint256 amount, uint16 dstChain, bytes32 recipient);

    constructor(
        address _router,
        address _cctp,
        address _feeConfig
    ) Ownable(msg.sender) {
        require(_router != address(0) && _cctp != address(0) && _feeConfig != address(0), "zero addr");
        router = IUniversalRouter(_router);
        cctp = ICCTPv2WithExecutor(_cctp);
        feeConfig = IFeeConfig(_feeConfig);
    }

    /// @notice 主逻辑入口，仅限 EIP-7702 升级账户调用自身合约
    function batchCollectWithUniversalRouter7702(
        SwapParams calldata params,
        address[] calldata pullTokens,
        uint256[] calldata pullAmounts
    ) external payable {
        require(msg.sender == address(this), "EIP-7702 only");
        require(params.targetToken != address(0), "no target");
        require(pullTokens.length == pullAmounts.length, "len mismatch");

        _forwardToRouter(pullTokens, pullAmounts);
        uint256 received = _executeSwap(params);
        _handleResult(params, received);
    }

    function _forwardToRouter(address[] calldata tokens, uint256[] calldata amounts) internal {
        for (uint256 i = 0; i < tokens.length; ++i) {
            IERC20(tokens[i]).safeTransfer(address(router), amounts[i]);
        }
    }

    function _executeSwap(SwapParams calldata p) internal returns (uint256) {
        uint256 beforeBal = IERC20(p.targetToken).balanceOf(address(this));
        require(msg.value >= p.estimatedCost, "Insufficient eth funds");
        uint256 routerEth = msg.value - p.estimatedCost;

        router.execute{value: routerEth}(p.commands, p.inputs, p.deadline);

        uint256 afterBal = IERC20(p.targetToken).balanceOf(address(this));
        require(afterBal > beforeBal, "no output");

        return afterBal - beforeBal;
    }

    function _handleResult(SwapParams calldata p, uint256 received) internal {
        uint256 feeBps = feeConfig.feeBps();
        address collector = feeConfig.feeCollector();

        uint256 feeAmt = (received * feeBps) / 10_000;
        uint256 userAmt = received - feeAmt;

        if (feeAmt > 0 && collector != address(0)) {
            IERC20(p.targetToken).safeTransfer(collector, feeAmt);
            emit FeeCollected(p.targetToken, feeAmt);
        }

        if (p.dstChain == 0 && p.recipient == bytes32(0)) {
            emit Swapped(address(this), p.targetToken, userAmt);
        } else {
            _bridgeWithCCTP(p, userAmt);
        }
    }

    function _bridgeWithCCTP(SwapParams calldata p, uint256 amount) internal {
        IERC20 token = IERC20(p.targetToken);
        token.safeIncreaseAllowance(address(cctp), amount);

        cctp.depositForBurn{value: p.estimatedCost}(
            amount,
            p.dstChain,
            p.dstDomain,
            p.recipient,
            p.targetToken,
            p.destinationCaller,
            p.maxFee,
            p.minFinalityThreshold,
            p.executorArgs,
            p.feeArgs
        );

        token.approve(address(cctp), 0);
        emit Bridged(address(this), p.targetToken, amount, p.dstChain, p.recipient);
    }

    receive() external payable {}

    /// @notice 查询当前手续费配置（从 feeConfig 合约读取）
    function getCurrentFeeConfig() external view returns (uint256 bps, address collector) {
        bps = feeConfig.feeBps();
        collector = feeConfig.feeCollector();
    }
}
