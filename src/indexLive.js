import "dotenv/config";
import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { SignalBuffer } from "./engines/signalBuffer.js";
import { liveTrader } from "./engines/liveTrader.js";
import { dualPositionStrategy } from "./engines/dualPositionStrategy.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { redeemWinningPositions } from "../backtest/clobTrader.js";

applyGlobalProxyFromEnv();

const MIN_TRADE_SIZE_USD = 5.0;

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  dim: "\x1b[2m"
};

function log(level, message) {
  const timestamp = new Date().toISOString();
  const colors = {
    INFO: ANSI.cyan,
    SUCCESS: ANSI.green,
    WARNING: ANSI.yellow,
    ERROR: ANSI.red,
    TRADE: ANSI.magenta
  };
  const color = colors[level] || ANSI.reset;
  console.log(`${ANSI.gray}[${timestamp}]${ANSI.reset} ${color}[${level}]${ANSI.reset} ${message}`);
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtcMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = gammaYes;
    downBuy = gammaNo;
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtcMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function main() {
  log("INFO", "Starting Live Trading Mode");
  log("INFO", `Minimum trade size: $${MIN_TRADE_SIZE_USD || 5}`);
  log("INFO", "Exit strategy: Resolution-based only (no early exit)");
  log("INFO", "Dual Position Strategy: Buy UP and DOWN on EVERY new BTC market with 5% take-profit");

  // Initialize trader
  const initialized = await liveTrader.init();
  if (!initialized) {
    log("ERROR", "Failed to initialize live trader. Exiting.");
    return;
  }

  log("SUCCESS", "Live trader initialized");

  // Check initial balance
  const balResult = await liveTrader.getBalance();
  if (balResult.ok) {
    log("INFO", `Current balance: $${balResult.balance.toFixed(2)}`);
  }

  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  const signalBuf = new SignalBuffer({ windowSecs: 60, minRatio: 0.70, minCount: 10 });
  let lastWindowSlug = null;
  let lastRedemptionCheck = 0;
  const REDEMPTION_CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes

  while (true) {
    try {
      const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

      const wsTick = binanceStream.getLast();
      const wsPrice = wsTick?.price ?? null;

      const polymarketWsTick = polymarketLiveStream.getLast();
      const polymarketWsPrice = polymarketWsTick?.price ?? null;

      const chainlinkWsTick = chainlinkStream.getLast();
      const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      // Update positions (check for fills and resolutions)
      await liveTrader.updatePositions();

      // Cleanup completed markets in strategy
      dualPositionStrategy.cleanup();

      // Check for redemptions periodically
      const now = Date.now();
      if (now - lastRedemptionCheck > REDEMPTION_CHECK_INTERVAL) {
        log("INFO", "Checking for redeemable positions...");
        const redeemResult = await redeemWinningPositions();
        if (redeemResult.ok && redeemResult.redeemed > 0) {
          log("SUCCESS", `Redeemed ${redeemResult.redeemed} winning position(s)`);
        }
        lastRedemptionCheck = now;
      }

      if (!poly.ok) {
        log("WARNING", `No active market found: ${poly.reason}`);
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }

      const market = poly.market;
      const currentWindowSlug = String(market?.slug ?? "");

      // Reset signal buffer on new market window
      if (currentWindowSlug && currentWindowSlug !== lastWindowSlug) {
        signalBuf.reset();
        lastWindowSlug = currentWindowSlug;
        log("INFO", `New market window: ${currentWindowSlug}`);
      }

      // Check for all BTC up/down markets for dual position strategy
      if (market.slug && (market.slug.includes("btc") || market.slug.includes("BTC"))) {
        const shouldEnter = dualPositionStrategy.shouldEnter(market, poly.prices);
        
        if (shouldEnter) {
          log("TRADE", `Dual Position Strategy triggered for ${market.slug}`);
          
          const entryResult = await dualPositionStrategy.enter({
            market,
            tokens: poly.tokens,
            prices: poly.prices
          });

          if (entryResult.ok) {
            log("SUCCESS", `Dual position opened successfully`);
          } else if (entryResult.partialSuccess) {
            log("WARNING", `Dual position partially opened (some orders failed)`);
          } else {
            log("ERROR", `Dual position entry failed: ${entryResult.error}`);
          }
        }
      }

      // Technical analysis for signal-based trading on 15m markets
      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim
      });

      const settlementMs = market?.endDate ? new Date(market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.prices.up;
      const marketDown = poly.prices.down;
      const edge = computeEdge({ 
        modelUp: timeAware.adjustedUp, 
        modelDown: timeAware.adjustedDown, 
        marketYes: marketUp, 
        marketNo: marketDown 
      });

      const rec = decide({
        remainingMinutes: timeLeftMin,
        edgeUp: edge.edgeUp,
        edgeDown: edge.edgeDown,
        modelUp: timeAware.adjustedUp,
        modelDown: timeAware.adjustedDown,
        entryMinute: timing.elapsedMinutes,
        regime: regimeInfo.regime,
      });

      signalBuf.push({ action: rec.action, side: rec.side });

      const bufState = signalBuf.consensus();
      const confirmedRec = rec.action === "ENTER" && !bufState.agree
        ? { ...rec, action: "NO_TRADE", reason: "awaiting_consensus", strength: null }
        : rec;

      // Execute signal-based trades on 15m markets (if enabled)
      if (confirmedRec.action === "ENTER" && market.slug && market.slug.includes("15m")) {
        const side = confirmedRec.side;
        const tokenId = side === "UP" ? poly.tokens.upTokenId : poly.tokens.downTokenId;
        const price = side === "UP" ? poly.prices.up : poly.prices.down;

        log("TRADE", `Signal-based trade: ${side} @ ${price}¢ (${confirmedRec.strength}, edge: ${confirmedRec.edge?.toFixed(3)})`);

        const tradeResult = await liveTrader.placeBuy({
          tokenId,
          price,
          side,
          market
        });

        if (tradeResult.ok) {
          log("SUCCESS", `Signal-based position opened: ${side} (buy + TP sell placed together)`);
        } else {
          log("ERROR", `Signal-based trade failed: ${tradeResult.error}`);
        }
      }

      // Display status
      const positionsSummary = liveTrader.getPositionsSummary();
      const strategyStatus = dualPositionStrategy.getStatus();
      
      log("INFO", `Positions: ${positionsSummary.count} | Strategy markets: ${strategyStatus.activeMarkets} | Signal: ${confirmedRec.action} ${confirmedRec.side || ""}`);

    } catch (err) {
      log("ERROR", `${err?.message ?? String(err)}`);
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

// Graceful shutdown handler
process.on('SIGINT', async () => {
  log("WARNING", "Received SIGINT, shutting down gracefully...");
  
  try {
    await liveTrader.closeSession();
    log("INFO", "Session closed successfully");
  } catch (err) {
    log("ERROR", `Error closing session: ${err.message}`);
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log("WARNING", "Received SIGTERM, shutting down gracefully...");
  
  try {
    await liveTrader.closeSession();
    log("INFO", "Session closed successfully");
  } catch (err) {
    log("ERROR", `Error closing session: ${err.message}`);
  }
  
  process.exit(0);
});

main();
