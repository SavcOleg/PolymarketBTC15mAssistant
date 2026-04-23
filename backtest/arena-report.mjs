#!/usr/bin/env node
/**
 * Summarize Strategy Arena session JSON: rolling win rate over last N resolved cycles.
 * Usage:
 *   node backtest/arena-report.mjs [session.json] [cycles]
 *   node backtest/arena-report.mjs   # latest arena-sessions/*.json by mtime
 *
 * For single-sided strategies, "cycle" = one closed trade (directional).
 * For dual_position, reports net PnL per window and % of windows with positive net (not comparable to directional WR).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dualByWindow, rollingSingleSided } from "./arenaStats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARENA_DIR = path.join(__dirname, "..", "arena-sessions");

function latestSessionFile() {
  if (!fs.existsSync(ARENA_DIR)) return null;
  const files = fs
    .readdirSync(ARENA_DIR)
    .filter((f) => f.endsWith(".json") && f !== "_active.json")
    .map((f) => ({ f, t: fs.statSync(path.join(ARENA_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(ARENA_DIR, files[0].f) : null;
}

function printStrat(s, cycles) {
  const head = `${s.name} [${s.asset}] (${s.strategyType})`;
  console.log(`\n--- ${head} ---`);
  if (s.strategyType === "dual_position") {
    const d = dualByWindow(s.trades || [], cycles);
    console.log(
      `  Last ${d.sample} resolved windows (of ${d.totalResolved} total resolved): ${d.pctPositiveWindows}% net-positive | net $${d.pnlUsd}`,
    );
    console.log(`  (${d.positiveWindows} positive / ${d.nonPositiveWindows} zero-or-negative in sample)`);
    if (d.openWindows) console.log(`  (${d.openWindows} window(s) still open / unresolved in session file)`);
  } else {
    const r = rollingSingleSided(s.trades || [], cycles);
    console.log(
      `  Last ${r.sample} trades (of ${r.totalClosed} closed): ${r.winRatePct}% WR | ${r.wins}W ${r.losses}L | net $${r.pnlUsd}`,
    );
    if (r.sample < cycles && r.totalClosed >= r.sample) {
      console.log(`  (session has fewer than ${cycles} trades in tail; sample = ${r.sample})`);
    }
  }
  const bal = s.balance != null && s.bank != null ? +(s.balance - s.bank).toFixed(2) : null;
  if (bal != null) console.log(`  Session PnL vs bank: $${bal}`);
}

const sessionArg = process.argv[2];
const cycles = Math.max(1, +(process.argv[3] || 50));
const sessionPath = sessionArg && sessionArg !== "--" ? path.resolve(sessionArg) : latestSessionFile();

if (!sessionPath || !fs.existsSync(sessionPath)) {
  console.error("No arena session file found. Pass path to arena-sessions/*.json or run the arena first.");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const strats = data.strategies || [];
console.log(`Arena report: ${path.basename(sessionPath)}`);
console.log(`sessionId=${data.sessionId} windowMinutes=${data.windowMinutes} savedAt=${data.savedAt || "?"}`);
console.log(`Rolling sample size (target): ${cycles} cycles`);

for (const s of strats) printStrat(s, cycles);

console.log("\nNote: 75% WR over 50×5m is a research target — live markets vary; use this report + Strategy Lab backtests together.\n");
