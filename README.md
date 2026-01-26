
```
██████╗ ██╗   ██╗███╗   ███╗██████╗      █████╗ ██████╗ ██╗            
██╔══██╗██║   ██║████╗ ████║██╔══██╗    ██╔══██╗██╔══██╗██║             
██████╔╝██║   ██║██╔████╔██║██████╔╝    ███████║██████╔╝██║
██╔═══╝ ██║   ██║██║╚██╔╝██║██╔═══╝     ██╔══██║██╔═══╝ ██║
██║     ╚██████╔╝██║ ╚═╝ ██║██║         ██║  ██║██║     ██║
╚═╝      ╚═════╝ ╚═╝     ╚═╝╚═╝         ╚═╝  ╚═╝╚═╝     ╚═╝
```

Real-time WebSocket API for monitoring PumpAPI token pairs and transactions on Solana.

## Features

- 🔥 **Real-time New Pairs**: Stream new token pair creation events (`create` and `create_v2`)
- 💰 **Transaction Monitoring**: Track buy/sell transactions for specific bonding curves
- ⚡ **High Performance**: Uses direct program log subscriptions (no transaction fetching)
- 🎯 **Dual Program Support**: Automatically detects and handles both `pump` and `pump_amm` programs
- 📊 **Account Data Decoding**: Decodes bonding curve account state using Anchor IDLs
- 🚀 **Auto Cleanup**: Automatically unsubscribes when clients disconnect

## Installation

```bash
npm install
```

## Configuration

Set your Solana RPC URL in `.env`:

```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

Or use the default public RPC endpoint.

## Usage

### Start the Server

```bash
npm start
```

The server will start on port `3000` by default.

## API Endpoints

### Health Check

```http
GET /health
```

Returns server health status.

### Status

```http
GET /status
```

Returns detailed status of all subscriptions.

### Token Info

```http
GET /info/:mint
```

Fetches complete token information including metadata from a mint address.

**Example:**
```bash
curl http://localhost:3000/info/F1b5B2dnYTPMViJ3Gtn1DLSQAwxPn42RdVzdpvrepump
```

**Response:**
```json
{
  "mint": "F1b5B2dnYTPMViJ3Gtn1DLSQAwxPn42RdVzdpvrepump",
  "bondingCurve": "HLmFrsxFKNhA5ogZ3H5SnM5QRCG1LxpM6oDigsRFGz7M",
  "complete": false,
  "creator": "...",
  "isMayhemMode": false,
  "metadata": {
    "name": "PenguCoin",
    "symbol": "PENGUCOIN",
    "uri": "https://ipfs.io/ipfs/...",
    "decimals": 6,
    "supply": "1000000000000000"
  }
}
```

**Note:** Metadata is fetched from Token-2022 extensions. If bonding curve decoding fails but metadata is available, the response will still include metadata with default values for bonding curve fields.

### Derive Bonding Curve

```http
GET /info/derive/:mint
```

Derives and returns the bonding curve PDA address from a mint address.

**Example:**
```bash
curl http://localhost:3000/info/derive/F1b5B2dnYTPMViJ3Gtn1DLSQAwxPn42RdVzdpvrepump
```

**Response:**
```json
{
  "bondingCurve": "HLmFrsxFKNhA5ogZ3H5SnM5QRCG1LxpM6oDigsRFGz7M"
}
```

This endpoint only derives the bonding curve address without fetching or decoding account data, making it fast and reliable.

## WebSocket Endpoints

### New Pairs Stream

Connect to stream all new token pair creations:

```javascript
const ws = new WebSocket('ws://localhost:3000/ws/newpairs');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('New pair:', data);
};
```

**Event Format:**
```json
{
  "type": "newPair",
  "instructionType": "create" | "create_v2",
  "data": {
    "name": "Token Name",
    "symbol": "SYMBOL",
    "uri": "https://...",
    "mint": "...",
    "bondingCurve": "...",
    "user": "...",
    "creator": "...",
    "timestamp": "...",
    "virtualTokenReserves": "...",
    "virtualSolReserves": "...",
    "realTokenReserves": "...",
    "tokenTotalSupply": "...",
    "tokenProgram": "...",
    "isMayhemMode": false
  },
  "signature": "...",
  "slot": 123456789
}
```

### Transaction Stream

Connect to stream buy/sell transactions for a specific bonding curve:

```javascript
const bondingCurve = '9wcD5EBuHPj9r2Qb1ks5KQTzYPqDxNLCX1wnegY6w562';
const ws = new WebSocket(`ws://localhost:3000/ws/txs?bondingCurve=${bondingCurve}`);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Transaction:', data);
};
```

**Alternative Query Format:**
```javascript
// Also supports ?= format
const ws = new WebSocket(`ws://localhost:3000/ws/txs?=${bondingCurve}`);
```

**Event Format:**
```json
{
  "type": "buy" | "sell",
  "amount": 0.123456789
}
```

**Connection Message:**
```json
{
  "type": "connected",
  "message": "Connected to transaction stream for bonding curve: ...",
  "bondingCurve": "...",
  "subscriptionStatus": {
    "subscribed": true,
    "eventCount": 0,
    "programType": "pump" | "pump_amm",
    "programId": "..."
  }
}
```

## Architecture

### New Pairs Subscription
- Uses `connection.onLogs()` to subscribe to program logs
- Filters for `CreateEvent` discriminators
- Distinguishes between `create` and `create_v2` instructions
- Commitment level: `processed` (faster event detection)

### Transaction Subscription
- Uses `connection.onLogs()` for buy/sell event detection
- Uses `connection.onAccountChange()` for account state updates
- Automatically determines program type (`pump` or `pump_amm`) from bonding curve owner
- Decodes account data using Anchor IDLs
- Commitment level: `finalized`
- **No transaction fetching** - uses only subscription data (prevents rate limiting)

## Development

```bash
# Run with nodemon (auto-reload)
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

## Dependencies

- `@solana/web3.js` - Solana blockchain interaction
- `@coral-xyz/anchor` - Anchor IDL decoding
- `express` - HTTP server
- `ws` - WebSocket server
- `typescript` - TypeScript support

## License

MIT

