// scripts/dust-collector-7702-wormhole.js
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, Wallet, Contract, isAddress, Interface, toUtf8String
} from 'ethers';
import { JsonRpcProvider } from 'ethers';
import readline from 'readline';

console.log("\n🚀 DustCollector EIP-7702 Wormhole Script");
console.log("🧪 Powered by EIP-7702 + Wormhole Bridge");
console.log("✨ Direct token transfer - No approvals needed!");

/* ---------- Config Validation ---------- */
const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`❌ Missing environment variable: ${key}`);
  return value;
};

const RPC_URL        = requireEnv('RPC_URL');
const PRIVKEY        = requireEnv('PRIVATE_KEY');
const COLLECTOR      = requireEnv('TARGET_CONTRACT'); // DustCollector7702Wormhole 合约地址
const TARGET         = requireEnv('TARGET_TOKEN');
const DST_CHAIN_ID   = parseInt(requireEnv('DST_CHAIN_ID') || '0');
const RECIPIENT      = process.env.RECIPIENT || ZeroHash;
const ARBITER_FEE    = BigInt(process.env.ARBITER_FEE || '0');

// Smart Batching Configuration
const MAX_TOKENS_PER_BATCH = parseInt(process.env.MAX_TOKENS_PER_BATCH || '3');
const ENABLE_AUTO_BATCHING = process.env.ENABLE_AUTO_BATCHING !== 'false';

// 🔧 添加本链交换判断
const IS_LOCAL_SWAP = DST_CHAIN_ID === 0;

console.log(`📦 Smart Batching: ${ENABLE_AUTO_BATCHING ? 'Enabled' : 'Disabled'}`);
console.log(`🔢 Max tokens per batch: ${MAX_TOKENS_PER_BATCH}`);
console.log(`🏠 Transaction type: ${IS_LOCAL_SWAP ? 'Local Swap Only' : 'Cross-chain Bridge'}`);

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
  },
  {
    addr: requireEnv('TOKEN3'),
    dec: parseInt(process.env.TOKEN3_DEC || '18'),
    amt: process.env.TOKEN3_AMT || '0.00001',
    fee: parseInt(process.env.TOKEN3_FEE || '3000')
  }
];

// Add TOKEN4 conditionally
const token4Addr = process.env.TOKEN4;
if (token4Addr && (!ENABLE_AUTO_BATCHING || TOKENS.length < MAX_TOKENS_PER_BATCH)) {
  TOKENS.push({
    addr: token4Addr,
    dec: parseInt(process.env.TOKEN4_DEC || '18'),
    amt: process.env.TOKEN4_AMT || '0.00001',
    fee: parseInt(process.env.TOKEN4_FEE || '3000')
  });
  console.log(`✅ Added TOKEN4 to batch`);
} else if (token4Addr) {
  console.log(`⚠️  TOKEN4 skipped due to batch size limit (${MAX_TOKENS_PER_BATCH})`);
}

// 🔧 简化的 ABI 定义 - 匹配 Wormhole 合约
const DUST_ABI = [
  {
    "type": "function",
    "name": "batchCollectWithUniversalRouter7702",
    "inputs": [
      {
        "name": "params",
        "type": "tuple",
        "components": [
          {"name": "commands", "type": "bytes"},
          {"name": "inputs", "type": "bytes[]"},
          {"name": "deadline", "type": "uint256"},
          {"name": "targetToken", "type": "address"},
          {"name": "dstChain", "type": "uint16"},
          {"name": "recipient", "type": "bytes32"},
          {"name": "arbiterFee", "type": "uint256"}
        ]
      },
      {"name": "tokens", "type": "address[]"},
      {"name": "amounts", "type": "uint256[]"}
    ],
    "outputs": [],
    "stateMutability": "payable"
  }
];

// Wormhole Core ABI for fee calculation
const WORMHOLE_CORE_ABI = [
  'function messageFee() external view returns (uint256)'
];

// ERC20 ABI for balance checking
const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)'
];

function detectAddressType(address) {
  if (isAddress(address)) return 'ethereum';
  const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (solanaPattern.test(address)) return 'solana';
  if (address.startsWith('0x') && address.length === 66) return 'hex';
  return 'unknown';
}

// Base58 functions for Solana addresses
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str) {
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    const index = BASE58_ALPHABET.indexOf(str[i]);
    if (index === -1) throw new Error('Invalid base58 character');
    result = result * 58n + BigInt(index);
  }
  const bytes = [];
  while (result > 0n) {
    bytes.unshift(Number(result % 256n));
    result = result / 256n;
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.unshift(0);
  return Buffer.from(bytes);
}

function addressToBytes32(address) {
  const addressType = detectAddressType(address);
  switch (addressType) {
    case 'ethereum':
      const cleanAddr = address.toLowerCase().replace('0x', '');
      return `0x${'000000000000000000000000' + cleanAddr}`;
    case 'solana':
      const decoded = base58Decode(address);
      return `0x${decoded.toString('hex').padStart(64, '0')}`;
    case 'hex':
      return `0x${address.replace('0x', '').padStart(64, '0')}`;
    default:
      throw new Error(`Unsupported address format: ${address}`);
  }
}

function v3Path(tokenA, tokenB, fee) {
  return solidityPacked(['address', 'uint24', 'address'], [tokenA, fee, tokenB]);
}

async function getWormholeFee(provider, coreAddress) {
  // 🔧 本链交换时跳过 Wormhole fee 查询
  if (IS_LOCAL_SWAP) {
    console.log('🏠 Local swap detected - Skipping Wormhole fee query');
    return BigInt('0');
  }
  
  if (!coreAddress || coreAddress === ZeroHash) {
    console.log('⚠️  No Wormhole core address provided, using default fee');
    return BigInt('100000000000000'); // 0.0001 ETH default
  }
  
  try {
    const coreContract = new Contract(coreAddress, WORMHOLE_CORE_ABI, provider);
    const fee = await coreContract.messageFee();
    console.log(`✅ Wormhole message fee: ${fee} wei`);
    return fee;
  } catch (error) {
    console.warn(`⚠️  Failed to get Wormhole fee: ${error.message}`);
    return BigInt('100000000000000'); // 0.0001 ETH fallback
  }
}

async function delegateToContract(wallet, provider, targetContract) {
  console.log('\n🔗 ====== EIP-7702 DELEGATION PROCESS ======');
  
  const code = await provider.getCode(wallet.address);
  
  if (code !== "0x") {
    if (code.startsWith("0xef0100")) {
      const currentDelegation = "0x" + code.slice(8);
      console.log("⚠️  EOA currently delegated to:", currentDelegation);
      
      if (currentDelegation.toLowerCase() === targetContract.toLowerCase()) {
        console.log("✅ Already delegated to target contract. Ready to proceed!");
        return true;
      }
    }
  } else {
    console.log("📋 EOA has no current delegation. Will delegate now...");
  }

  const contractCode = await provider.getCode(targetContract);
  if (contractCode === "0x") {
    throw new Error("Target address is not a contract");
  }

  const network = await provider.getNetwork();
  const currentNonce = await wallet.getNonce();
  
  console.log("Network Chain ID:", network.chainId);
  console.log("Delegating EOA to:", targetContract);

  const authorization = await wallet.authorize({
    address: targetContract,
    nonce: currentNonce + 1,
    chainId: network.chainId,
  });

  const tx = await wallet.sendTransaction({
    type: 4,
    to: wallet.address,
    authorizationList: [authorization],
  });

  console.log("✅ Sent delegate tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ Confirmed in block:", receipt.blockNumber);

  await new Promise(resolve => setTimeout(resolve, 3000));

  let retries = 0;
  const maxRetries = 5;
  
  while (retries < maxRetries) {
    const newCode = await provider.getCode(wallet.address);
    
    if (newCode.startsWith("0xef0100")) {
      const delegatedTo = "0x" + newCode.slice(8);
      if (delegatedTo.toLowerCase() === targetContract.toLowerCase()) {
        console.log("✅ Delegation successful! Delegated to:", delegatedTo);
        console.log("🎉 EIP-7702 delegation completed successfully!");
        return true;
      }
    }
    
    retries++;
    if (retries < maxRetries) {
      console.log(`⏳ Retry ${retries}/${maxRetries} - waiting for state update...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  throw new Error("Failed to verify delegation");
}

async function revokeDelegation(wallet, provider) {
  console.log('\n🔄 ====== REVOKING EIP-7702 DELEGATION ======');
  
  const code = await provider.getCode(wallet.address);
  if (code === "0x") {
    console.log("✅ EOA is not currently delegated. No revocation needed.");
    return true;
  }
  
  const network = await provider.getNetwork();
  const currentNonce = await wallet.getNonce();

  const authorization = await wallet.authorize({
    address: '0x0000000000000000000000000000000000000000',
    nonce: currentNonce + 1,
    chainId: network.chainId,
  });

  const tx = await wallet.sendTransaction({
    type: 4,
    to: wallet.address,
    authorizationList: [authorization],
  });

  console.log("✅ Sent revocation tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ Revocation confirmed in block:", receipt.blockNumber);

  await new Promise(resolve => setTimeout(resolve, 3000));

  const newCode = await provider.getCode(wallet.address);
  if (newCode === "0x") {
    console.log("✅ Delegation successfully revoked! EOA restored to normal state.");
    return true;
  } else {
    throw new Error("Failed to verify delegation revocation");
  }
}

function askUserChoice() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n❓ ====== DELEGATION MANAGEMENT ======');
    console.log('🔗 Your account is currently delegated to the DustCollector contract.');
    console.log('💡 You can choose to:');
    console.log('   1️⃣  Keep the delegation (for future transactions)');
    console.log('   2️⃣  Revoke the delegation (restore EOA to normal state)');
    
    rl.question('👉 Do you want to REVOKE the delegation? (y/N): ', (answer) => {
      rl.close();
      const shouldRevoke = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
      resolve(shouldRevoke);
    });
  });
}

// Main execution
(async () => {
  try {
    console.log('\n📋 ====== CONFIGURATION SUMMARY ======');
    console.log(`📨 Recipient: ${RECIPIENT}`);
    console.log(`🌉 Destination Chain: ${DST_CHAIN_ID}`);
    console.log(`🏠 Transaction Mode: ${IS_LOCAL_SWAP ? 'LOCAL SWAP ONLY' : 'CROSS-CHAIN BRIDGE'}`);
    console.log(`🎯 DustCollector Contract: ${COLLECTOR}`);
    console.log(`🔢 Tokens to process: ${TOKENS.length}`);
    console.log(`💰 Arbiter Fee: ${ARBITER_FEE} wei`);
    console.log('=====================================\n');

    const provider = new JsonRpcProvider(RPC_URL);
    const wallet = new Wallet(PRIVKEY, provider);
    
    console.log(`👛 Wallet: ${wallet.address}`);
    
    // Process recipient address - 保留recipient处理，无论本地还是跨链
    let recipientBytes32 = ZeroHash;
    if (RECIPIENT && RECIPIENT !== ZeroHash) {
      const addressType = detectAddressType(RECIPIENT);
      console.log(`🎯 Detected recipient address type: ${addressType.toUpperCase()}`);
      recipientBytes32 = addressToBytes32(RECIPIENT);
      console.log(`📨 Recipient (bytes32): ${recipientBytes32}`);
      if (IS_LOCAL_SWAP) {
        console.log(`🏠 Local swap mode - Recipient will be used for local processing`);
      }
    } else {
      console.log(`📨 No recipient specified - Using zero address`);
    }
    
    // Parse token amounts and check balances
    for (const t of TOKENS) {
      t.amtWei = parseUnits(t.amt, t.dec);
    }

    console.log('\n💰 ====== CHECKING TOKEN BALANCES ======');
    for (const token of TOKENS) {
      const tokenContract = new Contract(token.addr, ERC20_ABI, provider);
      const balance = await tokenContract.balanceOf(wallet.address);
      console.log(`🪙 Token ${token.addr}:`);
      console.log(`   Balance: ${balance}`);
      console.log(`   Required: ${token.amtWei}`);
      console.log(`   Sufficient: ${balance >= token.amtWei ? '✅' : '❌'}`);
      
      if (balance < token.amtWei) {
        throw new Error(`Insufficient balance for token ${token.addr}`);
      }
    }

    // Step 1: Ensure delegation
    await delegateToContract(wallet, provider, COLLECTOR);

    // Step 2: Calculate Wormhole fee (跨链时才查询)
    console.log('\n💰 ====== CALCULATING FEES ======');
    const WORMHOLE_CORE = process.env.WORMHOLE_CORE;
    let wormholeFee = BigInt('0');
    
    if (IS_LOCAL_SWAP) {
      console.log(`🏠 Local swap mode - No cross-chain fees required`);
    } else if (recipientBytes32 !== ZeroHash) {
      wormholeFee = await getWormholeFee(provider, WORMHOLE_CORE);
      console.log(`🌉 Cross-chain transfer enabled - Fee: ${wormholeFee} wei`);
    } else {
      console.log(`📍 Cross-chain mode but no valid recipient - Processing as local swap`);
    }

    // Add buffer for transaction execution
    // 🔧 本链交换无需msg.value，只有跨链才需要支付费用

    const totalMsgValue = wormholeFee;
    
    console.log(`💰 Total value to send: ${totalMsgValue} wei`);

    // Step 3: Build transaction
    console.log('\n🔨 ====== BUILDING TRANSACTION ======');
    const abi = AbiCoder.defaultAbiCoder();
    const commands = '0x' + '00'.repeat(TOKENS.length);
    
    const inputs = TOKENS.map((t, index) => {
      const path = v3Path(t.addr, TARGET, t.fee);
      const input = abi.encode(
        ['address','uint256','uint256','bytes','bool'], 
        [wallet.address, t.amtWei, 0, path, false]  // recipient = wallet.address (结果回到EOA)
      );
      console.log(`🔧 Input ${index + 1} for token ${t.addr}:`);
      console.log(`   Swap Recipient: ${wallet.address} (EOA itself)`);
      console.log(`   Amount: ${t.amtWei}`);
      console.log(`   Path: ${path}`);
      return input;
    });

    // 🔧 准备tokens和amounts参数
    const tokens = TOKENS.map(t => t.addr);
    const amounts = TOKENS.map(t => t.amtWei);
    
    console.log('\n📦 ====== TOKEN PARAMETERS ======');
    console.log('Tokens:', tokens);
    console.log('Amounts:', amounts.map(amt => amt.toString()));

    // Create contract instance - 关键：使用EOA地址作为合约地址
    const contract = new Contract(wallet.address, DUST_ABI, wallet);
    
    // Verify function selector
    console.log('\n🔍 ====== FUNCTION SELECTOR VERIFICATION ======');
    const expectedSelector = contract.interface.getFunction('batchCollectWithUniversalRouter7702').selector;
    console.log(`Expected function selector: ${expectedSelector}`);
    
    // Create minimal test ABI to verify selector
    const testABI = [
      "function batchCollectWithUniversalRouter7702((bytes,bytes[],uint256,address,uint16,bytes32,uint256),address[],uint256[]) payable"
    ];
    const testInterface = new Interface(testABI);
    const testSelector = testInterface.getFunction('batchCollectWithUniversalRouter7702').selector;
    console.log(`Test selector: ${testSelector}`);
    console.log(`Selectors match: ${expectedSelector === testSelector}`);
    
    // Prepare SwapParams structure (简化本链交换参数)
    const swapParams = {
      commands,
      inputs,
      deadline: Math.floor(Date.now() / 1e3) + 1800,
      targetToken: TARGET,
      dstChain: DST_CHAIN_ID,
      recipient: recipientBytes32,
      arbiterFee: IS_LOCAL_SWAP ? BigInt('0') : ARBITER_FEE // 本链交换时无需arbiter fee
    };
    
    console.log('\n📋 ====== TRANSACTION PARAMETERS ======');
    console.log(`🎯 Target Token: ${swapParams.targetToken}`);
    console.log(`🌉 Destination Chain: ${swapParams.dstChain}`);
    console.log(`📨 Recipient: ${swapParams.recipient}`);
    console.log(`💰 Arbiter Fee: ${swapParams.arbiterFee}`);
    console.log(`🔧 Tokens Count: ${tokens.length}`);
    console.log(`⏰ Deadline: ${swapParams.deadline} (${new Date(swapParams.deadline * 1000).toISOString()})`);
    
    // Validate all parameters
    console.log('\n✅ ====== PARAMETER VALIDATION ======');
    console.log(`Target token is valid address: ${isAddress(swapParams.targetToken)}`);
    console.log(`Commands length: ${swapParams.commands.length}`);
    console.log(`Inputs array length: ${swapParams.inputs.length}`);
    console.log(`Tokens array length: ${tokens.length}`);
    console.log(`Amounts array length: ${amounts.length}`);
    console.log(`All amounts > 0: ${amounts.every(amt => amt > 0)}`);
    console.log(`Deadline > now: ${swapParams.deadline > Math.floor(Date.now() / 1000)}`);
    console.log(`Transaction mode: ${IS_LOCAL_SWAP ? 'LOCAL' : 'CROSS-CHAIN'}`);
    
    // 🔧 本链交换时跳过跨链相关的验证
    if (!IS_LOCAL_SWAP) {
      console.log('\n🌉 ====== CROSS-CHAIN VALIDATION ======');
      console.log(`Destination chain > 0: ${swapParams.dstChain > 0}`);
      console.log(`Has valid recipient: ${swapParams.recipient !== ZeroHash}`);
      console.log(`Wormhole fee calculated: ${wormholeFee > 0}`);
    } else {
      console.log('\n🏠 ====== LOCAL SWAP VALIDATION ======');
      console.log(`✅ Local swap mode - Skipping cross-chain validations`);
    }
    
    // Debug contract state before gas estimation (跨链时才检查bridge相关)
    console.log('\n🔍 ====== CONTRACT STATE DEBUGGING ======');
    try {
      // Check if contract has required methods
      const contractWithSigner = new Contract(COLLECTOR, [
        'function router() external view returns (address)',
        ...(IS_LOCAL_SWAP ? [] : [
          'function bridge() external view returns (address)', 
          'function core() external view returns (address)'
        ]),
        'function feeConfig() external view returns (address)',
        'function getCurrentFeeConfig() external view returns (uint256, address)'
      ], wallet);
      
      console.log('📋 Checking contract dependencies...');
      const routerAddr = await contractWithSigner.router();
      console.log(`🔧 Router: ${routerAddr}`);
      
      // 本链交换时跳过bridge相关检查
      if (!IS_LOCAL_SWAP) {
        const bridgeAddr = await contractWithSigner.bridge();
        const coreAddr = await contractWithSigner.core();
        console.log(`🌉 Bridge: ${bridgeAddr}`);
        console.log(`💎 Core: ${coreAddr}`);
        
        // Verify bridge components are not zero addresses
        const zeroAddr = '0x0000000000000000000000000000000000000000';
        if ([bridgeAddr, coreAddr].includes(zeroAddr)) {
          throw new Error('❌ One or more bridge components are zero addresses');
        }
      } else {
        console.log(`🏠 Local swap mode - Skipping bridge component checks`);
      }
      
      const feeConfigAddr = await contractWithSigner.feeConfig();
      console.log(`⚙️  FeeConfig: ${feeConfigAddr}`);
      
      // Check fee config
      const [feeBps, feeCollector] = await contractWithSigner.getCurrentFeeConfig();
      console.log(`💰 Fee BPS: ${feeBps}`);
      console.log(`💳 Fee Collector: ${feeCollector}`);
      
    } catch (debugError) {
      console.error(`⚠️  Contract debug failed: ${debugError.message}`);
    }

    // Gas estimation with better error handling
    console.log('\n⛽ ====== GAS ESTIMATION ======');
    
    // 🔧 检查账户ETH余额
    const ethBalance = await provider.getBalance(wallet.address);
    console.log(`💰 Current ETH balance: ${ethBalance} wei (${(Number(ethBalance) / 1e18).toFixed(6)} ETH)`);
    console.log(`💰 Required msg.value: ${totalMsgValue} wei (${(Number(totalMsgValue) / 1e18).toFixed(6)} ETH)`);
    
    if (ethBalance < totalMsgValue) {
      throw new Error(`Insufficient ETH balance for msg.value: have ${ethBalance}, need ${totalMsgValue}`);
    }
    
    try {
      const estimatedGas = await contract.batchCollectWithUniversalRouter7702.estimateGas(
        swapParams,
        tokens,
        amounts,
        {
          value: totalMsgValue,
          from: wallet.address
        }
      );
      console.log(`✅ Estimated gas: ${estimatedGas}`);
      
      // 🔧 估算总gas费用
      const gasPrice = await provider.getFeeData();
      const maxGasCost = estimatedGas * (gasPrice.maxFeePerGas || gasPrice.gasPrice || BigInt('20000000000'));
      console.log(`⛽ Estimated max gas cost: ${maxGasCost} wei (${(Number(maxGasCost) / 1e18).toFixed(6)} ETH)`);
      
      if (ethBalance < maxGasCost + totalMsgValue) {
        console.warn(`⚠️  Warning: ETH balance may be insufficient for gas + value`);
        console.warn(`   Balance: ${(Number(ethBalance) / 1e18).toFixed(6)} ETH`);
        console.warn(`   Estimated need: ${(Number(maxGasCost + totalMsgValue) / 1e18).toFixed(6)} ETH`);
      }
      
    } catch (gasError) {
      console.error(`❌ Gas estimation failed: ${gasError.message}`);
      
      // Debug delegation state
      const currentCode = await provider.getCode(wallet.address);
      if (currentCode.startsWith("0xef0100")) {
        const delegatedTo = "0x" + currentCode.slice(8);
        console.log(`🔍 EOA delegated to: ${delegatedTo}`);
        console.log(`🔍 Expected: ${COLLECTOR}`);
        console.log(`🔍 Match: ${delegatedTo.toLowerCase() === COLLECTOR.toLowerCase()}`);
      } else {
        console.log(`❌ EOA not properly delegated. Code: ${currentCode}`);
      }
      
      if (process.env.SKIP_GAS_ESTIMATION === 'true') {
        console.log('🚀 Skipping gas estimation and sending transaction directly...');
      } else {
        throw new Error(`Gas estimation failed: ${gasError.message}`);
      }
    }
    
    // Send transaction
    console.log('\n📤 ====== SENDING TRANSACTION ======');
    
    const baseGas = 300000n; // 基础gas
    const gasPerToken = 120000n; // 每个token的gas成本
    const bridgeGas = IS_LOCAL_SWAP ? 0n : 200000n; // 本链交换无需bridge gas
    const dynamicGasLimit = baseGas + (gasPerToken * BigInt(TOKENS.length)) + bridgeGas;
    const maxGasLimit = IS_LOCAL_SWAP ? 2000000n : 3000000n; // 本链交换降低gas上限
    const finalGasLimit = dynamicGasLimit < 1500000n ? 1500000n : 
                         dynamicGasLimit > maxGasLimit ? maxGasLimit : 
                         dynamicGasLimit;
    
    console.log(`⛽ Gas limit: ${finalGasLimit} (${IS_LOCAL_SWAP ? 'Local' : 'Cross-chain'} mode)`);
    console.log(`💰 Msg.value: ${totalMsgValue} wei (${(Number(totalMsgValue) / 1e18).toFixed(6)} ETH)`);
    console.log(`🔧 Transaction type: ${IS_LOCAL_SWAP ? 'Local Swap - No ETH transfer needed' : 'Cross-chain - ETH for fees'}`);
    
    let tx;
    try {
      tx = await contract.batchCollectWithUniversalRouter7702(
        swapParams,
        tokens,
        amounts,
        {
          value: totalMsgValue,
          gasLimit: finalGasLimit
        }
      );
      console.log('✅ Transaction sent successfully');
    } catch (sendError) {
      console.error(`❌ Failed to send transaction: ${sendError.message}`);
      
      // If it's a revert with data, try to decode it
      if (sendError.data) {
        console.log(`🔍 Error data: ${sendError.data}`);
        try {
          // Try to decode common error messages
          if (sendError.data.startsWith('0x08c379a0')) {
            const errorMessage = toUtf8String('0x' + sendError.data.slice(138));
            console.log(`🔍 Decoded error: ${errorMessage}`);
          }
        } catch (decodeError) {
          console.log(`⚠️  Could not decode error data`);
        }
      }
      
      throw sendError;
    }

    console.log('\n🎯 ====== TRANSACTION RESULT ======');
    console.log('📝 Transaction hash:', tx.hash);
    console.log('⏳ Waiting for confirmation...');
    
    const receipt = await tx.wait();
    console.log(receipt.status === 1 ? '✅ Transaction Success!' : '❌ Transaction Failed!');
    
    if (receipt.status === 1) {
      console.log('\n🎉 ====== SUCCESS SUMMARY ======');
      console.log(`✅ Transaction confirmed in block: ${receipt.blockNumber}`);
      console.log(`⛽ Gas used: ${receipt.gasUsed}`);
      console.log(`💰 Total cost: ${totalMsgValue} wei`);
      
      console.log('\n📋 EXECUTION SUMMARY:');
      console.log('1️⃣  ✅ EIP-7702 delegation completed');
      console.log('2️⃣  ✅ Direct token transfer to UniversalRouter');
      console.log('3️⃣  ✅ Token swap executed');
      
      if (IS_LOCAL_SWAP) {
        console.log('4️⃣  ✅ Local swap completed (no bridge required)');
        console.log(`🏠 All tokens swapped to ${TARGET} and kept in wallet`);
        if (recipientBytes32 !== ZeroHash) {
          console.log(`📨 Recipient parameter preserved: ${RECIPIENT}`);
        }
      } else if (recipientBytes32 !== ZeroHash) {
        console.log('4️⃣  ✅ Wormhole cross-chain bridge completed');
        console.log(`📨 Recipient: ${RECIPIENT}`);
      } else {
        console.log('4️⃣  ✅ Local swap completed (no valid bridge recipient)');
      }
      
      // Ask about delegation management
      const shouldRevoke = await askUserChoice();
      
      if (shouldRevoke) {
        await revokeDelegation(wallet, provider);
        console.log('\n✅ All done! Your EOA has been restored to normal state.');
      } else {
        console.log('\n✅ All done! Your EOA remains delegated for future transactions.');
      }
    }
    
  } catch (error) {
    console.error('\n🚨 ====== SCRIPT ERROR ======');
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
})();