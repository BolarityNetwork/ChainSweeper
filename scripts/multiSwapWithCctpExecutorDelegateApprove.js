// scripts/dust-collector-7702-cctp-metamask.js
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, Wallet, Contract, isAddress, Interface, toUtf8String
} from 'ethers';
import { JsonRpcProvider } from 'ethers';
import axios from 'axios';
import { createHash } from 'crypto';
import { serialize } from 'binary-layout';
import readline from 'readline';

console.log("\n🚀 DustCollector EIP-7702 CCTP MetaMask Script");
console.log("🧪 Powered by EIP-7702 + CCTP Bridge + MetaMask Smart Wallet");
console.log("✨ Batch approve + swap + bridge in one transaction!");

/* ---------- Config Validation ---------- */
const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`❌ Missing environment variable: ${key}`);
  return value;
};

const RPC_URL        = requireEnv('RPC_URL');
const PRIVKEY        = requireEnv('PRIVATE_KEY');
const COLLECTOR      = requireEnv('COLLECTOR'); // DustCollectorStandardApproval 合约地址
const METAMASK_WALLET = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'; // MetaMask Smart Wallet
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

// 🔧 Check if this is a local operation
const IS_LOCAL_OPERATION = DST_CHAIN_ID === 0;

// Smart Batching Configuration
const MAX_TOKENS_PER_BATCH = parseInt(process.env.MAX_TOKENS_PER_BATCH || '3');
const ENABLE_AUTO_BATCHING = process.env.ENABLE_AUTO_BATCHING !== 'false';

// 🆕 Solana ATA related configuration
const SOLANA_TOKEN_MINT = process.env.SOLANA_TOKEN_MINT || '';
const USE_ATA_FOR_SOLANA = process.env.USE_ATA_FOR_SOLANA !== 'false';

// 🆕 Execution mode configuration
const EXECUTION_MODE = process.env.EXECUTION_MODE || 'gas';
const GAS_DROP_LIMIT = BigInt(process.env.GAS_DROP_LIMIT || '500000');
const SOLANA_GAS_LIMIT = BigInt(process.env.SOLANA_GAS_LIMIT || '1400000');
const SOLANA_GAS_DROP = BigInt(process.env.SOLANA_GAS_DROP || '500000');

if (IS_LOCAL_OPERATION) {
  console.log("🏠 LOCAL OPERATION MODE - Skipping cross-chain logic");
} else {
  // Display execution mode info only for cross-chain operations
  console.log(`📦 Smart Batching: ${ENABLE_AUTO_BATCHING ? 'Enabled' : 'Disabled'}`);
  console.log(`🔢 Max tokens per batch: ${MAX_TOKENS_PER_BATCH}`);
  console.log(`🎯 Execution Mode: ${EXECUTION_MODE.toUpperCase()}`);
  console.log(`🤖 MetaMask Smart Wallet: ${METAMASK_WALLET}`);
  console.log(`🏪 DustCollector Contract: ${COLLECTOR}`);
  if (EXECUTION_MODE === 'drop') {
    console.log(`⛽ Gas Drop Limit: ${GAS_DROP_LIMIT}`);
  }
  if (API_DST_CHAIN === 1) {
    console.log(`🔥 Solana Gas Limit: ${SOLANA_GAS_LIMIT} CU`);
    if (USE_ATA_FOR_SOLANA && SOLANA_TOKEN_MINT) {
      console.log(`💳 Will calculate ATA for token mint: ${SOLANA_TOKEN_MINT}`);
    }
  }
}

const TOKENS = [
  {
    addr: requireEnv('TOKEN1'),
    dec: parseInt(process.env.TOKEN1_DEC || '18'),
    amt: process.env.TOKEN1_AMT || '0.00001',
    fee: parseInt(process.env.TOKEN1_FEE || '3000')
  }
];

// Add more tokens conditionally
for (let i = 2; i <= 5; i++) {
  const tokenAddr = process.env[`TOKEN${i}`];
  if (tokenAddr && (!ENABLE_AUTO_BATCHING || TOKENS.length < MAX_TOKENS_PER_BATCH)) {
    TOKENS.push({
      addr: tokenAddr,
      dec: parseInt(process.env[`TOKEN${i}_DEC`] || '18'),
      amt: process.env[`TOKEN${i}_AMT`] || '0.00001',
      fee: parseInt(process.env[`TOKEN${i}_FEE`] || '3000')
    });
    console.log(`✅ Added TOKEN${i} to batch`);
  } else if (tokenAddr) {
    console.log(`⚠️  TOKEN${i} skipped due to batch size limit (${MAX_TOKENS_PER_BATCH})`);
  }
}

// 🔧 DustCollector Standard Approval ABI (匹配你的合约)
const DUST_ABI = [
  {
    "type": "function",
    "name": "batchCollectWithUniversalRouter", 
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
      {"name": "pullTokens", "type": "address[]"},
      {"name": "pullAmounts", "type": "uint256[]"}
    ],
    "outputs": [],
    "stateMutability": "payable"
  }
];

// MetaMask Smart Wallet ABI (基于你提供的 ABI 中的关键函数)
const METAMASK_WALLET_ABI = [
  {
    "type": "function",
    "name": "execute",
    "inputs": [
      {
        "name": "_mode",
        "type": "bytes32"
      },
      {
        "name": "_executionCalldata", 
        "type": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "executeFromExecutor",
    "inputs": [
      {
        "name": "_mode",
        "type": "bytes32"
      },
      {
        "name": "_executionCalldata",
        "type": "bytes" 
      }
    ],
    "outputs": [
      {
        "name": "returnData_",
        "type": "bytes[]"
      }
    ],
    "stateMutability": "payable"
  }
];

// ERC20 ABI for approvals and balance checking
const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)'
];

// 🔧 Binary Layout for CCTP Executor instructions (same as original)
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

// 🔧 Base58 functions for Solana addresses
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

function base58Encode(buffer) {
  let num = 0n;
  for (const byte of buffer) {
    num = num * 256n + BigInt(byte);
  }
  
  let encoded = '';
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    encoded = BASE58_ALPHABET[Number(remainder)] + encoded;
  }
  
  for (const byte of buffer) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }
  
  return encoded;
}

// 🆕 Calculate Solana ATA address function
async function findAssociatedTokenAddress(walletAddress, tokenMintAddress) {
  console.log('🔐 Calculating ATA address...');
  console.log(`   👛 Wallet: ${walletAddress}`);
  console.log(`   🪙 Token Mint: ${tokenMintAddress}`);
  
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const { getAssociatedTokenAddress } = await import('@solana/spl-token');
    
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(tokenMintAddress);
    const ata = await getAssociatedTokenAddress(mintPubkey, walletPubkey);
    
    console.log(`   ✅ ATA Address: ${ata.toBase58()}`);
    return ata.toBase58();
  } catch (e) {
    console.warn('   ⚠️  @solana/web3.js not found. For accurate ATA calculation, please install:');
    console.warn('   npm install @solana/web3.js @solana/spl-token');
    throw new Error('Cannot calculate ATA without Solana libraries. Please install @solana/web3.js and @solana/spl-token');
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

function v3Path(tokenA, tokenB, fee) {
  return solidityPacked(['address', 'uint24', 'address'], [tokenA, fee, tokenB]);
}

function serializeRelayInstructions(apiDstChain, recipient, mode = EXECUTION_MODE) {
  console.log(`🔧 Serializing relay instructions with binary-layout...`);
  console.log(`   📍 Destination chain: ${apiDstChain}`);
  console.log(`   🎯 Execution mode: ${mode.toUpperCase()}`);
  
  let instructions = [];
  
  if (mode === 'drop') {
    console.log(`   📦 Using GasDropOffInstruction for ${apiDstChain === 1 ? 'Solana' : 'EVM'} chain`);
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
      console.log(`   🚀 Adding GasInstruction for Solana compute unit limit`);
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: SOLANA_GAS_LIMIT,
          msgValue: 5000000n
        }
      });
    } else {
      console.log(`  🚀 Adding GasInstruction for EVM chain`);
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: 200000n,
          msgValue: 0n
        }
      });
    }
    
    console.log(`   💸 Drop off amount: ${dropOffAmount} ${apiDstChain === 1 ? 'lamports' : 'gas'}`);
    console.log(`   📍 Recipient: ${recipient}`);
    if (apiDstChain === 1) {
      console.log(`   💻 Compute Unit Limit: ${SOLANA_GAS_LIMIT} CU`);
    }
    
  } else {
    console.log(`   🚀 Using GasInstruction (manual gas deposit required)`);
    
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
  
  const relayInstructions = {
    requests: instructions
  };
  
  const serialized = serialize(relayInstructionsLayout, relayInstructions);
  const result = '0x' + Buffer.from(serialized).toString('hex');
  
  console.log(`   📊 Total instructions: ${instructions.length}`);
  instructions.forEach((inst, index) => {
    const instructionType = inst.request.type;
    console.log(`   📋 Instruction ${index + 1}:`);
    console.log(`      - Type: ${instructionType}`);
    if (instructionType === "GasInstruction") {
      console.log(`      - Gas Limit: ${inst.request.gasLimit}`);
      console.log(`      - Msg Value: ${inst.request.msgValue}`);
    } else {
      console.log(`      - Drop Off: ${inst.request.dropOff}`);
      console.log(`      - Recipient: ${inst.request.recipient}`);
    }
  });
  console.log(`   📝 Serialized: ${result}`);
  console.log(`   📏 Length: ${result.length} chars`);
  
  return result;
}

async function getQuoteFromExecutor(apiSrcChain, apiDstChain, recipient) {
  const relayInstructions = serializeRelayInstructions(apiDstChain, recipient);
  
  const requestPayload = {
    srcChain: apiSrcChain,
    dstChain: apiDstChain,
    relayInstructions
  };
  
  console.log('\n📤 Requesting quote from executor...');
  console.log('🔍 API Request:', JSON.stringify(requestPayload, null, 2));
  
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
    console.error('Request Data:', JSON.stringify(requestPayload, null, 2));
    console.error('================================\n');
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

// 🆕 Create batch approval + dust collection calldata for MetaMask Smart Wallet
function createBatchExecutionCalldata(wallet, tokens, amounts, swapParams, pullTokens, pullAmounts) {
  console.log('\n🔧 ====== CREATING BATCH EXECUTION CALLDATA ======');
  
  const executions = [];
  
  // 1. Add approval transactions for each token
  tokens.forEach((token, index) => {
    const tokenContract = new Contract(token.addr, ERC20_ABI);
    const approveCalldata = tokenContract.interface.encodeFunctionData('approve', [COLLECTOR, amounts[index]]);
    
    executions.push({
      target: token.addr,
      value: 0,
      callData: approveCalldata
    });
    
    console.log(`📝 Added approve execution for token ${index + 1}: ${token.addr}`);
  });
  
  // 2. Add the main dust collection transaction
  const dustContract = new Contract(COLLECTOR, DUST_ABI);
  const dustCalldata = dustContract.interface.encodeFunctionData('batchCollectWithUniversalRouter', [
    swapParams,
    pullTokens,
    pullAmounts
  ]);
  
  executions.push({
    target: COLLECTOR,
    value: swapParams.estimatedCost, // Include ETH value for bridge fees
    callData: dustCalldata
  });
  
  console.log(`📝 Added dust collection execution`);
  console.log(`   Target: ${COLLECTOR}`);
  console.log(`   Value: ${swapParams.estimatedCost} wei`);
  
  // 3. Encode executions for MetaMask Smart Wallet
  // Mode: 0x01000000 = EXEC_TYPE_DEFAULT + CALL_TYPE_BATCH 
  const mode = '0x0100000000000000000000000000000000000000000000000000000000000000';
  
  // Encode execution array
  const executionCalldata = AbiCoder.defaultAbiCoder().encode(
    ['tuple(address target, uint256 value, bytes callData)[]'],
    [executions]
  );
  
  console.log(`📊 Batch summary:`);
  console.log(`   Total executions: ${executions.length}`);
  console.log(`   Approvals: ${executions.length - 1}`);
  console.log(`   Dust collection: 1`);
  console.log(`   Total ETH value: ${swapParams.estimatedCost} wei`);
  
  return {
    mode,
    executionCalldata,
    totalValue: swapParams.estimatedCost,
    executionsCount: executions.length
  };
}

function askUserChoice() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n❓ ====== DELEGATION MANAGEMENT ======');
    console.log('🔗 Your account is currently delegated to the MetaMask Smart Wallet contract.');
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
    console.log(`🏠 Local Operation: ${IS_LOCAL_OPERATION ? 'YES' : 'NO'}`);
    console.log(`📨 Recipient (Original): ${RECIPIENT}`);
    
    if (!IS_LOCAL_OPERATION) {
      console.log(`🎛️  Execution Mode: ${EXECUTION_MODE.toUpperCase()}`);
      console.log(`🤖 MetaMask Smart Wallet: ${METAMASK_WALLET}`);
      console.log(`🏪 DustCollector Contract: ${COLLECTOR}`);
      console.log(`🔢 Tokens to process: ${TOKENS.length}`);
      if (EXECUTION_MODE === 'drop') {
        console.log(`⛽ Gas Drop Limit: ${GAS_DROP_LIMIT}`);
      }
      if (API_DST_CHAIN === 1) {
        console.log(`🔥 Solana Gas Limit: ${SOLANA_GAS_LIMIT} CU`);
        console.log(`💳 Use ATA: ${USE_ATA_FOR_SOLANA}`);
        if (SOLANA_TOKEN_MINT) {
          console.log(`🪙 Token Mint: ${SOLANA_TOKEN_MINT}`);
        }
      }
    }
    console.log('=====================================\n');

    const provider = new JsonRpcProvider(RPC_URL);
    const wallet = new Wallet(PRIVKEY, provider);
    const chainId = (await provider.getNetwork()).chainId;
    
    console.log(`👛 Wallet: ${wallet.address}`);
    console.log(`🌐 Chain ID: ${chainId}`);
    
    // 🔧 Process recipient address
    let finalRecipient = RECIPIENT;
    let gasRecipient = RECIPIENT;
    let recipientBytes32;
    
    if (IS_LOCAL_OPERATION) {
      // For local operations, we can use simpler logic
      console.log('🏠 Processing recipient for local operation...');
      if (isAddress(RECIPIENT)) {
        recipientBytes32 = addressToBytes32(RECIPIENT);
        console.log(`📨 Local recipient (bytes32): ${recipientBytes32}`);
      } else {
        // If recipient is not a valid address, use zero (will default to msg.sender)
        recipientBytes32 = ZeroHash;
        console.log(`📨 Using zero address (will default to msg.sender)`);
      }
    } else {
      // Cross-chain logic (existing code)
      const addressType = detectAddressType(RECIPIENT);
      console.log(`🎯 Detected address type: ${addressType.toUpperCase()}`);
      
      // 🆕 If target is Solana and ATA is enabled, calculate ATA address
      if (API_DST_CHAIN === 1 && addressType === 'solana' && USE_ATA_FOR_SOLANA && SOLANA_TOKEN_MINT) {
        try {
          console.log('\n💳 ====== CALCULATING ATA ADDRESS ======');
          finalRecipient = await findAssociatedTokenAddress(RECIPIENT, SOLANA_TOKEN_MINT);
          console.log(`✅ Using ATA address: ${finalRecipient}`);
          console.log('=====================================\n');
        } catch (error) {
          console.error(`⚠️  Failed to calculate ATA: ${error.message}`);
          console.error('   Falling back to EOA address...');
        }
      }
      
      try {
        recipientBytes32 = addressToBytes32(finalRecipient);
        
        if (API_DST_CHAIN === 1 && addressType !== 'solana') {
          console.warn(`⚠️  Warning: Target is Solana (chain ${API_DST_CHAIN}) but address looks like ${addressType}. This might cause issues.`);
        } else if (API_DST_CHAIN !== 1 && addressType === 'solana') {
          console.warn(`⚠️  Warning: Target is EVM chain (${API_DST_CHAIN}) but address looks like Solana. This might cause issues.`);
        }
        
      } catch (error) {
        throw new Error(`Failed to process recipient address: ${error.message}`);
      }
    }
    
    console.log(`📨 Original Recipient: ${RECIPIENT}`);
    console.log(`📨 Final Recipient: ${finalRecipient}`);
    if (!IS_LOCAL_OPERATION) {
      const addressType = detectAddressType(RECIPIENT);
      console.log(`🏷️  Address Type: ${addressType.toUpperCase()}`);
    }
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

    // Step 1: Ensure delegation to MetaMask Smart Wallet
    await delegateToContract(wallet, provider, METAMASK_WALLET);

    // Step 2: Get quote from executor for CCTP bridge - skip for local operations
    let signedQuote = '0x';
    let relayInstructions = '0x';
    let estimatedCost = 0n;
    let actualMsgValue = 0n;

    if (IS_LOCAL_OPERATION) {
      console.log('\n🏠 ====== SKIPPING EXECUTOR QUOTE (LOCAL OPERATION) ======');
      console.log('💰 No cross-chain fees required for local operation');
      
      // Set default values for local operation
      signedQuote = '0x';
      relayInstructions = '0x';
      estimatedCost = 0n;
      actualMsgValue = 0n;
      
    } else {
      console.log('\n💰 ====== GETTING QUOTE FROM EXECUTOR ======');
      const { signedQuote: quote, relayInstructions: instructions, estimatedCost: cost } = await getQuoteFromExecutor(
        API_SRC_CHAIN,
        API_DST_CHAIN,
        gasRecipient
      );

      signedQuote = quote;
      relayInstructions = instructions;
      estimatedCost = cost;

      const buffer = estimatedCost > 0n ? estimatedCost / 10n : BigInt('5000000000000000');
      actualMsgValue = estimatedCost + buffer;
      
      console.log(`📦 Estimated Cost: ${estimatedCost} wei`);
      console.log(`🔧 Buffer: ${buffer} wei`);
      console.log(`💰 Total value to send: ${actualMsgValue} wei`);
    }

    // Step 3: Build transaction parameters
    console.log('\n🔨 ====== BUILDING TRANSACTION ======');
    const abi = AbiCoder.defaultAbiCoder();
    const commands = '0x' + '00'.repeat(TOKENS.length);
    const inputs = TOKENS.map(t =>
      abi.encode(
        ['address','uint256','uint256','bytes','bool'], 
        [COLLECTOR, t.amtWei, 0, v3Path(t.addr, TARGET, t.fee), false]
      )
    );

    console.log(`📝 Commands: ${commands}`);
    console.log(`📋 Inputs count: ${inputs.length}`);

    // Create SwapParams for CCTP (matches your contract structure)
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
    
    const pullTokens = TOKENS.map(t => t.addr);
    const pullAmounts = TOKENS.map(t => t.amtWei);
    
    console.log('\n📋 ====== TRANSACTION PARAMETERS ======');
    console.log(`🎯 Target Token: ${swapParams.targetToken}`);
    console.log(`🌉 Destination Chain: ${swapParams.dstChain}`);
    console.log(`🌍 Destination Domain: ${swapParams.dstDomain}`);
    console.log(`📨 Recipient: ${swapParams.recipient}`);
    console.log(`🔧 Tokens Count: ${pullTokens.length}`);
    console.log(`⏰ Deadline: ${swapParams.deadline} (${new Date(swapParams.deadline * 1000).toISOString()})`);

    // Step 4: Create batch execution calldata for MetaMask Smart Wallet
    const { mode, executionCalldata, totalValue, executionsCount } = createBatchExecutionCalldata(
      wallet, TOKENS, TOKENS.map(t => t.amtWei), swapParams, pullTokens, pullAmounts
    );

    // Step 5: Execute via MetaMask Smart Wallet (EOA acting as the contract)
    console.log('\n📤 ====== EXECUTING VIA METAMASK SMART WALLET ======');
    
    const smartWalletContract = new Contract(wallet.address, METAMASK_WALLET_ABI, wallet);
    
    console.log(`🔧 Mode: ${mode}`);
    console.log(`📊 Total executions: ${executionsCount}`);
    console.log(`💰 Total ETH value: ${totalValue} wei`);
    
    // Gas estimation
    console.log('\n⛽ ====== GAS ESTIMATION ======');
    try {
      const estimatedGas = await smartWalletContract.execute.estimateGas(mode, executionCalldata, {
        value: totalValue,
        from: wallet.address
      });
      console.log(`✅ Estimated gas: ${estimatedGas}`);
    } catch (gasError) {
      console.warn(`⚠️  Gas estimation failed: ${gasError.message}`);
      console.log('🚀 Proceeding with fixed gas limit...');
    }
    
    // Send transaction
    console.log('\n📤 ====== SENDING BATCH TRANSACTION ======');
    
    const baseGas = 500000n; // Base gas for smart wallet execution
    const gasPerApproval = 50000n; // Gas per approval
    const dustCollectionGas = IS_LOCAL_OPERATION ? 400000n : 800000n; // Less gas for local operations
    const dynamicGasLimit = baseGas + (gasPerApproval * BigInt(TOKENS.length)) + dustCollectionGas;
    const finalGasLimit = dynamicGasLimit < 2000000n ? 2000000n : 
                         dynamicGasLimit > 4000000n ? 4000000n : 
                         dynamicGasLimit;
    
    console.log(`⛽ Gas limit: ${finalGasLimit}`);
    
    const tx = await smartWalletContract.execute(mode, executionCalldata, {
      value: totalValue,
      gasLimit: finalGasLimit
    });

    console.log('\n🎯 ====== TRANSACTION RESULT ======');
    console.log('📝 Transaction hash:', tx.hash);
    console.log('⏳ Waiting for confirmation...');
    
    const receipt = await tx.wait();
    console.log(receipt.status === 1 ? '✅ Transaction Success!' : '❌ Transaction Failed!');
    
    if (receipt.status === 1) {
      console.log('\n🎉 ====== SUCCESS SUMMARY ======');
      console.log(`✅ Transaction confirmed in block: ${receipt.blockNumber}`);
      console.log(`⛽ Gas used: ${receipt.gasUsed}`);
      console.log(`💰 Total cost: ${totalValue} wei`);
      console.log(`📨 Target Address: ${finalRecipient}`);
      if (finalRecipient !== RECIPIENT) {
        console.log(`   (ATA calculated from EOA: ${RECIPIENT})`);
      }
      
      if (IS_LOCAL_OPERATION) {
        console.log('\n📋 LOCAL OPERATION COMPLETED:');
        console.log('1️⃣  ✅ EIP-7702 delegation to MetaMask Smart Wallet completed');
        console.log('2️⃣  ✅ Batch token approvals executed');
        console.log('3️⃣  ✅ Token swap via UniversalRouter completed');
        console.log('4️⃣  ✅ Tokens should now be in your wallet or specified recipient address');
        console.log('5️⃣  ✅ No cross-chain transfer was needed');
      } else {
        console.log('\n📋 EXECUTION SUMMARY:');
        console.log('1️⃣  ✅ EIP-7702 delegation to MetaMask Smart Wallet completed');
        console.log('2️⃣  ✅ Batch token approvals executed');
        console.log('3️⃣  ✅ Token swap via UniversalRouter completed');
        console.log('4️⃣  ✅ CCTP cross-chain bridge initiated');
        
        if (EXECUTION_MODE === 'gas') {
          console.log('\n📋 NEXT STEPS (GAS Mode):');
          console.log('1️⃣  Your tokens are being transferred cross-chain');
          console.log('2️⃣  You need to manually deposit gas on the destination chain');
          console.log('3️⃣  Monitor the transfer status using the link below');
        } else {
          console.log('\n📋 NEXT STEPS (DROP Mode):');
          console.log('1️⃣  Tokens will automatically arrive at your recipient address');
          if (API_DST_CHAIN === 1 && USE_ATA_FOR_SOLANA && finalRecipient !== RECIPIENT) {
            console.log('2️⃣  Tokens will be in the Associated Token Account (ATA)');
          }
          console.log('3️⃣  Check your destination chain balance in a few minutes');
        }
        
        console.log(`\n🌐 Track your transfer: ${EXECUTOR_API}/status/${tx.hash}`);
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
    
    if (error.response?.data) {
      console.error(`🌐 API Error Details:`);
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    
    if (error.code) {
      console.error(`🔧 Error Code: ${error.code}`);
    }
    
    console.error('\n💡 TROUBLESHOOTING TIPS:');
    console.error('1. Check your .env configuration');
    console.error('2. Verify wallet has sufficient balance');
    console.error('3. Ensure all token addresses are correct');
    console.error('4. Verify COLLECTOR contract address');
    if (!IS_LOCAL_OPERATION) {
      console.error('5. Check CCTP bridge configuration (DST_CHAIN_ID, DST_DOMAIN)');
      console.error('6. Verify executor API endpoint');
      console.error('7. Check network connectivity and RPC endpoint');
      if (API_DST_CHAIN === 1) {
        console.error('8. For Solana token transfers:');
        console.error('   - Set SOLANA_TOKEN_MINT to the token mint address');
        console.error('   - Install @solana/web3.js and @solana/spl-token for ATA support');
      }
      console.error('9. Ensure binary-layout is installed: npm install binary-layout');
      console.error('10. Check MetaMask Smart Wallet delegation compatibility');
    } else {
      console.error('5. For local operations, ensure RECIPIENT is a valid Ethereum address');
      console.error('6. Or leave RECIPIENT blank to use your own wallet address');
    }
    
    process.exit(1);
  }
})();