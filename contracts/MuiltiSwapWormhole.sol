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

interface IPermit2 {
    /// @notice 使用已有授权，从 `from` 地址将 `token` 转出到 `to`
    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external;
}

/* ───────────── 主合约 ───────────── */
contract DustCollectorUniversalPermit2 is Ownable {
    using SafeERC20 for IERC20;

    /* immutables */
    IUniversalRouter public immutable router;
    IWormholeBridge  public immutable bridge;
    IWormholeCore    public immutable core;
    IPermit2         public immutable permit2;

    /* fee */
    address public feeCollector;
    uint256 public feeBps = 30; // 0.3 %

    /* params */
    struct SwapParams {
        bytes   commands;
        bytes[] inputs;
        uint256 deadline;
        address targetToken;
        uint16  dstChain;
        bytes32 recipient;
        uint256 arbiterFee;
    }

    /* events */
    event FeeCollected(address indexed token, uint256 amount);
    event Swapped(address indexed user, address indexed token, uint256 amount);
    event Bridged(address indexed user, address indexed token, uint256 amount, uint16 dstChain, bytes32 recipient, uint64 seq);

    constructor(
        address _router,
        address _bridgeContract,
        address _core,
        address _permit2,
        address _feeCollector
    ) Ownable(msg.sender) {
        require(
            _router != address(0) &&
            _bridgeContract != address(0) &&
            _core != address(0) &&
            _permit2 != address(0) &&
            _feeCollector != address(0),
            "zero addr"
        );

        router       = IUniversalRouter(_router);
        bridge       = IWormholeBridge(_bridgeContract);
        core         = IWormholeCore(_core);
        permit2      = IPermit2(_permit2);
        feeCollector = _feeCollector;
    }

    /* admin */
    function setFee(uint256 _bps, address _collector) external onlyOwner {
        require(_bps <= 1000, "too high");
        feeBps = _bps;
        feeCollector = _collector;
    }

    /* ------------------ main entry ------------------ */
    function batchCollectWithUniversalRouter(
        SwapParams calldata params,
        address[] calldata pullTokens,
        uint256[] calldata pullAmounts
    ) external payable {
        require(params.targetToken != address(0), "no target");
        require(pullTokens.length == pullAmounts.length, "len mismatch");

        _pullAndForward(pullTokens, pullAmounts);
        uint256 received = _executeSwap(params);
        _handleResult(params, received);
    }

    /* -------- internal: pull & forward -------- */
    function _pullAndForward(address[] calldata tokens, uint256[] calldata amounts) internal {
        for (uint256 i; i < tokens.length; ++i) {
            // 1. 从用户拉币（使用 Permit2）
            permit2.transferFrom(
                msg.sender,
                address(this),
                uint160(amounts[i]),
                tokens[i]
            );
            // 2. 转给 Router
            IERC20(tokens[i]).safeTransfer(address(router), amounts[i]);
        }
    }

    /* -------- internal: swap -------- */
    function _executeSwap(SwapParams calldata p) internal returns (uint256) {
        uint256 msgFee    = _msgFee(p);
        uint256 routerEth = msg.value - msgFee;

        uint256 beforeBal = IERC20(p.targetToken).balanceOf(address(this));
        router.execute{value: routerEth}(p.commands, p.inputs, p.deadline);
        uint256 afterBal  = IERC20(p.targetToken).balanceOf(address(this));

        require(afterBal > beforeBal, "no output");
        return afterBal - beforeBal;
    }

    /* -------- internal: fee calc -------- */
    function _msgFee(SwapParams calldata p) internal view returns (uint256) {
        if (p.dstChain == 0 && p.recipient == bytes32(0) && p.arbiterFee == 0) return 0;
        uint256 fee = core.messageFee();
        require(msg.value >= fee , "fee underflow");
        return fee;
    }

    /* -------- internal: after swap -------- */
    function _handleResult(SwapParams calldata p, uint256 received) internal {
        uint256 feeAmt  = received * feeBps / 10_000;
        uint256 userAmt = received - feeAmt;

        if (feeAmt > 0) {
            IERC20(p.targetToken).safeTransfer(feeCollector, feeAmt);
            emit FeeCollected(p.targetToken, feeAmt);
        }

        if (p.dstChain == 0 && p.recipient == bytes32(0) && p.arbiterFee == 0) {
            IERC20(p.targetToken).safeTransfer(msg.sender, userAmt);
            emit Swapped(msg.sender, p.targetToken, userAmt);
        } else {
            _bridgeTokens(p, userAmt);
        }
    }

    /* -------- internal: bridge -------- */
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
        emit Bridged(msg.sender, p.targetToken, amt, p.dstChain, p.recipient, seq);
    }

    /* rescue */
    function rescueERC20(address t, address to, uint256 amt) external onlyOwner {
        IERC20(t).safeTransfer(to, amt);
    }

    receive() external payable {}
}
