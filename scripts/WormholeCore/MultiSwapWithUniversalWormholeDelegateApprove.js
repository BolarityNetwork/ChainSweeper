// scripts/dust-collector-fixed.js
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, Wallet, Contract, isAddress
} from 'ethers';
import { JsonRpcProvider } from 'ethers';
import readline from 'readline';

console.log("\n🚀 DustCollector Standard Approval Test Script (Fixed)");
console.log("🧪 Powered by EIP-7702 + Standard ERC20 Approvals + Wormhole");
console.log("✨ Batch approve + swap + bridge in one transaction!");

/* ---------- Config Validation ---------- */
const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`❌ Missing environment variable: ${key}`);
  return value;
};

const RPC_URL = requireEnv('RPC_URL');
const PRIVATE_KEY = requireEnv('PRIVATE_KEY');
const DUST_COLLECTOR = requireEnv('COLLECTOR');
const METAMASK_WALLET = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B';
const TARGET_TOKEN = requireEnv('TARGET_TOKEN');

// Chain configuration
const DST_CHAIN_ID = parseInt(process.env.DST_CHAIN_ID || '0');
const RECIPIENT = process.env.RECIPIENT || '';
const ARBITER_FEE = BigInt(process.env.ARBITER_FEE || '0');

// Wormhole fee buffer
const WORMHOLE_FEE_BUFFER = BigInt(process.env.WORMHOLE_FEE_BUFFER || '100000000000');

// Smart Batching Configuration
const MAX_TOKENS_PER_BATCH = parseInt(process.env.MAX_TOKENS_PER_BATCH || '4');
const ENABLE_AUTO_BATCHING = process.env.ENABLE_AUTO_BATCHING !== 'false';

// Token configuration
const TOKENS = [
  {
    addr: requireEnv('TOKEN1'),
    dec: parseInt(process.env.TOKEN1_DEC || '18'),
    amt: process.env.TOKEN1_AMT || '0.001',
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
      amt: process.env[`TOKEN${i}_AMT`] || '0.001',
      fee: parseInt(process.env[`TOKEN${i}_FEE`] || '3000')
    });
    console.log(`✅ Added TOKEN${i} to batch`);
  } else if (tokenAddr) {
    console.log(`⚠️  TOKEN${i} skipped due to batch size limit (${MAX_TOKENS_PER_BATCH})`);
  }
}

// Contract ABIs
const DUST_COLLECTOR_ABI = [
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
          {"name": "recipient", "type": "bytes32"},
          {"name": "arbiterFee", "type": "uint256"}
        ]
      },
      {"name": "pullTokens", "type": "address[]"},
      {"name": "pullAmounts", "type": "uint256[]"}
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  "function core() view returns (address)"
];

const METAMASK_WALLET_ABI = [
  {
    "type": "function",
    "name": "execute",
    "inputs": [
      {"name": "_mode", "type": "bytes32"},
      {"name": "_executionCalldata", "type": "bytes"}
    ],
    "outputs": [],
    "stateMutability": "payable"
  }
];

const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)'
];

const WORMHOLE_CORE_ABI = [
  'function messageFee() external view returns (uint256)'
];

// Helper functions
function v3Path(tokenA, tokenB, fee) {
  return solidityPacked(['address', 'uint24', 'address'], [tokenA, fee, tokenB]);
}

// Base58 decode function for Solana addresses
function base58Decode(str) {
  const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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

function detectAddressType(address) {
  if (!address || address === '') return 'empty';
  if (isAddress(address)) return 'ethereum';
  const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (solanaPattern.test(address)) return 'solana';
  if (address.startsWith('0x') && address.length === 66) return 'hex';
  return 'unknown';
}

function addressToBytes32(address) {
  if (!address || address === '' || address === ZeroHash) {
    return ZeroHash;
  }
  
  const addressType = detectAddressType(address);
  console.log(`🔍 Detected address type: ${addressType.toUpperCase()}`);
  
  switch (addressType) {
    case 'ethereum':
      const cleanAddr = address.toLowerCase().replace('0x', '');
      return `0x${'000000000000000000000000' + cleanAddr}`;
      
    case 'solana':
      try {
        const decoded = base58Decode(address);
        if (decoded.length !== 32) {
          throw new Error(`Invalid Solana address length: ${decoded.length} bytes`);
        }
        return `0x${decoded.toString('hex')}`;
      } catch (error) {
        throw new Error(`Failed to decode Solana address: ${error.message}`);
      }
      
    case 'hex':
      return `0x${address.replace('0x', '').padStart(64, '0')}`;
      
    default:
      throw new Error(`Unsupported address format: ${address}. Expected Ethereum (0x...) or Solana (base58) address.`);
  }
}

// EIP-7702 delegation functions
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

// Create batch execution calldata
function createBatchExecutionCalldata(wallet, tokens, amounts, swapParams, pullTokens, pullAmounts, totalETHValue) {
  console.log('\n🔧 ====== CREATING BATCH EXECUTION CALLDATA ======');
  
  const executions = [];
  
  // 1. Add approval transactions for each token
  tokens.forEach((token, index) => {
    const tokenContract = new Contract(token.addr, ERC20_ABI);
    const approveCalldata = tokenContract.interface.encodeFunctionData('approve', [DUST_COLLECTOR, amounts[index]]);
    
    executions.push({
      target: token.addr,
      value: 0,
      callData: approveCalldata
    });
    
    console.log(`📝 Added approve execution for token ${index + 1}: ${token.addr}`);
    console.log(`   Amount: ${amounts[index]} wei`);
  });
  
  // 2. Add the main dust collection transaction
  const dustContract = new Contract(DUST_COLLECTOR, DUST_COLLECTOR_ABI);
  const dustCalldata = dustContract.interface.encodeFunctionData('batchCollectWithUniversalRouter', [
    swapParams,
    pullTokens,
    pullAmounts
  ]);
  
  executions.push({
    target: DUST_COLLECTOR,
    value: totalETHValue,
    callData: dustCalldata
  });
  
  console.log(`📝 Added dust collection execution`);
  console.log(`   Target: ${DUST_COLLECTOR}`);
  console.log(`   Value: ${totalETHValue} wei`);
  
  // 3. Encode executions for MetaMask Smart Wallet
  const mode = '0x0100000000000000000000000000000000000000000000000000000000000000';
  
  const executionCalldata = AbiCoder.defaultAbiCoder().encode(
    ['tuple(address target, uint256 value, bytes callData)[]'],
    [executions]
  );
  
  console.log(`📊 Batch summary:`);
  console.log(`   Total executions: ${executions.length}`);
  console.log(`   Approvals: ${executions.length - 1}`);
  console.log(`   Dust collection: 1`);
  console.log(`   Total ETH value: ${totalETHValue} wei`);
  
  return {
    mode,
    executionCalldata,
    totalValue: totalETHValue,
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
    const IS_LOCAL_OPERATION = DST_CHAIN_ID === 0;
    
    console.log('\n📋 ====== CONFIGURATION SUMMARY ======');
    console.log(`🏠 Dust Collector: ${DUST_COLLECTOR}`);
    console.log(`🤖 MetaMask Smart Wallet: ${METAMASK_WALLET}`);
    console.log(`🎯 Target Token: ${TARGET_TOKEN}`);
    console.log(`🌉 Destination Chain: ${DST_CHAIN_ID === 0 ? 'Local (same chain)' : `Chain ${DST_CHAIN_ID}`}`);
    console.log(`📨 Recipient: ${RECIPIENT || 'msg.sender (you)'}`);
    console.log(`💰 Arbiter Fee: ${ARBITER_FEE} wei`);
    console.log(`🪙 Tokens to collect: ${TOKENS.length}`);
    console.log(`📦 Smart Batching: ${ENABLE_AUTO_BATCHING ? 'Enabled' : 'Disabled'}`);
    console.log(`🔢 Max tokens per batch: ${MAX_TOKENS_PER_BATCH}`);
    TOKENS.forEach((token, i) => {
      console.log(`   ${i + 1}. ${token.addr} (${token.amt} tokens, ${token.fee} fee tier)`);
    });
    console.log('=====================================\n');

    // Setup provider and wallet
    const provider = new JsonRpcProvider(RPC_URL);
    const wallet = new Wallet(PRIVATE_KEY, provider);
    const chainId = (await provider.getNetwork()).chainId;
    
    // Check wallet balance
    const balance = await provider.getBalance(wallet.address);
    console.log(`👛 Wallet: ${wallet.address}`);
    console.log(`🌐 Chain ID: ${chainId}`);
    console.log(`💰 ETH Balance: ${balance} wei (${Number(balance) / 1e18} ETH)`);
    
    // Parse token amounts
    for (const token of TOKENS) {
      token.amtWei = parseUnits(token.amt, token.dec);
      console.log(`🪙 ${token.addr}: ${token.amt} tokens = ${token.amtWei} wei`);
    }

    // 🔧 Fixed token balance checking
    console.log('\n💰 ====== CHECKING TOKEN BALANCES ======');
    for (const token of TOKENS) {
      const tokenContract = new Contract(token.addr, ERC20_ABI, provider);
      const tokenBalance = await tokenContract.balanceOf(wallet.address);
      const tokenSymbol = await tokenContract.symbol().catch(() => 'UNKNOWN');
      const tokenDecimals = Number(await tokenContract.decimals().catch(() => 18)); // 🔧 确保转换为 number
      
      console.log(`🪙 Token ${tokenSymbol} (${token.addr}):`);
      console.log(`   Balance: ${tokenBalance} wei (${Number(tokenBalance) / (10**tokenDecimals)} ${tokenSymbol})`);
      console.log(`   Required: ${token.amtWei} wei (${token.amt} ${tokenSymbol})`);
      console.log(`   Sufficient: ${tokenBalance >= token.amtWei ? '✅' : '❌'}`);
      
      if (tokenBalance < token.amtWei) {
        throw new Error(`Insufficient balance for token ${tokenSymbol} (${token.addr}). Need ${token.amt} but only have ${Number(tokenBalance) / (10**tokenDecimals)}`);
      }
    }

    // Convert recipient to bytes32
    const recipientBytes32 = addressToBytes32(RECIPIENT);
    console.log(`📨 Original Recipient: ${RECIPIENT || 'Empty (will use msg.sender)'}`);
    console.log(`📨 Recipient (bytes32): ${recipientBytes32}`);
    
    // Validate address type compatibility with target chain
    if (RECIPIENT && DST_CHAIN_ID !== 0) {
      const addressType = detectAddressType(RECIPIENT);
      if (DST_CHAIN_ID === 1 || DST_CHAIN_ID === 21) {
        if (addressType !== 'solana') {
          console.warn(`⚠️  Warning: Target is Solana (chain ${DST_CHAIN_ID}) but address looks like ${addressType}. This might cause issues.`);
        } else {
          console.log(`✅ Address type matches Solana destination chain`);
        }
      } else {
        if (addressType !== 'ethereum') {
          console.warn(`⚠️  Warning: Target is EVM chain (${DST_CHAIN_ID}) but address looks like ${addressType}. This might cause issues.`);
        } else {
          console.log(`✅ Address type matches EVM destination chain`);
        }
      }
    }

    // Setup contracts
    const dustCollector = new Contract(DUST_COLLECTOR, DUST_COLLECTOR_ABI, wallet);

    // Calculate wormhole fee if cross-chain
    let wormholeFee = 0n;
    let totalETH = 0n;
    
    if (DST_CHAIN_ID !== 0) {
      console.log('\n🌉 ====== CALCULATING WORMHOLE FEE ======');
      try {
        const coreAddress = await dustCollector.core();
        const wormholeCore = new Contract(coreAddress, WORMHOLE_CORE_ABI, provider);
        wormholeFee = await wormholeCore.messageFee();
        totalETH = wormholeFee + WORMHOLE_FEE_BUFFER;
        console.log(`📊 Wormhole message fee: ${wormholeFee} wei`);
        console.log(`🔧 Fee buffer: ${WORMHOLE_FEE_BUFFER} wei`);
        console.log(`💰 Total ETH needed: ${totalETH} wei`);
      } catch (error) {
        console.error(`⚠️  Warning: Could not get wormhole fee: ${error.message}`);
        console.error('   Using buffer amount only...');
        totalETH = WORMHOLE_FEE_BUFFER;
        console.log(`💰 Using buffer as fallback: ${totalETH} wei`);
      }
    } else {
      console.log('\n🏠 ====== LOCAL OPERATION - NO WORMHOLE FEE ======');
      console.log('💰 No cross-chain fees required');
      totalETH = 0n;
    }

    // Step 1: Ensure delegation to MetaMask Smart Wallet
    await delegateToContract(wallet, provider, METAMASK_WALLET);

    // Step 2: Build swap parameters
    console.log('\n🔨 ====== BUILDING SWAP TRANSACTION ======');
    
    const commands = '0x' + '00'.repeat(TOKENS.length);
    
    const abi = AbiCoder.defaultAbiCoder();
    const inputs = TOKENS.map((token) => {
      const path = v3Path(token.addr, TARGET_TOKEN, token.fee);
      return abi.encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        [DUST_COLLECTOR, token.amtWei, 0, path, false]
      );
    });

    console.log(`📝 Commands: ${commands}`);
    console.log(`📋 Inputs count: ${inputs.length}`);
    console.log(`⏰ Deadline: ${Math.floor(Date.now() / 1000) + 1800}`);

    // Prepare swap parameters (matching your contract's SwapParams struct)
    const swapParams = {
      commands,
      inputs,
      deadline: Math.floor(Date.now() / 1000) + 1800,
      targetToken: TARGET_TOKEN,
      dstChain: DST_CHAIN_ID,
      recipient: recipientBytes32,
      arbiterFee: ARBITER_FEE
    };
    
    const pullTokens = TOKENS.map(t => t.addr);
    const pullAmounts = TOKENS.map(t => t.amtWei);
    
    console.log('\n📊 Transaction Summary:');
    console.log(`🎯 Target Token: ${TARGET_TOKEN}`);
    console.log(`🌉 Destination Chain: ${DST_CHAIN_ID}`);
    console.log(`📨 Recipient: ${recipientBytes32}`);
    console.log(`💰 ETH Value: ${totalETH} wei (${totalETH === 0n ? 'Local operation - no fees' : 'Cross-chain fees'})`);
    console.log(`🔧 Tokens Count: ${pullTokens.length}`);

    // Step 3: Create batch execution calldata for MetaMask Smart Wallet
    const { mode, executionCalldata, totalValue, executionsCount } = createBatchExecutionCalldata(
      wallet, TOKENS, TOKENS.map(t => t.amtWei), swapParams, pullTokens, pullAmounts, totalETH
    );

    // Step 4: Execute via MetaMask Smart Wallet
    console.log('\n📤 ====== EXECUTING VIA METAMASK SMART WALLET ======');
    
    const smartWalletContract = new Contract(wallet.address, METAMASK_WALLET_ABI, wallet);
    
    console.log(`🔧 Mode: ${mode}`);
    console.log(`📊 Total executions: ${executionsCount}`);
    console.log(`💰 Total ETH value: ${totalValue} wei`);
    
    // Final balance check with proper BigInt handling
    const currentBalance = await provider.getBalance(wallet.address);
    let estimatedGasCost = 0n;
    
    try {
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || 1000000000n; // 🔧 确保是 BigInt
      estimatedGasCost = 2500000n * gasPrice; // 🔧 都使用 BigInt
    } catch (error) {
      console.warn(`⚠️  Could not estimate gas cost: ${error.message}`);
      estimatedGasCost = 2500000n * 1000000000n; // 🔧 Fallback 也使用 BigInt
    }
    
    const totalNeeded = totalValue + estimatedGasCost;
    
    console.log(`💰 Current balance: ${currentBalance} wei (${Number(currentBalance) / 1e18} ETH)`);
    console.log(`⛽ Estimated gas cost: ${estimatedGasCost} wei (${Number(estimatedGasCost) / 1e18} ETH)`);
    console.log(`💸 Total needed: ${totalNeeded} wei (${Number(totalNeeded) / 1e18} ETH)`);
    
    if (currentBalance < totalNeeded) {
      throw new Error(`Insufficient balance! Need ${Number(totalNeeded) / 1e18} ETH but only have ${Number(currentBalance) / 1e18} ETH`);
    }
    
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
    
    const baseGas = 500000n;
    const gasPerApproval = 50000n;
    const dustCollectionGas = IS_LOCAL_OPERATION ? 600000n : 1200000n;
    const dynamicGasLimit = baseGas + (gasPerApproval * BigInt(TOKENS.length)) + dustCollectionGas;
    const finalGasLimit = dynamicGasLimit < 2500000n ? 2500000n : 
                         dynamicGasLimit > 5000000n ? 5000000n : 
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
      console.log(`💰 Total ETH spent: ${totalValue} wei`);
      console.log(`📝 Transaction hash: ${tx.hash}`);
      
      if (IS_LOCAL_OPERATION) {
        console.log('\n📋 LOCAL OPERATION COMPLETED:');
        console.log('1️⃣  ✅ EIP-7702 delegation to MetaMask Smart Wallet completed');
        console.log('2️⃣  ✅ Batch token approvals executed');
        console.log('3️⃣  ✅ Token swap via UniversalRouter completed');
        console.log('4️⃣  ✅ Tokens swapped to target token in your wallet');
        console.log('5️⃣  ✅ No cross-chain transfer was needed');
      } else {
        console.log('\n📋 CROSS-CHAIN OPERATION COMPLETED:');
        console.log('1️⃣  ✅ EIP-7702 delegation to MetaMask Smart Wallet completed');
        console.log('2️⃣  ✅ Batch token approvals executed');
        console.log('3️⃣  ✅ Token swap via UniversalRouter completed');
        console.log('4️⃣  ✅ Wormhole cross-chain bridge initiated');
        console.log('\n💡 Next Steps:');
        console.log('⏳ Wait a few minutes for cross-chain completion');
        console.log('🌉 Track your transaction on Wormhole Explorer: https://wormholescan.io/');
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
    
    if (error.reason) {
      console.error(`🔍 Reason: ${error.reason}`);
    }
    
    if (error.code) {
      console.error(`🔧 Error Code: ${error.code}`);
    }
    
    console.error('\n💡 TROUBLESHOOTING TIPS:');
    console.error('1. Check your .env configuration');
    console.error('2. Verify wallet has sufficient ETH balance');
    console.error('3. Verify wallet has sufficient token balances');
    console.error('4. Check token addresses and decimals');
    console.error('5. Verify DUST_COLLECTOR contract address');
    console.error('6. Verify METAMASK_WALLET contract address');
    console.error('7. Ensure TARGET_TOKEN is valid');
    console.error('8. Check Uniswap V3 pool exists for token pairs');
    console.error('9. For cross-chain: verify DST_CHAIN_ID is valid Wormhole chain ID');
    console.error('10. Ensure RECIPIENT address format is correct');
    console.error('11. Check RPC endpoint is working');
    console.error('12. Ensure EIP-7702 is supported on your test network');
    console.error('13. Check that MetaMask Smart Wallet contract is deployed');
    
    process.exit(1);
  }
})();