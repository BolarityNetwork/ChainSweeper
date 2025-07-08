// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
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

struct ExecutorArgs {
    address refundAddress;
    bytes signedQuote;
    bytes instructions;
}

struct FeeArgs {
    uint16 dbps;
    address payee;
}

contract DustCollectorUniversalPermit2 is Ownable {
    using SafeERC20 for IERC20;

    IUniversalRouter public immutable router;
    IPermit2 public immutable permit2;
    ICCTPv2WithExecutor public immutable cctp;

    address public feeCollector;
    uint256 public feeBps = 30;

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
    }

    event FeeCollected(address indexed token, uint256 amount);
    event Swapped(address indexed user, address indexed token, uint256 amount);
    event Bridged(address indexed user, address indexed token, uint256 amount, uint16 dstChain, bytes32 recipient);

    constructor(address _router, address _permit2, address _cctp, address _feeCollector) Ownable(msg.sender) {
        require(_router != address(0) && _permit2 != address(0) && _cctp != address(0) && _feeCollector != address(0), "zero addr");
        router = IUniversalRouter(_router);
        permit2 = IPermit2(_permit2);
        cctp = ICCTPv2WithExecutor(_cctp);
        feeCollector = _feeCollector;
    }

    function setFee(uint256 _bps, address _collector) external onlyOwner {
        require(_bps <= 1000, "too high");
        feeBps = _bps;
        feeCollector = _collector;
    }

    function batchCollectWithUniversalRouter(
        SwapParams calldata params,
        address[] calldata pullTokens,
        uint256[] calldata pullAmounts
    ) external payable {
        require(params.targetToken != address(0), "no target");
        require(pullTokens.length == pullAmounts.length, "len mismatch");

        _pullAndForward(pullTokens, pullAmounts);
        uint256 received = _executeSwap(params);
        _handleResult(params, received, msg.value);
    }

    function _pullAndForward(address[] calldata tokens, uint256[] calldata amounts) internal {
        for (uint256 i; i < tokens.length; ++i) {
            permit2.transferFrom(msg.sender, address(this), uint160(amounts[i]), tokens[i]);
            IERC20(tokens[i]).safeTransfer(address(router), amounts[i]);
        }
    }

    function _executeSwap(SwapParams calldata p) internal returns (uint256) {
        uint256 beforeBal = IERC20(p.targetToken).balanceOf(address(this));
        router.execute{value: 0}(p.commands, p.inputs, p.deadline);
        uint256 afterBal = IERC20(p.targetToken).balanceOf(address(this));
        require(afterBal > beforeBal, "no output");
        return afterBal - beforeBal;
    }

    function _handleResult(SwapParams calldata p, uint256 received, uint256 msgValue) internal {
        uint256 feeAmt = received * feeBps / 10_000;
        uint256 userAmt = received - feeAmt;

        if (feeAmt > 0) {
            IERC20(p.targetToken).safeTransfer(feeCollector, feeAmt);
            emit FeeCollected(p.targetToken, feeAmt);
        }

        if (p.dstChain == 0 && p.recipient == bytes32(0)) {
            IERC20(p.targetToken).safeTransfer(msg.sender, userAmt);
            emit Swapped(msg.sender, p.targetToken, userAmt);
        } else {
            _bridgeWithCCTP(p, userAmt, msgValue);
        }
    }

    function _bridgeWithCCTP(SwapParams calldata p, uint256 amount, uint256 msgValue) internal {
        IERC20 token = IERC20(p.targetToken);
        token.safeIncreaseAllowance(address(cctp), amount);

        cctp.depositForBurn{value: msgValue}(
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
        emit Bridged(msg.sender, p.targetToken, amount, p.dstChain, p.recipient);
    }

    function rescueERC20(address t, address to, uint256 amt) external onlyOwner {
        IERC20(t).safeTransfer(to, amt);
    }

    receive() external payable {}
}
