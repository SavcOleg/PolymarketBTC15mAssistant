import "dotenv/config";
import { getMarketByWindow, getPriceAtTime } from "./dataSync.js";

/**
 * Simple Dual Position Strategy Backtest
 * 
 * Tests the strategy of buying both UP and DOWN at market open
 * with 5% take-profit targets on each side
 */

const TRADE_SIZE = 5.0; // $5 per side
const TAKE_PROFIT_PCT = 0.05; // 5%
const MARKET_DURATION_MS = 15 * 60 * 1000; // 15 minutes

async function backtestDualPosition({ startDate, endDate, series = "15m" }) {
  console.log("\n=== DUAL POSITION STRATEGY BACKTEST ===\n");
  console.log(`Period: ${startDate} to ${endDate}`);
  console.log(`Series: ${series}`);
  console.log(`Trade size: $${TRADE_SIZE} per side ($${TRADE_SIZE * 2} total per market)`);
  console.log(`Take-profit: ${TAKE_PROFIT_PCT * 100}%\n`);

  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  
  const results = {
    totalMarkets: 0,
    marketsTraded: 0,
    totalCost: 0,
    totalRevenue: 0,
    totalPnl: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    trades: []
  };

  // Generate market windows (every 15 minutes)
  const windowMs = 15 * 60 * 1000;
  
  for (let windowStart = start; windowStart < end; windowStart += windowMs) {
    const windowEnd = windowStart + windowMs;
    
    try {
      // Try to get market data for this window
      const market = await getMarketByWindow(windowStart, series);
      
      if (!market || !market.prices || market.prices.length === 0) {
        continue;
      }

      results.totalMarkets++;

      // Get entry prices (at market open)
      const entryPriceData = market.prices[0];
      if (!entryPriceData) continue;

      const upEntry = parseFloat(entryPriceData.up || 0);
      const downEntry = parseFloat(entryPriceData.down || 0);

      if (upEntry <= 0 || downEntry <= 0 || upEntry + downEntry === 0) {
        continue;
      }

      // Normalize prices
      const sum = upEntry + downEntry;
      const upPrice = upEntry / sum;
      const downPrice = downEntry / sum;

      // Calculate contracts and costs
      const upContracts = TRADE_SIZE / upPrice;
      const downContracts = TRADE_SIZE / downPrice;
      const upCost = upContracts * upPrice;
      const downCost = downContracts * downPrice;
      const totalCost = upCost + downCost;

      // Calculate take-profit prices
      const upTpPrice = upPrice * (1 + TAKE_PROFIT_PCT);
      const downTpPrice = downPrice * (1 + TAKE_PROFIT_PCT);

      let upFilled = false;
      let downFilled = false;
      let upFillTime = null;
      let downFillTime = null;

      // Check each price tick to see if take-profit hit
      for (let i = 1; i < market.prices.length; i++) {
        const tick = market.prices[i];
        const tickTime = tick.timestamp;
        
        if (tickTime > windowEnd) break;

        const upCurrent = parseFloat(tick.up || 0);
        const downCurrent = parseFloat(tick.down || 0);
        const tickSum = upCurrent + downCurrent;
        
        if (tickSum === 0) continue;

        const upNorm = upCurrent / tickSum;
        const downNorm = downCurrent / tickSum;

        // Check if UP take-profit hit
        if (!upFilled && upNorm >= upTpPrice) {
          upFilled = true;
          upFillTime = new Date(tickTime).toISOString();
        }

        // Check if DOWN take-profit hit
        if (!downFilled && downNorm >= downTpPrice) {
          downFilled = true;
          downFillTime = new Date(tickTime).toISOString();
        }

        // Exit early if both filled
        if (upFilled && downFilled) break;
      }

      // Calculate P&L
      let upRevenue = 0;
      let downRevenue = 0;

      if (upFilled) {
        upRevenue = upContracts * upTpPrice;
      }

      if (downFilled) {
        downRevenue = downContracts * downTpPrice;
      }

      // Get resolution outcome
      const resolution = market.resolution;
      
      // Add resolution revenue for unfilled positions
      if (!upFilled && resolution === "Up") {
        upRevenue = upContracts * 1.0; // Wins full payout
      } else if (!upFilled && resolution === "Down") {
        upRevenue = 0; // Loses
      }

      if (!downFilled && resolution === "Down") {
        downRevenue = downContracts * 1.0; // Wins full payout
      } else if (!downFilled && resolution === "Up") {
        downRevenue = 0; // Loses
      }

      const totalRevenue = upRevenue + downRevenue;
      const pnl = totalRevenue - totalCost;

      results.marketsTraded++;
      results.totalCost += totalCost;
      results.totalRevenue += totalRevenue;
      results.totalPnl += pnl;

      if (pnl > 0.01) results.wins++;
      else if (pnl < -0.01) results.losses++;
      else results.breakevens++;

      const trade = {
        window: new Date(windowStart).toISOString(),
        upEntry: upPrice.toFixed(4),
        downEntry: downPrice.toFixed(4),
        upTp: upTpPrice.toFixed(4),
        downTp: downTpPrice.toFixed(4),
        upFilled: upFilled,
        downFilled: downFilled,
        upFillTime,
        downFillTime,
        resolution,
        cost: totalCost.toFixed(2),
        revenue: totalRevenue.toFixed(2),
        pnl: pnl.toFixed(2),
        pnlPct: ((pnl / totalCost) * 100).toFixed(2)
      };

      results.trades.push(trade);

      // Log significant trades
      if (Math.abs(pnl) > 1.0) {
        const color = pnl > 0 ? '\x1b[32m' : '\x1b[31m';
        const reset = '\x1b[0m';
        console.log(`${color}${new Date(windowStart).toISOString().slice(11, 19)} | UP:${upPrice.toFixed(2)} DN:${downPrice.toFixed(2)} | UP-TP:${upFilled?"✓":"✗"} DN-TP:${downFilled?"✓":"✗"} | Res:${resolution} | PnL: $${pnl.toFixed(2)}${reset}`);
      }

    } catch (err) {
      // Skip markets with no data
      continue;
    }
  }

  // Print summary
  console.log("\n=== BACKTEST RESULTS ===\n");
  console.log(`Total Markets Available: ${results.totalMarkets}`);
  console.log(`Markets Traded: ${results.marketsTraded}`);
  console.log(`Total Cost: $${results.totalCost.toFixed(2)}`);
  console.log(`Total Revenue: $${results.totalRevenue.toFixed(2)}`);
  console.log(`Total PnL: $${results.totalPnl.toFixed(2)}`);
  console.log(`\nWins: ${results.wins}`);
  console.log(`Losses: ${results.losses}`);
  console.log(`Break-evens: ${results.breakevens}`);
  console.log(`Win Rate: ${((results.wins / results.marketsTraded) * 100).toFixed(2)}%`);
  console.log(`Avg PnL per Trade: $${(results.totalPnl / results.marketsTraded).toFixed(2)}`);
  console.log(`ROI: ${((results.totalPnl / results.totalCost) * 100).toFixed(2)}%`);

  // Show best and worst trades
  const sorted = results.trades.sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
  
  console.log("\n=== TOP 5 TRADES ===");
  sorted.slice(0, 5).forEach((t, i) => {
    console.log(`${i + 1}. ${t.window} | PnL: $${t.pnl} (${t.pnlPct}%) | UP-TP:${t.upFilled?"✓":"✗"} DN-TP:${t.downFilled?"✓":"✗"} | Res:${t.resolution}`);
  });

  console.log("\n=== BOTTOM 5 TRADES ===");
  sorted.slice(-5).reverse().forEach((t, i) => {
    console.log(`${i + 1}. ${t.window} | PnL: $${t.pnl} (${t.pnlPct}%) | UP-TP:${t.upFilled?"✓":"✗"} DN-TP:${t.downFilled?"✓":"✗"} | Res:${t.resolution}`);
  });

  return results;
}

// Run backtest
const args = process.argv.slice(2);
const days = args[0] ? parseInt(args[0]) : 7;

const endDate = new Date();
const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

backtestDualPosition({
  startDate: startDate.toISOString(),
  endDate: endDate.toISOString(),
  series: "15m"
}).then(() => {
  console.log("\n✓ Backtest complete\n");
  process.exit(0);
}).catch(err => {
  console.error("Backtest failed:", err.message);
  process.exit(1);
});
