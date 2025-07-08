// multi-swap-with-permit2.js  (ES Module)  ------------------------------
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, MaxUint256
} from 'ethers';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';

/* ---------- 全局配置 ---------- */
const RPC_URL   = process.env.RPC_URL;
const PRIVKEY   = process.env.PRIVATE_KEY;
const PERMIT2   = '0x000000000022D473030F116dDEE9F6B43aC78BA3';      // Uniswap Permit2
const COLLECTOR = '0x45AAbad78c43C337cB6Cf2fFeCE42aa394d26314';      // 你的 DustCollector
const TARGET    = '0x66a00769800E651E9DbbA384d2B41A45A9660912';      // 最终换成的 Token

/* ---------- 多币种配置 ---------- */
const TOKENS = [
  {
    addr : '0x4aDcEaAec49D145C0764A626a0F610C9eDfFf35B',          // ATG
    dec  : 18,
    amt  : '0.10',
    fee  : 3000                                                   // 0.3 %
  },
  {
    addr : '0x1d2727D1A01D5067760a2Dd13c5936DDebCDeD5b',          // USDC (假地址示例)
    dec  : 18,
    amt  : '0.20',
    fee  : 3000
  }
];

/* ---------- ABI ---------- */
const DUST_ABI = [
  'function batchCollectWithUniversalRouter((' +
    'bytes commands,bytes[] inputs,uint256 deadline,' +
    'address targetToken,uint16 dstChain,bytes32 recipient,uint256 arbiterFee' +
  '), address[] pullTokens, uint256[] pullAmounts) payable'
];

const ERC20_ABI = [
  'function approve(address,uint256) external returns (bool)',
  'function allowance(address,address) view returns (uint256)'
];

const PERMIT2_ABI = [
  // returns (uint160 amount, uint48 expiration, uint48 nonce)
  'function allowance(address owner,address token,address spender) view returns (uint160,uint48,uint48)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration) external'
];

/* ---------- 工具函数 ---------- */
function v3Path(a, b, fee) {
  return solidityPacked(['address', 'uint24', 'address'], [a, fee, b]);
}

/**
 * 为指定 token 确保：
 * ① ERC20 → Permit2 已授权；
 * ② Permit2 → Collector 已授权。
 */
async function ensurePermit2(token, owner, amount) {
  const erc20  = new Contract(token, ERC20_ABI  , owner);
  const permit = new Contract(PERMIT2, PERMIT2_ABI, owner);

  /* === 1. ERC20 → Permit2 === */
  const curErc20Allow = await erc20.allowance(owner.address, PERMIT2);
  if (curErc20Allow < amount) {
    console.log(`  · Approving ERC20 → Permit2   (${token})`);
    await (await erc20.approve(PERMIT2, MaxUint256)).wait();
  }

  /* === 2. Permit2 → DustCollector === */
  const [allowAmt] = await permit.allowance(owner.address, token, COLLECTOR);
  if (allowAmt < amount) {
    console.log(`  · Approving Permit2 → Collector (${token})`);
    const maxUint160 = (1n << 160n) - 1n;               // 2¹⁶⁰-1
    const expiration = Math.floor(Date.now() / 1e3) + 3600 * 24 * 30; // 30 天
    await (await permit.approve(token, COLLECTOR, maxUint160, expiration)).wait();
  }
}

/* ===================== 主流程 ===================== */
(async () => {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet   = new Wallet(PRIVKEY, provider);

  console.log(`\n🔑  Wallet: ${wallet.address}`);
  console.log('------------------------------------------------------------\n');

  /* ---------- 1. 逐币授权 ---------- */
  for (const tk of TOKENS) {
    tk.amtWei = parseUnits(tk.amt, tk.dec);          // BigInt 数量
    await ensurePermit2(tk.addr, wallet, tk.amtWei);
  }

  /* ---------- 2. 组装 UniversalRouter commands/inputs ---------- */
  const abiCoder = AbiCoder.defaultAbiCoder();
  let   commands = '';                               // 每个代币一条 0x00
  const inputs   = [];

  for (const tk of TOKENS) {
    commands += '00';
    inputs.push(
      abiCoder.encode(
        ['address','uint256','uint256','bytes','bool'],
        [COLLECTOR, tk.amtWei, 0, v3Path(tk.addr, TARGET, tk.fee), false]  // payerIsUser = false
      )
    );
  }
  commands  = '0x' + commands;
  const deadline = Math.floor(Date.now() / 1e3) + 1800;  // 30 分钟

  /* ---------- 3. pullTokens & pullAmounts ---------- */
  const pullTokens  = TOKENS.map(t => t.addr);
  const pullAmounts = TOKENS.map(t => t.amtWei);

  /* ---------- 4. 调 DustCollector ---------- */
  const collector = new Contract(COLLECTOR, DUST_ABI, wallet);

  console.log('⏳  Sending transaction …');
  const tx = await collector.batchCollectWithUniversalRouter(
    {
      commands,
      inputs,
      deadline,
      targetToken: TARGET,
      dstChain:    0,
      recipient:   ZeroHash,
      arbiterFee:  0
    },
    pullTokens,
    pullAmounts,
    { value: 0 }
  );

  console.log(`📨  Tx hash: ${tx.hash}`);
  const rc = await tx.wait();
  console.log(rc.status === 1 ? '✅  SUCCESS' : '❌  FAILED');
})().catch(console.error);
