# DustCollector Executor Script

🚀 **Powered by Permit2 + Wormhole CCTP v2 + Executor**

A TypeScript script for collecting dust tokens across different blockchains using cross-chain bridge technology. This script automatically swaps small token amounts to a target token and transfers them to a destination chain.

## 🌟 Features

- **Cross-chain dust collection**: Collect small token amounts and bridge them across chains
- **Multi-token support**: Handle multiple tokens in a single transaction
- **Two execution modes**: 
  - `gas`: Manual claim required on destination chain
  - `drop`: Automatic delivery to recipient address
- **Smart address detection**: Automatically detects Ethereum and Solana address formats
- **Permit2 integration**: Gasless token approvals
- **Universal Router**: Efficient token swapping via Uniswap V3

## 📋 Prerequisites

- Node.js (v16 or higher)
- TypeScript
- A wallet with tokens to collect
- Sufficient native tokens for gas fees
- RPC endpoint for the source chain

## 🚀 Installation

1. Clone the repository and navigate to the project directory
2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory (see Configuration section)

4. Run the script:
```bash
npx ts-node scripts/dust-executor.ts
```

## ⚙️ Configuration

Create a `.env` file with the following configuration:

```env
# ========= RPC & Wallet Configuration =========
RPC_URL=https://rpc.ankr.com/base_sepolia/your_api_key
PRIVATE_KEY=your_private_key_here

# ========= Contract Addresses =========
COLLECTOR=0x92879b56FE794b3b745cA2CBD3815475c5E579CE
TARGET_TOKEN=0x036CbD53842c5426634e7929541eC2318f3dCF7e

# ========= Token Configuration =========
TOKEN1=0x4aDcEaAec49D145C0764A626a0F610C9eDfFf35B
TOKEN1_AMT=0.00000000000001
TOKEN1_DEC=18
TOKEN1_FEE=3000

TOKEN2=0x1d2727D1A01D5067760a2Dd13c5936DDebCDeD5b
TOKEN2_AMT=0.00000000000001
TOKEN2_DEC=18
TOKEN2_FEE=3000

# ========= Cross-chain & Recipient Info =========
RECIPIENT=0x52389e164444e68178ABFa97d32908f00716A408

# Wormhole/CCTP chain identifiers
DST_CHAIN_ID=10002      # Wormhole chain ID
DST_DOMAIN=0            # CCTP destination domain

# ========= Executor API & Relay Options =========
EXECUTOR_API=https://executor-testnet.labsapis.com
DESTINATION_CALLER=0x0000000000000000000000000000000000000000000000000000000000000000

# ========= Fee Settings =========
MAX_FEE=100
MIN_FINALITY_THRESHOLD=0
FEE_DBPS=0
FEE_PAYEE=0x0000000000000000000000000000000000000000

# ========= Executor Modes =========
EXECUTION_MODE=gas       # Options: gas | drop
GAS_DROP_LIMIT=500000    # Only needed if EXECUTION_MODE=drop
SOLANA_GAS_LIMIT=10000000  # Only needed if destination is Solana

# ========= Executor Chain ID Settings =========
API_SRC_CHAIN=10004       # Source chain Wormhole ID (Base Sepolia)
API_DST_CHAIN=10002       # Destination chain Wormhole ID (Sepolia)
```

## 🔧 Configuration Parameters

### Required Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `RPC_URL` | RPC endpoint for source chain | `https://rpc.ankr.com/base_sepolia/...` |
| `PRIVATE_KEY` | Private key of wallet (without 0x prefix) | `536dc...c8c1277...` |
| `COLLECTOR` | DustCollector contract address | `0x92879b56FE794b3b745cA2CBD3815475c5E579CE` |
| `TARGET_TOKEN` | Token to swap dust tokens into | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `RECIPIENT` | Destination address for funds | `0x52389e16444...00716A408` |

### Token Configuration

For each token you want to collect, configure:
- `TOKEN1`: Token contract address
- `TOKEN1_AMT`: Amount to collect (in token units)
- `TOKEN1_DEC`: Token decimals (usually 18)
- `TOKEN1_FEE`: Uniswap V3 fee tier (3000 = 0.3%)

### Chain IDs

Common Wormhole Chain IDs:
- **Ethereum Mainnet**: 2
- **Ethereum Sepolia**: 10002
- **Base**: 30
- **Base Sepolia**: 10004
- **Solana**: 1

Common CCTP Domains:
- **Ethereum Sepolia**: 0
- **Base Sepolia**: 6
- **Solana**: 5

## 🎯 Execution Modes

### Gas Mode (`EXECUTION_MODE=gas`)
- **How it works**: Funds are bridged to destination chain but require manual claiming
- **Pros**: Lower gas costs, more control
- **Cons**: Requires additional transaction on destination chain
- **Use case**: When you want to batch multiple claims or have specific timing requirements

### Drop Mode (`EXECUTION_MODE=drop`)
- **How it works**: Funds are automatically delivered to recipient address
- **Pros**: Fully automated, no manual claiming needed
- **Cons**: Higher gas costs
- **Use case**: When you want complete automation
- **Note**: Not supported on Solana (will fallback to gas mode)

## 🔍 Address Format Support

The script automatically detects and handles multiple address formats:

- **Ethereum addresses**: `0x1234...5678` (42 characters)
- **Solana addresses**: `2ujBt...JSeN9` (32-44 characters, base58)
- **Hex format**: `0x1234...` (66 characters)

## 📖 Usage Examples

### Example 1: Collect dust from Base Sepolia to Ethereum Sepolia

```env
API_SRC_CHAIN=10004    # Base Sepolia
API_DST_CHAIN=10002    # Ethereum Sepolia
DST_CHAIN_ID=10002
DST_DOMAIN=0
EXECUTION_MODE=drop
```

### Example 2: Collect dust to Solana

```env
API_SRC_CHAIN=10004    # Base Sepolia
API_DST_CHAIN=1        # Solana
DST_CHAIN_ID=1
DST_DOMAIN=5
RECIPIENT=2ujBt8HgwkZYVmvjuE3RrBhbcYQGcEz5kdJKj2SeN9  # Solana address
EXECUTION_MODE=gas     # Solana only supports gas mode
```

## 🚨 Important Notes

### Security
- **Never commit your private key to version control**
- Use environment variables or encrypted key management
- Test with small amounts first

### Gas Considerations
- Ensure your wallet has sufficient native tokens for gas
- Cross-chain operations require gas on both source and destination chains
- Drop mode requires higher gas limits

### Address Compatibility
- Ensure recipient address format matches destination chain:
  - Use Ethereum addresses for EVM chains
  - Use Solana addresses for Solana destinations
- The script will warn about mismatched address types

## 🛠️ Troubleshooting

### Common Issues

**"Missing environment variable" error**
- Verify all required variables are set in `.env`
- Check for typos in variable names

**"Unsupported address format" error**
- Verify recipient address format
- Ensure address type matches destination chain

**"API Error" responses**
- Check network connectivity
- Verify chain IDs are correct
- Try switching execution modes

**Transaction failures**
- Increase gas limits
- Check token balances
- Verify contract addresses

### Debug Tips

1. **Check configuration**: The script prints a configuration summary at startup
2. **Monitor gas usage**: Track gas costs in the output logs
3. **Verify addresses**: Script shows detected address types
4. **Check API responses**: Full API request/response data is logged

### Getting Help

If you encounter issues:
1. Check the troubleshooting section in the script output
2. Verify your `.env` configuration
3. Test with smaller amounts first
4. Check network status and RPC endpoints

## 📝 Script Output

The script provides detailed logging:
- Configuration summary
- Address type detection
- Permit2 transaction status
- API requests and responses
- Transaction hash and confirmation
- Next steps based on execution mode

## 🔗 Useful Links

- [Wormhole Chain IDs](https://docs.wormhole.com/wormhole/reference/constants)
- [CCTP Domains](https://developers.circle.com/stablecoins/supported-domains)
- [Uniswap V3 Fee Tiers](https://docs.uniswap.org/concepts/protocol/fees)

## ⚠️ Disclaimer

This script interacts with smart contracts and cross-chain bridges. Always:
- Test with small amounts first
- Verify all addresses and configurations
- Understand the risks of cross-chain transactions
- Keep your private keys secure

Use at your own risk. The authors are not responsible for any losses.