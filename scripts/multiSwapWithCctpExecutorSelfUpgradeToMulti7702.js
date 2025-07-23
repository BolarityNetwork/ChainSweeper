// scripts/dust-executor-7702-updated.js
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, Wallet, Contract, isAddress
} from 'ethers';
import { JsonRpcProvider } from 'ethers';
import axios from 'axios';
import { createHash } from 'crypto';
import { serialize } from 'binary-layout';
import readline from 'readline';

console.log("\n🚀 DustCollector EIP-7702 Direct Script (Updated)");
console.log("🧪 Powered by EIP-7702 + Wormhole CCTP v2 + Executor");
console.log("✨ Direct token transfer - No approvals needed!");

/* ---------- Config Validation ---------- */
const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`❌ Missing environment variable: ${key}`);
  return value;
};

const RPC_URL        = requireEnv('RPC_URL');
const PRIVKEY        = requireEnv('PRIVATE_KEY');
const COLLECTOR      = requireEnv('TARGET_CONTRACT'); // DustCollector7702 合约地址
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

// Configuration
const SOLANA_TOKEN_MINT = process.env.SOLANA_TOKEN_MINT || '';
const USE_ATA_FOR_SOLANA = process.env.USE_ATA_FOR_SOLANA !== 'false';
const EXECUTION_MODE = process.env.EXECUTION_MODE || 'gas';
const GAS_DROP_LIMIT = BigInt(process.env.GAS_DROP_LIMIT || '500000');
const SOLANA_GAS_LIMIT = BigInt(process.env.SOLANA_GAS_LIMIT || '1400000');
const SOLANA_GAS_DROP = BigInt(process.env.SOLANA_GAS_DROP || '500000');
const MAX_TOKENS_PER_BATCH = parseInt(process.env.MAX_TOKENS_PER_BATCH || '3');
const ENABLE_AUTO_BATCHING = process.env.ENABLE_AUTO_BATCHING !== 'false';

console.log(`🎯 Execution Mode: ${EXECUTION_MODE.toUpperCase()}`);
console.log(`📦 Smart Batching: ${ENABLE_AUTO_BATCHING ? 'Enabled' : 'Disabled'}`);
console.log(`🔢 Max tokens per batch: ${MAX_TOKENS_PER_BATCH}`);

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

// 🔧 更新的 ABI 定义 - 匹配最新合约
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
          {"name": "dstDomain", "type": "uint32"},
          {"name": "recipient", "type": "bytes32"},
          {"name": "arbiterFee", "type": "uint256"},
          {"name": "destinationCaller", "type": "bytes32"},
          {"name": "maxFee", "type": "uint256"},
          {"name": "minFinalityThreshold", "type": "uint32"},
          {
            "name": "executorArgs",
            "type": "tuple",
            "components": [
              {"name": "refundAddress", "type": "address"},
              {"name": "signedQuote", "type": "bytes"},
              {"name": "instructions", "type": "bytes"}
            ]
          },
          {
            "name": "feeArgs",
            "type": "tuple",
            "components": [
              {"name": "dbps", "type": "uint16"},
              {"name": "payee", "type": "address"}
            ]
          },
          {"name": "estimatedCost", "type": "uint256"}
        ]
      },
      {"name": "pullTokens", "type": "address[]"},    // 🔧 新增：需要转移的token地址
      {"name": "pullAmounts", "type": "uint256[]"}    // 🔧 新增：对应的数量
    ],
    "outputs": [],
    "stateMutability": "payable"
  }
];

// ERC20 ABI for balance checking
const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)'
];

// 🔧 Binary Layout Definitions (keeping all helper functions the same)
const hexConversion = {
  to: (encoded) => {
    return `0x${Buffer.from(encoded).toString('hex')}`;
  },
  from: (decoded) => {
    const hex = decoded.startsWith('0x') ? decoded.slice(2) : decoded;
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  },
};

const gasInstructionLayout = [
  { name: "gasLimit", binary: "uint", size: 16 },
  { name: "msgValue", binary: "uint", size: 16 },
];

const gasDropOffInstructionLayout = [
  { name: "dropOff", binary: "uint", size: 16 },
  { name: "recipient", binary: "bytes", size: 32, custom: hexConversion },
];

const relayInstructionLayout = [
  {
    name: "request",
    binary: "switch",
    idSize: 1,
    idTag: "type",
    layouts: [
      [[1, "GasInstruction"], gasInstructionLayout],
      [[2, "GasDropOffInstruction"], gasDropOffInstructionLayout],
    ],
  },
];

const relayInstructionsLayout = [
  {
    name: "requests",
    binary: "array",
    layout: relayInstructionLayout,
  },
];

// Base58 functions (same as before)
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

async function findAssociatedTokenAddress(walletAddress, tokenMintAddress) {
  console.log('🔐 Calculating ATA address...');
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const { getAssociatedTokenAddress } = await import('@solana/spl-token');
    
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(tokenMintAddress);
    const ata = await getAssociatedTokenAddress(mintPubkey, walletPubkey);
    
    console.log(`   ✅ ATA Address: ${ata.toBase58()}`);
    return ata.toBase58();
  } catch (e) {
    console.warn('   ⚠️  @solana/web3.js not found.');
    throw new Error('Cannot calculate ATA without Solana libraries.');
  }
}

function detectAddressType(address) {
  if (isAddress(address)) return 'ethereum';
  const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (solanaPattern.test(address)) return 'solana';
  if (address.startsWith('0x') && address.length === 66) return 'hex';
  return 'unknown';
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

function serializeRelayInstructions(apiDstChain, recipient, mode = EXECUTION_MODE) {
  console.log(`🔧 Serializing relay instructions...`);
  let instructions = [];
  
  if (mode === 'drop') {
    const recipientBytes32 = addressToBytes32(recipient);
    const dropOffAmount = apiDstChain === 1 ? SOLANA_GAS_DROP : GAS_DROP_LIMIT;
    
    instructions.push({
      request: {
        type: "GasDropOffInstruction",
        dropOff: dropOffAmount,
        recipient: recipientBytes32
      }
    });
    
    if (apiDstChain === 1) {
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: SOLANA_GAS_LIMIT,
          msgValue: 5000000n
        }
      });
    } else {
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: 200000n,
          msgValue: 0n
        }
      });
    }
  } else {
    if (apiDstChain === 1) {
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: SOLANA_GAS_LIMIT,
          msgValue: 5000000n
        }
      });
    } else {
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: 200000n,
          msgValue: 0n
        }
      });
    }
  }
  
  const relayInstructions = { requests: instructions };
  const serialized = serialize(relayInstructionsLayout, relayInstructions);
  return '0x' + Buffer.from(serialized).toString('hex');
}

function v3Path(tokenA, tokenB, fee) {
  return solidityPacked(['address', 'uint24', 'address'], [tokenA, fee, tokenB]);
}

async function getQuoteFromExecutor(apiSrcChain, apiDstChain, recipient) {
  const relayInstructions = serializeRelayInstructions(apiDstChain, recipient);
  
  const requestPayload = {
    srcChain: apiSrcChain,
    dstChain: apiDstChain,
    relayInstructions
  };
  
  console.log('\n📤 Requesting quote from executor...');
  
  try {
    const res = await axios.post(`${EXECUTOR_API}/v0/quote`, requestPayload, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    console.log('✅ Quote received successfully');
    console.log(`📊 Estimated cost: ${res.data.estimatedCost || 'N/A'} wei`);
    
    return {
      signedQuote: res.data.signedQuote,
      relayInstructions,
      estimatedCost: BigInt(res.data.estimatedCost || '0')
    };
  } catch (error) {
    console.error('\n❌ ====== API ERROR DETAILS ======');
    console.error('Status:', error.response?.status);
    console.error('Data:', error.response?.data);
    throw error;
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
    console.log(`🌐 Source Chain (API): ${API_SRC_CHAIN}`);
    console.log(`🎯 Destination Chain (API): ${API_DST_CHAIN}`);
    console.log(`📨 Recipient (Original): ${RECIPIENT}`);
    console.log(`🎛️  Execution Mode: ${EXECUTION_MODE.toUpperCase()}`);
    console.log(`🎯 DustCollector Contract: ${COLLECTOR}`);
    console.log(`🔢 Tokens to process: ${TOKENS.length}`);
    console.log('=====================================\n');

    const provider = new JsonRpcProvider(RPC_URL);
    const wallet = new Wallet(PRIVKEY, provider);
    
    // Process recipient address
    let finalRecipient = RECIPIENT;
    let gasRecipient = RECIPIENT;
    const addressType = detectAddressType(RECIPIENT);
    console.log(`🎯 Detected address type: ${addressType.toUpperCase()}`);
    
    // Calculate ATA if needed
    if (API_DST_CHAIN === 1 && addressType === 'solana' && USE_ATA_FOR_SOLANA && SOLANA_TOKEN_MINT) {
      try {
        console.log('\n💳 ====== CALCULATING ATA ADDRESS ======');
        finalRecipient = await findAssociatedTokenAddress(RECIPIENT, SOLANA_TOKEN_MINT);
        console.log(`✅ Using ATA address: ${finalRecipient}`);
        console.log('=====================================\n');
      } catch (error) {
        console.error(`⚠️  Failed to calculate ATA: ${error.message}`);
      }
    }
    
    const recipientBytes32 = addressToBytes32(finalRecipient);
    
    console.log(`👛 Wallet: ${wallet.address}`);
    console.log(`📨 Final Recipient: ${finalRecipient}`);
    console.log(`📨 Recipient (bytes32): ${recipientBytes32}`);
    
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

    // Step 2: Get quote
    console.log('\n💰 ====== GETTING QUOTE FROM EXECUTOR ======');
    const { signedQuote, relayInstructions, estimatedCost } = await getQuoteFromExecutor(
      API_SRC_CHAIN,
      API_DST_CHAIN,
      gasRecipient
    );

    const buffer = estimatedCost > 0n ? estimatedCost / 10n : BigInt('5000000000000000');
    const actualMsgValue = estimatedCost + buffer;
    
    console.log(`📦 Estimated Cost: ${estimatedCost} wei`);
    console.log(`💰 Total value to send: ${actualMsgValue} wei`);

    // Step 3: Build transaction
    console.log('\n🔨 ====== BUILDING TRANSACTION ======');
    const abi = AbiCoder.defaultAbiCoder();
    const commands = '0x' + '00'.repeat(TOKENS.length);
    
    // 🔧 关键修复：UniversalRouter的recipient现在应该指向Router本身，因为token会被直接转移到Router
    const UNIVERSAL_ROUTER = process.env.UNIVERSAL_ROUTER || '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
    
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

    // 🔧 准备pullTokens和pullAmounts
    const pullTokens = TOKENS.map(t => t.addr);
    const pullAmounts = TOKENS.map(t => t.amtWei);
    
    console.log('\n📦 ====== PULL PARAMETERS ======');
    console.log('Pull Tokens:', pullTokens);
    console.log('Pull Amounts:', pullAmounts.map(amt => amt.toString()));

    // Create contract instance - 关键：使用EOA地址作为合约地址
    const contract = new Contract(wallet.address, DUST_ABI, wallet);
    
    // Prepare SwapParams structure
    const swapParams = {
      commands,
      inputs,
      deadline: Math.floor(Date.now() / 1e3) + 1800,
      targetToken: TARGET,
      dstChain: DST_CHAIN_ID,
      dstDomain: DST_DOMAIN,
      recipient: recipientBytes32,
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
      estimatedCost: actualMsgValue
    };
    
    console.log('\n📋 ====== TRANSACTION PARAMETERS ======');
    console.log(`🎯 Target Token: ${swapParams.targetToken}`);
    console.log(`🌉 Destination Chain: ${swapParams.dstChain}`);
    console.log(`📨 Recipient: ${swapParams.recipient}`);
    console.log(`🔧 Pull Tokens Count: ${pullTokens.length}`);
    
    // Gas estimation
    console.log('\n⛽ ====== GAS ESTIMATION ======');
    try {
      const estimatedGas = await contract.batchCollectWithUniversalRouter7702.estimateGas(
        swapParams,
        pullTokens,
        pullAmounts,
        {
          value: actualMsgValue,
          from: wallet.address
        }
      );
      console.log(`✅ Estimated gas: ${estimatedGas}`);
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
      
      throw new Error(`Gas estimation failed: ${gasError.message}`);
    }
    
    // Send transaction
    console.log('\n📤 ====== SENDING TRANSACTION ======');
    
    const baseGas = 400000n; // 增加基础gas，考虑token转移操作
    const gasPerToken = 150000n; // 每个token的gas成本
    const dynamicGasLimit = baseGas + (gasPerToken * BigInt(TOKENS.length));
    const finalGasLimit = dynamicGasLimit < 1800000n ? 1800000n : 
                         dynamicGasLimit > 3500000n ? 3500000n : 
                         dynamicGasLimit;
    
    console.log(`⛽ Gas limit: ${finalGasLimit}`);
    
    let tx;
    try {
      tx = await contract.batchCollectWithUniversalRouter7702(
        swapParams,
        pullTokens,
        pullAmounts,
        {
          value: actualMsgValue,
          gasLimit: finalGasLimit
        }
      );
      console.log('✅ Transaction sent successfully');
    } catch (sendError) {
      console.error(`❌ Failed to send transaction: ${sendError.message}`);
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
      console.log(`💰 Total cost: ${actualMsgValue} wei`);
      console.log(`📨 Target Address: ${finalRecipient}`);
      
      console.log('\n📋 EXECUTION SUMMARY:');
      console.log('1️⃣  ✅ EIP-7702 delegation completed');
      console.log('2️⃣  ✅ Direct token transfer to UniversalRouter');
      console.log('3️⃣  ✅ Token swap executed');
      console.log('4️⃣  ✅ Cross-chain bridge completed');
      
      console.log(`\n🌐 Track your transfer: ${EXECUTOR_API}/status/${tx.hash}`);
      
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