
```
██████╗ ██╗   ██╗███╗   ███╗██████╗      █████╗ ██████╗ ██╗
██╔══██╗██║   ██║████╗ ████║██╔══██╗    ██╔══██╗██╔══██╗██║
██████╔╝██║   ██║██╔████╔██║██████╔╝    ███████║██████╔╝██║
██╔═══╝ ██║   ██║██║╚██╔╝██║██╔═══╝     ██╔══██║██╔═══╝ ██║
██║     ╚██████╔╝██║ ╚═╝ ██║██║         ██║  ██║██║     ██║
╚═╝      ╚═════╝ ╚═╝     ╚═╝╚═╝         ╚═╝  ╚═╝╚═╝     ╚═╝
```

Real-time WebSocket API for monitoring Pump.fun token pairs and transactions on Solana.

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

## Program Support

### Pump Program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`)
- Events: `CreateEvent`, `TradeEvent`
- TradeEvent includes `is_buy` field to determine buy/sell

### Pump AMM Program (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`)
- Events: `BuyEvent`, `SellEvent`
- Separate events for buy and sell operations

## Performance

- **Zero RPC Rate Limiting**: Uses only WebSocket subscriptions, no polling
- **Efficient Event Detection**: Direct log parsing with Anchor discriminators
- **Automatic Cleanup**: Subscriptions are removed when clients disconnect
- **Shared Subscriptions**: Multiple clients can share the same bonding curve subscription

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

