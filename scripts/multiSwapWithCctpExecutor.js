// scripts/dust-executor.js
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, Wallet, Contract, MaxUint256, isAddress
} from 'ethers';
import { JsonRpcProvider } from 'ethers';
import axios from 'axios';
import { createHash } from 'crypto';
import { serialize } from 'binary-layout';

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

// 🆕 Solana ATA related configuration
const SOLANA_TOKEN_MINT = process.env.SOLANA_TOKEN_MINT || ''; // Token mint address on Solana
const USE_ATA_FOR_SOLANA = process.env.USE_ATA_FOR_SOLANA !== 'false'; // Enable ATA by default

// Solana Program IDs (fixed values)
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// 🆕 Execution mode configuration
const EXECUTION_MODE = process.env.EXECUTION_MODE || 'gas'; // 'gas' or 'drop'
const GAS_DROP_LIMIT = BigInt(process.env.GAS_DROP_LIMIT || '500000'); // gas limit for drop mode
const SOLANA_GAS_LIMIT = BigInt(process.env.SOLANA_GAS_LIMIT || '1400000'); // Solana specific gas limit (CU)
const SOLANA_GAS_DROP = BigInt(process.env.SOLANA_GAS_DROP || '500000');

// Display execution mode info
console.log(`🎯 Execution Mode: ${EXECUTION_MODE.toUpperCase()}`);
console.log(EXECUTION_MODE === 'drop' 
  ? "   📦 Auto-delivery to recipient address" 
  : "   🏷️  Manual claim required on destination chain");
if (EXECUTION_MODE === 'drop') {
  console.log(`   ⛽ Gas Drop Limit: ${GAS_DROP_LIMIT} gas`);
}
if (API_DST_CHAIN === 1) {
  console.log(`   🔥 Solana Gas Limit: ${SOLANA_GAS_LIMIT} CU`);
  if (USE_ATA_FOR_SOLANA && SOLANA_TOKEN_MINT) {
    console.log(`   💳 Will calculate ATA for token mint: ${SOLANA_TOKEN_MINT}`);
  }
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

// 🔧 Binary Layout Definitions
// Custom conversion for hex strings (JavaScript version)
const hexConversion = {
  to: (encoded) => {
    return `0x${Buffer.from(encoded).toString('hex')}`;
  },
  from: (decoded) => {
    const hex = decoded.startsWith('0x') ? decoded.slice(2) : decoded;
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  },
};

// Define instruction layouts according to official spec
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

// 🔧 Base58 encode/decode functions
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
  
  // Return Buffer instead of hex string for further processing
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
  
  // Handle leading zeros
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
    // Try to use Solana libraries if available
    const { PublicKey } = await import('@solana/web3.js');
    const { getAssociatedTokenAddress } = await import('@solana/spl-token');
    
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(tokenMintAddress);
    const ata = await getAssociatedTokenAddress(mintPubkey, walletPubkey);
    
    console.log(`   ✅ ATA Address: ${ata.toBase58()}`);
    return ata.toBase58();
  } catch (e) {
    // If Solana libraries not installed, provide a hint
    console.warn('   ⚠️  @solana/web3.js not found. For accurate ATA calculation, please install:');
    console.warn('   npm install @solana/web3.js @solana/spl-token');
    throw new Error('Cannot calculate ATA without Solana libraries. Please install @solana/web3.js and @solana/spl-token');
  }
}

// 🔧 Smart address type detection
function detectAddressType(address) {
  // Detect Ethereum address (starts with 0x, 42 characters)
  if (isAddress(address)) {
    return 'ethereum';
  }
  
  // Detect Solana address (base58 format, 32-44 characters, excludes 0, O, I, l)
  const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (solanaPattern.test(address)) {
    return 'solana';
  }
  
  // Detect hex format
  if (address.startsWith('0x') && address.length === 66) {
    return 'hex';
  }
  
  return 'unknown';
}

// 🔧 Convert address to bytes32 format
function addressToBytes32(address) {
  const addressType = detectAddressType(address);
  
  switch (addressType) {
    case 'ethereum':
      // Ethereum address 20 bytes -> 32 bytes (left padding with 0)
      const cleanAddr = address.toLowerCase().replace('0x', '');
      return `0x${'000000000000000000000000' + cleanAddr}`;
      
    case 'solana':
      // Solana address decoded from base58 to 32 bytes
      const decoded = base58Decode(address);
      return `0x${decoded.toString('hex').padStart(64, '0')}`;
      
    case 'hex':
      // Already in hex format, ensure it's 32 bytes
      return `0x${address.replace('0x', '').padStart(64, '0')}`;
      
    default:
      throw new Error(`Unsupported address format: ${address}. Expected Ethereum (0x...) or Solana (base58) address.`);
  }
}

// 🔧 Serialization using binary-layout (MODIFIED to support multiple instructions)
function serializeRelayInstructions(apiDstChain, recipient, mode = EXECUTION_MODE) {
  console.log(`🔧 Serializing relay instructions with binary-layout...`);
  console.log(`   📍 Destination chain: ${apiDstChain}`);
  console.log(`   🎯 Execution mode: ${mode.toUpperCase()}`);
  
  let instructions = [];
  
  if (mode === 'drop') {
    // Mode 1: GasDropOffInstruction - auto gas delivery
    console.log(`   📦 Using GasDropOffInstruction for ${apiDstChain === 1 ? 'Solana' : 'EVM'} chain`);
    const recipientBytes32 = addressToBytes32(recipient);
    
    // Use appropriate gas limit based on destination chain
    const dropOffAmount = apiDstChain === 1 ? SOLANA_GAS_DROP : GAS_DROP_LIMIT;
    
    // 1. Add GasDropOffInstruction
    instructions.push({
      request: {
        type: "GasDropOffInstruction",
        dropOff: dropOffAmount,
        recipient: recipientBytes32
      }
    });
    
    // 2. 🆕 For Solana, also add GasInstruction to set compute unit limit
    if (apiDstChain === 1) {
      console.log(`   🚀 Adding GasInstruction for Solana compute unit limit`);
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: SOLANA_GAS_LIMIT,  // 1.4M CU
          msgValue: 5000000n  // No additional msg value needed
        }
      });
    }else {
      console.log(`  🚀 Adding GasInstruction for for EVM chain`);
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: 200000n,  // 200k gas
          msgValue: 0n        // No msg value
        }
      });
    }
    
    console.log(`   💸 Drop off amount: ${dropOffAmount} ${apiDstChain === 1 ? 'lamports' : 'gas'}`);
    console.log(`   📍 Recipient: ${recipient}`);
    if (apiDstChain === 1) {
      console.log(`   💻 Compute Unit Limit: ${SOLANA_GAS_LIMIT} CU`);
    }
    
  } else {
    // Mode 2: GasInstruction - manual gas deposit required
    console.log(`   🚀 Using GasInstruction (manual gas deposit required)`);
    
    if (apiDstChain === 1) {
      // Solana: Higher compute units
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: SOLANA_GAS_LIMIT,
          msgValue: 5000000n // 1M lamports
        }
      });
    } else {
      // EVM chains: Standard gas limit
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: 200000n, // 200k gas
          msgValue: 0n       // No msg value
        }
      });
    }
  }
  
  // Create the instructions array
  const relayInstructions = {
    requests: instructions  // Now supports multiple instructions
  };
  
  // Serialize using binary-layout
  const serialized = serialize(relayInstructionsLayout, relayInstructions);
  const result = '0x' + Buffer.from(serialized).toString('hex');
  
  // Log details
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

// 🔧 V3 path builder for Uniswap
function v3Path(tokenA, tokenB, fee) {
  return solidityPacked(['address', 'uint24', 'address'], [tokenA, fee, tokenB]);
}

// 🔧 Get quote from executor API
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

// Main execution
(async () => {
  try {
    console.log('\n📋 ====== CONFIGURATION SUMMARY ======');
    console.log(`🌐 Source Chain (API): ${API_SRC_CHAIN}`);
    console.log(`🎯 Destination Chain (API): ${API_DST_CHAIN}`);
    console.log(`📨 Recipient (Original): ${RECIPIENT}`);
    console.log(`🎛️  Execution Mode: ${EXECUTION_MODE.toUpperCase()}`);
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
    console.log('=====================================\n');

    const provider = new JsonRpcProvider(RPC_URL);
    const wallet = new Wallet(PRIVKEY, provider);
    const chainId = (await provider.getNetwork()).chainId;
    
    // 🔧 Process recipient address
    let finalRecipient = RECIPIENT;
    let gasRecipient = RECIPIENT;
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
        // Continue with original address
      }
    }
    
    let recipientBytes32;
    try {
      recipientBytes32 = addressToBytes32(finalRecipient);
      
      // Validate address type compatibility with target chain
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
    console.log(`📨 Final Recipient: ${finalRecipient}`);
    console.log(`🏷️  Address Type: ${addressType.toUpperCase()}`);
    console.log(`📨 Recipient (bytes32): ${recipientBytes32}`);
    
    // Parse token amounts
    for (const t of TOKENS) t.amtWei = parseUnits(t.amt, t.dec);

    // Permit2 setup
    console.log('\n🔐 ====== PERMIT2 SETUP ======');
    const permit2 = new Contract(PERMIT2, PERMIT2_ABI, wallet);
    const expiration = Math.floor(Date.now() / 1e3) + 86400 * 30; // 30 days
    const sigDeadline = Math.floor(Date.now() / 1e3) + 3600; // 1 hour
    
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

    // 🔧 Get quote - use final address (might be ATA)
    console.log('\n💰 ====== GETTING QUOTE FROM EXECUTOR ======');
    const { signedQuote, relayInstructions, estimatedCost } = await getQuoteFromExecutor(
      API_SRC_CHAIN,
      API_DST_CHAIN,
      gasRecipient  // use the EOA if gas drop is enabled
    );

    // Calculate fee with buffer
    const buffer = estimatedCost > 0n ? estimatedCost / 10n : BigInt('5000000000000000'); // 10% buffer or 0.001 ETH
    const actualMsgValue = estimatedCost + buffer;
    
    console.log(`📦 Estimated Cost: ${estimatedCost} wei`);
    console.log(`🔧 Buffer : ${buffer} wei`);
    console.log(`💰 Total value to send: ${actualMsgValue} wei`);

    // Build transaction
    console.log('\n🔨 ====== BUILDING TRANSACTION ======');
    const abi = AbiCoder.defaultAbiCoder();
    const commands = '0x' + '00'.repeat(TOKENS.length); // V3_SWAP_EXACT_IN command for each token
    const inputs = TOKENS.map(t =>
      abi.encode(
        ['address','uint256','uint256','bytes','bool'], 
        [COLLECTOR, t.amtWei, 0, v3Path(t.addr, TARGET, t.fee), false]
      )
    );

    console.log(`📝 Commands: ${commands}`);
    console.log(`📋 Inputs count: ${inputs.length}`);

    // Create contract instance
    const contract = new Contract(COLLECTOR, DUST_ABI, wallet);
    
    // Prepare transaction parameters
    const txParams = {
      commands,
      inputs,
      deadline: Math.floor(Date.now() / 1e3) + 1800, // 30 minutes
      targetToken: TARGET,
      dstChain: DST_CHAIN_ID,
      dstDomain: DST_DOMAIN,
      recipient: recipientBytes32,  // Use converted bytes32 format
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
    
    // Send transaction
    console.log('⏳ Sending main transaction...');
    const tx = await contract.batchCollectWithUniversalRouter(
      txParams,
      TOKENS.map(t => t.addr),
      TOKENS.map(t => t.amtWei),
      {
        value: actualMsgValue,
        gasLimit: 1_500_000,
        nonce: nonce + 1
      }
    );

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
      if (finalRecipient !== RECIPIENT) {
        console.log(`   (ATA calculated from EOA: ${RECIPIENT})`);
      }
      
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
    if (API_DST_CHAIN === 1) {
      console.error('9. For Solana token transfers:');
      console.error('   - Set SOLANA_TOKEN_MINT to the token mint address');
      console.error('   - Or set USE_ATA_FOR_SOLANA=false to use EOA directly');
      console.error('   - Install @solana/web3.js and @solana/spl-token for ATA support');
    }
    console.error('10. Ensure binary-layout is installed:');
    console.error('    npm install binary-layout');
    
    process.exit(1);
  }
})();