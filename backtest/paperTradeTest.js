import "dotenv/config";
import { fetchLiveEventsBySeriesId, flattenEventMarkets, pickLatestLiveMarket, fetchClobPrice } from "../src/data/polymarket.js";
import { CONFIG } from "../src/config.js";

/**
 * Paper Trading Test for Dual Position Strategy
 * Tests with LIVE Polymarket data but simulated orders
 */

const ANSI = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

let positions = [];
let totalCost = 0;
let totalRevenue = 0;

async function getCurrentMarket() {
  try {
    const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
    const markets = flattenEventMarkets(events);
    const market = pickLatestLiveMarket(markets);
    return market;
  } catch (err) {
    console.error("Error fetching market:", err.message);
    return null;
  }
}

async function getPrices(market) {
  try {
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : JSON.parse(market.outcomes || "[]");
    const clobTokenIds = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : JSON.parse(market.clobTokenIds || "[]");

    let upTokenId = null;
    let downTokenId = null;

    for (let i = 0; i < outcomes.length; i++) {
      const label = String(outcomes[i]).toLowerCase();
      const tokenId = clobTokenIds[i];
      if (label === "up") upTokenId = tokenId;
      if (label === "down") downTokenId = tokenId;
    }

    if (!upTokenId || !downTokenId) {
      return null;
    }

    const [upPrice, downPrice] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" })
    ]);

    return { up: upPrice, down: downPrice, upTokenId, downTokenId };
  } catch (err) {
    console.error("Error fetching prices:", err.message);
    return null;
  }
}

async function paperTradeTest() {
  console.log(`\n${ANSI.cyan}╔════════════════════════════════════════════════════════╗${ANSI.reset}`);
  console.log(`${ANSI.cyan}║   DUAL POSITION PAPER TRADING TEST (LIVE DATA)        ║${ANSI.reset}`);
  console.log(`${ANSI.cyan}╚════════════════════════════════════════════════════════╝${ANSI.reset}\n`);

  console.log("Fetching current live market...\n");

  const market = await getCurrentMarket();
  
  if (!market) {
    console.log(`${ANSI.red}✗ No active market found${ANSI.reset}\n`);
    return;
  }

  console.log(`${ANSI.green}✓ Market found:${ANSI.reset} ${market.slug}`);
  console.log(`  Question: ${market.question || market.title}`);
  console.log(`  End time: ${market.endDate}\n`);

  console.log("Fetching live prices...\n");

  const prices = await getPrices(market);

  if (!prices) {
    console.log(`${ANSI.red}✗ Could not fetch prices${ANSI.reset}\n`);
    return;
  }

  const upPrice = prices.up;
  const downPrice = prices.down;

  console.log(`${ANSI.cyan}═══ LIVE MARKET PRICES ═══${ANSI.reset}`);
  console.log(`  ${ANSI.green}UP:${ANSI.reset}   ${(upPrice * 100).toFixed(2)}¢`);
  console.log(`  ${ANSI.red}DOWN:${ANSI.reset} ${(downPrice * 100).toFixed(2)}¢\n`);

  // Simulate dual position entry
  const TRADE_SIZE = 5.0;
  const upSize = Math.ceil(TRADE_SIZE / upPrice);
  const downSize = Math.ceil(TRADE_SIZE / downPrice);
  const upCost = upSize * upPrice;
  const downCost = downSize * downPrice;
  const totalCost = upCost + downCost;

  console.log(`${ANSI.yellow}═══ SIMULATED ENTRY (Paper Trading) ═══${ANSI.reset}`);
  console.log(`  ${ANSI.green}UP Position:${ANSI.reset}`);
  console.log(`    Size: ${upSize} contracts`);
  console.log(`    Cost: $${upCost.toFixed(2)}`);
  console.log(`    Entry: ${(upPrice * 100).toFixed(2)}¢`);
  console.log(`    Take-Profit: ${(upPrice * 1.05 * 100).toFixed(2)}¢ (+5%)`);
  
  console.log(`\n  ${ANSI.red}DOWN Position:${ANSI.reset}`);
  console.log(`    Size: ${downSize} contracts`);
  console.log(`    Cost: $${downCost.toFixed(2)}`);
  console.log(`    Entry: ${(downPrice * 100).toFixed(2)}¢`);
  console.log(`    Take-Profit: ${(downPrice * 1.05 * 100).toFixed(2)}¢ (+5%)`);
  
  console.log(`\n  ${ANSI.cyan}Total Cost: $${totalCost.toFixed(2)}${ANSI.reset}\n`);

  // Calculate scenarios
  console.log(`${ANSI.cyan}═══ PROFIT SCENARIOS ═══${ANSI.reset}\n`);

  // Scenario 1: Both TPs hit
  const scenario1Rev = (upSize * upPrice * 1.05) + (downSize * downPrice * 1.05);
  const scenario1Pnl = scenario1Rev - totalCost;
  console.log(`${ANSI.green}Best Case:${ANSI.reset} Both take-profits hit`);
  console.log(`  Revenue: $${scenario1Rev.toFixed(2)}`);
  console.log(`  PnL: ${scenario1Pnl > 0 ? ANSI.green : ANSI.red}$${scenario1Pnl.toFixed(2)} (${((scenario1Pnl/totalCost)*100).toFixed(2)}%)${ANSI.reset}\n`);

  // Scenario 2: UP TP hits, DOWN wins at resolution
  const scenario2Rev = (upSize * upPrice * 1.05) + (downSize * 1.0);
  const scenario2Pnl = scenario2Rev - totalCost;
  console.log(`${ANSI.green}Good Case:${ANSI.reset} UP TP hits, market resolves DOWN`);
  console.log(`  Revenue: $${scenario2Rev.toFixed(2)}`);
  console.log(`  PnL: ${scenario2Pnl > 0 ? ANSI.green : ANSI.red}$${scenario2Pnl.toFixed(2)} (${((scenario2Pnl/totalCost)*100).toFixed(2)}%)${ANSI.reset}\n`);

  // Scenario 3: No TP, resolution wins one side
  const scenario3Rev = Math.max(upSize * 1.0, downSize * 1.0);
  const scenario3Pnl = scenario3Rev - totalCost;
  console.log(`${ANSI.yellow}Common Case:${ANSI.reset} No TP fills, resolution wins one side`);
  console.log(`  Revenue: $${scenario3Rev.toFixed(2)}`);
  console.log(`  PnL: ${scenario3Pnl > 0 ? ANSI.green : scenario3Pnl < 0 ? ANSI.red : ANSI.yellow}$${scenario3Pnl.toFixed(2)} (${((scenario3Pnl/totalCost)*100).toFixed(2)}%)${ANSI.reset}\n`);

  console.log(`${ANSI.cyan}═══ SUMMARY ═══${ANSI.reset}`);
  console.log(`  • Strategy: Buy both UP and DOWN`);
  console.log(`  • Total investment: $${totalCost.toFixed(2)}`);
  console.log(`  • Profit if both TP: +$${scenario1Pnl.toFixed(2)}`);
  console.log(`  • Profit if one TP + win: +$${scenario2Pnl.toFixed(2)}`);
  console.log(`  • Result if no TP: ~$${scenario3Pnl.toFixed(2)} (usually break-even)`);
  console.log(`\n  ${ANSI.green}✓ This is PAPER TRADING - No real orders placed${ANSI.reset}\n`);

  console.log(`${ANSI.gray}To trade for real, run: npm run live${ANSI.reset}\n`);
}

paperTradeTest().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
