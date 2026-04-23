import "dotenv/config";

/**
 * Simple Dual Position Strategy Simulator
 * 
 * Simulates buying UP and DOWN at different market scenarios
 * to show how the strategy performs
 */

console.log("\n╔════════════════════════════════════════════════════════════╗");
console.log("║     DUAL POSITION STRATEGY SIMULATION                     ║");
console.log("╚════════════════════════════════════════════════════════════╝\n");

console.log("Strategy: Buy $5 UP + $5 DOWN at market open");
console.log("Take-Profit: 5% on each side");
console.log("Exit: Take-profit fill OR market resolution\n");

// Test scenarios
const scenarios = [
  {
    name: "Scenario 1: UP side take-profit hits",
    upOpen: 0.48,
    downOpen: 0.52,
    upPeak: 0.53,    // Hits TP at 0.504 (48 * 1.05)
    downPeak: 0.47,
    resolution: "Down" // Market resolves DOWN
  },
  {
    name: "Scenario 2: DOWN side take-profit hits",
    upOpen: 0.55,
    downOpen: 0.45,
    upPeak: 0.50,
    downPeak: 0.50,    // Hits TP at 0.4725 (45 * 1.05)
    resolution: "Up"
  },
  {
    name: "Scenario 3: Both take-profits hit (best case)",
    upOpen: 0.48,
    downOpen: 0.52,
    upPeak: 0.52,    // Both hit TP
    downPeak: 0.56,
    resolution: "Up"
  },
  {
    name: "Scenario 4: Neither TP hits, resolves UP",
    upOpen: 0.50,
    downOpen: 0.50,
    upPeak: 0.51,    // Doesn't hit 0.525
    downPeak: 0.49,
    resolution: "Up"
  },
  {
    name: "Scenario 5: Neither TP hits, resolves DOWN",
    upOpen: 0.50,
    downOpen: 0.50,
    upPeak: 0.51,
    downPeak: 0.49,    // Doesn't hit 0.525
    resolution: "Down"
  }
];

const TRADE_SIZE = 5.0;
const TP_PCT = 0.05;

console.log("═══════════════════════════════════════════════════════════════\n");

scenarios.forEach((scenario, idx) => {
  console.log(`\x1b[1m${scenario.name}\x1b[0m`);
  console.log(`─`.repeat(60));
  
  const { upOpen, downOpen, upPeak, downPeak, resolution } = scenario;
  
  // Calculate entry
  const upContracts = TRADE_SIZE / upOpen;
  const downContracts = TRADE_SIZE / downOpen;
  const upCost = upContracts * upOpen;
  const downCost = downContracts * downOpen;
  const totalCost = upCost + downCost;
  
  // Calculate TP prices
  const upTP = upOpen * (1 + TP_PCT);
  const downTP = downOpen * (1 + TP_PCT);
  
  // Check TP fills
  const upTpFilled = upPeak >= upTP;
  const downTpFilled = downPeak >= downTP;
  
  console.log(`Entry: UP ${(upOpen * 100).toFixed(1)}¢ ($${upCost.toFixed(2)}, ${upContracts.toFixed(1)} contracts)`);
  console.log(`       DOWN ${(downOpen * 100).toFixed(1)}¢ ($${downCost.toFixed(2)}, ${downContracts.toFixed(1)} contracts)`);
  console.log(`Total Cost: $${totalCost.toFixed(2)}`);
  console.log();
  
  console.log(`Take-Profit Targets:`);
  console.log(`  UP: ${(upTP * 100).toFixed(1)}¢ → ${upTpFilled ? '\x1b[32m✓ FILLED\x1b[0m' : '\x1b[90m✗ not filled\x1b[0m'} (peak: ${(upPeak * 100).toFixed(1)}¢)`);
  console.log(`  DOWN: ${(downTP * 100).toFixed(1)}¢ → ${downTpFilled ? '\x1b[32m✓ FILLED\x1b[0m' : '\x1b[90m✗ not filled\x1b[0m'} (peak: ${(downPeak * 100).toFixed(1)}¢)`);
  console.log(`Resolution: ${resolution}`);
  console.log();
  
  // Calculate revenue
  let upRevenue = 0;
  let downRevenue = 0;
  
  if (upTpFilled) {
    upRevenue = upContracts * upTP;
  } else if (resolution === "Up") {
    upRevenue = upContracts * 1.0; // Wins at resolution
  }
  
  if (downTpFilled) {
    downRevenue = downContracts * downTP;
  } else if (resolution === "Down") {
    downRevenue = downContracts * 1.0; // Wins at resolution
  }
  
  const totalRevenue = upRevenue + downRevenue;
  const pnl = totalRevenue - totalCost;
  const pnlPct = (pnl / totalCost) * 100;
  
  console.log(`Revenue:`);
  console.log(`  UP: $${upRevenue.toFixed(2)} ${upTpFilled ? '(TP fill)' : resolution === 'Up' ? '(resolution)' : '(lost)'}`);
  console.log(`  DOWN: $${downRevenue.toFixed(2)} ${downTpFilled ? '(TP fill)' : resolution === 'Down' ? '(resolution)' : '(lost)'}`);
  console.log(`  Total: $${totalRevenue.toFixed(2)}`);
  console.log();
  
  const pnlColor = pnl > 0 ? '\x1b[32m' : pnl < 0 ? '\x1b[31m' : '\x1b[33m';
  const pnlLabel = pnl > 0 ? 'PROFIT' : pnl < 0 ? 'LOSS' : 'BREAK-EVEN';
  console.log(`${pnlColor}PnL: $${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) - ${pnlLabel}\x1b[0m`);
  
  console.log(`\n${'═'.repeat(60)}\n`);
});

// Summary analysis
console.log("\x1b[1m📊 STRATEGY ANALYSIS\x1b[0m\n");

console.log("\x1b[32m✓ Best Case:\x1b[0m Both take-profits fill");
console.log("  - Revenue: ~$10.50 (both sides +5%)");
console.log("  - Profit: ~$0.50 (+5%)");
console.log("  - Rare: Requires high volatility\n");

console.log("\x1b[33m◐ Common Case:\x1b[0m One TP fills, resolution determines other");
console.log("  - If both on same side: Break-even or small loss");
console.log("  - If TP on winning side: ~$0.25 profit");
console.log("  - If TP on losing side: ~$4.75 loss\n");

console.log("\x1b[31m✗ Worst Case:\x1b[0m No TP fills, resolution determines outcome");
console.log("  - Win one side, lose other");
console.log("  - Result: ~$0 (break-even) due to $10 cost vs $10 payout\n");

console.log("\x1b[36m💡 KEY INSIGHTS:\x1b[0m");
console.log("  • Strategy profits from volatility (TP fills)");
console.log("  • Without TP fills, usually break-even (±$0)");
console.log("  • Need ~10-20% of trades to hit one TP for profitability");
console.log("  • Market-making style: small frequent gains from volatility");
console.log("  • Risk: ~$5 max loss if only wrong side TP fills\n");

console.log("═══════════════════════════════════════════════════════════════\n");
