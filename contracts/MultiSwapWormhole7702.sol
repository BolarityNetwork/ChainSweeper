// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/* ───────────── 外部接口 ───────────── */
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IWormholeCore {
    function messageFee() external view returns (uint256);
}

interface IWormholeBridge {
    function transferTokens(
        address token, uint256 amount, uint16 dstChain,
        bytes32 recipient, uint256 arbiterFee, uint32 nonce
    ) external payable returns (uint64);
}

interface IFeeConfig {
    function feeCollector() external view returns (address);
    function feeBps() external view returns (uint256);
}

/* ───────────── 主合约 ───────────── */
contract DustCollector7702Wormhole is Ownable {
    using SafeERC20 for IERC20;

    IUniversalRouter public immutable router;
    IWormholeBridge  public immutable bridge;
    IWormholeCore    public immutable core;
    IFeeConfig       public immutable feeConfig;

    struct SwapParams {
        bytes   commands;
        bytes[] inputs;
        uint256 deadline;
        address targetToken;
        uint16  dstChain;
        bytes32 recipient;
        uint256 arbiterFee;
    }

    event FeeCollected(address indexed token, uint256 amount);
    event Swapped(address indexed user, address indexed token, uint256 amount);
    event Bridged(address indexed user, address indexed token, uint256 amount, uint16 dstChain, bytes32 recipient, uint64 seq);

    constructor(
        address _router,
        address _bridge,
        address _core,
        address _feeConfig
    ) Ownable(msg.sender) {
        require(_router != address(0) && _bridge != address(0) && _core != address(0) && _feeConfig != address(0), "zero addr");
        router = IUniversalRouter(_router);
        bridge = IWormholeBridge(_bridge);
        core   = IWormholeCore(_core);
        feeConfig = IFeeConfig(_feeConfig);
    }

    function batchCollectWithUniversalRouter7702(
        SwapParams calldata params,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external payable {
        require(msg.sender == address(this), "EIP-7702 only");
        require(params.targetToken != address(0), "no target");
        require(tokens.length == amounts.length, "len mismatch");

        _forwardToRouter(tokens, amounts);
        uint256 received = _executeSwap(params);
        _handleResult(params, received);
    }

    function _forwardToRouter(address[] calldata tokens, uint256[] calldata amounts) internal {
        for (uint256 i = 0; i < tokens.length; ++i) {
            IERC20(tokens[i]).safeTransfer(address(router), amounts[i]);
        }
    }

    function _executeSwap(SwapParams calldata p) internal returns (uint256) {
        uint256 fee = _msgFee(p);
        uint256 before = IERC20(p.targetToken).balanceOf(address(this));
        router.execute{value: msg.value - fee}(p.commands, p.inputs, p.deadline);
        uint256 afterAmt = IERC20(p.targetToken).balanceOf(address(this));
        require(afterAmt > before, "no output");
        return afterAmt - before;
    }

    function _msgFee(SwapParams calldata p) internal view returns (uint256) {
        if (p.dstChain == 0 && p.recipient == bytes32(0) && p.arbiterFee == 0) return 0;
        uint256 fee = core.messageFee();
        require(msg.value >= fee, "fee underflow");
        return fee;
    }

    function _handleResult(SwapParams calldata p, uint256 received) internal {
        uint256 bps = feeConfig.feeBps();
        address collector = feeConfig.feeCollector();

        uint256 feeAmt  = received * bps / 10_000;
        uint256 userAmt = received - feeAmt;

        if (feeAmt > 0 && collector != address(0)) {
            IERC20(p.targetToken).safeTransfer(collector, feeAmt);
            emit FeeCollected(p.targetToken, feeAmt);
        }

        if (p.dstChain == 0 && p.recipient == bytes32(0) && p.arbiterFee == 0) {
            emit Swapped(address(this), p.targetToken, userAmt);
        } else {
            _bridgeTokens(p, userAmt);
        }
    }

    function _bridgeTokens(SwapParams calldata p, uint256 amt) internal {
        uint256 msgFee = core.messageFee();
        IERC20(p.targetToken).safeIncreaseAllowance(address(bridge), amt);
        uint64 seq = bridge.transferTokens{value: msgFee}(
            p.targetToken,
            amt,
            p.dstChain,
            p.recipient,
            p.arbiterFee,
            uint32(block.timestamp)
        );
        IERC20(p.targetToken).approve(address(bridge), 0);
        emit Bridged(address(this), p.targetToken, amt, p.dstChain, p.recipient, seq);
    }

    receive() external payable {}

    /// @notice 查询当前手续费配置（从 feeConfig 合约读取）
    function getCurrentFeeConfig() external view returns (uint256 bps, address collector) {
        bps = feeConfig.feeBps();
        collector = feeConfig.feeCollector();
    }
}
