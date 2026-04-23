# Quick Start Guide - Live Trading

## Prerequisites Checklist

- [ ] Node.js installed (v18+ recommended)
- [ ] Polymarket account with API credentials
- [ ] At least $50 USDC in Polymarket wallet
- [ ] Supabase project set up (optional but recommended)
- [ ] If using EOA wallet: 0.1+ MATIC for redemption gas

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Configure Environment

Create/update `.env` file:

```bash
# Required: Polymarket credentials
POLYMARKET_API_KEY=your_api_key_here
POLYMARKET_FUNDER_ADDRESS=0x_your_wallet_address
POLYMARKET_PRIVATE_KEY=0x_your_private_key
POLYMARKET_API_SECRET=your_api_secret
POLYMARKET_API_PASSPHRASE=your_passphrase
POLYMARKET_SIGNATURE_TYPE=1  # 1 for Magic/Email login, 0 for EOA

# Optional: Database tracking
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
```

### Getting Polymarket Credentials

1. **Magic/Email Login Users** (recommended):
   - Go to https://reveal.magic.link/polymarket
   - Enter your Polymarket email
   - Copy all credentials
   - Set `POLYMARKET_SIGNATURE_TYPE=1`

2. **EOA/MetaMask Users**:
   - Export private key from MetaMask
   - Get API credentials from Polymarket dashboard
   - Set `POLYMARKET_SIGNATURE_TYPE=0`
   - **Important**: Send 0.1+ MATIC to your wallet for redemption gas

## Step 3: Verify Configuration

Check that everything is set up:

```bash
node -e "import('./src/engines/liveTrader.js').then(m => m.liveTrader.init().then(ok => console.log('Setup OK:', ok)))"
```

Should output: `Setup OK: true`

## Step 4: Start Trading

```bash
npm run live
```

## What to Expect

### First 30 Seconds
- System initializes CLOB client
- Creates trading session in database
- Starts monitoring markets
- Shows current balance

### During Operation
You'll see colored log messages:

- 🔵 **[INFO]** - System status updates
- 🟢 **[SUCCESS]** - Successful trades, fills
- 🟡 **[WARNING]** - Non-critical issues
- 🔴 **[ERROR]** - Failed trades, errors
- 🟣 **[TRADE]** - Trade signals and executions

### Example Output

```
[2024-04-08T12:00:00.000Z] [INFO] Starting Live Trading Mode
[2024-04-08T12:00:00.100Z] [INFO] Minimum trade size: $5
[2024-04-08T12:00:00.200Z] [SUCCESS] Live trader initialized
[2024-04-08T12:00:00.300Z] [INFO] Current balance: $50.25
[2024-04-08T12:00:05.000Z] [INFO] New market window: btc-updown-5m-1775232000
[2024-04-08T12:00:05.500Z] [TRADE] Dual Position Strategy triggered for btc-updown-5m-1775232000
[2024-04-08T12:00:06.000Z] [SUCCESS] Dual position opened successfully
[2024-04-08T12:00:10.000Z] [INFO] Positions: 2 | Strategy markets: 1 | Signal: NO_TRADE
```

## Step 5: Monitor Performance

### Check Session Statistics

While running, the system tracks:
- Trades opened/closed
- Total PnL
- Win/loss counts
- Open positions

### View in Database (if Supabase configured)

1. Go to your Supabase dashboard
2. Navigate to Table Editor
3. Check `live_sessions` table for session stats
4. Check `trades` table for individual trades

### Manual Queries

```sql
-- Current session stats
SELECT * FROM live_sessions 
WHERE status = 'RUNNING' 
ORDER BY started_at DESC 
LIMIT 1;

-- Recent trades
SELECT * FROM trades 
ORDER BY entry_time DESC 
LIMIT 10;

-- Session PnL summary
SELECT 
  session_id,
  COUNT(*) as total_trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
  SUM(pnl) as total_pnl
FROM trades
GROUP BY session_id
ORDER BY MAX(entry_time) DESC;
```

## Step 6: Stop Trading

Press `Ctrl+C` to stop. The system will:
1. Close the trading session
2. Update database with final stats
3. Exit gracefully

## Troubleshooting Common Issues

### "CLOB client not initialized"
- Check API credentials in `.env`
- Verify `POLYMARKET_PRIVATE_KEY` is correct
- Ensure `POLYMARKET_SIGNATURE_TYPE` matches your wallet type

### "Insufficient balance"
- Deposit more USDC to Polymarket
- Check balance at https://polymarket.com/wallet
- Need $10 minimum for dual position ($5 per side)

### "Signer wallet needs MATIC"
- Only affects EOA wallets (signature type 0)
- Send 0.1 MATIC to the signer address shown in error
- Get MATIC from Polygon faucet or exchange
- Bridge from Ethereum using https://wallet.polygon.technology/

### "Failed to save trade to database"
- Check `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- Verify Supabase project is active
- Check if tables exist (see database schema below)

### No Markets Detected
- Verify markets are active at https://polymarket.com/
- Check if it's during active trading hours
- 5-minute markets may not always be available

### Orders Not Filling
- Markets are volatile, prices move fast
- Take-profit at 5% may not hit before resolution
- This is expected behavior (resolution-based exit)

## Database Setup (Optional)

If using Supabase tracking, create these tables:

```sql
-- Live sessions table
CREATE TABLE live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  strategy TEXT,
  config JSONB,
  trades_opened INTEGER DEFAULT 0,
  trades_closed INTEGER DEFAULT 0,
  total_pnl NUMERIC(10, 2) DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  open_positions INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trades table
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES live_sessions(id),
  market_slug TEXT NOT NULL,
  market_end_date TIMESTAMPTZ,
  side TEXT NOT NULL,
  entry_price NUMERIC(10, 4) NOT NULL,
  exit_price NUMERIC(10, 4),
  size NUMERIC(10, 2) NOT NULL,
  cost_usd NUMERIC(10, 2) NOT NULL,
  pnl NUMERIC(10, 2),
  entry_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ,
  status TEXT NOT NULL,
  exit_reason TEXT,
  order_id TEXT,
  token_id TEXT,
  strategy TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_sessions_status ON live_sessions(status);
CREATE INDEX idx_sessions_started ON live_sessions(started_at DESC);
CREATE INDEX idx_trades_session ON trades(session_id);
CREATE INDEX idx_trades_entry_time ON trades(entry_time DESC);
CREATE INDEX idx_trades_status ON trades(status);
```

## Next Steps

Once running successfully:

1. **Monitor for 1-2 hours** to understand behavior
2. **Check balance periodically** to ensure no issues
3. **Review trade history** in Supabase
4. **Adjust configuration** if needed (see LIVE_TRADING.md)
5. **Set appropriate risk limits** based on your comfort

## Safety Tips

- Start with minimum balance ($50-100)
- Monitor actively for first few hours
- Set up alerts for balance depletion
- Review session PnL regularly
- Don't trade more than you can afford to lose

## Support Resources

- Full documentation: `LIVE_TRADING.md`
- Implementation details: `IMPLEMENTATION_SUMMARY.md`
- Code documentation: inline comments in source files
- Polymarket docs: https://docs.polymarket.com/

## Emergency Stop

If you need to stop immediately:
1. Press `Ctrl+C`
2. Wait for graceful shutdown message
3. Check open positions at https://polymarket.com/positions
4. Manually close positions if needed

The bot will automatically:
- Cancel open take-profit orders on shutdown
- Keep positions until resolution or redemption
- Track all trades in database for later analysis
