import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { summarizeArenaStrategies } from "./arenaStats.js";
import { fileURLToPath } from "node:url";
import { computeSessionVwap, computeVwapSeries } from "../src/indicators/vwap.js";
import { computeRsi, slopeLast } from "../src/indicators/rsi.js";
import { computeMacd } from "../src/indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "../src/indicators/heikenAshi.js";
import { computeBollingerBands, detectSqueeze } from "../src/indicators/bollingerBands.js";
import { computeEmaCrossover } from "../src/indicators/ema.js";
import { computeAdx } from "../src/indicators/adx.js";
import { computeStochRsi } from "../src/indicators/stochasticRsi.js";
import { computeObvSignal } from "../src/indicators/obv.js";
import { computeAtrWithAvg } from "../src/indicators/atr.js";
import { computeCci } from "../src/indicators/cci.js";
import { computeWilliamsR } from "../src/indicators/williamsR.js";
import { computeMfi } from "../src/indicators/mfi.js";
import { computeKeltner } from "../src/indicators/keltner.js";
import { detectRegime } from "../src/engines/regime.js";
import { scoreDirectionV2, applyTimeAwareness, DEFAULT_WEIGHTS, DEFAULT_FILTERS } from "../src/engines/probability.js";
import { computeEdge, decideV2 } from "../src/engines/edge.js";
import {
  decideMomentumEntry,
  simulateTpSlInWindow,
  computeTpSlPrices,
  checkTpSl,
  buildTradeRecord,
  buildTradeSignals,
  STRATEGY_DEFAULTS,
} from "../src/engines/momentumScalp.js";
import {
  insertTrade,
  updateTrade,
  insertTradeSignals,
  insertMarketSnapshot,
  insertPriceTick,
  insertBacktestRun,
  updateBacktestRun,
  insertBacktestTrades,
  getActiveStrategy,
  getOpenTrades,
  insertSession,
  upsertSession,
  updateSession,
  listSessions,
  getSession,
  deleteSession,
} from "../src/db/supabase.js";
import { clamp } from "../src/utils.js";
import { discoverCurrentMarket, discoverNextMarket, fetchRealPrices, clearMarketCache, resolveLiveWindowBounds, discoverAllArenaMarkets, clearArenaMarketCache, ARENA_SERIES } from "./polymarket.js";
import { initClobClient, getClobStatus, placeBuyOrder, placeSellOrder, cancelOrder, cancelAllOrders, fetchPolymarketAccountSnapshot, redeemWinningPositions, fetchRedeemablePositions } from "./clobTrader.js";
import {
  runSync, getSyncStatus, getStore, getMarketByWindow,
  getPriceAtTime, getPricePath,
} from "./dataSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MIN_BET_USD = 5;

const klineCache = new Map();

/**
 * Polymarket BTC Up/Down settles on whether end price is above window open (UP vs DOWN).
 * At entry, blend TA probabilities with a prior from BTC move open → entry (same scale as dynamic quote model).
 */
function blendResolutionSettlementPrior(adjustedUp, adjustedDown, entryPrice, startPrice, marketSensitivity, weight) {
  if (weight <= 0 || startPrice <= 0) {
    return { modelUp: adjustedUp, modelDown: adjustedDown, priorUp: null };
  }
  const movePct = (entryPrice - startPrice) / startPrice;
  const priorUp = clamp(0.5 + movePct * marketSensitivity, 0.15, 0.85);
  const priorDown = 1 - priorUp;
  let u = (1 - weight) * adjustedUp + weight * priorUp;
  let d = (1 - weight) * adjustedDown + weight * priorDown;
  const sum = u + d;
  if (sum > 0) {
    u /= sum;
    d /= sum;
  }
  return { modelUp: u, modelDown: d, priorUp: +priorUp.toFixed(4) };
}

async function fetchKlinesBatch(symbol, interval, startTime, endTime) {
  const params = new URLSearchParams({ symbol, interval, limit: "1000" });
  if (startTime) params.set("startTime", String(startTime));
  if (endTime) params.set("endTime", String(endTime));
  const res = await fetch(`https://api.binance.com/api/v3/klines?${params}`);
  if (!res.ok) throw new Error(`Binance API ${res.status}`);
  const raw = await res.json();
  return raw.map((k) => ({
    openTime: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    closeTime: k[6],
  }));
}

async function fetchKlinesWithRetry(symbol, interval, startTime, endTime, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const batch = await fetchKlinesBatch(symbol, interval, startTime, endTime);
      if (batch.length) return batch;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr || new Error("Binance klines empty after retries");
}

async function fetchAllKlines(days, onProgress) {
  const cacheKey = `${days}`;
  const cached = klineCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 120_000) {
    if (onProgress) onProgress({ stage: "cache_hit", total: cached.data.length });
    return cached.data;
  }

  const end = Date.now();
  const start = end - days * 86_400_000;
  const totalBatches = Math.ceil((end - start) / (1000 * 60_000));
  let completed = 0;

  const ranges = [];
  let cursor = start;
  while (cursor < end) {
    const batchEnd = Math.min(cursor + 1000 * 60_000, end);
    ranges.push([cursor, batchEnd]);
    cursor = batchEnd + 1;
  }

  const all = [];
  const PARALLEL = 4;
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    const batch = ranges.slice(i, i + PARALLEL);
    const results = await Promise.all(
      batch.map(([s, e]) => fetchKlinesBatch("BTCUSDT", "1m", s, e))
    );
    for (const r of results) all.push(...r);
    completed += batch.length;
    if (onProgress) onProgress({ stage: "fetching", completed, total: ranges.length });
    if (i + PARALLEL < ranges.length) await new Promise((r) => setTimeout(r, 150));
  }

  all.sort((a, b) => a.openTime - b.openTime);
  const deduped = [];
  const seen = new Set();
  for (const k of all) {
    if (!seen.has(k.openTime)) {
      seen.add(k.openTime);
      deduped.push(k);
    }
  }

  klineCache.set(cacheKey, { data: deduped, ts: Date.now() });
  return deduped;
}

function groupWindows(klines, winMin = 15) {
  const winMs = winMin * 60_000;
  const map = new Map();
  for (const k of klines) {
    const ws = Math.floor(k.openTime / winMs) * winMs;
    if (!map.has(ws)) map.set(ws, []);
    map.get(ws).push(k);
  }
  return [...map.entries()]
    .map(([s, c]) => ({ startMs: s, endMs: s + winMs, candles: c.sort((a, b) => a.openTime - b.openTime) }))
    .sort((a, b) => a.startMs - b.startMs);
}

function countVwapCrosses(closes, vs, lb) {
  if (closes.length < lb || vs.length < lb) return null;
  let n = 0;
  for (let i = closes.length - lb + 1; i < closes.length; i++) {
    const p = closes[i - 1] - vs[i - 1];
    const c = closes[i] - vs[i];
    if (p && ((p > 0 && c < 0) || (p < 0 && c > 0))) n++;
  }
  return n;
}

function computeAllIndicators(recent, closes) {
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const last = closes[closes.length - 1];
  const vwapS = computeVwapSeries(recent);
  const vN = vwapS[vwapS.length - 1];
  const vSlope = vwapS.length >= 5 ? (vN - vwapS[vwapS.length - 5]) / 5 : null;

  const rsiNow = computeRsi(closes, 14);
  const rsiArr = [];
  for (let i = 0; i < closes.length; i++) {
    const r = computeRsi(closes.slice(0, i + 1), 14);
    if (r !== null) rsiArr.push(r);
  }
  const rsiSlope = slopeLast(rsiArr, 3);

  const macd = computeMacd(closes, 12, 26, 9);
  const ha = computeHeikenAshi(recent);
  const consec = countConsecutive(ha);

  const bb = computeBollingerBands(closes, 20, 2);
  const squeeze = detectSqueeze(closes, 20, 2, 20);
  const emaCross = computeEmaCrossover(closes, 9, 21);
  const adx = computeAdx(recent, 14);
  const stochRsi = computeStochRsi(closes, 14, 14, 3, 3);
  const obvSignal = computeObvSignal(recent, 6, 24);
  const atrData = computeAtrWithAvg(recent, 14, 20);
  const cci = computeCci(highs, lows, closes, 20);
  const williamsR = computeWilliamsR(highs, lows, closes, 14);
  const mfi = computeMfi(recent, 14);
  const keltner = computeKeltner(recent, closes, 20, 10, 2);

  const vc = countVwapCrosses(closes, vwapS, 20);
  const volR = recent.slice(-20).reduce((a, c) => a + c.volume, 0);
  const volA = recent.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;
  const fvr = vN !== null && vwapS.length >= 3
    ? closes[closes.length - 1] < vN && closes[closes.length - 2] > vwapS[vwapS.length - 2]
    : false;

  const regime = detectRegime({ price: last, vwap: vN, vwapSlope: vSlope, vwapCrossCount: vc, volumeRecent: volR, volumeAvg: volA });

  return {
    price: last, vwap: vN, vwapSlope: vSlope, vwapSeries: vwapS,
    rsi: rsiNow, rsiSlope,
    macd, heikenColor: consec.color, heikenCount: consec.count,
    bb, squeeze, emaCross, adx, stochRsi, obvSignal, atrData,
    cci, williamsR, mfi, keltner,
    failedVwapReclaim: fvr, regime, vwapCrossCount: vc, volumeRecent: volR, volumeAvg: volA,
  };
}

async function runBacktest({
  days = 3, bank = 1000, maxBet = MIN_BET_USD, entryMinute = 5,
  feeRate = 0.02, marketMode = "dynamic", marketSensitivity = 80,
  weights = {}, filters = {}, windowMinutes = 15,
}, onProgress) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const f = { ...DEFAULT_FILTERS, ...filters };
  const winMin = windowMinutes;

  const klines = await fetchAllKlines(days, onProgress);
  const windows = groupWindows(klines, winMin);
  const store = getStore();

  if (onProgress) onProgress({ stage: "computing", total: windows.length });

  let bal = bank;
  const trades = [];
  const balHist = [{ time: windows[0]?.startMs || Date.now(), balance: bal, tradeId: 0 }];

  const minCandles = winMin <= 5 ? 2 : 10;
  let realDataCount = 0;

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    if (win.candles.length < minCandles) continue;

    const startPrice = win.candles[0].open;
    const endPrice = win.candles[win.candles.length - 1].close;
    const syntheticUp = endPrice >= startPrice;

    const polyMkt = getMarketByWindow(win.startMs, winMin);
    const realResolution = polyMkt?.resolution || null;
    const actualUp = realResolution ? realResolution === "UP" : syntheticUp;

    const entryCutoff = win.startMs + entryMinute * 60_000;
    const entryCandles = win.candles.filter((c) => c.openTime < entryCutoff);
    if (entryCandles.length < 1) continue;

    const entryPrice = entryCandles[entryCandles.length - 1].close;
    const hist = klines.filter((k) => k.openTime < entryCutoff);
    const recent = hist.slice(-240);
    if (recent.length < 50) continue;

    const closes = recent.map((c) => c.close);
    const ind = computeAllIndicators(recent, closes);

    const scored = scoreDirectionV2(ind, w, f);
    const remMin = winMin - entryMinute;
    const ta = applyTimeAwareness(scored.rawUp, remMin, winMin);

    const priorW = f.resolutionPriorWeight;
    const effPriorW = priorW != null ? clamp(+priorW, 0, 0.85) : 0;
    const blended = blendResolutionSettlementPrior(
      ta.adjustedUp, ta.adjustedDown, entryPrice, startPrice, marketSensitivity, effPriorW,
    );

    let mUp, mDown, priceSource = "synthetic";
    const entrySec = Math.round(entryCutoff / 1000);
    const realEntry = polyMkt ? getPriceAtTime(polyMkt.slug, winMin, entrySec) : null;

    if (realEntry != null && realEntry > 0.01 && realEntry < 0.99) {
      mUp = realEntry;
      mDown = +(1 - realEntry).toFixed(4);
      priceSource = "real";
      realDataCount++;
    } else if (marketMode === "fixed") {
      mUp = 0.5; mDown = 0.5;
    } else {
      const earlyMove = (entryPrice - startPrice) / startPrice;
      mUp = clamp(0.5 + earlyMove * marketSensitivity, 0.25, 0.75);
      mDown = clamp(1 - mUp, 0.25, 0.75);
    }

    const rec = decideV2({
      remainingMinutes: remMin,
      modelUp: blended.modelUp,
      modelDown: blended.modelDown,
      confluence: scored.confluence,
      filtered: scored.filtered,
      minProbOverride: f.minProb || null,
    });

    if (rec.action === "ENTER" && bal >= maxBet) {
      const side = rec.side;
      const bPrice = side === "UP" ? mUp : mDown;
      const shares = maxBet / bPrice;
      const correct = (side === "UP" && actualUp) || (side === "DOWN" && !actualUp);

      let pnl;
      if (correct) {
        const grossProfit = shares - maxBet;
        const fee = grossProfit * feeRate;
        pnl = +(grossProfit - fee).toFixed(2);
      } else {
        pnl = -maxBet;
      }

      const synCorrect = (side === "UP" && syntheticUp) || (side === "DOWN" && !syntheticUp);
      let syntheticPnl;
      if (priceSource === "real") {
        const synMUp = marketMode === "fixed" ? 0.5 : clamp(0.5 + ((entryPrice - startPrice) / startPrice) * marketSensitivity, 0.25, 0.75);
        const synMDown = +(1 - synMUp).toFixed(4);
        const synBPrice = side === "UP" ? synMUp : synMDown;
        const synShares = maxBet / synBPrice;
        if (synCorrect) { const gp = synShares - maxBet; syntheticPnl = +(gp - gp * feeRate).toFixed(2); }
        else syntheticPnl = -maxBet;
      } else {
        syntheticPnl = pnl;
      }

      bal = +(bal + pnl).toFixed(2);
      const tradeId = trades.length + 1;

      trades.push({
        id: tradeId,
        time: new Date(win.startMs + entryMinute * 60_000).toISOString(),
        windowStart: win.startMs,
        side, buyPrice: +bPrice.toFixed(4), shares: +shares.toFixed(2), cost: maxBet,
        actualOutcome: actualUp ? "UP" : "DOWN", correct, pnl, balance: bal,
        priceSource,
        realResolution,
        realEntryPrice: priceSource === "real" ? +mUp.toFixed(4) : null,
        syntheticPnl,
        polymarketVolume: polyMkt?.volume || null,
        modelUp: +blended.modelUp.toFixed(4), modelDown: +blended.modelDown.toFixed(4),
        modelUpTa: +ta.adjustedUp.toFixed(4), modelDownTa: +ta.adjustedDown.toFixed(4),
        settlementPriorUp: blended.priorUp,
        marketUp: +mUp.toFixed(4), marketDown: +mDown.toFixed(4),
        regime: ind.regime.regime, strength: rec.strength, phase: rec.phase,
        confluence: scored.confluence,
        btcStart: +startPrice.toFixed(2), btcEnd: +endPrice.toFixed(2), btcEntry: +entryPrice.toFixed(2),
        rsi: ind.rsi != null ? +ind.rsi.toFixed(1) : null,
        adx: ind.adx?.adx != null ? +ind.adx.adx.toFixed(1) : null,
        bbPos: ind.bb?.position != null ? +ind.bb.position.toFixed(2) : null,
      });

      balHist.push({ time: win.startMs, balance: bal, tradeId });
    } else {
      trades.push({
        id: trades.length + 1,
        time: new Date(win.startMs + entryMinute * 60_000).toISOString(),
        windowStart: win.startMs,
        noEntry: true,
        skipReason: bal < maxBet ? "insufficient_balance" : (rec.reason || "no_edge"),
        side: null,
        actualOutcome: actualUp ? "UP" : "DOWN",
        modelUp: +blended.modelUp.toFixed(4), modelDown: +blended.modelDown.toFixed(4),
        confluence: scored.confluence,
        regime: ind.regime.regime,
        phase: rec.phase,
        priceSource,
        realResolution,
        btcStart: +startPrice.toFixed(2), btcEnd: +endPrice.toFixed(2), btcEntry: +entryPrice.toFixed(2),
      });
    }

    if (onProgress && wi % 50 === 0) {
      onProgress({ stage: "processing", completed: wi, total: windows.length });
    }
  }

  const totalTrades = trades.filter((t) => !t.noEntry).length;
  const wins = trades.filter((t) => !t.noEntry && t.correct).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? +(wins / totalTrades * 100).toFixed(1) : 0;
  const totalPnl = +(bal - bank).toFixed(2);
  const totalPnlPct = +((bal - bank) / bank * 100).toFixed(2);

  let peak = -Infinity, maxDD = 0;
  for (const p of balHist) { if (p.balance > peak) peak = p.balance; const dd = peak - p.balance; if (dd > maxDD) maxDD = dd; }

  const enteredTrades = trades.filter((t) => !t.noEntry);
  const grossWins = enteredTrades.filter((t) => t.correct).reduce((a, t) => a + t.pnl, 0);
  const grossLosses = Math.abs(enteredTrades.filter((t) => !t.correct).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? +(grossWins / grossLosses).toFixed(2) : grossWins > 0 ? Infinity : 0;

  let maxCW = 0, maxCL = 0, cw = 0, cl = 0;
  for (const t of enteredTrades) { if (t.correct) { cw++; cl = 0; } else { cl++; cw = 0; } if (cw > maxCW) maxCW = cw; if (cl > maxCL) maxCL = cl; }

  const avgWin = wins > 0 ? +(grossWins / wins).toFixed(2) : 0;
  const avgLoss = losses > 0 ? +(enteredTrades.filter((t) => !t.correct).reduce((a, t) => a + t.pnl, 0) / losses).toFixed(2) : 0;

  const byRegime = {}, bySide = { UP: { wins: 0, total: 0 }, DOWN: { wins: 0, total: 0 } }, byStrength = {};
  const byResolution = { UP: { wins: 0, total: 0, pnl: 0 }, DOWN: { wins: 0, total: 0, pnl: 0 }, unknown: { wins: 0, total: 0, pnl: 0 } };
  for (const t of enteredTrades) {
    if (!byRegime[t.regime]) byRegime[t.regime] = { wins: 0, total: 0 };
    byRegime[t.regime].total++; if (t.correct) byRegime[t.regime].wins++;
    bySide[t.side].total++; if (t.correct) bySide[t.side].wins++;
    const s = t.strength || "NONE";
    if (!byStrength[s]) byStrength[s] = { wins: 0, total: 0 };
    byStrength[s].total++; if (t.correct) byStrength[s].wins++;
    const settleKey = t.realResolution || t.actualOutcome;
    const rk = (settleKey === "UP" || settleKey === "DOWN") ? settleKey : "unknown";
    byResolution[rk].total++; if (t.correct) byResolution[rk].wins++; byResolution[rk].pnl += t.pnl;
  }

  const realTradeCount = enteredTrades.filter(t => t.priceSource === "real").length;
  const realCovPct = totalTrades > 0 ? +((realTradeCount / totalTrades) * 100).toFixed(1) : 0;
  const skippedWindows = trades.filter(t => t.noEntry).length;

  return {
    settings: { days, bank, maxBet, entryMinute, feeRate, marketMode, marketSensitivity, windowMinutes: winMin, weights: w, filters: f },
    stats: { totalTrades, wins, losses, winRate, totalPnl, totalPnlPct, finalBalance: bal,
      avgPnl: totalTrades > 0 ? +(totalPnl / totalTrades).toFixed(2) : 0,
      maxDrawdown: +maxDD.toFixed(2),
      bestTrade: enteredTrades.length ? Math.max(...enteredTrades.map((t) => t.pnl)) : 0,
      worstTrade: enteredTrades.length ? Math.min(...enteredTrades.map((t) => t.pnl)) : 0,
      profitFactor, maxConsecWins: maxCW, maxConsecLosses: maxCL, avgWin, avgLoss,
      realDataCoverage: realCovPct, realDataTrades: realTradeCount,
      skippedWindows, totalWindows: windows.length },
    breakdowns: { byRegime, bySide, byStrength, byResolution },
    balanceHistory: balHist, trades, totalWindows: windows.length, totalCandles: klines.length,
  };
}

// --- Momentum Scalp Backtest (with TP/SL) ---

async function runMomentumBacktest({
  days = 3, bank = 1000, maxBet = MIN_BET_USD, entryMinute = 5,
  feeRate = 0.02, tpPct = 0.12, slPct = 0.50,
  marketMode = "dynamic", marketSensitivity = 80,
  weights = {}, filters = {},
  saveToDb = false, strategyId = null, windowMinutes = 15,
}, onProgress) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const f = { ...DEFAULT_FILTERS, ...filters };
  const winMin = windowMinutes;

  const klines = await fetchAllKlines(days, onProgress);
  const windows = groupWindows(klines, winMin);
  const store = getStore();

  if (onProgress) onProgress({ stage: "computing", total: windows.length });

  let bal = bank;
  const trades = [];
  const balHist = [{ time: windows[0]?.startMs || Date.now(), balance: bal, tradeId: 0 }];

  let tpHits = 0, slHits = 0, resolvedWins = 0, resolvedLosses = 0;
  let totalHoldMinutes = 0;
  let realDataCount = 0;
  const minCandlesMom = winMin <= 5 ? 2 : 10;

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    if (win.candles.length < minCandlesMom) continue;

    const startPrice = win.candles[0].open;
    const endPrice = win.candles[win.candles.length - 1].close;
    const syntheticUp = endPrice >= startPrice;

    const polyMkt = getMarketByWindow(win.startMs, winMin);
    const realResolution = polyMkt?.resolution || null;
    const actualUp = realResolution ? realResolution === "UP" : syntheticUp;

    const entryCutoff = win.startMs + entryMinute * 60_000;
    const entryCandles = win.candles.filter((c) => c.openTime < entryCutoff);
    if (entryCandles.length < 1) continue;

    const entryPrice = entryCandles[entryCandles.length - 1].close;
    const hist = klines.filter((k) => k.openTime < entryCutoff);
    const recent = hist.slice(-240);
    if (recent.length < 50) continue;

    const closes = recent.map((c) => c.close);
    const ind = computeAllIndicators(recent, closes);

    const scored = scoreDirectionV2(ind, w, f);
    const remMin = winMin - entryMinute;
    const ta = applyTimeAwareness(scored.rawUp, remMin, winMin);

    let mUp, mDown, priceSource = "synthetic";
    const entrySec = Math.round(entryCutoff / 1000);
    const realEntry = polyMkt ? getPriceAtTime(polyMkt.slug, winMin, entrySec) : null;

    if (realEntry != null && realEntry > 0.01 && realEntry < 0.99) {
      mUp = realEntry;
      mDown = +(1 - realEntry).toFixed(4);
      priceSource = "real";
      realDataCount++;
    } else if (marketMode === "fixed") {
      mUp = 0.5; mDown = 0.5;
    } else {
      const earlyMove = (entryPrice - startPrice) / startPrice;
      mUp = clamp(0.5 + earlyMove * marketSensitivity, 0.25, 0.75);
      mDown = clamp(1 - mUp, 0.25, 0.75);
    }

    const rec = decideMomentumEntry({
      remainingMinutes: remMin,
      modelUp: ta.adjustedUp,
      modelDown: ta.adjustedDown,
      confluence: scored.confluence,
      filtered: scored.filtered,
      indicators: ind,
      windowMinutes: winMin,
      config: f,
    });

    if (rec.action === "ENTER" && bal >= maxBet) {
      const side = rec.side;
      const bPrice = side === "UP" ? mUp : mDown;
      const shares = maxBet / bPrice;

      const { tpPrice, slPrice } = computeTpSlPrices(bPrice, tpPct, slPct);

      const realPricePath = polyMkt ? getPricePath(
        polyMkt.slug, winMin,
        Math.round(entryCutoff / 1000),
        Math.round((win.startMs + winMin * 60_000) / 1000)
      ) : null;

      const simResult = simulateTpSlInWindow({
        entryPrice: bPrice,
        entryCandleIdx: entryCandles.length - 1,
        windowCandles: win.candles,
        side,
        tpPct,
        slPct,
        feeRate,
        realPricePath: priceSource === "real" ? realPricePath : null,
        realResolution,
      });

      const pnl = +(simResult.pnl * maxBet).toFixed(2);
      bal = +(bal + pnl).toFixed(2);
      const tradeId = trades.length + 1;

      let exitReason = simResult.exitReason;
      if (exitReason === "TP_HIT") tpHits++;
      else if (exitReason === "SL_HIT") slHits++;
      else if (exitReason === "RESOLVED_WIN") resolvedWins++;
      else resolvedLosses++;

      totalHoldMinutes += simResult.exitMinute;

      const btcHigh = Math.max(...win.candles.map(c => c.high));
      const btcLow = Math.min(...win.candles.map(c => c.low));

      trades.push({
        id: tradeId,
        time: new Date(win.startMs + entryMinute * 60_000).toISOString(),
        windowStart: win.startMs,
        side, buyPrice: +bPrice.toFixed(4), shares: +shares.toFixed(2), cost: maxBet,
        actualOutcome: actualUp ? "UP" : "DOWN",
        correct: (side === "UP" && actualUp) || (side === "DOWN" && !actualUp),
        pnl, balance: bal,
        priceSource,
        realResolution,
        realEntryPrice: priceSource === "real" ? +mUp.toFixed(4) : null,
        syntheticPnl: pnl,
        polymarketVolume: polyMkt?.volume || null,
        exitReason,
        exitPrice: simResult.exitPrice,
        exitMinute: simResult.exitMinute,
        tpPrice: +tpPrice.toFixed(4),
        slPrice: +slPrice.toFixed(4),
        modelUp: +ta.adjustedUp.toFixed(4), modelDown: +ta.adjustedDown.toFixed(4),
        marketUp: +mUp.toFixed(4), marketDown: +mDown.toFixed(4),
        regime: ind.regime.regime, strength: rec.strength, phase: rec.phase,
        confluence: scored.confluence,
        btcStart: +startPrice.toFixed(2), btcEnd: +endPrice.toFixed(2), btcEntry: +entryPrice.toFixed(2),
        btcHigh: +btcHigh.toFixed(2), btcLow: +btcLow.toFixed(2),
        rsi: ind.rsi != null ? +ind.rsi.toFixed(1) : null,
        adx: ind.adx?.adx != null ? +ind.adx.adx.toFixed(1) : null,
        bbPos: ind.bb?.position != null ? +ind.bb.position.toFixed(2) : null,
        atrRatio: ind.atrData?.ratio != null ? +ind.atrData.ratio.toFixed(2) : null,
      });

      balHist.push({ time: win.startMs, balance: bal, tradeId });
    } else {
      trades.push({
        id: trades.length + 1,
        time: new Date(win.startMs + entryMinute * 60_000).toISOString(),
        windowStart: win.startMs,
        noEntry: true,
        skipReason: bal < maxBet ? "insufficient_balance" : (rec.reason || "no_edge"),
        side: null,
        actualOutcome: actualUp ? "UP" : "DOWN",
        modelUp: +ta.adjustedUp.toFixed(4), modelDown: +ta.adjustedDown.toFixed(4),
        confluence: scored.confluence,
        regime: ind.regime.regime,
        phase: rec.phase,
        priceSource,
        realResolution,
        btcStart: +startPrice.toFixed(2), btcEnd: +endPrice.toFixed(2), btcEntry: +entryPrice.toFixed(2),
      });
    }

    if (onProgress && wi % 50 === 0) {
      onProgress({ stage: "processing", completed: wi, total: windows.length });
    }
  }

  const enteredTrades = trades.filter((t) => !t.noEntry);
  const skippedWindows = trades.filter(t => t.noEntry).length;
  const totalTrades = enteredTrades.length;
  const wins = enteredTrades.filter((t) => t.pnl > 0).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? +(wins / totalTrades * 100).toFixed(1) : 0;
  const totalPnl = +(bal - bank).toFixed(2);
  const totalPnlPct = +((bal - bank) / bank * 100).toFixed(2);

  let peak = -Infinity, maxDD = 0;
  for (const p of balHist) { if (p.balance > peak) peak = p.balance; const dd = peak - p.balance; if (dd > maxDD) maxDD = dd; }

  const grossWins = enteredTrades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLosses = Math.abs(enteredTrades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? +(grossWins / grossLosses).toFixed(2) : grossWins > 0 ? Infinity : 0;

  let maxCW = 0, maxCL = 0, cw = 0, cl = 0;
  for (const t of enteredTrades) { if (t.pnl > 0) { cw++; cl = 0; } else { cl++; cw = 0; } if (cw > maxCW) maxCW = cw; if (cl > maxCL) maxCL = cl; }

  const avgWin = wins > 0 ? +(grossWins / wins).toFixed(2) : 0;
  const avgLoss = losses > 0 ? +(enteredTrades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0) / losses).toFixed(2) : 0;

  const byRegime = {}, bySide = { UP: { wins: 0, total: 0 }, DOWN: { wins: 0, total: 0 } }, byStrength = {};
  const byExitType = { TP_HIT: { wins: 0, total: tpHits }, SL_HIT: { wins: 0, total: slHits }, RESOLVED_WIN: { wins: resolvedWins, total: resolvedWins }, RESOLVED_LOSS: { wins: 0, total: resolvedLosses } };
  const byResolution = { UP: { wins: 0, total: 0, pnl: 0 }, DOWN: { wins: 0, total: 0, pnl: 0 }, unknown: { wins: 0, total: 0, pnl: 0 } };
  for (const t of enteredTrades) {
    if (!byRegime[t.regime]) byRegime[t.regime] = { wins: 0, total: 0 };
    byRegime[t.regime].total++; if (t.pnl > 0) byRegime[t.regime].wins++;
    bySide[t.side].total++; if (t.pnl > 0) bySide[t.side].wins++;
    const s = t.strength || "NONE";
    if (!byStrength[s]) byStrength[s] = { wins: 0, total: 0 };
    byStrength[s].total++; if (t.pnl > 0) byStrength[s].wins++;
    const settleKey = t.realResolution || t.actualOutcome;
    const rk = (settleKey === "UP" || settleKey === "DOWN") ? settleKey : "unknown";
    byResolution[rk].total++; if (t.pnl > 0) byResolution[rk].wins++; byResolution[rk].pnl += t.pnl;
  }
  for (const t of enteredTrades) {
    if (t.exitReason === "TP_HIT") byExitType.TP_HIT.wins++;
  }

  const realTradeCount = enteredTrades.filter(t => t.priceSource === "real").length;
  const realCovPct = totalTrades > 0 ? +((realTradeCount / totalTrades) * 100).toFixed(1) : 0;

  const result = {
    strategy: "momentum_scalp",
    settings: { days, bank, maxBet, entryMinute, feeRate, tpPct, slPct, marketMode, marketSensitivity, windowMinutes: winMin, weights: w, filters: f },
    stats: {
      totalTrades, wins, losses, winRate, totalPnl, totalPnlPct, finalBalance: bal,
      avgPnl: totalTrades > 0 ? +(totalPnl / totalTrades).toFixed(2) : 0,
      maxDrawdown: +maxDD.toFixed(2),
      bestTrade: enteredTrades.length ? Math.max(...enteredTrades.map((t) => t.pnl)) : 0,
      worstTrade: enteredTrades.length ? Math.min(...enteredTrades.map((t) => t.pnl)) : 0,
      profitFactor, maxConsecWins: maxCW, maxConsecLosses: maxCL, avgWin, avgLoss,
      tpHits, slHits, resolvedWins, resolvedLosses,
      skippedWindows,
      avgHoldMinutes: totalTrades > 0 ? +(totalHoldMinutes / totalTrades).toFixed(1) : 0,
      realDataCoverage: realCovPct, realDataTrades: realTradeCount,
      totalWindows: windows.length,
    },
    breakdowns: { byRegime, bySide, byStrength, byExitType, byResolution },
    balanceHistory: balHist, trades, totalWindows: windows.length, totalCandles: klines.length,
  };

  if (saveToDb) {
    try {
      const run = await insertBacktestRun({
        strategy_id: strategyId,
        days, bank, max_bet: maxBet, entry_minute: entryMinute, fee_rate: feeRate,
        tp_pct: tpPct, sl_pct: slPct,
        market_mode: marketMode, market_sensitivity: marketSensitivity,
        weights: w, filters: f,
        total_trades: totalTrades, wins, losses, win_rate: winRate,
        total_pnl: totalPnl, total_pnl_pct: totalPnlPct, final_balance: bal,
        max_drawdown: +maxDD.toFixed(2), profit_factor: profitFactor,
        avg_win: avgWin, avg_loss: avgLoss,
        best_trade: result.stats.bestTrade, worst_trade: result.stats.worstTrade,
        max_consec_wins: maxCW, max_consec_losses: maxCL,
        tp_hits: tpHits, sl_hits: slHits, resolution_exits: resolvedWins + resolvedLosses,
        avg_hold_time_minutes: result.stats.avgHoldMinutes,
        breakdown_by_regime: byRegime, breakdown_by_side: bySide,
        breakdown_by_strength: byStrength, breakdown_by_exit_type: byExitType,
        balance_history: balHist,
        completed_at: new Date().toISOString(),
      });

      if (run) {
        const dbTrades = trades.map(t => ({
          run_id: run.id,
          trade_number: t.id,
          window_start: new Date(t.windowStart).toISOString(),
          side: t.side,
          entry_price: t.buyPrice,
          entry_cost: t.cost,
          exit_price: t.exitPrice,
          exit_reason: t.exitReason,
          tp_price: t.tpPrice,
          sl_price: t.slPrice,
          actual_outcome: t.actualOutcome,
          correct: t.correct,
          pnl: t.pnl,
          balance_after: t.balance,
          hold_time_minutes: t.exitMinute,
          model_up: t.modelUp, model_down: t.modelDown,
          market_up: t.marketUp, market_down: t.marketDown,
          confluence: t.confluence, regime: t.regime,
          strength: t.strength, phase: t.phase,
          btc_start: t.btcStart, btc_end: t.btcEnd, btc_entry: t.btcEntry,
          btc_high: t.btcHigh, btc_low: t.btcLow,
          rsi: t.rsi, adx: t.adx, bb_pos: t.bbPos, atr_ratio: t.atrRatio,
        }));
        await insertBacktestTrades(dbTrades);
        result.dbRunId = run.id;
        console.log(`[DB] Backtest saved: ${run.id} (${totalTrades} trades)`);
      }
    } catch (err) {
      console.error("[DB] Failed to save backtest:", err.message);
    }
  }

  return result;
}

// --- Dual Position Backtest (buy BOTH UP and DOWN, TP 5% each side) ---

async function runDualPositionBacktest({
  days = 3, bank = 1000, maxBet = MIN_BET_USD, entryMinute = 0,
  feeRate = 0.02, tpPct = 0.05,
  marketMode = "dynamic", marketSensitivity = 80,
  windowMinutes = 15,
}, onProgress) {
  const winMin = windowMinutes;

  const klines = await fetchAllKlines(days, onProgress);
  const windows = groupWindows(klines, winMin);
  const store = getStore();

  if (onProgress) onProgress({ stage: "computing", total: windows.length });

  let bal = bank;
  const trades = [];
  const balHist = [{ time: windows[0]?.startMs || Date.now(), balance: bal, tradeId: 0 }];

  let tpHitsUp = 0, tpHitsDown = 0, resolvedWins = 0, resolvedLosses = 0;
  let realDataCount = 0;
  const minCandlesDual = winMin <= 5 ? 2 : 3;
  const betPerSide = maxBet;
  const costPerMarket = betPerSide * 2;

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    if (win.candles.length < minCandlesDual) continue;

    const startPrice = win.candles[0].open;
    const endPrice = win.candles[win.candles.length - 1].close;
    const syntheticUp = endPrice >= startPrice;

    const polyMkt = getMarketByWindow(win.startMs, winMin);
    const realResolution = polyMkt?.resolution || null;
    const actualUp = realResolution ? realResolution === "UP" : syntheticUp;

    const entryCutoff = win.startMs + entryMinute * 60_000;
    const entryCandles = win.candles.filter((c) => c.openTime < entryCutoff);

    let mUp, mDown, priceSource = "synthetic";
    const entrySec = Math.round(entryCutoff / 1000);
    const realEntry = polyMkt ? getPriceAtTime(polyMkt.slug, winMin, entrySec) : null;

    if (realEntry != null && realEntry > 0.01 && realEntry < 0.99) {
      mUp = realEntry;
      mDown = +(1 - realEntry).toFixed(4);
      priceSource = "real";
      realDataCount++;
    } else if (marketMode === "fixed") {
      mUp = 0.5; mDown = 0.5;
    } else {
      const earlyMove = entryCandles.length > 0
        ? (entryCandles[entryCandles.length - 1].close - startPrice) / startPrice
        : 0;
      mUp = clamp(0.5 + earlyMove * marketSensitivity, 0.25, 0.75);
      mDown = clamp(1 - mUp, 0.25, 0.75);
    }

    if (bal < costPerMarket) {
      trades.push({
        id: trades.length + 1,
        time: new Date(win.startMs + entryMinute * 60_000).toISOString(),
        windowStart: win.startMs,
        noEntry: true,
        skipReason: "insufficient_balance",
        side: "DUAL",
        actualOutcome: actualUp ? "UP" : "DOWN",
        priceSource,
        realResolution,
        btcStart: +startPrice.toFixed(2), btcEnd: +endPrice.toFixed(2),
        btcEntry: entryCandles.length > 0 ? +entryCandles[entryCandles.length - 1].close.toFixed(2) : +startPrice.toFixed(2),
      });
      continue;
    }

    // Only enter when odds are near 50/50 (35-65%)
    if (mUp < 0.35 || mUp > 0.65 || mDown < 0.35 || mDown > 0.65) {
      trades.push({
        id: trades.length + 1,
        time: new Date(win.startMs + entryMinute * 60_000).toISOString(),
        windowStart: win.startMs,
        noEntry: true,
        skipReason: "odds_too_skewed",
        side: "DUAL",
        actualOutcome: actualUp ? "UP" : "DOWN",
        priceSource,
        realResolution,
        btcStart: +startPrice.toFixed(2), btcEnd: +endPrice.toFixed(2),
        btcEntry: entryCandles.length > 0 ? +entryCandles[entryCandles.length - 1].close.toFixed(2) : +startPrice.toFixed(2),
      });
      continue;
    }

    const upShares = betPerSide / mUp;
    const upTpPrice = Math.min(mUp * (1 + tpPct), 0.99);
    const downShares = betPerSide / mDown;
    const downTpPrice = Math.min(mDown * (1 + tpPct), 0.99);

    // Simulate price path to check for TP fills
    let upTpHit = false;
    let downTpHit = false;

    const realPricePath = polyMkt ? getPricePath(
      polyMkt.slug, winMin,
      Math.round(entryCutoff / 1000),
      Math.round((win.startMs + winMin * 60_000) / 1000)
    ) : null;

    if (realPricePath && realPricePath.length > 0) {
      for (const pt of realPricePath) {
        const pUp = pt.price;
        const pDown = +(1 - pUp).toFixed(4);
        if (!upTpHit && pUp >= upTpPrice) upTpHit = true;
        if (!downTpHit && pDown >= downTpPrice) downTpHit = true;
        if (upTpHit && downTpHit) break;
      }
    } else {
      // Simulate via candle volatility: if price swings ≥ tpPct of the entry, TP fires
      const candlesAfterEntry = win.candles.filter(c => c.openTime >= entryCutoff);
      for (const c of candlesAfterEntry) {
        const highMove = (c.high - startPrice) / startPrice;
        const lowMove = (startPrice - c.low) / startPrice;
        // UP TP hits when price goes up → UP probability increases
        if (!upTpHit && highMove >= tpPct * mUp) upTpHit = true;
        // DOWN TP hits when price goes down → DOWN probability increases
        if (!downTpHit && lowMove >= tpPct * mDown) downTpHit = true;
        if (upTpHit && downTpHit) break;
      }
    }

    // Calculate revenue for each side
    let upRevenue = 0;
    let downRevenue = 0;
    let upExitReason, downExitReason;

    if (upTpHit) {
      upRevenue = upShares * upTpPrice;
      upExitReason = "TP_HIT";
      tpHitsUp++;
    } else if (actualUp) {
      upRevenue = upShares * 1.0;
      upExitReason = "RESOLVED_WIN";
      resolvedWins++;
    } else {
      upRevenue = 0;
      upExitReason = "RESOLVED_LOSS";
      resolvedLosses++;
    }

    if (downTpHit) {
      downRevenue = downShares * downTpPrice;
      downExitReason = "TP_HIT";
      tpHitsDown++;
    } else if (!actualUp) {
      downRevenue = downShares * 1.0;
      downExitReason = "RESOLVED_WIN";
      resolvedWins++;
    } else {
      downRevenue = 0;
      downExitReason = "RESOLVED_LOSS";
      resolvedLosses++;
    }

    const grossRevenue = upRevenue + downRevenue;
    const fee = Math.max(0, grossRevenue - costPerMarket) * feeRate;
    const pnl = +(grossRevenue - costPerMarket - fee).toFixed(2);

    bal = +(bal + pnl).toFixed(2);
    const tradeId = trades.length + 1;

    const exitReason = upTpHit || downTpHit
      ? (upTpHit && downTpHit ? "BOTH_TP" : upTpHit ? "UP_TP" : "DOWN_TP")
      : (actualUp ? "RESOLVED_UP" : "RESOLVED_DOWN");

    trades.push({
      id: tradeId,
      time: new Date(win.startMs + entryMinute * 60_000).toISOString(),
      windowStart: win.startMs,
      side: "DUAL",
      buyPrice: +mUp.toFixed(4),
      shares: +(upShares + downShares).toFixed(2),
      cost: costPerMarket,
      actualOutcome: actualUp ? "UP" : "DOWN",
      correct: pnl > 0,
      pnl, balance: bal,
      priceSource,
      realResolution,
      realEntryPrice: priceSource === "real" ? +mUp.toFixed(4) : null,
      syntheticPnl: pnl,
      polymarketVolume: polyMkt?.volume || null,
      exitReason,
      upEntry: +mUp.toFixed(4), downEntry: +mDown.toFixed(4),
      upTpPrice: +upTpPrice.toFixed(4), downTpPrice: +downTpPrice.toFixed(4),
      upTpHit, downTpHit,
      upExitReason, downExitReason,
      upRevenue: +upRevenue.toFixed(2), downRevenue: +downRevenue.toFixed(2),
      modelUp: +mUp.toFixed(4), modelDown: +mDown.toFixed(4),
      marketUp: +mUp.toFixed(4), marketDown: +mDown.toFixed(4),
      regime: "N/A", strength: "DUAL", phase: "ENTRY",
      confluence: 0,
      btcStart: +startPrice.toFixed(2), btcEnd: +endPrice.toFixed(2),
      btcEntry: entryCandles.length > 0 ? +entryCandles[entryCandles.length - 1].close.toFixed(2) : +startPrice.toFixed(2),
    });

    balHist.push({ time: win.startMs, balance: bal, tradeId });

    if (onProgress && wi % 50 === 0) {
      onProgress({ stage: "processing", completed: wi, total: windows.length });
    }
  }

  const enteredTrades = trades.filter((t) => !t.noEntry);
  const skippedWindows = trades.filter(t => t.noEntry).length;
  const totalTrades = enteredTrades.length;
  const wins = enteredTrades.filter((t) => t.pnl > 0).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? +(wins / totalTrades * 100).toFixed(1) : 0;
  const totalPnl = +(bal - bank).toFixed(2);
  const totalPnlPct = +((bal - bank) / bank * 100).toFixed(2);

  let peak = -Infinity, maxDD = 0;
  for (const p of balHist) { if (p.balance > peak) peak = p.balance; const dd = peak - p.balance; if (dd > maxDD) maxDD = dd; }

  const grossWins = enteredTrades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLosses = Math.abs(enteredTrades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? +(grossWins / grossLosses).toFixed(2) : grossWins > 0 ? Infinity : 0;

  let maxCW = 0, maxCL = 0, cw = 0, cl = 0;
  for (const t of enteredTrades) { if (t.pnl > 0) { cw++; cl = 0; } else { cl++; cw = 0; } if (cw > maxCW) maxCW = cw; if (cl > maxCL) maxCL = cl; }

  const avgWin = wins > 0 ? +(grossWins / wins).toFixed(2) : 0;
  const avgLoss = losses > 0 ? +(enteredTrades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0) / losses).toFixed(2) : 0;

  const tpHits = tpHitsUp + tpHitsDown;
  const byRegime = { "N/A": { wins, total: totalTrades } };
  const bySide = { UP: { wins: 0, total: totalTrades }, DOWN: { wins: 0, total: totalTrades } };
  for (const t of enteredTrades) { if (t.pnl > 0) { bySide.UP.wins++; bySide.DOWN.wins++; } }
  const byStrength = { DUAL: { wins, total: totalTrades } };
  const byExitType = {};
  for (const t of enteredTrades) {
    if (!byExitType[t.exitReason]) byExitType[t.exitReason] = { wins: 0, total: 0 };
    byExitType[t.exitReason].total++;
    if (t.pnl > 0) byExitType[t.exitReason].wins++;
  }
  const byResolution = { UP: { wins: 0, total: 0, pnl: 0 }, DOWN: { wins: 0, total: 0, pnl: 0 }, unknown: { wins: 0, total: 0, pnl: 0 } };
  for (const t of enteredTrades) {
    const rk = (t.actualOutcome === "UP" || t.actualOutcome === "DOWN") ? t.actualOutcome : "unknown";
    byResolution[rk].total++; if (t.pnl > 0) byResolution[rk].wins++; byResolution[rk].pnl += t.pnl;
  }

  const realTradeCount = enteredTrades.filter(t => t.priceSource === "real").length;
  const realCovPct = totalTrades > 0 ? +((realTradeCount / totalTrades) * 100).toFixed(1) : 0;

  return {
    strategy: "dual_position",
    settings: { days, bank, maxBet, entryMinute, feeRate, tpPct, slPct: null, marketMode, marketSensitivity, windowMinutes: winMin },
    stats: {
      totalTrades, wins, losses, winRate, totalPnl, totalPnlPct, finalBalance: bal,
      avgPnl: totalTrades > 0 ? +(totalPnl / totalTrades).toFixed(2) : 0,
      maxDrawdown: +maxDD.toFixed(2),
      bestTrade: enteredTrades.length ? Math.max(...enteredTrades.map((t) => t.pnl)) : 0,
      worstTrade: enteredTrades.length ? Math.min(...enteredTrades.map((t) => t.pnl)) : 0,
      profitFactor, maxConsecWins: maxCW, maxConsecLosses: maxCL, avgWin, avgLoss,
      tpHits, tpHitsUp, tpHitsDown, resolvedWins, resolvedLosses,
      skippedWindows,
      realDataCoverage: realCovPct, realDataTrades: realTradeCount,
      totalWindows: windows.length,
    },
    breakdowns: { byRegime, bySide, byStrength, byExitType, byResolution },
    balanceHistory: balHist, trades, totalWindows: windows.length, totalCandles: klines.length,
  };
}

/** Optimizer SSE + localStorage stay small; UI only needs stats, settings, and a trade sample. */
const OPTIMIZER_TRADE_CAP = 60;

function pickOptimizerPayloadRows(results) {
  return results.map((r) => {
    const trades = r.trades || [];
    return {
      rank: r.rank,
      name: r.name,
      description: r.description,
      type: r.type,
      windowMinutes: r.windowMinutes,
      entryMinute: r.entryMinute,
      tpPct: r.tpPct,
      slPct: r.slPct,
      filters: r.filters,
      stats: r.stats,
      settings: r.settings,
      breakdowns: r.breakdowns,
      totalWindows: r.totalWindows,
      dbRunId: r.dbRunId || null,
      trades: trades.length > OPTIMIZER_TRADE_CAP ? trades.slice(-OPTIMIZER_TRADE_CAP) : trades,
    };
  });
}

// --- Live simulation state ---
const liveState = {
  running: false,
  bank: 1000,
  maxBet: MIN_BET_USD,
  feeRate: 0.02,
  tpPct: 0.12,
  slPct: 0.50,
  trades: [],
  balance: 1000,
  subscribers: new Set(),
  klines: [],
  currentWindow: null,
  weights: { ...DEFAULT_WEIGHTS },
  filters: { ...DEFAULT_FILTERS },
  windowMinutes: 15,
  entryMinute: 5,
  entryDecided: false,
  tradingMode: "paper",
  strategyMode: "momentum_scalp",
  strategyId: null,
  configName: null,
  strategyName: null,
  strategyDescription: null,
  strategyType: null,
  backtestStats: null,
  backtestTotalWindows: null,
  activeTrade: null,
  polymarket: {
    market: null,
    slug: null,
    question: null,
    upTokenId: null,
    downTokenId: null,
    upAsk: null,
    downAsk: null,
    upBid: null,
    downBid: null,
    upMid: null,
    downMid: null,
    spread: null,
    endDate: null,
    endMs: null,
  },
  pmPriceMissStreak: 0,
  lastBtcClose: null,
  dualPreOrdered: new Set(),
  dualNextMarket: null,
  /** Per-window audit for logging no-entry rows after resolution */
  windowAudit: null,
  /** Session tracking */
  sessionId: null,
  sessionStartedAt: null,
  sessionName: null,
};

// --- Session Management (DB-only) ---

function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildSessionSnapshot(label) {
  const wins = liveState.trades.filter(t => t.correct === true).length;
  const losses = liveState.trades.filter(t => t.correct === false).length;
  const totalPnl = +(liveState.balance - liveState.bank).toFixed(2);
  return {
    id: liveState.sessionId,
    name: label || liveState.sessionName || liveState.strategyName || "Unnamed Session",
    startedAt: liveState.sessionStartedAt,
    savedAt: new Date().toISOString(),
    bank: liveState.bank,
    balance: liveState.balance,
    totalPnl,
    maxBet: liveState.maxBet,
    feeRate: liveState.feeRate,
    tpPct: liveState.tpPct,
    slPct: liveState.slPct,
    tradingMode: liveState.tradingMode,
    strategyMode: liveState.strategyMode,
    strategyId: liveState.strategyId,
    configName: liveState.configName,
    strategyName: liveState.strategyName,
    strategyDescription: liveState.strategyDescription,
    strategyType: liveState.strategyType,
    backtestStats: liveState.backtestStats,
    backtestTotalWindows: liveState.backtestTotalWindows,
    windowMinutes: liveState.windowMinutes,
    entryMinute: liveState.entryMinute,
    marketSensitivity: liveState.marketSensitivity ?? 80,
    weights: liveState.weights,
    filters: liveState.filters,
    trades: liveState.trades,
    activeTrade: liveState.activeTrade,
    stats: { wins, losses, totalTrades: liveState.trades.length, totalPnl },
  };
}

async function saveSession(label) {
  if (!liveState.sessionId) return null;
  const snapshot = buildSessionSnapshot(label);
  try {
    const result = await upsertSession({
      id: snapshot.id,
      name: snapshot.name,
      started_at: snapshot.startedAt,
      saved_at: snapshot.savedAt,
      bank: snapshot.bank,
      balance: snapshot.balance,
      total_pnl: snapshot.totalPnl,
      trading_mode: snapshot.tradingMode,
      strategy_name: snapshot.strategyName,
      strategy_type: snapshot.strategyType,
      window_minutes: snapshot.windowMinutes,
      stats: snapshot.stats,
      snapshot: snapshot,
    });
    if (result) {
      console.log(`[SESSION] Saved to DB → ${liveState.sessionId} (balance=$${liveState.balance})`);
    } else {
      console.warn(`[SESSION] DB upsert returned null for ${liveState.sessionId}`);
    }
  } catch (err) {
    console.error("[SESSION] DB save failed:", err.message);
  }
  return snapshot;
}

let autoSaveInterval = null;

function startAutoSave() {
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(() => {
    if (liveState.running && liveState.sessionId) saveSession().catch(() => {});
  }, 60_000);
}

function stopAutoSave() {
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of liveState.subscribers) {
    try { res.write(msg); } catch { liveState.subscribers.delete(res); }
  }
}

function broadcastPolymarketSnapshot(extra = {}) {
  const pm = liveState.polymarket;
  broadcast({
    type: "pm_snapshot",
    windowMinutes: liveState.windowMinutes,
    polymarket: {
      slug: pm.slug,
      question: pm.question,
      upAsk: pm.upAsk,
      downAsk: pm.downAsk,
      upBid: pm.upBid,
      downBid: pm.downBid,
      upMid: pm.upMid,
      downMid: pm.downMid,
      spread: pm.spread,
      endDate: pm.endDate,
      connected: !!(pm.upTokenId && pm.downTokenId),
      pricesStale: !!(pm.upTokenId && pm.downTokenId && (pm.upAsk == null || pm.downAsk == null)),
      ...extra,
    },
  });
}

function withTimeout(promise, ms, label = "op") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

let tickInFlight = false;
let tickStartedAt = 0;
async function liveTick() {
  if (!liveState.running) return;
  if (tickInFlight) {
    if (Date.now() - tickStartedAt > 15000) {
      console.warn("[TICK] Force-resetting stuck tick lock");
      tickInFlight = false;
    } else return;
  }
  tickInFlight = true;
  tickStartedAt = Date.now();
  try {
    const tEnd = Date.now();
    const tStart = tEnd - 240 * 60_000;
    const wMinTick = liveState.windowMinutes;
    const [klRes, mktRes] = await Promise.allSettled([
      withTimeout(fetchKlinesWithRetry("BTCUSDT", "1m", tStart, tEnd), 8000, "klines"),
      withTimeout(discoverCurrentMarket(false, wMinTick), 8000, "market").catch((e) => { console.error("Market discovery:", e.message); return null; }),
    ]);

    const mktInfo = mktRes.status === "fulfilled" ? mktRes.value : null;
    if (mktInfo) {
      liveState.polymarket.market = mktInfo.market;
      liveState.polymarket.slug = mktInfo.slug;
      liveState.polymarket.question = mktInfo.question;
      liveState.polymarket.upTokenId = mktInfo.upTokenId;
      liveState.polymarket.downTokenId = mktInfo.downTokenId;
      liveState.polymarket.endDate = mktInfo.endDate;
      liveState.polymarket.endMs = mktInfo.endMs;
    }

    let prices = null;
    if (liveState.polymarket.upTokenId && liveState.polymarket.downTokenId) {
      prices = await withTimeout(fetchRealPrices(liveState.polymarket.upTokenId, liveState.polymarket.downTokenId), 8000, "prices").catch(e => { console.error("[TICK]", e.message); return null; });
      if (prices) {
        liveState.polymarket.upAsk = prices.upAsk;
        liveState.polymarket.downAsk = prices.downAsk;
        liveState.polymarket.upBid = prices.upBid;
        liveState.polymarket.downBid = prices.downBid;
        liveState.polymarket.upMid = prices.upMid;
        liveState.polymarket.downMid = prices.downMid;
        liveState.polymarket.spread = prices.spread;
      }

      const gotBook = prices?.upAsk != null && prices?.downAsk != null;
      if (!gotBook) {
        liveState.pmPriceMissStreak += 1;
        if (liveState.pmPriceMissStreak >= 3) {
          liveState.pmPriceMissStreak = 0;
          clearMarketCache();
          const mktFresh = await withTimeout(discoverCurrentMarket(true, liveState.windowMinutes), 8000, "rediscovery").catch(() => null);
          if (mktFresh) {
            liveState.polymarket.market = mktFresh.market;
            liveState.polymarket.slug = mktFresh.slug;
            liveState.polymarket.question = mktFresh.question;
            liveState.polymarket.upTokenId = mktFresh.upTokenId;
            liveState.polymarket.downTokenId = mktFresh.downTokenId;
            liveState.polymarket.endDate = mktFresh.endDate;
            liveState.polymarket.endMs = mktFresh.endMs;
            prices = await withTimeout(fetchRealPrices(mktFresh.upTokenId, mktFresh.downTokenId), 8000, "prices-retry").catch(() => null);
            if (prices) {
              liveState.polymarket.upAsk = prices.upAsk;
              liveState.polymarket.downAsk = prices.downAsk;
              liveState.polymarket.upBid = prices.upBid;
              liveState.polymarket.downBid = prices.downBid;
              liveState.polymarket.upMid = prices.upMid;
              liveState.polymarket.downMid = prices.downMid;
              liveState.polymarket.spread = prices.spread;
            }
          }
        }
      } else {
        liveState.pmPriceMissStreak = 0;
      }
    } else {
      liveState.pmPriceMissStreak = 0;
    }

    let batch;
    if (klRes.status === "fulfilled") {
      batch = klRes.value;
    } else {
      console.error("Binance klines:", klRes.reason?.message || klRes.reason);
      broadcastPolymarketSnapshot({ btcFeedOk: false });
      return;
    }
    if (!batch.length) {
      console.warn("[TICK] Empty kline batch, skipping");
      broadcastPolymarketSnapshot({ btcFeedOk: true });
      return;
    }

    liveState.klines = batch;
    const closes = batch.map((c) => c.close);
    const last = closes[closes.length - 1];
    liveState.lastBtcClose = last;

    const wMin = liveState.windowMinutes;
    const winMs = wMin * 60_000;
    const nowMs = Date.now();
    const pmSnap = {
      slug: liveState.polymarket.slug,
      endMs: liveState.polymarket.endMs,
    };
    const { windowStart, windowEnd } = resolveLiveWindowBounds(nowMs, wMin, pmSnap);
    const remainingMs = windowEnd - nowMs;
    const remainingMin = remainingMs / 60_000;

    const ind = computeAllIndicators(batch, closes);
    const scored = scoreDirectionV2(ind, liveState.weights, liveState.filters);
    const entryRemainingMin = Math.max(wMin - liveState.entryMinute, remainingMin);
    const ta = applyTimeAwareness(scored.rawUp, entryRemainingMin, wMin);

    const windowCandles = batch.filter((k) => k.openTime >= windowStart && k.openTime < windowEnd);
    const windowStartPrice = windowCandles.length ? windowCandles[0].open : null;
    const elapsedMin = (nowMs - windowStart) / 60_000;

    // --- TP/SL MONITORING for active trade(s) ---
    // For dual position: check ALL pending trades in current window
    const pendingLiveTrades = liveState.strategyType === "dual_position"
      ? liveState.trades.filter(t => t.pnl === null && !t.noEntry && t.side)
      : (liveState.activeTrade && liveState.activeTrade.pnl === null ? [liveState.activeTrade] : []);

    for (const at of pendingLiveTrades) {
      const currentSharePrice = at.side === "UP"
        ? (prices?.upBid ?? prices?.upMid ?? at.buyPrice)
        : (prices?.downBid ?? prices?.downMid ?? at.buyPrice);

      const tpSlResult = checkTpSl(at.buyPrice, currentSharePrice, liveState.tpPct, liveState.slPct);
      const unrealizedPct = (currentSharePrice - at.buyPrice) / at.buyPrice;

      insertPriceTick({
        trade_id: at.dbId || null,
        tick_time: new Date().toISOString(),
        btc_price: last,
        share_price: currentSharePrice,
        unrealized_pnl_pct: unrealizedPct,
      }).catch(() => {});

      if (tpSlResult) {
        const shares = at.cost / at.buyPrice;
        const grossPnl = (tpSlResult.exitPrice - at.buyPrice) * shares;
        const fee = tpSlResult.reason === "TP_HIT" ? grossPnl * liveState.feeRate : 0;
        at.pnl = +(grossPnl - fee).toFixed(2);
        at.exitPrice = tpSlResult.exitPrice;
        at.exitReason = tpSlResult.reason;
        at.exitTime = new Date().toISOString();
        at.holdMinutes = +((new Date(at.exitTime) - new Date(at.time)) / 60000).toFixed(3);
        at.btcEnd = +last.toFixed(2);
        at.correct = at.pnl > 0;
        liveState.balance = +(liveState.balance + at.pnl).toFixed(2);
        at.balance = liveState.balance;

        const exitTag = liveState.strategyType === "dual_position" ? `DUAL:${at.side}` : "TRADE";
        console.log(`[${exitTag}] >>> ${tpSlResult.reason} | exit@${tpSlResult.exitPrice.toFixed(4)} | pnl=$${at.pnl} (${(tpSlResult.pnlPct * 100).toFixed(1)}%) | balance=$${liveState.balance}`);
        broadcast({ type: "trade_exit", trade: at, balance: liveState.balance, reason: tpSlResult.reason });
        saveSession().catch(() => {});

        if (at.dbId) {
          updateTrade(at.dbId, {
            exit_price: at.exitPrice,
            exit_time: at.exitTime,
            exit_reason: at.exitReason,
            status: tpSlResult.reason,
            pnl: at.pnl,
            pnl_pct: tpSlResult.pnlPct,
            btc_price_at_exit: last,
            actual_outcome: null,
          }).catch(() => {});
        }

        // Clear activeTrade only when all dual trades are resolved
        if (liveState.strategyType !== "dual_position") {
          liveState.activeTrade = null;
        }
      } else {
        broadcast({
          type: "tp_sl_monitor",
          entryPrice: at.buyPrice,
          currentPrice: currentSharePrice,
          unrealizedPct: +(unrealizedPct * 100).toFixed(2),
          tpPrice: at.tpPrice,
          slPrice: at.slPrice,
          side: at.side,
        });
      }
    }

    // --- WINDOW CHANGE: resolve any trade that wasn't TP/SL'd ---
    if (liveState.currentWindow !== windowStart) {
      if (liveState.currentWindow !== null) {
        const prevCandles = batch.filter((k) => k.openTime >= liveState.currentWindow && k.openTime < liveState.currentWindow + winMs);
        if (prevCandles.length >= 2) {
          const pStart = prevCandles[0].open;
          const pEnd = prevCandles[prevCandles.length - 1].close;
          const actualUp = pEnd >= pStart;

          // Resolve ALL pending trades for the window (supports dual position with 2 trades)
          const pendingTrades = liveState.trades.filter((t) => t.windowStart === liveState.currentWindow && t.pnl === null && !t.noEntry && t.side);
          for (const pendingTrade of pendingTrades) {
            const correct = (pendingTrade.side === "UP" && actualUp) || (pendingTrade.side === "DOWN" && !actualUp);
            const shares = pendingTrade.cost / pendingTrade.buyPrice;
            if (correct) {
              const gp = shares - pendingTrade.cost;
              pendingTrade.pnl = +(gp - gp * liveState.feeRate).toFixed(2);
            } else {
              pendingTrade.pnl = -pendingTrade.cost;
            }
            pendingTrade.correct = correct;
            pendingTrade.actualOutcome = actualUp ? "UP" : "DOWN";
            pendingTrade.exitReason = correct ? "RESOLVED_WIN" : "RESOLVED_LOSS";
            pendingTrade.exitTime = new Date().toISOString();
            pendingTrade.exitPrice = correct ? 1.0 : 0.0;
            pendingTrade.holdMinutes = +((new Date(pendingTrade.exitTime) - new Date(pendingTrade.time)) / 60000).toFixed(3);
            pendingTrade.btcEnd = +pEnd.toFixed(2);
            liveState.balance = +(liveState.balance + pendingTrade.pnl).toFixed(2);
            pendingTrade.balance = liveState.balance;
            broadcast({ type: "trade_resolved", trade: pendingTrade, balance: liveState.balance });
          }
          if (pendingTrades.length > 0) {
            saveSession().catch(() => {});

            // Auto-claim winning positions on-chain for real trades
            if (liveState.tradingMode === "real" && correct) {
              setTimeout(async () => {
                console.log("[REDEEM] Auto-claiming winning position after window resolution…");
                try {
                  const r = await redeemWinningPositions();
                  console.log(`[REDEEM] Auto-claim: redeemed=${r.redeemed} failed=${r.failed ?? 0} ${r.error || ""}`);
                  broadcast({
                    type: "redeem_result",
                    redeemed: r.redeemed ?? 0,
                    failed: r.failed ?? 0,
                    needsMatic: r.needsMatic ?? false,
                    signerAddress: r.signerAddress,
                    maticBalance: r.maticBalance,
                    error: r.error,
                    results: r.results,
                  });
                } catch (e) {
                  console.error("[REDEEM] Auto-claim error:", e.message);
                  broadcast({ type: "redeem_result", redeemed: 0, failed: 1, error: e.message });
                }
              }, 8000); // wait 8s for market to fully settle on-chain
            }

            if (pendingTrade.dbId) {
              updateTrade(pendingTrade.dbId, {
                exit_price: correct ? 1.0 : 0.0,
                exit_time: new Date().toISOString(),
                exit_reason: pendingTrade.exitReason,
                status: "RESOLVED",
                pnl: pendingTrade.pnl,
                pnl_pct: pendingTrade.pnl / pendingTrade.cost,
                btc_price_at_exit: pEnd,
                btc_window_close: pEnd,
                actual_outcome: actualUp ? "UP" : "DOWN",
              }).catch(() => {});
            }

            if (liveState.activeTrade?.windowStart === liveState.currentWindow) {
              liveState.activeTrade = null;
            }
          }

          const hadRealEntry = liveState.trades.some((t) => t.windowStart === liveState.currentWindow && !t.noEntry && t.side);
          if (!hadRealEntry && prevCandles.length >= 2) {
            const auditSnap = liveState.windowAudit;
            const aUp = pEnd >= pStart;
            const hadEligible = !!auditSnap?.hadEligibleTick;
            const skipReason = hadEligible
              ? String(auditSnap.lastRecReason || auditSnap.lastRecAction || "NO_TRADE")
              : String(auditSnap?.lastGate || "never_eligible");
            const skippedRow = {
              id: liveState.trades.length + 1,
              time: new Date().toISOString(),
              windowStart: liveState.currentWindow,
              noEntry: true,
              side: null,
              skipReason,
              hadEligibleTick: hadEligible,
              modelLean: auditSnap?.leanSide ?? null,
              modelUp: auditSnap?.modelUp != null ? +Number(auditSnap.modelUp).toFixed(4) : null,
              modelDown: auditSnap?.modelDown != null ? +Number(auditSnap.modelDown).toFixed(4) : null,
              confluence: auditSnap?.confluence ?? null,
              phase: auditSnap?.phase ?? null,
              regime: auditSnap?.regime ?? null,
              filtered: auditSnap?.filtered ?? null,
              buyPrice: null,
              cost: null,
              actualOutcome: aUp ? "UP" : "DOWN",
              btcStart: +pStart.toFixed(2),
              btcEnd: +pEnd.toFixed(2),
              correct: null,
              pnl: null,
              exitPrice: null,
              exitReason: "NO_ENTRY_RESOLVED",
              exitTime: new Date().toISOString(),
              balance: liveState.balance,
              tradingMode: liveState.tradingMode,
            };
            liveState.trades.push(skippedRow);
            console.log(`[SKIP→RESOLVED] window ${new Date(liveState.currentWindow).toISOString()} | BTC ${aUp ? "UP" : "DOWN"} | ${skipReason}`);
            broadcast({ type: "trade_skipped_resolved", trade: skippedRow, balance: liveState.balance });
          }
        }
      }
      liveState.currentWindow = windowStart;
      // If we pre-ordered for this window, skip normal entry
      const hasPreOrder = liveState.trades.some(t => t.preOrdered && t.windowStart === windowStart && t.pnl === null);
      liveState.entryDecided = hasPreOrder;
      if (hasPreOrder) {
        console.log(`[DUAL] Window ${new Date(windowStart).toISOString()} — pre-ordered trades active, skipping normal entry`);
      }
      liveState.windowAudit = {
        windowStart,
        lastGate: null,
        hadEligibleTick: false,
      };
    }

    // --- ENTRY DECISION ---
    let rec;
    if (liveState.strategyType === "resolution") {
      const priorW = liveState.filters.resolutionPriorWeight ?? 0.30;
      const effPriorW = clamp(priorW, 0, 0.85);
      const blended = blendResolutionSettlementPrior(
        ta.adjustedUp, ta.adjustedDown,
        last, windowStartPrice ?? last,
        liveState.marketSensitivity, effPriorW,
      );
      rec = decideV2({
        remainingMinutes: remainingMin,
        modelUp: blended.modelUp,
        modelDown: blended.modelDown,
        confluence: scored.confluence,
        filtered: scored.filtered,
        minProbOverride: liveState.filters.minProb || null,
      });
    } else {
      rec = decideMomentumEntry({
        remainingMinutes: remainingMin,
        modelUp: ta.adjustedUp,
        modelDown: ta.adjustedDown,
        confluence: scored.confluence,
        filtered: scored.filtered,
        indicators: ind,
        windowMinutes: wMin,
        config: liveState.filters,
      });
    }

    const minRemaining = liveState.strategyType === "resolution" ? 0 : (wMin <= 5 ? 0.5 : 1.5);
    const canEnter = !liveState.entryDecided
      && !liveState.activeTrade
      && elapsedMin >= liveState.entryMinute
      && remainingMin > minRemaining
      && liveState.balance >= liveState.maxBet;

    let entryGate = "ok";
    if (!canEnter) {
      if (liveState.entryDecided) entryGate = "already_decided_this_window";
      else if (liveState.activeTrade) entryGate = "active_trade";
      else if (liveState.balance < liveState.maxBet) entryGate = "low_balance";
      else if (elapsedMin < liveState.entryMinute) entryGate = "before_entry_minute";
      else if (remainingMin <= minRemaining) entryGate = "past_time_cutoff";
      else entryGate = "blocked";
    }

    const decisionReason = rec.reason != null ? rec.reason : null;

    if (!canEnter && !liveState.activeTrade && elapsedMin < liveState.entryMinute) {
      if (Math.round(elapsedMin * 10) % 100 === 0) console.log(`[WAIT] Window ${new Date(windowStart).toISOString()} | elapsed=${elapsedMin.toFixed(1)}m | waiting for entry min ${liveState.entryMinute}`);
    }
    const liveTag = liveState.strategyType === "resolution" ? "SNIPER" : liveState.strategyType === "dual_position" ? "DUAL" : "SCALP";

    // --- DUAL POSITION: enter both sides immediately (only near 50/50 odds) ---
    if (liveState.strategyType === "dual_position" && canEnter) {
      const mUp = prices?.upAsk ?? 0.5;
      const mDown = prices?.downAsk ?? 0.5;

      if (mUp < 0.35 || mUp > 0.65 || mDown < 0.35 || mDown > 0.65) {
        if (!liveState.entryDecided) {
          console.log(`[DUAL] Skipping — odds too skewed: UP ${(mUp*100).toFixed(0)}¢ / DOWN ${(mDown*100).toFixed(0)}¢ (need 35-65¢)`);
          broadcast({ type: "dual_skip", reason: "odds_too_skewed", upPrice: mUp, downPrice: mDown });
        }
      } else {
      liveState.entryDecided = true;
      const dualTpPct = liveState.tpPct ?? 0.05;
      const betPerSide = liveState.maxBet;

      for (const dualSide of ["UP", "DOWN"]) {
        const bPrice = dualSide === "UP" ? mUp : mDown;
        const tpPrice = +(Math.min(bPrice * (1 + dualTpPct), 0.99)).toFixed(4);
        const tradeTokenId = dualSide === "UP" ? liveState.polymarket.upTokenId : liveState.polymarket.downTokenId;

        const trade = {
          id: liveState.trades.length + 1,
          time: new Date().toISOString(),
          windowStart,
          side: dualSide,
          buyPrice: +bPrice.toFixed(4),
          cost: betPerSide,
          tpPrice,
          slPrice: null,
          tokenId: tradeTokenId || null,
          actualOutcome: null, correct: null, pnl: null,
          exitPrice: null, exitReason: null, exitTime: null, balance: null,
          modelUp: +mUp.toFixed(4), modelDown: +mDown.toFixed(4),
          marketUp: +mUp.toFixed(4), marketDown: +mDown.toFixed(4),
          btcStart: windowStartPrice ? +windowStartPrice.toFixed(2) : +last.toFixed(2),
          btcEnd: null,
          confluence: 0, regime: ind.regime.regime, strength: "DUAL", phase: "ENTRY",
          tradingMode: liveState.tradingMode, dbId: null,
        };

        liveState.trades.push(trade);
        broadcast({ type: "trade_entered", trade, tpPrice, slPrice: null });
        console.log(`[DUAL] >>> ENTERED ${dualSide} @ ${bPrice.toFixed(4)} | TP=${tpPrice} | cost=$${betPerSide} | mode=${liveState.tradingMode}`);

        if (liveState.tradingMode === "real" && tradeTokenId) {
          const rawSize = betPerSide / bPrice;
          const orderSize = Math.max(5, Math.floor(rawSize * 10000) / 10000);
          (async () => {
            try {
              // Step 1: Place buy order
              const orderResult = await placeBuyOrder({ tokenId: tradeTokenId, price: bPrice, size: orderSize });
              console.log(`[DUAL] Real BUY ${dualSide}: ${orderResult.ok ? "OK" : "FAILED"} — ${JSON.stringify(orderResult)}`);
              broadcast({ type: "real_order", trade, orderResult });

              // Step 2: Immediately place TP sell order if buy succeeded
              if (orderResult.ok) {
                const sellResult = await placeSellOrder({ tokenId: tradeTokenId, price: tpPrice, size: orderSize });
                trade.realTpOrderId = sellResult?.order?.orderID || null;
                console.log(`[DUAL] TP SELL ${dualSide} @ ${(tpPrice*100).toFixed(2)}¢: ${sellResult.ok ? "OK" : "FAILED"} — ${JSON.stringify(sellResult)}`);
                broadcast({ type: "real_sell_order", trade, sellResult, reason: "TP_ORDER" });
              }
            } catch (err) {
              console.error(`[DUAL] Real order error ${dualSide}:`, err.message);
            }
          })();
        }
      }

      // For dual, we track the last entered trade as active for UI
      liveState.activeTrade = liveState.trades[liveState.trades.length - 1];
      liveState.balance = +(liveState.balance - betPerSide * 2).toFixed(2);
      } // close else (odds OK)
    }

    // --- DUAL PRE-ORDER: discover & order on NEXT market before it opens ---
    if (liveState.strategyType === "dual_position" && remainingMin < 2 && liveState.balance >= liveState.maxBet * 2) {
      try {
        const nextMkt = await withTimeout(discoverNextMarket(wMin), 8000, "next-market").catch(() => null);
        if (nextMkt && nextMkt.slug && !liveState.dualPreOrdered.has(nextMkt.slug)) {
          const nextPrices = await withTimeout(fetchRealPrices(nextMkt.upTokenId, nextMkt.downTokenId), 8000, "next-prices").catch(() => null);
          const nUp = nextPrices?.upAsk ?? 0.5;
          const nDown = nextPrices?.downAsk ?? 0.5;
          const startsInSec = Math.round((nextMkt.effectiveStartMs - Date.now()) / 1000);

          if (nUp < 0.35 || nUp > 0.65 || nDown < 0.35 || nDown > 0.65) {
            console.log(`[DUAL PRE-ORDER] Next market ${nextMkt.slug} odds skewed: UP ${(nUp*100).toFixed(0)}¢ / DOWN ${(nDown*100).toFixed(0)}¢ — skipping pre-order`);
            broadcast({ type: "dual_preorder_skip", slug: nextMkt.slug, upPrice: nUp, downPrice: nDown, startsInSec });
          } else {
            liveState.dualPreOrdered.add(nextMkt.slug);
            liveState.dualNextMarket = nextMkt;
            const dualTpPct = liveState.tpPct ?? 0.05;
            const betPerSide = liveState.maxBet;

            console.log(`[DUAL PRE-ORDER] Placing orders on NEXT market: ${nextMkt.slug} (starts in ${startsInSec}s) UP=${(nUp*100).toFixed(1)}¢ DOWN=${(nDown*100).toFixed(1)}¢`);
            broadcast({ type: "dual_preorder_start", slug: nextMkt.slug, startsInSec, upPrice: nUp, downPrice: nDown });

            for (const dualSide of ["UP", "DOWN"]) {
              const bPrice = dualSide === "UP" ? nUp : nDown;
              const tpPrice = +(Math.min(bPrice * (1 + dualTpPct), 0.99)).toFixed(4);
              const tradeTokenId = dualSide === "UP" ? nextMkt.upTokenId : nextMkt.downTokenId;

              const trade = {
                id: liveState.trades.length + 1,
                time: new Date().toISOString(),
                windowStart: nextMkt.effectiveStartMs,
                side: dualSide,
                buyPrice: +bPrice.toFixed(4),
                cost: betPerSide,
                tpPrice,
                slPrice: null,
                tokenId: tradeTokenId || null,
                actualOutcome: null, correct: null, pnl: null,
                exitPrice: null, exitReason: null, exitTime: null, balance: null,
                modelUp: +nUp.toFixed(4), modelDown: +nDown.toFixed(4),
                marketUp: +nUp.toFixed(4), marketDown: +nDown.toFixed(4),
                btcStart: +last.toFixed(2),
                btcEnd: null,
                confluence: 0, regime: ind.regime?.regime ?? "UNKNOWN", strength: "DUAL", phase: "PRE-ORDER",
                tradingMode: liveState.tradingMode, dbId: null,
                preOrdered: true,
                preOrderSlug: nextMkt.slug,
              };

              liveState.trades.push(trade);
              broadcast({ type: "trade_entered", trade, tpPrice, slPrice: null, preOrdered: true });
              console.log(`[DUAL PRE-ORDER] >>> ${dualSide} @ ${bPrice.toFixed(4)} | TP=${tpPrice} | cost=$${betPerSide} | starts in ${startsInSec}s`);

              if (liveState.tradingMode === "real" && tradeTokenId) {
                const rawSize = betPerSide / bPrice;
                const orderSize = Math.max(5, Math.floor(rawSize * 10000) / 10000);
                (async () => {
                  try {
                    const orderResult = await placeBuyOrder({ tokenId: tradeTokenId, price: bPrice, size: orderSize });
                    console.log(`[DUAL PRE-ORDER] Real BUY ${dualSide}: ${orderResult.ok ? "OK" : "FAILED"} — ${JSON.stringify(orderResult)}`);
                    broadcast({ type: "real_order", trade, orderResult, preOrdered: true });
                    if (orderResult.ok) {
                      const sellResult = await placeSellOrder({ tokenId: tradeTokenId, price: tpPrice, size: orderSize });
                      trade.realTpOrderId = sellResult?.order?.orderID || null;
                      console.log(`[DUAL PRE-ORDER] TP SELL ${dualSide} @ ${(tpPrice*100).toFixed(2)}¢: ${sellResult.ok ? "OK" : "FAILED"} — ${JSON.stringify(sellResult)}`);
                      broadcast({ type: "real_sell_order", trade, sellResult, reason: "TP_ORDER", preOrdered: true });
                    }
                  } catch (err) {
                    console.error(`[DUAL PRE-ORDER] Order error ${dualSide}:`, err.message);
                  }
                })();
              }
            }

            liveState.entryDecided = true;
            liveState.balance = +(liveState.balance - betPerSide * 2).toFixed(2);
            console.log(`[DUAL PRE-ORDER] Orders placed for ${nextMkt.slug}. Balance: $${liveState.balance}`);
          }
        }
      } catch (err) {
        console.error("[DUAL PRE-ORDER] Error:", err.message);
      }
    }

    if (liveState.strategyType !== "dual_position" && canEnter) {
      console.log(`[${liveTag}] Window ${new Date(windowStart).toISOString()} | elapsed=${elapsedMin.toFixed(1)}m rem=${remainingMin.toFixed(1)}m | action=${rec.action} | reason=${decisionReason ?? "—"} | side=${rec.side} | strength=${rec.strength} | conf=${scored.confluence} | filtered=${scored.filtered || "none"} | modelUp=${ta.adjustedUp.toFixed(3)} modelDown=${ta.adjustedDown.toFixed(3)}`);

      if (rec.action === "ENTER") {
        liveState.entryDecided = true;
        const mUp = prices?.upAsk ?? 0.5;
        const mDown = prices?.downAsk ?? 0.5;
        const bPrice = rec.side === "UP" ? mUp : mDown;
        const { tpPrice, slPrice } = computeTpSlPrices(bPrice, liveState.tpPct, liveState.slPct);

        const tradeTokenId = rec.side === "UP" ? liveState.polymarket.upTokenId : liveState.polymarket.downTokenId;
        const trade = {
          id: liveState.trades.length + 1,
          time: new Date().toISOString(),
          windowStart,
          side: rec.side,
          buyPrice: +bPrice.toFixed(4),
          cost: liveState.maxBet,
          tpPrice,
          slPrice,
          tokenId: tradeTokenId || null,
          actualOutcome: null,
          correct: null,
          pnl: null,
          exitPrice: null,
          exitReason: null,
          exitTime: null,
          balance: null,
          modelUp: +ta.adjustedUp.toFixed(4),
          modelDown: +ta.adjustedDown.toFixed(4),
          marketUp: mUp != null ? +mUp.toFixed(4) : null,
          marketDown: mDown != null ? +mDown.toFixed(4) : null,
          btcStart: windowStartPrice ? +windowStartPrice.toFixed(2) : +last.toFixed(2),
          btcEnd: null,
          confluence: scored.confluence,
          regime: ind.regime.regime,
          strength: rec.strength,
          phase: rec.phase,
          tradingMode: liveState.tradingMode,
          dbId: null,
        };

        liveState.trades.push(trade);
        liveState.activeTrade = trade;
        broadcast({ type: "trade_entered", trade, tpPrice, slPrice });
        console.log(`[${liveTag}] >>> ENTERED ${rec.side} @ ${bPrice.toFixed(4)} | TP=${tpPrice} SL=${slPrice} | cost=$${liveState.maxBet} | mode=${liveState.tradingMode}`);

        const tradeRecord = buildTradeRecord({
          strategyId: liveState.strategyId,
          side: rec.side,
          entryPrice: bPrice,
          cost: liveState.maxBet,
          tpPct: liveState.tpPct,
          slPct: liveState.slPct,
          windowStart,
          windowEnd,
          windowMinutes: wMin,
          tokenId: rec.side === "UP" ? liveState.polymarket.upTokenId : liveState.polymarket.downTokenId,
          marketSlug: liveState.polymarket.slug,
          marketQuestion: liveState.polymarket.question,
          btcPrice: last,
          btcWindowOpen: windowStartPrice,
          prices,
          modelUp: ta.adjustedUp,
          modelDown: ta.adjustedDown,
          confluence: scored.confluence,
          regime: ind.regime.regime,
          strength: rec.strength,
          phase: rec.phase,
          tradingMode: liveState.tradingMode,
        });

        insertTrade(tradeRecord).then((dbRow) => {
          if (dbRow) {
            trade.dbId = dbRow.id;
            const signals = buildTradeSignals(dbRow.id, ind, scored, ta);
            insertTradeSignals(signals).catch(() => {});
          }
        }).catch(() => {});

        if (liveState.tradingMode === "real" && (wMin === 15 || wMin === 5)) {
          if (tradeTokenId) {
            const rawSize = liveState.maxBet / bPrice;
            // CLOB minimum is 5 shares; if maxBet can't buy 5 shares, we still use 5 (slight overrun)
            const orderSize = Math.max(5, Math.floor(rawSize * 10000) / 10000);
            const actualCost = +(orderSize * bPrice).toFixed(4);
            if (actualCost > liveState.maxBet * 3) {
              console.warn(`[${liveTag}] Order would cost $${actualCost} (maxBet=$${liveState.maxBet}) — skipping to protect budget`);
              broadcast({ type: "real_order", trade, orderResult: { ok: false, error: `Min order cost $${actualCost.toFixed(2)} exceeds maxBet ($${liveState.maxBet}). Raise maxBet or wait for lower price.` } });
            } else {
              if (actualCost > liveState.maxBet) console.warn(`[${liveTag}] Spending $${actualCost} (CLOB min 5 shares) > maxBet $${liveState.maxBet}`);
              const orderResult = await placeBuyOrder({
                tokenId: tradeTokenId,
                price: bPrice,
                size: orderSize,
                negRisk: liveState.polymarket.negRisk ?? false,
              });
              trade.realOrder = orderResult;
              trade.realOrderId = orderResult?.order?.orderID || null;
              console.log(`[${liveTag}] Real buy result (size=${orderSize}, cost=$${actualCost}):`, JSON.stringify(orderResult));
              broadcast({ type: "real_order", trade, orderResult });
            }
          }
        }
      }
    }

    if (!liveState.windowAudit || liveState.windowAudit.windowStart !== windowStart) {
      liveState.windowAudit = {
        windowStart,
        lastGate: null,
        hadEligibleTick: false,
      };
    }
    liveState.windowAudit.lastGate = entryGate;
    if (canEnter) {
      liveState.windowAudit.hadEligibleTick = true;
      liveState.windowAudit.lastRecAction = rec.action;
      liveState.windowAudit.lastRecReason = rec.reason ?? null;
      liveState.windowAudit.modelUp = ta.adjustedUp;
      liveState.windowAudit.modelDown = ta.adjustedDown;
      liveState.windowAudit.leanSide = ta.adjustedUp >= ta.adjustedDown ? "UP" : "DOWN";
      liveState.windowAudit.confluence = scored.confluence;
      liveState.windowAudit.filtered = scored.filtered || null;
      liveState.windowAudit.phase = rec.phase;
      liveState.windowAudit.regime = ind.regime.regime;
    }

    insertMarketSnapshot({
      market_slug: liveState.polymarket.slug || "btc-15m",
      window_start: new Date(windowStart).toISOString(),
      window_minutes: wMin,
      snapshot_time: new Date().toISOString(),
      btc_price: last,
      btc_window_open: windowStartPrice,
      btc_change_pct: windowStartPrice ? ((last - windowStartPrice) / windowStartPrice * 100) : null,
      up_ask: prices?.upAsk, up_bid: prices?.upBid,
      down_ask: prices?.downAsk, down_bid: prices?.downBid,
      up_mid: prices?.upMid, down_mid: prices?.downMid,
      spread: prices?.spread,
      indicators: {
        rsi: ind.rsi, vwapDist: ind.vwap ? ((ind.price - ind.vwap) / ind.vwap * 100) : null,
        macdHist: ind.macd?.hist, bbPos: ind.bb?.position, adx: ind.adx?.adx,
        stochK: ind.stochRsi?.k, atrRatio: ind.atrData?.ratio, regime: ind.regime.regime,
      },
      model_up: ta.adjustedUp, model_down: ta.adjustedDown,
      confluence: scored.confluence, regime: ind.regime.regime,
      action: rec.action, side: rec.side, strength: rec.strength,
    }).catch(() => {});

    const pm = liveState.polymarket;
    const at = liveState.activeTrade;
    broadcast({
      type: "tick",
      price: +last.toFixed(2),
      windowStart,
      windowEnd,
      remainingMin: +remainingMin.toFixed(2),
      modelUp: +ta.adjustedUp.toFixed(4),
      modelDown: +ta.adjustedDown.toFixed(4),
      confluence: scored.confluence,
      filtered: scored.filtered,
      action: rec.action,
      side: rec.side,
      strength: rec.strength,
      phase: rec.phase,
      balance: liveState.balance,
      tradingMode: liveState.tradingMode,
      strategyMode: liveState.strategyMode,
      configName: liveState.configName,
      windowMinutes: liveState.windowMinutes,
      entryMinute: liveState.entryMinute,
      elapsedMin: +elapsedMin.toFixed(1),
      entryDecided: liveState.entryDecided,
      canEnter,
      entryGate,
      decisionReason,
      tpPct: liveState.tpPct,
      slPct: liveState.slPct,
      activeTrade: at ? {
        side: at.side, entryPrice: at.buyPrice, tpPrice: at.tpPrice, slPrice: at.slPrice,
      } : null,
      totalTrades: liveState.trades.length,
      wins: liveState.trades.filter((t) => t.pnl > 0).length,
      losses: liveState.trades.filter((t) => t.pnl != null && t.pnl <= 0).length,
      tpHits: liveState.trades.filter((t) => t.exitReason === "TP_HIT").length,
      slHits: liveState.trades.filter((t) => t.exitReason === "SL_HIT").length,
      polymarket: {
        slug: pm.slug,
        question: pm.question,
        upAsk: pm.upAsk,
        downAsk: pm.downAsk,
        upBid: pm.upBid,
        downBid: pm.downBid,
        upMid: pm.upMid,
        downMid: pm.downMid,
        spread: pm.spread,
        endDate: pm.endDate,
        connected: !!(pm.upTokenId && pm.downTokenId),
        pricesStale: !!(pm.upTokenId && pm.downTokenId && (pm.upAsk == null || pm.downAsk == null)),
        btcFeedOk: true,
      },
      indicators: {
        rsi: ind.rsi != null ? +ind.rsi.toFixed(1) : null,
        vwapDist: ind.vwap ? +(((ind.price - ind.vwap) / ind.vwap) * 100).toFixed(3) : null,
        macdHist: ind.macd?.hist != null ? +ind.macd.hist.toFixed(4) : null,
        bbPos: ind.bb?.position != null ? +ind.bb.position.toFixed(2) : null,
        adx: ind.adx?.adx != null ? +ind.adx.adx.toFixed(1) : null,
        stochK: ind.stochRsi?.k != null ? +ind.stochRsi.k.toFixed(1) : null,
        obvBullish: ind.obvSignal?.bullish ?? null,
        atrRatio: ind.atrData?.ratio != null ? +ind.atrData.ratio.toFixed(2) : null,
        emaBullish: ind.emaCross?.bullish ?? null,
        regime: ind.regime.regime,
      },
    });
  } catch (err) {
    console.error("[TICK ERROR]", err.message, err.stack?.split('\n')[1]?.trim());
    broadcast({ type: "error", message: err.message });
  } finally {
    tickInFlight = false;
  }
}

let liveInterval = null;

async function startLive(config) {
  // --- Resume from saved session ---
  if (config.resumeSessionId) {
    let saved = null;
    try {
      const row = await getSession(config.resumeSessionId);
      if (row?.snapshot) saved = row.snapshot;
    } catch {}
    if (saved) {
      console.log(`[SESSION] Resuming session ${config.resumeSessionId} — balance=$${saved.balance}`);
      liveState.sessionId = saved.id;
      liveState.sessionName = saved.name;
      liveState.sessionStartedAt = saved.startedAt;
      liveState.bank = saved.bank;
      liveState.balance = saved.balance;
      liveState.maxBet = Math.max(MIN_BET_USD, saved.maxBet ?? MIN_BET_USD);
      liveState.feeRate = saved.feeRate ?? 0.02;
      liveState.tpPct = saved.tpPct ?? STRATEGY_DEFAULTS.tpPct;
      liveState.slPct = saved.slPct ?? STRATEGY_DEFAULTS.slPct;
      liveState.tradingMode = saved.tradingMode || "paper";
      liveState.strategyMode = saved.strategyMode || "momentum_scalp";
      liveState.strategyId = saved.strategyId || null;
      liveState.configName = saved.configName || null;
      liveState.strategyName = saved.strategyName || null;
      liveState.strategyDescription = saved.strategyDescription || null;
      liveState.strategyType = saved.strategyType || null;
      liveState.backtestStats = saved.backtestStats || null;
      liveState.backtestTotalWindows = saved.backtestTotalWindows || null;
      liveState.windowMinutes = saved.windowMinutes || 15;
      liveState.entryMinute = saved.entryMinute ?? (liveState.windowMinutes <= 5 ? 2 : 5);
      liveState.trades = Array.isArray(saved.trades) ? saved.trades : [];
      liveState.activeTrade = null;
      liveState.currentWindow = null;
      liveState.entryDecided = false;
      liveState.dualPreOrdered = new Set();
      liveState.dualNextMarket = null;
      liveState.windowAudit = null;
      liveState.weights = { ...DEFAULT_WEIGHTS, ...(saved.weights || {}) };
      liveState.filters = { ...DEFAULT_FILTERS, ...(saved.filters || {}) };
      liveState.marketSensitivity = saved.marketSensitivity ?? 80;
      liveState.running = true;
      clearMarketCache();
      liveState.pmPriceMissStreak = 0;
      liveState.lastBtcClose = null;
      if (liveInterval) clearInterval(liveInterval);
      startAutoSave();
      liveTick();
      liveInterval = setInterval(liveTick, 1_000);
      return;
    }
    console.warn(`[SESSION] Resume failed — session file not found: ${config.resumeSessionId}`);
  }

  // --- Fresh start ---
  liveState.bank = config.bank || 1000;
  liveState.balance = config.bank || 1000;
  liveState.maxBet = Math.max(MIN_BET_USD, config.maxBet ?? MIN_BET_USD);
  liveState.feeRate = config.feeRate || 0.02;
  const isResolution = config.strategyType === "resolution";
  const isDualPosition = config.strategyType === "dual_position";
  liveState.tpPct = isResolution ? null : (config.tpPct ?? STRATEGY_DEFAULTS.tpPct);
  liveState.slPct = (isResolution || isDualPosition) ? null : (config.slPct ?? STRATEGY_DEFAULTS.slPct);
  liveState.tradingMode = config.tradingMode || "paper";
  liveState.strategyMode = config.strategyMode || "momentum_scalp";
  liveState.configName = config.configName || null;
  liveState.strategyName = config.strategyName || null;
  liveState.strategyDescription = config.strategyDescription || null;
  liveState.strategyType = config.strategyType || null;
  liveState.backtestStats = config.backtestStats || null;
  const twCfg = config.totalWindows ?? config.backtestStats?.totalWindows;
  liveState.backtestTotalWindows = (twCfg != null && Number.isFinite(twCfg) && twCfg > 0) ? Math.round(twCfg) : null;
  liveState.windowMinutes = config.windowMinutes || 15;
  liveState.entryMinute = config.entryMinute ?? (liveState.windowMinutes <= 5 ? 2 : 5);
  liveState.trades = [];
  liveState.activeTrade = null;
  liveState.currentWindow = null;
  liveState.entryDecided = false;
  liveState.dualPreOrdered = new Set();
  liveState.dualNextMarket = null;
  liveState.windowAudit = null;
  liveState.weights = { ...DEFAULT_WEIGHTS, ...(config.weights || {}) };
  liveState.filters = { ...DEFAULT_FILTERS, ...(config.filters || {}) };
  liveState.marketSensitivity = config.marketSensitivity ?? 80;

  // Create a new session ID
  liveState.sessionId = generateSessionId();
  liveState.sessionStartedAt = new Date().toISOString();
  liveState.sessionName = config.strategyName || "Session";

  liveState.running = true;

  const stratName = isResolution
    ? (liveState.windowMinutes <= 5 ? "hold_5m_late_sniper" : "hold_15m_late_sniper")
    : (liveState.windowMinutes <= 5 ? "momentum_scalp_5m" : "momentum_scalp_15m");
  const strat = await getActiveStrategy(stratName).catch(() => null);
  if (strat) {
    liveState.strategyId = strat.id;
    if (!isResolution) {
      if (!config.tpPct) liveState.tpPct = Number(strat.tp_pct);
      if (!config.slPct) liveState.slPct = Number(strat.sl_pct);
    }
    console.log(`[STRATEGY] Loaded "${strat.name}" from DB — TP=${liveState.tpPct} SL=${liveState.slPct}`);
  }

  // Save initial session record to Supabase (best-effort)
  insertSession({
    id: liveState.sessionId,
    name: liveState.sessionName,
    started_at: liveState.sessionStartedAt,
    saved_at: liveState.sessionStartedAt,
    bank: liveState.bank,
    balance: liveState.balance,
    total_pnl: 0,
    trading_mode: liveState.tradingMode,
    strategy_name: liveState.strategyName,
    strategy_type: liveState.strategyType,
    window_minutes: liveState.windowMinutes,
    stats: { wins: 0, losses: 0, totalTrades: 0, totalPnl: 0 },
    snapshot: buildSessionSnapshot(),
  }).catch(() => {});

  clearMarketCache();
  liveState.pmPriceMissStreak = 0;
  liveState.lastBtcClose = null;
  if (liveInterval) clearInterval(liveInterval);
  startAutoSave();
  const tickMs = 1_000;
  liveTick();
  liveInterval = setInterval(liveTick, tickMs);
}

function stopLive() {
  if (liveState.running && liveState.sessionId) {
    saveSession().catch(() => {});
  }
  liveState.running = false;
  if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
  stopAutoSave();
  clearMarketCache();
  liveState.pmPriceMissStreak = 0;
}

// ===================== STRATEGY ARENA =====================

const arenaState = {
  running: false,
  subscribers: new Set(),
  strategies: [],
  markets: {},
  windowMinutes: 15,
  pmPriceMissCount: 0,
  sessionId: null,
  startedAt: null,
};

let arenaInterval = null;
let arenaTickInFlight = false;
let arenaTickStartedAt = 0;
let arenaAutoSaveInterval = null;

const ARENA_SESSION_DIR = path.join(__dirname, "..", "arena-sessions");
const ARENA_ACTIVE_FILE = path.join(ARENA_SESSION_DIR, "_active.json");

function ensureArenaSessionDir() {
  try { fs.mkdirSync(ARENA_SESSION_DIR, { recursive: true }); } catch {}
}

function serializeStrategy(s) {
  return {
    id: s.id, name: s.name, description: s.description,
    strategyType: s.strategyType, asset: s.asset,
    windowMinutes: s.windowMinutes, entryMinute: s.entryMinute,
    weights: s.weights, filters: s.filters,
    bank: s.bank, balance: s.balance, maxBet: s.maxBet,
    feeRate: s.feeRate, tpPct: s.tpPct, slPct: s.slPct,
    marketSensitivity: s.marketSensitivity,
    trades: s.trades, activeTrades: s.activeTrades,
    currentWindow: s.currentWindow, entryDecided: s.entryDecided,
    backtestStats: s.backtestStats,
  };
}

function deserializeStrategy(raw) {
  return {
    ...raw,
    weights: { ...DEFAULT_WEIGHTS, ...(raw.weights || {}) },
    filters: { ...DEFAULT_FILTERS, ...(raw.filters || {}) },
    trades: raw.trades || [],
    activeTrades: raw.activeTrades || [],
    currentWindow: raw.currentWindow ?? null,
    entryDecided: raw.entryDecided ?? false,
  };
}

function saveArenaSession() {
  if (!arenaState.running || !arenaState.sessionId) return;
  ensureArenaSessionDir();
  const snapshot = {
    sessionId: arenaState.sessionId,
    startedAt: arenaState.startedAt,
    savedAt: new Date().toISOString(),
    windowMinutes: arenaState.windowMinutes,
    strategies: arenaState.strategies.map(serializeStrategy),
  };
  try {
    fs.writeFileSync(ARENA_ACTIVE_FILE, JSON.stringify(snapshot, null, 2));
    const archivePath = path.join(ARENA_SESSION_DIR, `${arenaState.sessionId}.json`);
    fs.writeFileSync(archivePath, JSON.stringify(snapshot, null, 2));
  } catch (e) {
    console.error("[ARENA] Save error:", e.message);
  }
}

function loadActiveArenaSession() {
  try {
    if (!fs.existsSync(ARENA_ACTIVE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(ARENA_ACTIVE_FILE, "utf8"));
    if (!raw.strategies?.length) return null;
    return raw;
  } catch { return null; }
}

function clearActiveArenaSession() {
  try { if (fs.existsSync(ARENA_ACTIVE_FILE)) fs.unlinkSync(ARENA_ACTIVE_FILE); } catch {}
}

function listArenaSessions() {
  ensureArenaSessionDir();
  try {
    return fs.readdirSync(ARENA_SESSION_DIR)
      .filter(f => f.endsWith(".json") && f !== "_active.json")
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(ARENA_SESSION_DIR, f), "utf8"));
          const strats = data.strategies || [];
          const totalPnl = strats.reduce((sum, s) => sum + (s.balance - s.bank), 0);
          const totalTrades = strats.reduce((sum, s) => sum + (s.trades?.filter(t => t.pnl != null && !t.noEntry)?.length || 0), 0);
          return {
            sessionId: data.sessionId,
            startedAt: data.startedAt,
            savedAt: data.savedAt,
            windowMinutes: data.windowMinutes,
            strategyCount: strats.length,
            assets: [...new Set(strats.map(s => s.asset))],
            totalPnl: +totalPnl.toFixed(2),
            totalTrades,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  } catch { return []; }
}

function startArenaAutoSave() {
  stopArenaAutoSave();
  arenaAutoSaveInterval = setInterval(() => {
    if (arenaState.running) saveArenaSession();
  }, 30_000);
}

function stopArenaAutoSave() {
  if (arenaAutoSaveInterval) { clearInterval(arenaAutoSaveInterval); arenaAutoSaveInterval = null; }
}

function arenaBroadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of arenaState.subscribers) {
    try { res.write(msg); } catch { arenaState.subscribers.delete(res); }
  }
}

function createArenaStrategy(cfg, index) {
  return {
    id: cfg.id || `strat_${index}_${Date.now()}`,
    name: cfg.name || `Strategy ${index + 1}`,
    description: cfg.description || "",
    strategyType: cfg.strategyType || cfg.type || "momentum",
    asset: (cfg.asset || "BTC").toUpperCase(),
    windowMinutes: cfg.windowMinutes || 15,
    entryMinute: cfg.entryMinute ?? (cfg.windowMinutes <= 5 ? 2 : 5),
    weights: { ...DEFAULT_WEIGHTS, ...(cfg.weights || {}) },
    filters: { ...DEFAULT_FILTERS, ...(cfg.filters || {}) },
    bank: cfg.bank || 1000,
    balance: cfg.bank || 1000,
    maxBet: Math.max(MIN_BET_USD, cfg.maxBet ?? MIN_BET_USD),
    feeRate: cfg.feeRate ?? 0.02,
    tpPct: cfg.tpPct ?? 0.12,
    slPct: cfg.slPct ?? 0.50,
    marketSensitivity: cfg.marketSensitivity ?? 80,
    trades: [],
    activeTrades: [],
    currentWindow: null,
    entryDecided: false,
    backtestStats: cfg.backtestStats || null,
  };
}

function arenaStrategyStats(s) {
  const closed = s.trades.filter(t => t.pnl != null && !t.noEntry);
  const wins = closed.filter(t => t.pnl > 0).length;
  const losses = closed.filter(t => t.pnl <= 0).length;
  const totalPnl = +(s.balance - s.bank).toFixed(2);
  const pnlPct = s.bank > 0 ? +((totalPnl / s.bank) * 100).toFixed(2) : 0;
  let peak = s.bank;
  let maxDd = 0;
  let runBal = s.bank;
  for (const t of s.trades) {
    if (t.pnl != null) {
      runBal = +(runBal + t.pnl).toFixed(2);
      if (runBal > peak) peak = runBal;
      const dd = peak - runBal;
      if (dd > maxDd) maxDd = dd;
    }
  }
  const winRate = closed.length > 0 ? +((wins / closed.length) * 100).toFixed(1) : 0;
  const tpHits = s.trades.filter(t => t.exitReason === "TP_HIT").length;
  const slHits = s.trades.filter(t => t.exitReason === "SL_HIT").length;
  let streak = 0, streakType = null;
  for (let i = closed.length - 1; i >= 0; i--) {
    const w = closed[i].pnl > 0;
    if (streakType === null) { streakType = w ? "W" : "L"; streak = 1; }
    else if ((w && streakType === "W") || (!w && streakType === "L")) streak++;
    else break;
  }
  return { wins, losses, totalPnl, pnlPct, maxDrawdown: +maxDd.toFixed(2), winRate, tpHits, slHits, streak, streakType, totalTrades: closed.length };
}

function arenaEvalStrategy(s, ind, prices, batch, windowStart, windowEnd, remainingMin, elapsedMin, last, windowStartPrice) {
  const wMin = s.windowMinutes;
  const winMs = wMin * 60_000;

  for (let i = s.activeTrades.length - 1; i >= 0; i--) {
    const at = s.activeTrades[i];
    if (at.pnl !== null) { s.activeTrades.splice(i, 1); continue; }

    const currentSharePrice = at.side === "UP"
      ? (prices?.upBid ?? prices?.upMid ?? at.buyPrice)
      : (prices?.downBid ?? prices?.downMid ?? at.buyPrice);

    if (s.tpPct != null || s.slPct != null) {
      const tpSlResult = checkTpSl(at.buyPrice, currentSharePrice, s.tpPct, s.slPct);
      if (tpSlResult) {
        const shares = at.cost / at.buyPrice;
        const grossPnl = (tpSlResult.exitPrice - at.buyPrice) * shares;
        const fee = tpSlResult.reason === "TP_HIT" ? grossPnl * s.feeRate : 0;
        at.pnl = +(grossPnl - fee).toFixed(2);
        at.exitPrice = tpSlResult.exitPrice;
        at.exitReason = tpSlResult.reason;
        at.exitTime = new Date().toISOString();
        at.holdMinutes = +((new Date(at.exitTime) - new Date(at.time)) / 60000).toFixed(3);
        at.btcEnd = +last.toFixed(2);
        at.correct = at.pnl > 0;
        s.balance = +(s.balance + at.pnl).toFixed(2);
        at.balance = s.balance;
        s.activeTrades.splice(i, 1);
        continue;
      }
    }
    at._unrealizedPct = +((currentSharePrice - at.buyPrice) / at.buyPrice * 100).toFixed(2);
    at._currentPrice = currentSharePrice;
  }

  if (s.currentWindow !== windowStart) {
    if (s.currentWindow !== null) {
      const prevCandles = batch.filter(k => k.openTime >= s.currentWindow && k.openTime < s.currentWindow + winMs);
      if (prevCandles.length >= 2) {
        const pStart = prevCandles[0].open;
        const pEnd = prevCandles[prevCandles.length - 1].close;
        const actualUp = pEnd >= pStart;

        const pendingTrades = s.trades.filter(t => t.windowStart === s.currentWindow && t.pnl === null && !t.noEntry && t.side);
        for (const pt of pendingTrades) {
          const correct = (pt.side === "UP" && actualUp) || (pt.side === "DOWN" && !actualUp);
          const shares = pt.cost / pt.buyPrice;
          if (correct) {
            const gp = shares - pt.cost;
            pt.pnl = +(gp - gp * s.feeRate).toFixed(2);
          } else {
            pt.pnl = -pt.cost;
          }
          pt.correct = correct;
          pt.actualOutcome = actualUp ? "UP" : "DOWN";
          pt.exitReason = correct ? "RESOLVED_WIN" : "RESOLVED_LOSS";
          pt.exitTime = new Date().toISOString();
          pt.exitPrice = correct ? 1.0 : 0.0;
          pt.holdMinutes = +((new Date(pt.exitTime) - new Date(pt.time)) / 60000).toFixed(3);
          pt.btcEnd = +pEnd.toFixed(2);
          s.balance = +(s.balance + pt.pnl).toFixed(2);
          pt.balance = s.balance;
        }
        s.activeTrades = s.activeTrades.filter(at => at.pnl === null);

        if (!s.trades.some(t => t.windowStart === s.currentWindow && !t.noEntry && t.side)) {
          s.trades.push({
            id: s.trades.length + 1,
            time: new Date().toISOString(),
            windowStart: s.currentWindow,
            noEntry: true, side: null, skipReason: "NO_ENTRY",
            actualOutcome: actualUp ? "UP" : "DOWN",
            btcStart: +pStart.toFixed(2), btcEnd: +pEnd.toFixed(2),
            correct: null, pnl: null, exitReason: "NO_ENTRY_RESOLVED",
            exitTime: new Date().toISOString(), balance: s.balance,
          });
        }
      }
    }
    s.currentWindow = windowStart;
    s.entryDecided = false;
  }

  const sScored = scoreDirectionV2(ind, s.weights, s.filters);
  const entryRemainingMin = Math.max(wMin - s.entryMinute, remainingMin);
  const sTa = applyTimeAwareness(sScored.rawUp, entryRemainingMin, wMin);

  let rec;
  if (s.strategyType === "resolution") {
    const priorW = s.filters.resolutionPriorWeight ?? 0.30;
    const effPriorW = clamp(priorW, 0, 0.85);
    const blended = blendResolutionSettlementPrior(
      sTa.adjustedUp, sTa.adjustedDown,
      last, windowStartPrice ?? last,
      s.marketSensitivity, effPriorW,
    );
    rec = decideV2({
      remainingMinutes: remainingMin,
      modelUp: blended.modelUp,
      modelDown: blended.modelDown,
      confluence: sScored.confluence,
      filtered: sScored.filtered,
      minProbOverride: s.filters.minProb || null,
    });
  } else if (s.strategyType === "dual_position") {
    rec = { action: "ENTER", side: "DUAL", strength: "DUAL", phase: "ENTRY", reason: null };
  } else {
    rec = decideMomentumEntry({
      remainingMinutes: remainingMin,
      modelUp: sTa.adjustedUp,
      modelDown: sTa.adjustedDown,
      confluence: sScored.confluence,
      filtered: sScored.filtered,
      indicators: ind,
      windowMinutes: wMin,
      config: s.filters,
    });
  }

  // Dual opens at entryMinute 0; allow entry until ~2s before window end so a late-started
  // arena tick still participates (0.5m min would skip the whole window and log bogus NO_ENTRY).
  const minRemaining =
    s.strategyType === "resolution" ? 0
    : s.strategyType === "dual_position" ? 0.03
    : (wMin <= 5 ? 0.5 : 1.5);
  const requiredBalance = s.strategyType === "dual_position" ? s.maxBet * 2 : s.maxBet;
  const canEnter = !s.entryDecided
    && s.activeTrades.length === 0
    && elapsedMin >= s.entryMinute
    && remainingMin > minRemaining
    && s.balance >= requiredBalance;

  if (s.strategyType === "dual_position" && canEnter) {
    s.entryDecided = true;
    const mUp = prices?.upAsk ?? 0.5;
    const mDown = prices?.downAsk ?? 0.5;
    const dualTpPct = s.tpPct ?? 0.05;
    const betPerSide = s.maxBet;

    for (const dualSide of ["UP", "DOWN"]) {
      const bPrice = dualSide === "UP" ? mUp : mDown;
      const tpPrice = +(Math.min(bPrice * (1 + dualTpPct), 0.99)).toFixed(4);
      const trade = {
        id: s.trades.length + 1,
        time: new Date().toISOString(),
        windowStart,
        side: dualSide,
        buyPrice: +bPrice.toFixed(4),
        cost: betPerSide,
        tpPrice, slPrice: null,
        actualOutcome: null, correct: null, pnl: null,
        exitPrice: null, exitReason: null, exitTime: null, balance: null,
        modelUp: +mUp.toFixed(4), modelDown: +mDown.toFixed(4),
        btcStart: windowStartPrice ? +windowStartPrice.toFixed(2) : +last.toFixed(2),
        btcEnd: null, asset: s.asset,
        confluence: 0, regime: ind.regime.regime, strength: "DUAL", phase: "ENTRY",
      };
      s.trades.push(trade);
      s.activeTrades.push(trade);
    }
    s.balance = +(s.balance - betPerSide * 2).toFixed(2);
  }

  if (s.strategyType !== "dual_position" && canEnter && rec.action === "ENTER") {
    s.entryDecided = true;
    const mUp = prices?.upAsk ?? 0.5;
    const mDown = prices?.downAsk ?? 0.5;
    const bPrice = rec.side === "UP" ? mUp : mDown;
    const { tpPrice, slPrice } = computeTpSlPrices(bPrice, s.tpPct, s.slPct);
    const trade = {
      id: s.trades.length + 1,
      time: new Date().toISOString(),
      windowStart,
      side: rec.side,
      buyPrice: +bPrice.toFixed(4),
      cost: s.maxBet,
      tpPrice, slPrice,
      actualOutcome: null, correct: null, pnl: null,
      exitPrice: null, exitReason: null, exitTime: null, balance: null,
      modelUp: +sTa.adjustedUp.toFixed(4), modelDown: +sTa.adjustedDown.toFixed(4),
      btcStart: windowStartPrice ? +windowStartPrice.toFixed(2) : +last.toFixed(2),
      btcEnd: null, asset: s.asset,
      confluence: sScored.confluence, regime: ind.regime.regime,
      strength: rec.strength, phase: rec.phase,
    };
    s.trades.push(trade);
    s.activeTrades.push(trade);
    s.balance = +(s.balance - s.maxBet).toFixed(2);
  }

  return {
    action: rec.action,
    side: rec.side,
    strength: rec.strength,
    modelUp: +sTa.adjustedUp.toFixed(4),
    modelDown: +sTa.adjustedDown.toFixed(4),
    confluence: sScored.confluence,
    canEnter,
  };
}

async function arenaTick() {
  if (!arenaState.running) return;
  if (arenaTickInFlight) {
    if (Date.now() - arenaTickStartedAt > 15000) {
      console.warn("[ARENA-TICK] Force-resetting stuck tick lock");
      arenaTickInFlight = false;
    } else return;
  }
  arenaTickInFlight = true;
  arenaTickStartedAt = Date.now();
  try {
    const tEnd = Date.now();
    const tStart = tEnd - 240 * 60_000;
    const wMin = arenaState.windowMinutes;

    const usedAssets = [...new Set(arenaState.strategies.map(s => s.asset))];
    const wKey = wMin <= 5 ? 5 : 15;
    const seriesMap = ARENA_SERIES[wKey] || {};
    const usedSymbols = [...new Set(usedAssets.map(a => seriesMap[a]?.symbol).filter(Boolean))];

    const klinePromises = usedSymbols.map(sym =>
      withTimeout(fetchKlinesWithRetry(sym, "1m", tStart, tEnd), 8000, `arena-klines-${sym}`)
        .catch(e => { console.error(`[ARENA] Klines ${sym}:`, e.message); return []; })
        .then(data => ({ symbol: sym, data }))
    );

    const mktPromise = withTimeout(discoverAllArenaMarkets(wMin), 10000, "arena-markets")
      .catch(e => { console.error("[ARENA] Market discovery:", e.message); return {}; });

    const [klineResults, allMarkets] = await Promise.all([
      Promise.all(klinePromises),
      mktPromise,
    ]);

    const klinesBySymbol = {};
    for (const r of klineResults) {
      if (r.data?.length) klinesBySymbol[r.symbol] = r.data;
    }

    arenaState.markets = allMarkets;

    const pricePromises = Object.entries(allMarkets).map(([asset, mkt]) =>
      withTimeout(fetchRealPrices(mkt.upTokenId, mkt.downTokenId), 6000, `arena-prices-${asset}`)
        .catch(() => null)
        .then(prices => ({ asset, prices }))
    );
    const priceResults = await Promise.all(pricePromises);
    const pricesByAsset = {};
    for (const r of priceResults) {
      if (r.prices) pricesByAsset[r.asset] = r.prices;
    }

    const nowMs = Date.now();
    const btcMkt = allMarkets.BTC || Object.values(allMarkets)[0];
    const pmSnap = btcMkt ? { slug: btcMkt.slug, endMs: btcMkt.endMs } : {};
    const { windowStart, windowEnd } = resolveLiveWindowBounds(nowMs, wMin, pmSnap);
    const remainingMs = windowEnd - nowMs;
    const remainingMin = remainingMs / 60_000;
    const elapsedMin = (nowMs - windowStart) / 60_000;

    const indBySymbol = {};
    for (const [sym, batch] of Object.entries(klinesBySymbol)) {
      const closes = batch.map(c => c.close);
      if (closes.length > 0) {
        indBySymbol[sym] = { ind: computeAllIndicators(batch, closes), batch, closes, last: closes[closes.length - 1] };
      }
    }

    const marketsPayload = {};
    for (const [asset, mkt] of Object.entries(allMarkets)) {
      const p = pricesByAsset[asset];
      marketsPayload[asset] = {
        slug: mkt.slug, question: mkt.question, assetName: mkt.assetName,
        upAsk: p?.upAsk ?? null, downAsk: p?.downAsk ?? null,
        upBid: p?.upBid ?? null, downBid: p?.downBid ?? null,
        spread: p?.spread ?? null,
        connected: !!(mkt.upTokenId && mkt.downTokenId),
      };
    }

    const strategyPayloads = [];
    for (const s of arenaState.strategies) {
      const assetInfo = seriesMap[s.asset];
      const sym = assetInfo?.symbol || "BTCUSDT";
      const symData = indBySymbol[sym];
      if (!symData) continue;

      const { ind, batch, last } = symData;
      const prices = pricesByAsset[s.asset] || null;
      const windowCandles = batch.filter(k => k.openTime >= windowStart && k.openTime < windowEnd);
      const windowStartPrice = windowCandles.length ? windowCandles[0].open : null;

      const evalResult = arenaEvalStrategy(s, ind, prices, batch, windowStart, windowEnd, remainingMin, elapsedMin, last, windowStartPrice);
      const stats = arenaStrategyStats(s);
      const activeTrade = s.activeTrades.length > 0 ? s.activeTrades.map(at => ({
        side: at.side,
        entryPrice: at.buyPrice,
        tpPrice: at.tpPrice,
        slPrice: at.slPrice,
        unrealizedPct: at._unrealizedPct ?? 0,
        currentPrice: at._currentPrice ?? at.buyPrice,
        time: at.time,
      })) : null;

      strategyPayloads.push({
        id: s.id,
        name: s.name,
        description: s.description,
        strategyType: s.strategyType,
        asset: s.asset,
        windowMinutes: s.windowMinutes,
        entryMinute: s.entryMinute,
        tpPct: s.tpPct,
        slPct: s.slPct,
        bank: s.bank,
        balance: s.balance,
        maxBet: s.maxBet,
        ...stats,
        ...evalResult,
        activeTrade,
        recentTrades: s.trades.slice(-15).reverse(),
        entryDecided: s.entryDecided,
      });
    }

    const btcData = indBySymbol.BTCUSDT;
    arenaBroadcast({
      type: "arena_tick",
      shared: {
        price: btcData ? +btcData.last.toFixed(2) : null,
        windowStart,
        windowEnd,
        remainingMin: +remainingMin.toFixed(2),
        elapsedMin: +elapsedMin.toFixed(1),
        windowMinutes: wMin,
        markets: marketsPayload,
      },
      strategies: strategyPayloads,
    });
  } catch (err) {
    console.error("[ARENA-TICK ERROR]", err.message, err.stack?.split('\n')[1]?.trim());
    arenaBroadcast({ type: "error", message: err.message });
  } finally {
    arenaTickInFlight = false;
  }
}

function startArena(configs, opts = {}) {
  if (arenaState.running) stopArena();
  const wMin = configs[0]?.windowMinutes || 15;
  arenaState.strategies = configs.map((cfg, i) => createArenaStrategy({ ...cfg, windowMinutes: wMin }, i));
  arenaState.windowMinutes = wMin;
  arenaState.running = true;
  arenaState.pmPriceMissCount = 0;
  arenaState.sessionId = opts.sessionId || `arena_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  arenaState.startedAt = opts.startedAt || new Date().toISOString();
  clearArenaMarketCache();
  if (arenaInterval) clearInterval(arenaInterval);
  arenaTick();
  arenaInterval = setInterval(arenaTick, 1_000);
  startArenaAutoSave();
  saveArenaSession();
  console.log(`[ARENA] Started (${arenaState.sessionId}) with ${arenaState.strategies.length} strategies across ${[...new Set(arenaState.strategies.map(s=>s.asset))].join(", ")}`);
}

function resumeArena(session) {
  if (arenaState.running) stopArena();
  arenaState.strategies = session.strategies.map(deserializeStrategy);
  arenaState.windowMinutes = session.windowMinutes || 15;
  arenaState.running = true;
  arenaState.pmPriceMissCount = 0;
  arenaState.sessionId = session.sessionId;
  arenaState.startedAt = session.startedAt;
  clearArenaMarketCache();
  if (arenaInterval) clearInterval(arenaInterval);
  arenaTick();
  arenaInterval = setInterval(arenaTick, 1_000);
  startArenaAutoSave();
  saveArenaSession();
  console.log(`[ARENA] Resumed session ${session.sessionId} with ${arenaState.strategies.length} strategies`);
}

function stopArena() {
  if (arenaState.running) saveArenaSession();
  arenaState.running = false;
  if (arenaInterval) { clearInterval(arenaInterval); arenaInterval = null; }
  stopArenaAutoSave();
  clearActiveArenaSession();
  console.log("[ARENA] Stopped");
}

// Auto-restore arena session on server start
{
  const savedArena = loadActiveArenaSession();
  if (savedArena) {
    console.log(`[ARENA] Found saved session ${savedArena.sessionId} with ${savedArena.strategies.length} strategies — auto-resuming...`);
    setTimeout(() => resumeArena(savedArena), 2000);
  }
}

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = (url.pathname || "/").replace(/\/+$/, "") || "/";

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"));
    return;
  }

  if (pathname === "/api/backtest") {
    const p = url.searchParams;
    const parseWeights = (s) => { try { return JSON.parse(s); } catch { return {}; } };

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });

    const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await runBacktest({
        days: clamp(+(p.get("days") || 3), 1, 60),
        bank: +(p.get("bank") || 1000),
        maxBet: Math.max(MIN_BET_USD, +(p.get("maxBet") || MIN_BET_USD)),
        entryMinute: clamp(+(p.get("entryMinute") || 9), 1, 13),
        feeRate: clamp(+(p.get("feeRate") || 0.02), 0, 0.2),
        marketMode: p.get("marketMode") || "dynamic",
        marketSensitivity: clamp(+(p.get("marketSensitivity") || 80), 10, 300),
        windowMinutes: clamp(+(p.get("windowMinutes") || 15), 1, 60),
        weights: parseWeights(p.get("weights") || "{}"),
        filters: parseWeights(p.get("filters") || "{}"),
      }, (progress) => sendSSE({ type: "progress", ...progress }));

      sendSSE({ type: "result", ...result });
    } catch (err) {
      console.error(err);
      sendSSE({ type: "error", error: err.message });
    }
    res.end();
    return;
  }

  if (pathname === "/api/backtest/momentum") {
    const p = url.searchParams;
    const parseWeights = (s) => { try { return JSON.parse(s); } catch { return {}; } };

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });

    const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await runMomentumBacktest({
        days: clamp(+(p.get("days") || 3), 1, 60),
        bank: +(p.get("bank") || 1000),
        maxBet: Math.max(MIN_BET_USD, +(p.get("maxBet") || MIN_BET_USD)),
        entryMinute: clamp(+(p.get("entryMinute") || 5), 1, 13),
        feeRate: clamp(+(p.get("feeRate") || 0.02), 0, 0.2),
        tpPct: clamp(+(p.get("tpPct") || 0.12), 0.01, 0.5),
        slPct: clamp(+(p.get("slPct") || 0.50), 0.1, 1.0),
        marketMode: p.get("marketMode") || "dynamic",
        marketSensitivity: clamp(+(p.get("marketSensitivity") || 80), 10, 300),
        windowMinutes: clamp(+(p.get("windowMinutes") || 15), 1, 60),
        weights: parseWeights(p.get("weights") || "{}"),
        filters: parseWeights(p.get("filters") || "{}"),
        saveToDb: p.get("saveToDb") === "true",
        strategyId: p.get("strategyId") || null,
      }, (progress) => sendSSE({ type: "progress", ...progress }));

      sendSSE({ type: "result", ...result });
    } catch (err) {
      console.error(err);
      sendSSE({ type: "error", error: err.message });
    }
    res.end();
    return;
  }

  if (pathname === "/api/live") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });

    liveState.subscribers.add(res);
    req.on("close", () => liveState.subscribers.delete(res));

    if (!liveState.running) {
      const p = url.searchParams;
      const parseJ = (s) => { try { return JSON.parse(s); } catch { return {}; } };
      await startLive({
        bank: +(p.get("bank") || 1000),
        maxBet: Math.max(MIN_BET_USD, +(p.get("maxBet") || MIN_BET_USD)),
        feeRate: +(p.get("feeRate") || 0.02),
        tpPct: p.get("tpPct") ? +p.get("tpPct") : undefined,
        slPct: p.get("slPct") ? +p.get("slPct") : undefined,
        windowMinutes: +(p.get("windowMinutes") || 15),
        entryMinute: clamp(+(p.get("entryMinute") || 5), 1, 13),
        tradingMode: p.get("tradingMode") || "paper",
        strategyMode: p.get("strategyMode") || "momentum_scalp",
        configName: p.get("configName") || null,
        strategyName: p.get("strategyName") || null,
        strategyDescription: p.get("strategyDescription") || null,
        strategyType: p.get("strategyType") || null,
        backtestStats: parseJ(p.get("backtestStats") || "null"),
        totalWindows: p.has("totalWindows") ? +p.get("totalWindows") : undefined,
        weights: parseJ(p.get("weights") || "{}"),
        filters: parseJ(p.get("filters") || "{}"),
      });
    }

    res.write(`data: ${JSON.stringify({ type: "connected", sessionId: liveState.sessionId, balance: liveState.balance, bank: liveState.bank, maxBet: liveState.maxBet, trades: liveState.trades, tradingMode: liveState.tradingMode, configName: liveState.configName, strategyName: liveState.strategyName, strategyDescription: liveState.strategyDescription, strategyType: liveState.strategyType, backtestStats: liveState.backtestStats, totalWindows: liveState.backtestTotalWindows, tpPct: liveState.tpPct, slPct: liveState.slPct, windowMinutes: liveState.windowMinutes, entryMinute: liveState.entryMinute })}\n\n`);
    return;
  }

  if (pathname === "/api/live/status") {
    const wins = liveState.trades.filter((t) => t.correct === true).length;
    const losses = liveState.trades.filter((t) => t.correct === false).length;
    const pm = liveState.polymarket;
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      running: liveState.running,
      balance: liveState.balance,
      bank: liveState.bank,
      maxBet: liveState.maxBet,
      windowMinutes: liveState.windowMinutes,
      entryMinute: liveState.entryMinute,
      tpPct: liveState.tpPct,
      slPct: liveState.slPct,
      totalTrades: liveState.trades.length,
      wins,
      losses,
      tradingMode: liveState.tradingMode,
      configName: liveState.configName,
      strategyName: liveState.strategyName,
      strategyDescription: liveState.strategyDescription,
      strategyType: liveState.strategyType,
      backtestStats: liveState.backtestStats,
      weights: liveState.weights,
      filters: liveState.filters,
      trades: liveState.trades,
      totalWindows: liveState.backtestTotalWindows,
      polymarket: { slug: pm.slug, question: pm.question, connected: !!(pm.upTokenId && pm.downTokenId) },
    }));
    return;
  }

  if (pathname === "/api/live/mode") {
    const p = url.searchParams;
    const mode = p.get("mode");
    if (mode === "paper" || mode === "real") {
      if (mode === "real") {
        const pk = process.env.POLYMARKET_PRIVATE_KEY;
        const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
        if (!pk || !funder) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: "Wallet not configured. Set POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS in .env" }));
          return;
        }
      }
      liveState.tradingMode = mode;
      broadcast({ type: "mode_changed", tradingMode: mode });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, tradingMode: mode }));
    } else {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Invalid mode. Use 'paper' or 'real'" }));
    }
    return;
  }

  if (pathname === "/api/live/config") {
    if (!liveState.running) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Live mode not running" }));
      return;
    }
    const p = url.searchParams;
    const parseJ = (s) => { try { return JSON.parse(s); } catch { return {}; } };
    const newWeights = parseJ(p.get("weights") || "{}");
    const newFilters = parseJ(p.get("filters") || "{}");
    const configName = p.get("configName") || null;
    if (p.has("maxBet")) liveState.maxBet = Math.max(MIN_BET_USD, +(p.get("maxBet")) || MIN_BET_USD);
    liveState.weights = { ...DEFAULT_WEIGHTS, ...newWeights };
    liveState.filters = { ...DEFAULT_FILTERS, ...newFilters };
    liveState.configName = configName;
    broadcast({ type: "config_changed", configName, maxBet: liveState.maxBet, weights: liveState.weights, filters: liveState.filters });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, configName, maxBet: liveState.maxBet }));
    return;
  }

  if (pathname === "/api/wallet/status") {
    const status = getClobStatus();
    const hasKey = !!process.env.POLYMARKET_API_KEY;
    const hasPK = !!process.env.POLYMARKET_PRIVATE_KEY;
    const addr = process.env.POLYMARKET_FUNDER_ADDRESS || null;
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      apiKeyConfigured: hasKey,
      privateKeyConfigured: hasPK,
      funderAddress: addr,
      clobConnected: status.connected,
      clobError: status.error || null,
      readyForRealTrading: hasPK && status.connected,
    }));
    return;
  }

  if (pathname === "/api/polymarket/account") {
    const status = getClobStatus();
    if (!status.connected) {
      res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        ok: false,
        error: status.error || "CLOB not connected. Set POLYMARKET_PRIVATE_KEY in .env and restart the server.",
      }));
      return;
    }
    try {
      const snap = await fetchPolymarketAccountSnapshot();
      res.writeHead(snap.ok ? 200 : 502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(snap));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ---- CLOB order management endpoints ----
  if (pathname === "/api/clob/cancel") {
    const orderId = url.searchParams.get("orderId");
    if (!orderId) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "orderId query param required" }));
      return;
    }
    const result = await cancelOrder(orderId);
    res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === "/api/clob/cancel-all") {
    const result = await cancelAllOrders();
    res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === "/api/clob/redeem") {
    try {
      const result = await redeemWinningPositions();
      res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === "/api/clob/redeemable") {
    try {
      const positions = await fetchRedeemablePositions();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, positions }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === "/api/clob/sell") {
    const tokenId = url.searchParams.get("tokenId");
    const price = parseFloat(url.searchParams.get("price") || "0");
    const size = parseFloat(url.searchParams.get("size") || "0");
    if (!tokenId || !price || !size) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "tokenId, price and size query params required" }));
      return;
    }
    const result = await placeSellOrder({ tokenId, price, size, negRisk: false });
    res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
    return;
  }
  // ---- end CLOB endpoints ----

  if (pathname === "/api/live/stop") {
    stopLive();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, sessionId: liveState.sessionId }));
    return;
  }

  if (pathname === "/api/trade/test") {
    const side = (url.searchParams.get("side") || "UP").toUpperCase();
    const amount = Math.max(0.50, Math.min(5, +(url.searchParams.get("amount") || 1)));
    const wMin = +(url.searchParams.get("windowMinutes") || liveState.windowMinutes || 5);
    const json = (s, b) => { res.writeHead(s, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(b)); };

    // Use live session market if available, otherwise auto-discover
    let tokenId = side === "UP" ? liveState.polymarket.upTokenId : liveState.polymarket.downTokenId;
    let askPrice = side === "UP" ? liveState.polymarket.upAsk : liveState.polymarket.downAsk;

    let mktTickSize = null;
    let mktNegRisk = false;

    if (!tokenId) {
      console.log(`[TEST-BUY] No live session — auto-discovering ${wMin}m market…`);
      try {
        const mkt = await discoverCurrentMarket(true, wMin);
        if (!mkt?.upTokenId) return json(400, { ok: false, error: "No active market found for this window" });
        const prices = await fetchRealPrices(mkt.upTokenId, mkt.downTokenId);
        tokenId = side === "UP" ? mkt.upTokenId : mkt.downTokenId;
        askPrice = side === "UP" ? prices?.upAsk : prices?.downAsk;
        mktTickSize = mkt.tickSize || null;
        mktNegRisk = mkt.negRisk || false;
        console.log(`[TEST-BUY] Found market: ${mkt.slug} | ${side} ask=${askPrice} | tickSize=${mktTickSize} negRisk=${mktNegRisk}`);
      } catch (e) {
        return json(500, { ok: false, error: `Market discovery failed: ${e.message}` });
      }
    } else {
      mktTickSize = liveState.polymarket.tickSize || null;
      mktNegRisk = liveState.polymarket.negRisk || false;
    }

    if (!tokenId) return json(400, { ok: false, error: "No token ID found for that side" });
    if (!askPrice || askPrice <= 0) return json(400, { ok: false, error: "No live price available for that side" });

    const rawSize = amount / askPrice;
    const orderSize = Math.max(5, Math.floor(rawSize * 10000) / 10000); // CLOB min 5 shares
    console.log(`[TEST-BUY] Placing real $${amount} ${side} @ ${askPrice} size=${orderSize} | token=${tokenId} negRisk=${mktNegRisk}`);
    const result = await placeBuyOrder({ tokenId, price: askPrice, size: orderSize, negRisk: mktNegRisk });
    console.log(`[TEST-BUY] Result:`, JSON.stringify(result));
    return json(result.ok ? 200 : 500, { ok: result.ok, side, amount, price: askPrice, tokenId, order: result.order || null, error: result.error || null });
  }

  if (pathname === "/api/live/save") {
    if (!liveState.running && !liveState.sessionId) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "No active session to save" }));
      return;
    }
    const label = url.searchParams.get("name") || null;
    const snapshot = await saveSession(label).catch(() => null);
    if (!snapshot) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Failed to save session" }));
      return;
    }
    broadcast({ type: "session_saved", sessionId: snapshot.id, name: snapshot.name, savedAt: snapshot.savedAt });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, session: snapshot }));
    return;
  }

  if (pathname === "/api/sessions") {
    try {
      const dbRows = await listSessions(100);
      const sessions = (dbRows || []).map(row => ({
        id: row.id,
        name: row.name,
        startedAt: row.started_at,
        savedAt: row.saved_at,
        bank: Number(row.bank),
        balance: Number(row.balance),
        totalPnl: Number(row.total_pnl),
        tradingMode: row.trading_mode,
        strategyName: row.strategy_name,
        strategyType: row.strategy_type,
        windowMinutes: row.window_minutes,
        stats: row.stats,
      }));
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, sessions }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: e.message, sessions: [] }));
    }
    return;
  }

  if (pathname.startsWith("/api/sessions/")) {
    const sessionId = pathname.replace("/api/sessions/", "").trim();
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Missing session ID" }));
      return;
    }

    if (req.method === "DELETE") {
      try {
        await deleteSession(sessionId);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true, sessionId }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    try {
      const row = await getSession(sessionId);
      if (!row?.snapshot) {
        res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "Session not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, session: row.snapshot }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === "/api/live/resume") {
    const p = url.searchParams;
    const sessionId = p.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "sessionId is required" }));
      return;
    }
    let saved = null;
    try {
      const row = await getSession(sessionId);
      if (row?.snapshot) saved = row.snapshot;
    } catch {}
    if (!saved) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Session not found" }));
      return;
    }
    if (liveState.running) stopLive();
    // SSE response — sets up live stream after resuming
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    liveState.subscribers.add(res);
    req.on("close", () => liveState.subscribers.delete(res));
    await startLive({ resumeSessionId: sessionId });
    res.write(`data: ${JSON.stringify({ type: "connected", resumed: true, sessionId, sessionName: liveState.sessionName, balance: liveState.balance, bank: liveState.bank, maxBet: liveState.maxBet, trades: liveState.trades, tradingMode: liveState.tradingMode, configName: liveState.configName, strategyName: liveState.strategyName, strategyDescription: liveState.strategyDescription, strategyType: liveState.strategyType, backtestStats: liveState.backtestStats, totalWindows: liveState.backtestTotalWindows, tpPct: liveState.tpPct, slPct: liveState.slPct, windowMinutes: liveState.windowMinutes, entryMinute: liveState.entryMinute })}\n\n`);
    return;
  }

  if (pathname === "/api/market/current") {
    try {
      const wm = clamp(+(url.searchParams.get("windowMinutes") || 15), 1, 60);
      const mkt = await discoverCurrentMarket(true, wm);
      if (!mkt) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "No active market found" }));
        return;
      }
      let prices = null;
      if (mkt.upTokenId && mkt.downTokenId) {
        prices = await fetchRealPrices(mkt.upTokenId, mkt.downTokenId);
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, market: { slug: mkt.slug, question: mkt.question, endDate: mkt.endDate, endMs: mkt.endMs }, prices }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === "/api/backtest/compare") {
    const p = url.searchParams;
    const parseJ = (s) => { try { return JSON.parse(s); } catch { return {}; } };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const baseConfig = {
        days: clamp(+(p.get("days") || 7), 1, 60),
        bank: +(p.get("bank") || 1000),
        maxBet: Math.max(MIN_BET_USD, +(p.get("maxBet") || MIN_BET_USD)),
        entryMinute: clamp(+(p.get("entryMinute") || 5), 1, 13),
        feeRate: clamp(+(p.get("feeRate") || 0.02), 0, 0.2),
        marketMode: p.get("marketMode") || "dynamic",
        marketSensitivity: clamp(+(p.get("marketSensitivity") || 80), 10, 300),
        windowMinutes: clamp(+(p.get("windowMinutes") || 15), 1, 60),
        weights: parseJ(p.get("weights") || "{}"),
        filters: parseJ(p.get("filters") || "{}"),
      };

      sendSSE({ type: "progress", stage: "running_original", message: "Running original strategy..." });
      const original = await runBacktest({ ...baseConfig }, (prog) => sendSSE({ type: "progress", ...prog, strategy: "original" }));

      sendSSE({ type: "progress", stage: "running_momentum", message: "Running momentum scalp strategy..." });
      const momentum = await runMomentumBacktest({
        ...baseConfig,
        tpPct: clamp(+(p.get("tpPct") || 0.12), 0.01, 0.5),
        slPct: clamp(+(p.get("slPct") || 0.50), 0.1, 1.0),
        saveToDb: p.get("saveToDb") === "true",
        strategyId: p.get("strategyId") || null,
      }, (prog) => sendSSE({ type: "progress", ...prog, strategy: "momentum" }));

      sendSSE({
        type: "compare_result",
        original: { strategy: "hold_to_resolution", stats: original.stats, breakdowns: original.breakdowns, balanceHistory: original.balanceHistory, trades: original.trades, settings: original.settings, totalWindows: original.totalWindows },
        momentum: { strategy: "momentum_scalp", stats: momentum.stats, breakdowns: momentum.breakdowns, balanceHistory: momentum.balanceHistory, trades: momentum.trades, settings: momentum.settings, totalWindows: momentum.totalWindows },
      });
    } catch (err) {
      console.error(err);
      sendSSE({ type: "error", error: err.message });
    }
    res.end();
    return;
  }

  if (pathname === "/api/backtest/optimize") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const p = url.searchParams;
    const days = clamp(+(p.get("days") || 14), 1, 60);
    const bank = +(p.get("bank") || 1000);
    const maxBet = Math.max(MIN_BET_USD, +(p.get("maxBet") || MIN_BET_USD));
    const feeRate = clamp(+(p.get("feeRate") || 0.02), 0, 0.2);
    const marketFilter = p.get("market") || "both";
    // Never persist each optimizer sweep — multiple full DB runs stall the last stage and are rarely needed.
    const saveToDbThisRun = false;

    const zf = { minConfluence: 0, adxGate: 0, atrGateRatio: 0, minProb: 0.50, sessionBoost: false };
    const zfResolution = {
      ...zf,
      resolutionPriorWeight: 0.30,
    };
    const zfResolutionCont = { ...zfResolution, resolutionPriorWeight: 0.42 };
    const zfResolutionTaHeavy = { ...zfResolution, resolutionPriorWeight: 0.08 };
    const zfResolutionConfluence = { ...zfResolution, minConfluence: 6, minProb: 0.57 };
    const zfMomAtr = { ...zf, atrGateRatio: 0.52 };
    const zfMomStrict = { ...zf, minConfluence: 6 };
    // Shorter 5m window: slightly stronger path-to-settle prior + fewer, higher-conviction entries (momentum/clutch timing).
    const zf5mLateConviction = { ...zfResolution, resolutionPriorWeight: 0.38, minConfluence: 5, minProb: 0.56 };
    const allConfigs = [
      // === 15-MINUTE STRATEGIES ===
      { name: "15m Late Sniper",        desc: "Enter min 11, hold to resolution. Settlement prior (open→entry vs TA) aligns with PM close rule.", type: "resolution", windowMinutes: 15, entryMinute: 11, tpPct: null, slPct: null, filters: zfResolution },
      { name: "15m Standard Hold",      desc: "Enter min 10, hold to resolution. Settlement prior blends window BTC path with indicators.", type: "resolution", windowMinutes: 15, entryMinute: 10, tpPct: null, slPct: null, filters: zfResolution },
      { name: "15m Early Hold",         desc: "Enter min 9, hold to resolution. More windows; prior nudges entries toward likely settle side.", type: "resolution", windowMinutes: 15, entryMinute: 9, tpPct: null, slPct: null, filters: zfResolution },
      { name: "15m Momentum Scalp",     desc: "TP 20% / SL 40%, enter min 10. Active risk management, locks in gains.", type: "momentum", windowMinutes: 15, entryMinute: 10, tpPct: 0.20, slPct: 0.40, filters: zf },
      { name: "15m Mean Reversion",     desc: "TP 12% / SL 50%, enter min 11. Tight take-profit exploits price snaps.", type: "momentum", windowMinutes: 15, entryMinute: 11, tpPct: 0.12, slPct: 0.50, filters: zf },
      { name: "15m Trend Rider",        desc: "TP 25% / SL 35%, enter min 9. Rides strong trends with tight stop.", type: "momentum", windowMinutes: 15, entryMinute: 9, tpPct: 0.25, slPct: 0.35, filters: zf },
      { name: "15m Intraday Continuation", desc: "Hold to resolution; stronger open→entry prior (empirical crypto intraday momentum). Entry min 10.", type: "resolution", windowMinutes: 15, entryMinute: 10, tpPct: null, slPct: null, filters: zfResolutionCont },
      { name: "15m TA-Heavy Hold",       desc: "Hold to resolution; weak settlement prior so VWAP/MACD/CCI/Keltner stack drives the call. Entry min 10.", type: "resolution", windowMinutes: 15, entryMinute: 10, tpPct: null, slPct: null, filters: zfResolutionTaHeavy },
      { name: "15m Confluence Resolution", desc: "Hold to resolution; requires 6+ agreeing indicators and higher min model prob. Entry min 10.", type: "resolution", windowMinutes: 15, entryMinute: 10, tpPct: null, slPct: null, filters: zfResolutionConfluence },
      { name: "15m ATR Expansion Scalp", desc: "TP 22% / SL 34%, enter min 9. Only trades when ATR ratio vs recent mean is elevated (volatility participation).", type: "momentum", windowMinutes: 15, entryMinute: 9, tpPct: 0.22, slPct: 0.34, filters: zfMomAtr },
      // === 5-MINUTE STRATEGIES ===
      { name: "5m Late Sniper",         desc: "Enter min 4, hold to resolution. Settlement prior + TA; short window matches PM up/down settle.", type: "resolution", windowMinutes: 5, entryMinute: 4, tpPct: null, slPct: null, filters: zfResolution },
      { name: "5m Standard Hold",       desc: "Enter min 3, hold to resolution. Blend of window BTC path and model for PM resolution.", type: "resolution", windowMinutes: 5, entryMinute: 3, tpPct: null, slPct: null, filters: zfResolution },
      { name: "5m Early Entry",         desc: "Enter min 2, hold to resolution. Higher churn; prior weights open→entry direction.", type: "resolution", windowMinutes: 5, entryMinute: 2, tpPct: null, slPct: null, filters: zfResolution },
      { name: "5m Quick Scalp",         desc: "TP 15% / SL 30%, enter min 3. Fast exits with active risk management.", type: "momentum", windowMinutes: 5, entryMinute: 3, tpPct: 0.15, slPct: 0.30, filters: zf },
      { name: "5m Micro Scalp",         desc: "TP 10% / SL 25%, enter min 4. Ultra-tight exits for quick flips.", type: "momentum", windowMinutes: 5, entryMinute: 4, tpPct: 0.10, slPct: 0.25, filters: zf },
      { name: "5m Aggressive Rider",    desc: "TP 20% / SL 40%, enter min 2. High volume, rides early momentum.", type: "momentum", windowMinutes: 5, entryMinute: 2, tpPct: 0.20, slPct: 0.40, filters: zf },
      { name: "5m Confluence Scalp",    desc: "TP 14% / SL 32%, enter min 3. Tighter entries: min 6-indicator confluence before scalping.", type: "momentum", windowMinutes: 5, entryMinute: 3, tpPct: 0.14, slPct: 0.32, filters: zfMomStrict },
      { name: "5m Late Conviction Hold", desc: "Enter min 4, hold to resolution. Stronger open→entry prior + 5+ confluence and 56% min prob — fewer trades, aims for clarity late in the candle.", type: "resolution", windowMinutes: 5, entryMinute: 4, tpPct: null, slPct: null, filters: zf5mLateConviction },
      // === DUAL POSITION STRATEGIES ===
      { name: "15m Dual Position 5%",  desc: "Buy both UP and DOWN at market open, 5% TP on each side. Profits from volatility.", type: "dual_position", windowMinutes: 15, entryMinute: 0, tpPct: 0.05, slPct: null, filters: zf },
      { name: "15m Dual Position 8%",  desc: "Buy both UP and DOWN at market open, 8% TP on each side. Wider target, fewer fills.", type: "dual_position", windowMinutes: 15, entryMinute: 0, tpPct: 0.08, slPct: null, filters: zf },
      { name: "15m Dual Position 3%",  desc: "Buy both UP and DOWN at market open, 3% TP. Tight target, more fills, smaller profit.", type: "dual_position", windowMinutes: 15, entryMinute: 0, tpPct: 0.03, slPct: null, filters: zf },
      { name: "5m Dual Position 5%",   desc: "Buy both UP and DOWN at 5m market open, 5% TP. Fast markets, higher volatility.", type: "dual_position", windowMinutes: 5, entryMinute: 0, tpPct: 0.05, slPct: null, filters: zf },
      { name: "5m Dual Position 3%",   desc: "Buy both UP and DOWN at 5m market open, 3% TP. Tight target for fast markets.", type: "dual_position", windowMinutes: 5, entryMinute: 0, tpPct: 0.03, slPct: null, filters: zf },
    ];

    const configs = marketFilter === "15" ? allConfigs.filter(c => c.windowMinutes === 15)
                  : marketFilter === "5"  ? allConfigs.filter(c => c.windowMinutes === 5)
                  : allConfigs;

    try {
      const results = [];
      for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        sendSSE({ type: "progress", stage: "running", current: i + 1, total: configs.length, name: cfg.name });

        const baseArgs = { days, bank, maxBet, feeRate, marketMode: "dynamic", marketSensitivity: 80, weights: {}, filters: cfg.filters, entryMinute: cfg.entryMinute, windowMinutes: cfg.windowMinutes };

        let result;
        if (cfg.type === "resolution") {
          result = await runBacktest(baseArgs, null);
        } else if (cfg.type === "dual_position") {
          result = await runDualPositionBacktest({ ...baseArgs, tpPct: cfg.tpPct }, null);
        } else {
          result = await runMomentumBacktest({ ...baseArgs, tpPct: cfg.tpPct, slPct: cfg.slPct, saveToDb: saveToDbThisRun, strategyId: null }, null);
        }

        results.push({
          rank: 0,
          name: cfg.name,
          description: cfg.desc,
          type: cfg.type,
          windowMinutes: cfg.windowMinutes,
          entryMinute: cfg.entryMinute,
          tpPct: cfg.tpPct,
          slPct: cfg.slPct,
          filters: cfg.filters,
          stats: result.stats,
          settings: result.settings,
          breakdowns: result.breakdowns,
          totalWindows: result.totalWindows,
          trades: result.trades,
          dbRunId: result.dbRunId || null,
        });
      }

      results.sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
      results.forEach((r, i) => r.rank = i + 1);

      sendSSE({ type: "progress", stage: "finalizing", current: configs.length, total: configs.length, name: "Ranking & sending results…" });
      const payloadResults = pickOptimizerPayloadRows(results);
      sendSSE({ type: "optimize_result", results: payloadResults, days, bank, maxBet, market: marketFilter });
    } catch (err) {
      console.error(err);
      sendSSE({ type: "error", error: err.message });
    }
    res.end();
    return;
  }

  if (pathname === "/api/strategies") {
    try {
      const { getSupabase } = await import("../src/db/supabase.js");
      const sb = getSupabase();
      if (!sb) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true, strategies: [] }));
        return;
      }
      const { data, error } = await sb.from("strategies").select("*").eq("is_active", true);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, strategies: data || [] }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, strategies: [] }));
    }
    return;
  }

  if (pathname === "/api/data/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, ...getSyncStatus() }));
    return;
  }

  if (pathname === "/api/data/sync") {
    const p = url.searchParams;
    const wm = p.get("windowMinutes") ? +p.get("windowMinutes") : null;
    const daysBack = clamp(+(p.get("daysBack") || 60), 1, 90);

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const sendSSE = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

    try {
      const result = await runSync({
        windowMinutes: wm,
        daysBack,
        onProgress: (ev) => sendSSE({ type: "sync_progress", ...ev }),
      });
      sendSSE({ type: "sync_done", ...result, status: getSyncStatus() });
    } catch (err) {
      console.error("[SYNC]", err);
      sendSSE({ type: "error", error: err.message });
    }
    res.end();
    return;
  }

  // ===================== ARENA ENDPOINTS =====================

  if (pathname === "/api/arena") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    arenaState.subscribers.add(res);
    req.on("close", () => arenaState.subscribers.delete(res));
    res.write(`data: ${JSON.stringify({ type: "arena_connected", running: arenaState.running, sessionId: arenaState.sessionId, startedAt: arenaState.startedAt, strategies: arenaState.strategies.map(s => ({ id: s.id, name: s.name, asset: s.asset, strategyType: s.strategyType, bank: s.bank, balance: s.balance })) })}\n\n`);
    return;
  }

  if (pathname === "/api/arena/start") {
    let body = "";
    req.on("data", c => body += c);
    await new Promise(r => req.on("end", r));
    let configs;
    try { configs = JSON.parse(body); } catch { configs = null; }
    if (!Array.isArray(configs) || configs.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Body must be a JSON array of strategy configs" }));
      return;
    }
    startArena(configs);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, sessionId: arenaState.sessionId, count: arenaState.strategies.length, strategies: arenaState.strategies.map(s => ({ id: s.id, name: s.name })) }));
    return;
  }

  if (pathname === "/api/arena/stop") {
    const sid = arenaState.sessionId;
    stopArena();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, savedSessionId: sid }));
    return;
  }

  if (pathname === "/api/arena/save") {
    if (!arenaState.running) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Arena not running" }));
      return;
    }
    saveArenaSession();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, sessionId: arenaState.sessionId }));
    return;
  }

  if (pathname === "/api/arena/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      running: arenaState.running,
      sessionId: arenaState.sessionId,
      startedAt: arenaState.startedAt,
      strategies: arenaState.strategies.map(s => ({
        id: s.id, name: s.name, strategyType: s.strategyType,
        asset: s.asset, bank: s.bank, balance: s.balance,
        ...arenaStrategyStats(s),
      })),
    }));
    return;
  }

  if (pathname === "/api/arena/rolling") {
    const cycles = Math.max(1, Math.min(500, +(url.searchParams.get("cycles") || 50)));
    const sessionIdParam = url.searchParams.get("sessionId");
    try {
      let strategies;
      let meta;
      if (sessionIdParam) {
        const filePath = path.join(ARENA_SESSION_DIR, `${sessionIdParam}.json`);
        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: "Session file not found" }));
          return;
        }
        const snap = JSON.parse(fs.readFileSync(filePath, "utf8"));
        strategies = (snap.strategies || []).map(deserializeStrategy);
        meta = {
          source: "snapshot",
          sessionId: snap.sessionId,
          windowMinutes: snap.windowMinutes,
          savedAt: snap.savedAt || null,
        };
      } else if (arenaState.running) {
        strategies = arenaState.strategies;
        meta = {
          source: "live",
          sessionId: arenaState.sessionId,
          windowMinutes: arenaState.windowMinutes,
          startedAt: arenaState.startedAt,
        };
      } else {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({
          ok: false,
          error: "Arena not running. Pass ?sessionId=arena_... to read a saved session, or start the arena.",
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        ok: true,
        cycles,
        ...meta,
        strategies: summarizeArenaStrategies(strategies, cycles),
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === "/api/arena/sessions") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true, sessions: listArenaSessions() }));
    return;
  }

  if (pathname === "/api/arena/resume") {
    let body = "";
    req.on("data", c => body += c);
    await new Promise(r => req.on("end", r));
    let data;
    try { data = JSON.parse(body); } catch { data = null; }
    const sessionId = data?.sessionId;
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Missing sessionId" }));
      return;
    }
    const filePath = path.join(ARENA_SESSION_DIR, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "Session not found" }));
      return;
    }
    try {
      const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
      resumeArena(session);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true, sessionId: session.sessionId, strategies: arenaState.strategies.length }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === "/api/arena/markets") {
    const wm = clamp(+(url.searchParams.get("windowMinutes") || 15), 1, 60);
    const wKey = wm <= 5 ? 5 : 15;
    const seriesMap = ARENA_SERIES[wKey] || {};
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      ok: true,
      windowMinutes: wKey,
      assets: Object.entries(seriesMap).map(([asset, info]) => ({
        asset,
        name: info.name,
        symbol: info.symbol,
        seriesId: info.seriesId,
      })),
    }));
    return;
  }

  if (pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      ok: false,
      error: "Unknown API route",
      path: pathname,
      hint: "Run the dashboard with: npm run backtest (serves backtest/server.js on port 3000)",
    }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use (another app or an old backtest server).`);
    console.error(`\n  Free it:    lsof -ti:${PORT} | xargs kill -9`);
    console.error(`  Or use:     PORT=3001 npm run backtest   (then open http://localhost:3001/)\n`);
    process.exit(1);
  }
  throw err;
});

const AUTO_SYNC_INTERVAL_MS = 60 * 60_000; // 60 minutes

async function autoSync() {
  console.log("[AUTO-SYNC] Starting background data sync…");
  try {
    const result = await runSync({ daysBack: 60 });
    const s = await Promise.resolve(getSyncStatus());
    console.log(
      `[AUTO-SYNC] Done — 15m: +${result.markets15m} mkts / +${result.prices15m} prices` +
      ` | 5m: +${result.markets5m} mkts / +${result.prices5m} prices` +
      ` | totals: ${s.markets15m}/${s.prices15m} (15m) · ${s.markets5m}/${s.prices5m} (5m)`
    );
  } catch (err) {
    console.error("[AUTO-SYNC] Failed:", err.message);
  }
}

server.listen(PORT, async () => {
  console.log(`\n  Backtest UI running at http://localhost:${PORT}`);
  console.log(`  CLOB account JSON: http://localhost:${PORT}/api/polymarket/account`);
  console.log(`  (from project root: npm run backtest — so .env is loaded)\n`);
  if (process.env.POLYMARKET_PRIVATE_KEY) {
    if (process.env.POLYMARKET_API_KEY) console.log(`  Polymarket API Key: configured`);
    console.log(`  Funder Address: ${process.env.POLYMARKET_FUNDER_ADDRESS || "not set"}`);
    await initClobClient();
  } else if (process.env.POLYMARKET_API_KEY) {
    console.log(`  Polymarket API Key: configured (private key not set — CLOB account API disabled)\n`);
  }

  // Initial sync on startup, then repeat every 60 minutes
  autoSync();
  setInterval(autoSync, AUTO_SYNC_INTERVAL_MS);
  console.log(`  Auto-sync: every ${AUTO_SYNC_INTERVAL_MS / 60_000} min (next in ~${AUTO_SYNC_INTERVAL_MS / 60_000} min after startup sync)\n`);
});

function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Shutting down...`);
  if (arenaState.running) {
    saveArenaSession();
    console.log("[ARENA] Session saved on shutdown");
  }
  process.exit(0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
