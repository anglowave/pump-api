
```
██████╗ ██╗   ██╗███╗   ███╗██████╗      █████╗ ██████╗ ██╗            
██╔══██╗██║   ██║████╗ ████║██╔══██╗    ██╔══██╗██╔══██╗██║             
██████╔╝██║   ██║██╔████╔██║██████╔╝    ███████║██████╔╝██║
██╔═══╝ ██║   ██║██║╚██╔╝██║██╔═══╝     ██╔══██║██╔═══╝ ██║
██║     ╚██████╔╝██║ ╚═╝ ██║██║         ██║  ██║██║     ██║
╚═╝      ╚═════╝ ╚═╝     ╚═╝╚═╝         ╚═╝  ╚═╝╚═╝     ╚═╝
```

High-level API for [pump.fun](https://pump.fun) and pump_amm programs on Solana. Provides WebSocket subscriptions for real-time event monitoring and REST endpoints for token data retrieval.

## Installation

```bash
npm install
```

## Configuration

Set your Solana RPC URL in `.env`:

```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

If not set, defaults to `https://api.mainnet-beta.solana.com`.

## Usage

Start the server:

```bash
npm start
```

Server runs on port `3000` by default (configurable via `PORT` environment variable).

## REST API

### Token Info

```http
GET /info/:mint
```

Fetches token information including metadata and bonding curve data.

**Parameters:**
- `mint` (path): Token mint address (Solana public key, 32-44 characters)

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

### Derive Bonding Curve

```http
GET /info/derive/:mint
```

Derives the bonding curve PDA address from a mint address using the pump.fun program seeds.

**Parameters:**
- `mint` (path): Token mint address

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

**Note:** This endpoint performs PDA derivation only. No account data is fetched or decoded.

### Health Check

```http
GET /health
```

Returns server health status and subscription metrics.

### Status

```http
GET /status
```

Returns detailed status of all active subscriptions, connection counts, and program information.

## WebSocket API

### New Pairs Stream

```javascript
ws://localhost:3000/ws/newpairs
```

Subscribes to `CreateEvent` events from the pump.fun program. Emits events when new token pairs are created via `create` or `create_v2` instructions.

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

**Example:**
```javascript
const ws = new WebSocket('ws://localhost:3000/ws/newpairs');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Handle new pair event
};
```

### Transaction Stream

```javascript
ws://localhost:3000/ws/txs?bondingCurve=<address>
ws://localhost:3000/ws/txs?=<address>
```

Subscribes to trade events for a specific bonding curve. Automatically detects program type (pump or pump_amm) and decodes events accordingly.

**Parameters:**
- `bondingCurve` (query): Bonding curve PDA address (required)

**Event Format:**
```json
{
  "type": "buy" | "sell",
  "amount": 0.123456789,
  "signature": "5j7s8K9L...",
  "timestamp": 1234567890
}
```

**Connection Response:**
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

**Example:**
```javascript
const bondingCurve = '9wcD5EBuHPj9r2Qb1ks5KQTzYPqDxNLCX1wnegY6w562';
const ws = new WebSocket(`ws://localhost:3000/ws/txs?bondingCurve=${bondingCurve}`);
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Handle transaction event
};
```

## Architecture

### Event Subscription

The API uses Solana WebSocket subscriptions to monitor program logs:

- **New Pairs**: Subscribes to pump.fun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) logs and filters for `CreateEvent` discriminators
- **Transactions**: Subscribes to program logs based on bonding curve account owner, automatically determining whether to use pump or pump_amm IDL

### Account Decoding

Bonding curve accounts are decoded using Anchor IDLs:
- Pump program: `config/idl/pump/idl.json`
- Pump AMM program: `config/idl/pump_amm/idl.json`

Account data is decoded using BorshCoder from `@coral-xyz/anchor`.

### PDA Derivation

Bonding curve addresses are derived using:
- Seeds: `["bonding-curve", mint]`
- Program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`

### Commitment Levels

- New pairs: `processed` (faster event detection)
- Transactions: `finalized` (ensures transaction finality)

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

