// scripts/dust-executor.ts
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, Wallet, Contract, MaxUint256, isAddress
} from 'ethers';
import { JsonRpcProvider } from 'ethers';
import axios from 'axios';
import { createHash } from 'crypto';

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
  
  // Decode addresses
  const wallet = base58Decode(walletAddress);
  const tokenMint = base58Decode(tokenMintAddress);
  const tokenProgramId = base58Decode(TOKEN_PROGRAM_ID);
  const associatedTokenProgramId = base58Decode(ASSOCIATED_TOKEN_PROGRAM_ID);
  
  // Build seeds
  const seeds = [
    wallet,
    tokenProgramId,
    tokenMint
  ];
  
  // Find PDA
  let nonce = 255;
  let address;
  
  while (nonce >= 0) {
    try {
      const seedsWithNonce = [
        ...seeds,
        Buffer.from([nonce]),
        associatedTokenProgramId
      ];
      
      const hash = createHash('sha256');
      hash.update(Buffer.concat(seedsWithNonce));
      const hashResult = hash.digest();
      
      // Check if on ed25519 curve
      // This is a simplified check, actual PDA validation is more complex
      // Usually nonce = 255 works
      if (nonce === 255) {
        // ATA typically uses nonce 255
        const message = Buffer.concat([
          ...seeds,
          Buffer.from('ProgramDerivedAddress'),
          Buffer.from([nonce]),
          associatedTokenProgramId
        ]);
        
        const hash = createHash('sha256');
        hash.update(message);
        address = hash.digest();
        break;
      }
      
      nonce--;
    } catch (e) {
      nonce--;
    }
  }
  
  if (!address) {
    throw new Error('Could not find valid ATA address');
  }
  
  // Use correct findProgramAddress algorithm
  const message = Buffer.concat([
    wallet,
    tokenProgramId,
    tokenMint,
    Buffer.from('ProgramDerivedAddress'),
    associatedTokenProgramId
  ]);
  
  const hash = createHash('sha256');
  hash.update(message);
  address = hash.digest();
  
  // Actual Solana ATA calculation is more complex, using simplified method here
  // In production, it's recommended to use @solana/spl-token library
  
  // Temporary solution: Use @solana/web3.js if available
  try {
    // Try to use more accurate method (if possible)
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
      return '0x' + '000000000000000000000000' + cleanAddr;
      
    case 'solana':
      // Solana address decoded from base58 to 32 bytes
      const decoded = base58Decode(address);
      return '0x' + decoded.toString('hex').padStart(64, '0');
      
    case 'hex':
      // Already in hex format, ensure it's 32 bytes
      return '0x' + address.replace('0x', '').padStart(64, '0');
      
    default:
      throw new Error(`Unsupported address format: ${address}. Expected Ethereum (0x...) or Solana (base58) address.`);
  }
}

// 🔧 Fixed serialization function - supports both modes
function serializeRelayInstructions(apiDstChain, recipient, mode = EXECUTION_MODE) {
  console.log(`🔧 Serializing for destination chain: ${apiDstChain}`);
  console.log(`🎯 Execution Mode: ${mode.toUpperCase()}`);
  
  if (mode === 'drop') {
    // 🔄 Mode 1: GasDropOffInstruction - auto gas delivery to specified address
    if (apiDstChain === 1) {
      // Solana: Use GasDROPInstruction
      const dropOffHex = GAS_DROP_LIMIT.toString(16).padStart(32, '0');
      const recipientHex = addressToBytes32(recipient).replace('0x', '');
      return '0x02' +                              // Type 2: GasDropOffInstruction
             dropOffHex +                          // gasLimit: dynamically set CU (16 bytes)
             recipientHex;                         // recipient: 32 bytes
    } else {
      // EVM chains: Use GasDropOffInstruction
      console.log(`🔧 Using GasDropOffInstruction for EVM chain`);
      
      // Convert gas limit to 16-byte hex
      const dropOffHex = GAS_DROP_LIMIT.toString(16).padStart(32, '0'); // 16 bytes
      
      // Ensure recipient is correct 32 bytes format
      const recipientHex = addressToBytes32(recipient).replace('0x', '');
      
      const result = '0x02' + dropOffHex + recipientHex;
      
      console.log(`🔧 DropOff (16 bytes): ${dropOffHex} (${GAS_DROP_LIMIT} gas)`);
      console.log(`🔧 Recipient (32 bytes): ${recipientHex}`);
      console.log(`🔧 Final relayInstructions: ${result}`);
      console.log(`🔧 Total length: ${result.length} chars (should be 130)`);
      
      return result;
    }
  } else {
    // 🚀 Mode 2: GasInstruction - requires manual gas deposit
    console.log(`🔧 Using GasInstruction mode (manual gas required)`);
    
    let gasLimit;
    if (apiDstChain === 1) {
      // Solana: Use higher compute units - 1,000,000 CU
      gasLimit = SOLANA_GAS_LIMIT.toString(16).padStart(32, '0'); // dynamically set

      const result = '0x01' +                        // Type 1: GasInstruction
             gasLimit +                              // gasLimit: 16 bytes
             '000000000000000000000000000f4240';    // manually set to 1,000,000 CU

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

// 🔧 Fixed API call function
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

    // 🔧 Get quote - use final address (might be ATA)
    console.log('\n💰 ====== GETTING QUOTE FROM EXECUTOR ======');
    const { signedQuote, relayInstructions, estimatedCost } = await getQuoteFromExecutor(
      API_SRC_CHAIN,
      API_DST_CHAIN,
      finalRecipient  // Use final address (EOA or ATA)
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
        recipient: recipientBytes32,  // 🔧 Use converted bytes32 format
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
        estimatedCost: actualMsgValue  // 🎯 Pass actualMsgValue as estimatedCost parameter
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
      console.log(`📨 Target Address: ${finalRecipient}`);
      if (finalRecipient !== RECIPIENT) {
        console.log(`   (ATA calculated from EOA: ${RECIPIENT})`);
      }
      
      if (EXECUTION_MODE === 'gas') {
        console.log('\n📋 NEXT STEPS (GAS Mode):');
        console.log('🏷️  Your funds are being transferred cross-chain');
        console.log('⏰ You will need to manually deposit gas on the destination chain');
        console.log('🔍 Check the executor status for completion');
      } else {
        console.log('\n📋 NEXT STEPS (DROP Mode):');
        console.log('📦 Tokens should automatically arrive at your recipient address');
        if (API_DST_CHAIN === 1 && USE_ATA_FOR_SOLANA && finalRecipient !== RECIPIENT) {
          console.log('💳 Tokens will be in the ATA account');
        }
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
    if (API_DST_CHAIN === 1) {
      console.error('9. For Solana token transfers:');
      console.error('   - Set SOLANA_TOKEN_MINT to the token mint address');
      console.error('   - Or set USE_ATA_FOR_SOLANA=false to use EOA directly');
      console.error('   - Install @solana/web3.js and @solana/spl-token for ATA support');
    }
    
    process.exit(1);
  }
})();