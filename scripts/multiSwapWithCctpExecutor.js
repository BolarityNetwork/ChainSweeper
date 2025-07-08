// scripts/dust-executor.ts
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, Wallet, Contract, MaxUint256, isAddress
} from 'ethers';
import { JsonRpcProvider } from 'ethers';
import axios from 'axios';

console.log("\n🚀 DustCollector Executor Script");
console.log("🧪 Powered by Permit2 + Wormhole CCTP v2 + Executor");

/* ---------- Config Validation ---------- */
const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`❌ Missing environment variable: ${key}`);
  return value;
};

const RPC_URL        = requireEnv('RPC_URL');
const PRIVKEY        = requireEnv('PRIVATE_KEY');
const PERMIT2        = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const COLLECTOR      = requireEnv('COLLECTOR');
const TARGET         = requireEnv('TARGET_TOKEN');
const DST_CHAIN_ID   = parseInt(requireEnv('DST_CHAIN_ID'));
const DST_DOMAIN     = parseInt(requireEnv('DST_DOMAIN'));
const API_SRC_CHAIN  = parseInt(requireEnv('API_SRC_CHAIN'));
const API_DST_CHAIN  = parseInt(requireEnv('API_DST_CHAIN'));
const RECIPIENT      = requireEnv('RECIPIENT');
const EXECUTOR_API   = process.env.EXECUTOR_API || 'https://executor-testnet.labsapis.com';
const DESTINATION_CALLER = process.env.DESTINATION_CALLER || ZeroHash;
const MAX_FEE = BigInt(process.env.MAX_FEE || '100');
const MIN_FINALITY_THRESHOLD = parseInt(process.env.MIN_FINALITY_THRESHOLD || '0');
const FEE_DBPS = parseInt(process.env.FEE_DBPS || '0');
const FEE_PAYEE = process.env.FEE_PAYEE || ZeroHash;

// 🆕 模式选择配置
const EXECUTION_MODE = process.env.EXECUTION_MODE || 'gas'; // 'gas' 或 'drop'
const GAS_DROP_LIMIT = BigInt(process.env.GAS_DROP_LIMIT || '500000'); // gas drop 模式的 gas limit
const SOLANA_GAS_LIMIT = BigInt(process.env.SOLANA_GAS_LIMIT || '1400000'); // Solana 专用 gas limit (CU)

// 显示执行模式信息
console.log(`🎯 Execution Mode: ${EXECUTION_MODE.toUpperCase()}`);
console.log(EXECUTION_MODE === 'drop' 
  ? "   📦 Auto-delivery to recipient address" 
  : "   🏷️  Manual claim required on destination chain");
if (EXECUTION_MODE === 'drop') {
  console.log(`   ⛽ Gas Drop Limit: ${GAS_DROP_LIMIT} gas`);
}
if (API_DST_CHAIN === 1) {
  console.log(`   🔥 Solana Gas Limit: ${SOLANA_GAS_LIMIT} CU`);
}

const TOKENS = [
  {
    addr: requireEnv('TOKEN1'),
    dec: parseInt(process.env.TOKEN1_DEC || '18'),
    amt: process.env.TOKEN1_AMT || '0.00001',
    fee: parseInt(process.env.TOKEN1_FEE || '3000')
  },
  {
    addr: requireEnv('TOKEN2'),
    dec: parseInt(process.env.TOKEN2_DEC || '18'),
    amt: process.env.TOKEN2_AMT || '0.00001',
    fee: parseInt(process.env.TOKEN2_FEE || '3000')
  }
];

const DUST_ABI = [
  `function batchCollectWithUniversalRouter(
    (
      bytes commands,
      bytes[] inputs,
      uint256 deadline,
      address targetToken,
      uint16 dstChain,
      uint32 dstDomain,
      bytes32 recipient,
      uint256 arbiterFee,
      bytes32 destinationCaller,
      uint256 maxFee,
      uint32 minFinalityThreshold,
      tuple(address refundAddress, bytes signedQuote, bytes instructions) executorArgs,
      tuple(uint16 dbps, address payee) feeArgs,
      uint256 estimatedCost
    ),
    address[] pullTokens,
    uint256[] pullAmounts
  ) payable`
];

const PERMIT2_ABI = [
  'function permit(address owner, tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce)[] details,address spender,uint256 sigDeadline) permitBatch, bytes signature) external',
  'function allowance(address user, address token, address spender) external view returns (uint160,uint48,uint48)'
];

// 🔧 Base58 解码函数（仅用于 Solana 地址）
function base58Decode(str) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    const index = alphabet.indexOf(str[i]);
    if (index === -1) throw new Error('Invalid base58 character');
    result = result * 58n + BigInt(index);
  }
  const bytes = [];
  while (result > 0n) {
    bytes.unshift(Number(result % 256n));
    result = result / 256n;
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.unshift(0);
  return '0x' + Buffer.from(bytes).toString('hex').padStart(64, '0');
}

// 🔧 智能检测地址类型
function detectAddressType(address) {
  // 检测以太坊地址 (0x开头，42字符)
  if (isAddress(address)) {
    return 'ethereum';
  }
  
  // 检测 Solana 地址 (base58格式，32-44字符，不包含0、O、I、l)
  const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (solanaPattern.test(address)) {
    return 'solana';
  }
  
  // 检测 hex 格式
  if (address.startsWith('0x') && address.length === 66) {
    return 'hex';
  }
  
  return 'unknown';
}

// 🔧 将地址转换为 bytes32 格式
function addressToBytes32(address) {
  const addressType = detectAddressType(address);
  
  switch (addressType) {
    case 'ethereum':
      // 以太坊地址 20 bytes -> 32 bytes (左填充 0)
      const cleanAddr = address.toLowerCase().replace('0x', '');
      return '0x' + '000000000000000000000000' + cleanAddr;
      
    case 'solana':
      // Solana 地址通过 base58 解码得到 32 bytes
      return base58Decode(address);
      
    case 'hex':
      // 已经是 hex 格式，确保是 32 bytes
      return '0x' + address.replace('0x', '').padStart(64, '0');
      
    default:
      throw new Error(`Unsupported address format: ${address}. Expected Ethereum (0x...) or Solana (base58) address.`);
  }
}

// 🔧 修正的序列化函数 - 支持两种模式
function serializeRelayInstructions(apiDstChain, recipient, mode = EXECUTION_MODE) {
  console.log(`🔧 Serializing for destination chain: ${apiDstChain}`);
  console.log(`🎯 Execution Mode: ${mode.toUpperCase()}`);
  
  if (mode === 'drop') {
    // 🔄 模式1: GasDropOffInstruction - 自动发送到指定地址
    if (apiDstChain === 1) {
      // Solana: 使用 GasInstruction（Solana 不支持 dropOff）
      const dropOffHex = GAS_DROP_LIMIT.toString(16).padStart(32, '0');
      return '0x01' +                              // Type 1: GasInstruction
             dropOffHex +                        // gasLimit: 动态设置的 CU (16 bytes)
             '000000000000000000000000000f4240';   // msgValue: 0 (16 bytes)
    } else {
      // EVM 链: 使用 GasDropOffInstruction
      console.log(`🔧 Using GasDropOffInstruction for EVM chain`);
      
      // 将 gas limit 转换为16字节的十六进制
      const dropOffHex = GAS_DROP_LIMIT.toString(16).padStart(32, '0'); // 16 bytes
      
      // 确保 recipient 是正确的 32 bytes 格式
      const recipientHex = addressToBytes32(recipient).replace('0x', '');
      
      const result = '0x02' + dropOffHex + recipientHex;
      
      console.log(`🔧 DropOff (16 bytes): ${dropOffHex} (${GAS_DROP_LIMIT} gas)`);
      console.log(`🔧 Recipient (32 bytes): ${recipientHex}`);
      console.log(`🔧 Final relayInstructions: ${result}`);
      console.log(`🔧 Total length: ${result.length} chars (should be 130)`);
      
      return result;
    }
  } else {
    // 🚀 模式2: GasInstruction - 需要手动领取
    console.log(`🔧 Using GasInstruction mode (manual gas required)`);
    
    let gasLimit;
    if (apiDstChain === 1) {
      // Solana: 使用更高的计算单位 - 1,000,000 CU
      gasLimit = SOLANA_GAS_LIMIT.toString(16).padStart(32, '0'); // 动态设置

      const result = '0x01' +                        // Type 1: GasInstruction
             gasLimit +                              // gasLimit: 16 bytes
             '000000000000000000000000000f4240';    //manually set to 1,000,000 CU

      console.log(`🔧 Solana gasLimit: ${SOLANA_GAS_LIMIT} CU`);
      console.log(`🔧 EVM gasLimit: 200,000 gas`);
      console.log(`🔧 GasLimit (16 bytes): ${gasLimit}`);
      console.log(`🔧 MsgValue (16 bytes): 000000000000000000000000000f4240`);
      console.log(`🔧 Final relayInstructions: ${result}`);
      console.log(`🔧 Total length: ${result.length} chars (should be 66)`);
      return  result;
    } else {
      // EVM limited: 200,000 gas 
      gasLimit = '00000000000000000000000000030d40'; // 200,000 gas

      const result = '0x01' +                        // Type 1: GasInstruction
                     gasLimit +                      // gasLimit: 16 bytes
                     '00000000000000000000000000000000'; // msgValue: 0 (16 bytes)
      console.log(`🔧 EVM gasLimit: 200,000 gas`);
      console.log(`🔧 GasLimit (16 bytes): ${gasLimit}`);
      console.log(`🔧 MsgValue (16 bytes): 00000000000000000000000000000000`);
      console.log(`🔧 Final relayInstructions: ${result}`);
      console.log(`🔧 Total length: ${result.length} chars (should be 66)`);

      return result;
    }
    

  }
}

function v3Path(a, b, fee) {
  return solidityPacked(['address', 'uint24', 'address'], [a, fee, b]);
}

// 🔧 修正的 API 调用函数
async function getQuoteFromExecutor(apiSrcChain, apiDstChain, recipient) {
  const relayInstructions = serializeRelayInstructions(apiDstChain, recipient);
  
  const requestPayload = {
    srcChain: apiSrcChain,
    dstChain: apiDstChain,
    relayInstructions
  };
  
  console.log('🔍 API Request:', JSON.stringify(requestPayload, null, 2));
  
  try {
    const res = await axios.post(`${EXECUTOR_API}/v0/quote`, requestPayload, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    console.log('✅ API Response received');
    console.log('📊 Estimated cost:', res.data.estimatedCost || 'N/A');
    
    return {
      signedQuote: res.data.signedQuote,
      relayInstructions,
      estimatedCost: BigInt(res.data.estimatedCost || '0')
    };
  } catch (error) {
    console.error('\n❌ ====== API ERROR DETAILS ======');
    console.error('Status:', error.response?.status);
    console.error('Data:', error.response?.data);
    console.error('Request Data:', JSON.stringify(requestPayload, null, 2));
    console.error('================================\n');
    throw error;
  }
}

(async () => {
  try {
    console.log('\n📋 ====== CONFIGURATION SUMMARY ======');
    console.log(`🌐 Source Chain (API): ${API_SRC_CHAIN}`);
    console.log(`🎯 Destination Chain (API): ${API_DST_CHAIN}`);
    console.log(`📨 Recipient: ${RECIPIENT}`);
    console.log(`🎛️  Execution Mode: ${EXECUTION_MODE.toUpperCase()}`);
    if (EXECUTION_MODE === 'drop') {
      console.log(`⛽ Gas Drop Limit: ${GAS_DROP_LIMIT}`);
    }
    if (API_DST_CHAIN === 1) {
      console.log(`🔥 Solana Gas Limit: ${SOLANA_GAS_LIMIT} CU`);
    }
    console.log('=====================================\n');

    const provider = new JsonRpcProvider(RPC_URL);
    const wallet = new Wallet(PRIVKEY, provider);
    const chainId = (await provider.getNetwork()).chainId;
    
    // 🔧 智能处理 recipient 地址 - 根据地址格式自动检测类型
    const addressType = detectAddressType(RECIPIENT);
    console.log(`🎯 Detected address type: ${addressType.toUpperCase()}`);
    
    let recipientBytes32;
    try {
      recipientBytes32 = addressToBytes32(RECIPIENT);
      
      // 验证地址类型与目标链的兼容性
      if (API_DST_CHAIN === 1 && addressType !== 'solana') {
        console.warn(`⚠️  Warning: Target is Solana (chain ${API_DST_CHAIN}) but address looks like ${addressType}. This might cause issues.`);
      } else if (API_DST_CHAIN !== 1 && addressType === 'solana') {
        console.warn(`⚠️  Warning: Target is EVM chain (${API_DST_CHAIN}) but address looks like Solana. This might cause issues.`);
      }
      
    } catch (error) {
      throw new Error(`Failed to process recipient address: ${error.message}`);
    }
    
    console.log(`👛 Wallet: ${wallet.address}`);
    console.log(`🌐 Chain ID: ${chainId}`);
    console.log(`📨 Original Recipient: ${RECIPIENT}`);
    console.log(`🏷️  Address Type: ${addressType.toUpperCase()}`);
    console.log(`📨 Recipient (bytes32): ${recipientBytes32}`);
    
    for (const t of TOKENS) t.amtWei = parseUnits(t.amt, t.dec);

    // Permit2 setup
    console.log('\n🔐 ====== PERMIT2 SETUP ======');
    const permit2 = new Contract(PERMIT2, PERMIT2_ABI, wallet);
    const expiration = Math.floor(Date.now() / 1e3) + 86400 * 30;
    const sigDeadline = Math.floor(Date.now() / 1e3) + 3600;
    const details = await Promise.all(TOKENS.map(async t => {
      const [, , nonce] = await permit2.allowance(wallet.address, t.addr, COLLECTOR);
      console.log(`🪙 Token: ${t.addr}, Amount: ${t.amt}, Nonce: ${nonce}`);
      return { token: t.addr, amount: t.amtWei, expiration, nonce };
    }));

    const domain = { name: 'Permit2', chainId, verifyingContract: PERMIT2 };
    const types = {
      PermitBatch: [
        { name: 'details', type: 'PermitDetails[]' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' }
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' }
      ]
    };

    const permitBatch = { details, spender: COLLECTOR, sigDeadline };
    const signature = await wallet.signTypedData(domain, types, permitBatch);
    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    
    console.log('⏳ Sending Permit2 transaction...');
    await permit2.permit(wallet.address, permitBatch, signature, { nonce });
    console.log('✅ Permit2 transaction completed');

    // 🔧 获取 quote - 使用原始地址作为参数传递给 API
    console.log('\n💰 ====== GETTING QUOTE FROM EXECUTOR ======');
    const { signedQuote, relayInstructions, estimatedCost } = await getQuoteFromExecutor(
      API_SRC_CHAIN,
      API_DST_CHAIN,
      RECIPIENT  // 传递原始地址，函数内部会处理转换
    );

    // Calculate fee with buffer
    const buffer = estimatedCost > 0n ? estimatedCost / 1n : BigInt('10000000000000000000000');
    const actualMsgValue = estimatedCost + buffer;
    
    console.log(`📦 Estimated Cost: ${estimatedCost} wei`);
    console.log(`💰 Using actual value with buffer: ${actualMsgValue} wei`);

    // Build transaction
    console.log('\n🔨 ====== BUILDING TRANSACTION ======');
    const abi = AbiCoder.defaultAbiCoder();
    const commands = '0x' + '00'.repeat(TOKENS.length);
    const inputs = TOKENS.map(t =>
      abi.encode(['address','uint256','uint256','bytes','bool'], [COLLECTOR, t.amtWei, 0, v3Path(t.addr, TARGET, t.fee), false])
    );

    console.log(`📝 Commands: ${commands}`);
    console.log(`📋 Inputs count: ${inputs.length}`);

    const contract = new Contract(COLLECTOR, DUST_ABI, wallet);
    
    console.log('⏳ Sending main transaction...');
    const tx = await contract.batchCollectWithUniversalRouter(
      {
        commands,
        inputs,
        deadline: Math.floor(Date.now() / 1e3) + 1800,
        targetToken: TARGET,
        dstChain: DST_CHAIN_ID,
        dstDomain: DST_DOMAIN,
        recipient: recipientBytes32,  // 🔧 使用转换后的 bytes32 格式
        arbiterFee: 0,
        destinationCaller: DESTINATION_CALLER,
        maxFee: MAX_FEE,
        minFinalityThreshold: MIN_FINALITY_THRESHOLD,
        executorArgs: {
          refundAddress: wallet.address,
          signedQuote,
          instructions: relayInstructions
        },
        feeArgs: {
          dbps: FEE_DBPS,
          payee: FEE_PAYEE
        },
        estimatedCost: actualMsgValue  // 🎯 新增：将 actualMsgValue 作为 estimatedCost 参数传递
      },
      TOKENS.map(t => t.addr),
      TOKENS.map(t => t.amtWei),
      {
        value: actualMsgValue,
        gasLimit: 1_500_000,
        nonce: nonce + 1
      }
    );

    console.log('\n🎯 ====== TRANSACTION RESULT ======');
    console.log('📝 Tx sent:', tx.hash);
    console.log('⏳ Waiting for confirmation...');
    
    const rc = await tx.wait();
    console.log(rc.status === 1 ? '✅ Transaction Success!' : '❌ Transaction Failed!');
    
    if (rc.status === 1) {
      console.log('\n🎉 ====== SUCCESS SUMMARY ======');
      console.log(`✅ Transaction confirmed in block: ${rc.blockNumber}`);
      console.log(`⛽ Gas used: ${rc.gasUsed}`);
      console.log(`💰 Total cost: ${actualMsgValue} wei`);
      console.log(`💰 Estimated cost parameter: ${actualMsgValue} wei`);
      
      if (EXECUTION_MODE === 'gas') {
        console.log('\n📋 NEXT STEPS (GAS Mode):');
        console.log('🏷️  Your funds are being transferred cross-chain');
        console.log('⏰ You will need to manually deposit gas on the destination chain');
        console.log('🔍 Check the executor status for completion');
      } else {
        console.log('\n📋 NEXT STEPS (DROP Mode):');
        console.log('📦 gas should automatically arrive at your recipient address');
        console.log('🔍 Check your destination chain balance');
      }
      
      console.log(`🌐 Track progress: ${EXECUTOR_API}/status/${tx.hash}`);
    }
    
  } catch (error) {
    console.error('\n🚨 ====== SCRIPT ERROR ======');
    console.error(`❌ Error: ${error.message}`);
    
    if (error.response?.data) {
      console.error(`🌐 API Error: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    
    if (error.code) {
      console.error(`🔧 Error Code: ${error.code}`);
    }
    
    console.error('\n💡 TROUBLESHOOTING TIPS:');
    console.error('1. Check your .env configuration');
    console.error('2. Verify wallet has sufficient balance');
    console.error('3. Try switching execution mode (gas/drop)');
    if (EXECUTION_MODE === 'drop') {
      console.error('4. Try increasing GAS_DROP_LIMIT');
      console.error('5. Or switch to gas mode: EXECUTION_MODE=gas');
    }
    console.error('6. Check network connectivity and RPC endpoint');
    console.error('7. Verify address format:');
    console.error('   - Ethereum: 0x1234...5678 (42 chars)');
    console.error('   - Solana: 2ujBt...JSeN9 (32-44 chars, base58)');
    console.error('8. Ensure target chain matches address type:');
    console.error('   - API_DST_CHAIN=1 for Solana addresses');
    console.error('   - API_DST_CHAIN!=1 for Ethereum addresses');
    
    process.exit(1);
  }
})();