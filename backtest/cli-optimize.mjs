#!/usr/bin/env node
/**
 * Runs /api/backtest/optimize via a short-lived backtest server (avoids importing server.js).
 * Usage: node backtest/cli-optimize.mjs [days] [market]
 *   days   — default 14, max 60
 *   market — both | 15 | 5
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const serverPath = path.join(__dirname, "server.js");
const port = 38000 + Math.floor(Math.random() * 2500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(p, maxMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`Server on :${p} did not become ready within ${maxMs}ms`);
}

async function readOptimizeResult(p, query) {
  const url = `http://127.0.0.1:${p}/api/backtest/optimize?${query}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`optimize HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (data.type === "optimize_result") return data;
        if (data.type === "error") throw new Error(data.error || "optimize error");
      }
    }
  }
  throw new Error("Stream ended without optimize_result");
}

function printResults(result, label) {
  const rows = result.results || [];
  console.log(`\n=== ${label} (${result.days}d, market=${result.market || "?"}) ===\n`);
  for (const r of rows) {
    const s = r.stats;
    const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor;
    console.log(
      `#${r.rank} ${r.name} | PnL $${s.totalPnl} | WR ${s.winRate}% | trades ${s.totalTrades}/${s.totalWindows ?? "?"} | PF ${pf} | real ${s.realDataCoverage ?? "?"}%`,
    );
  }
  if (!rows.length) {
    console.log("(no results)");
    return null;
  }
  const best = rows[0];
  console.log(`\n→ Top by total PnL: ${best.name}`);
  console.log(`   $${best.stats.totalPnl}  |  ${best.stats.winRate}% WR  |  ${best.stats.totalTrades} trades  |  max DD $${best.stats.maxDrawdown}\n`);
  return best;
}

const days = Math.min(60, Math.max(1, +(process.argv[2] || 14)));
const market = ["both", "15", "5"].includes(process.argv[3]) ? process.argv[3] : "both";

const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "ignore", "inherit"],
});

try {
  await waitForReady(port);
  const params = new URLSearchParams({
    days: String(days),
    bank: "1000",
    maxBet: "5",
    feeRate: "0.02",
    market,
  });
  console.error(`[cli-optimize] Server :${port} — running optimize (this may take several minutes for Binance klines)…`);
  const result = await readOptimizeResult(port, params.toString());
  printResults(result, "Strategy Lab ranking");
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(3000)]);
}
