# Live Trading Mode - Documentation

## Overview

The live trading mode implements automated trading on Polymarket with the following key features:

### Core Features

1. **Minimum Trade Size**: $5 per trade
2. **Exit Strategy**: Resolution-based only (no early exit except take-profit)
3. **Dual Position Strategy**: Automatically buys both UP and DOWN on every 5-minute market
4. **Take-Profit Orders**: 5% profit target on all positions
5. **Database Tracking**: Full trade history and position management in Supabase
6. **Auto-Redemption**: Automatically redeems winning positions every 5 minutes

## Strategies

### 1. Dual Position Strategy (5-Minute Markets)

**How it works:**
- Monitors for new 5-minute BTC Up/Down markets
- Enters positions within the first 30 seconds of market opening
- Places $5 buy order on UP outcome
- Places $5 buy order on DOWN outcome (total $10 per market)
- Automatically sets 5% take-profit sell orders on both positions
- Exits via take-profit fill or market resolution

**Risk Profile:**
- Maximum loss: $10 per market (if neither take-profit hits before resolution)
- Maximum gain: $10.50 (if one side take-profit fills at 5% gain)
- Strategy profits when one side moves 5%+ before market resolution
- This is a volatility/market-making strategy

**Example:**
```
Market opens:
- UP price: 48¢
- DOWN price: 52¢

Buys:
- 11 contracts UP @ 48¢ = $5.28
- 10 contracts DOWN @ 52¢ = $5.20
Total cost: $10.48

Take-profit orders placed:
- Sell 11 UP @ 50.4¢ (5% higher)
- Sell 10 DOWN @ 54.6¢ (5% higher)

If UP hits take-profit:
- Revenue: 11 × $0.504 = $5.544
- Profit on UP: $0.264
- Loss on DOWN (if doesn't hit): -$5.20
- Net: -$4.94 (loss)

Strategy requires both positions or high volatility to be profitable.
```

### 2. Signal-Based Strategy (15-Minute Markets)

**How it works:**
- Uses technical analysis (VWAP, RSI, MACD, Heiken Ashi)
- Detects market regime (TREND_UP, TREND_DOWN, RANGE, CHOP)
- Calculates model probability vs market price (edge detection)
- Requires 70% signal consensus over 60-second rolling window
- Only enters when edge threshold is met
- Minimum $5 per trade

**Entry Criteria:**
- EARLY phase (10-15 min remaining): 10% edge required
- MID phase (5-10 min remaining): 12% edge required
- LATE phase (0-5 min remaining): 20% edge required
- Skips first 2 minutes (indicator warm-up period)
- Regime alignment required (no counter-trend trades with weak edge)

## Running Live Trading

### Prerequisites

1. **Environment Variables** (in `.env`):
```bash
# Polymarket credentials
POLYMARKET_API_KEY=your_api_key
POLYMARKET_FUNDER_ADDRESS=0x...
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_API_SECRET=your_secret
POLYMARKET_API_PASSPHRASE=your_passphrase
POLYMARKET_SIGNATURE_TYPE=1  # 0=EOA, 1=Magic/Proxy

# Supabase (for trade tracking)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
```

2. **Wallet Balance**:
   - Ensure at least $50 USDC in your Polymarket wallet
   - Each dual position requires $10 ($5 per side)
   - Keep buffer for multiple concurrent markets

3. **MATIC for Gas** (if using EOA signature):
   - Need at least 0.1 MATIC for redemption transactions
   - Send to the signer wallet address (not funder address)

### Start Trading

```bash
npm run live
```

### Monitor Trading

The live mode outputs:
- Real-time position status
- Strategy triggers and entries
- Trade execution results
- Session statistics (PnL, win rate, etc.)
- Balance updates

### Stop Trading

Press `Ctrl+C` to stop. The session will be marked as stopped in the database.

## Database Schema

Trades are tracked in Supabase with the following tables:

### `live_sessions`
- `id`: UUID
- `started_at`: Timestamp
- `ended_at`: Timestamp
- `status`: RUNNING | STOPPED
- `strategy`: Strategy name
- `trades_opened`: Count
- `trades_closed`: Count
- `total_pnl`: Total profit/loss
- `win_count`: Number of winning trades
- `loss_count`: Number of losing trades
- `open_positions`: Current open positions

### `trades`
- `id`: UUID
- `session_id`: Foreign key to live_sessions
- `market_slug`: Polymarket market identifier
- `side`: UP | DOWN
- `entry_price`: Entry price in dollars
- `exit_price`: Exit price in dollars
- `size`: Position size (number of contracts)
- `cost_usd`: Total cost in USD
- `pnl`: Profit/loss in USD
- `entry_time`: Entry timestamp
- `exit_time`: Exit timestamp
- `status`: OPEN | CLOSED | RESOLVED
- `exit_reason`: TAKE_PROFIT | MARKET_RESOLUTION
- `order_id`: Polymarket order ID
- `token_id`: Polymarket token ID

## Risk Management

### Position Sizing
- Minimum $5 per position
- Position size calculated automatically based on price
- Example: If price is 50¢, buys 10 contracts ($5)

### Exit Strategy
- **Take-Profit**: 5% profit target (automatically placed as sell order)
- **Resolution**: Market resolves naturally after time window
- **No Stop-Loss**: Positions held until take-profit or resolution

### Maximum Risk
- Dual position strategy: $10 per market
- Signal-based strategy: $5 per trade
- Concurrent positions: Limited by wallet balance

## Performance Tracking

View session statistics in Supabase dashboard or via the trader object:

```javascript
liveTrader.getSessionStats()
// Returns:
// {
//   sessionId: "uuid",
//   tradesOpened: 10,
//   tradesClosed: 8,
//   totalPnl: -2.50,
//   winCount: 3,
//   lossCount: 5,
//   openPositions: 2,
//   winRate: "37.50%"
// }
```

## Safety Features

1. **Minimum Balance Check**: Won't trade if balance < $5
2. **Market Validation**: Verifies market is active and has valid token IDs
3. **Order Validation**: Checks for successful order placement before tracking
4. **Automatic Redemption**: Redeems winning positions every 5 minutes
5. **Session Tracking**: All trades logged to database for analysis
6. **Error Recovery**: Continues trading even if individual trades fail

## Troubleshooting

### "CLOB client not initialized"
- Check your API credentials in `.env`
- Verify POLYMARKET_PRIVATE_KEY is set correctly
- Check POLYMARKET_SIGNATURE_TYPE matches your wallet type

### "Insufficient balance"
- Deposit more USDC to your Polymarket wallet
- Check current balance: liveTrader.getBalance()

### "Signer wallet needs MATIC"
- Send at least 0.1 MATIC to the signer address
- Signer address shown in error message
- Only needed for EOA wallets (signature type 0)

### "Order rejected"
- Price may have moved (markets are fast-moving)
- Check spread and liquidity
- Verify order size meets minimum

### "Failed to save trade to database"
- Check SUPABASE_URL and SUPABASE_ANON_KEY
- Verify database tables exist (run migrations)
- Check network connectivity to Supabase

## Configuration

Edit settings in `src/config.js`:

```javascript
export const CONFIG = {
  pollIntervalMs: 1_000,  // Check for new markets every 1 second
  candleWindowMinutes: 15, // TA window size
  
  polymarket: {
    seriesId: "10192",  // BTC Up/Down 15m series
    autoSelectLatest: true,  // Auto-select latest market
    upOutcomeLabel: "Up",
    downOutcomeLabel: "Down"
  }
};
```

## Notes

- Markets resolve based on Chainlink BTC/USD price feed
- Price updates every ~30 seconds on Polygon
- Orders execute on Polymarket CLOB (Central Limit Order Book)
- All timestamps in UTC/ISO format
- Prices stored in cents (0-100 range) in code, dollars in database
