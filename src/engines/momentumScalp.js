import { clamp } from "../utils.js";

/**
 * Momentum Scalp Strategy with Active TP/SL
 *
 * Unlike the hold-to-resolution approach, this strategy:
 * 1. Enters based on multi-indicator confluence (same scoring engine)
 * 2. Monitors share price after entry in real-time
 * 3. Exits at TP (10-15% profit) or SL (50% loss) — whichever comes first
 * 4. Falls back to resolution-based exit only if neither triggers
 *
 * The key insight from research: Polymarket share prices swing 20-50% within
 * a 15m window due to thin liquidity and momentum. We exploit this volatility
 * by taking quick profits rather than holding to resolution.
 */

export const STRATEGY_DEFAULTS = {
  tpPct: 0.12,
  slPct: 0.50,
  maxBet: 5,
  windowMinutes: 15,
  entryMinute: 5,
  feeRate: 0.02,
  hedgeEnabled: true,
  hedgeThreshold: 0.30,
  maxTradesPerWindow: 1,
};

export function computeTpSlPrices(entryPrice, tpPct, slPct) {
  return {
    tpPrice: tpPct != null ? +(entryPrice * (1 + tpPct)).toFixed(4) : null,
    slPrice: slPct != null ? +(entryPrice * (1 - slPct)).toFixed(4) : null,
  };
}

/**
 * Check if current share price has hit TP or SL.
 * Returns { action, exitPrice, reason, pnlPct } or null if no trigger.
 */
export function checkTpSl(entryPrice, currentPrice, tpPct, slPct) {
  if (entryPrice <= 0 || currentPrice <= 0) return null;

  const changePct = (currentPrice - entryPrice) / entryPrice;

  if (tpPct != null && changePct >= tpPct) {
    return {
      action: "EXIT",
      exitPrice: currentPrice,
      reason: "TP_HIT",
      pnlPct: changePct,
    };
  }

  if (slPct != null && changePct <= -slPct) {
    return {
      action: "EXIT",
      exitPrice: currentPrice,
      reason: "SL_HIT",
      pnlPct: changePct,
    };
  }

  return null;
}

/**
 * Enhanced entry decision that factors in momentum quality.
 * On top of the base decideV2, adds:
 * - Momentum burst detection (price moved significantly in last few candles)
 * - Volume confirmation (volume above average)
 * - Regime filter (avoid choppy markets)
 */
export function decideMomentumEntry({
  remainingMinutes,
  modelUp,
  modelDown,
  confluence,
  filtered,
  indicators,
  windowMinutes = 15,
  config = {},
}) {
  const minProb = config.minProb || 0.60;
  const minConfluence = config.minConfluence || 5;

  const phase = remainingMinutes > (windowMinutes * 0.67)
    ? "EARLY"
    : remainingMinutes > (windowMinutes * 0.33)
      ? "MID"
      : "LATE";

  if (filtered) {
    return { action: "NO_TRADE", side: null, phase, reason: filtered, strength: null };
  }

  const tooLateThreshold = Math.max(0.3, windowMinutes * 0.1);
  if (phase === "LATE" && remainingMinutes < tooLateThreshold) {
    return { action: "NO_TRADE", side: null, phase, reason: "too_late", strength: null };
  }

  const bestSide = modelUp >= modelDown ? "UP" : "DOWN";
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}`, strength: null };
  }

  if (confluence < minConfluence) {
    return { action: "NO_TRADE", side: null, phase, reason: `confluence_below_${minConfluence}`, strength: null };
  }

  if (indicators) {
    const regimeTag = typeof indicators.regime === "string"
      ? indicators.regime
      : indicators.regime?.regime;
    if (regimeTag === "CHOP" && confluence < 7) {
      return { action: "NO_TRADE", side: null, phase, reason: "choppy_market", strength: null };
    }

    if (indicators.atrData?.ratio != null && indicators.atrData.ratio < 0.4) {
      return { action: "NO_TRADE", side: null, phase, reason: "low_volatility", strength: null };
    }

    const volumeRatio = indicators.volumeRecent && indicators.volumeAvg
      ? indicators.volumeRecent / indicators.volumeAvg
      : 1;
    if (volumeRatio < 0.6) {
      return { action: "NO_TRADE", side: null, phase, reason: "low_volume", strength: null };
    }
  }

  const strength = confluence >= 8
    ? "STRONG"
    : confluence >= 6
      ? "GOOD"
      : "MODERATE";

  return {
    action: "ENTER",
    side: bestSide,
    phase,
    strength,
    confluence,
    modelProb: bestModel,
  };
}

/**
 * Simulate TP/SL within a backtest window.
 * Uses real CLOB price path when available, otherwise falls back to
 * BTC-derived synthetic share price modeling.
 */
export function simulateTpSlInWindow({
  entryPrice,
  entryCandleIdx,
  windowCandles,
  side,
  tpPct,
  slPct,
  feeRate,
  realPricePath = null,
  realResolution = null,
}) {
  if (!windowCandles.length || entryCandleIdx >= windowCandles.length) {
    return { exitReason: "NO_DATA", exitPrice: entryPrice, exitMinute: 0, pnl: 0 };
  }

  const windowOpen = windowCandles[0].open;
  const totalCandles = windowCandles.length;
  const { tpPrice, slPrice } = computeTpSlPrices(entryPrice, tpPct, slPct);

  if (realPricePath && realPricePath.length >= 2) {
    const sorted = [...realPricePath].sort((a, b) => a.t - b.t);

    for (let i = 0; i < sorted.length; i++) {
      const pt = sorted[i];
      let sharePrice = side === "UP" ? pt.p : 1 - pt.p;
      sharePrice = clamp(sharePrice, 0.02, 0.98);

      if (slPrice !== null && sharePrice <= slPrice) {
        const exitPrice = slPrice;
        const shares = 1 / entryPrice;
        return {
          exitReason: "SL_HIT",
          exitPrice: +exitPrice.toFixed(4),
          exitMinute: Math.min(i + entryCandleIdx + 1, totalCandles - 1),
          pnl: +((exitPrice - entryPrice) * shares).toFixed(4),
          shareEstimate: +sharePrice.toFixed(4),
        };
      }

      if (tpPrice !== null && sharePrice >= tpPrice) {
        const exitPrice = tpPrice;
        const shares = 1 / entryPrice;
        const grossProfit = (exitPrice - entryPrice) * shares;
        const fee = grossProfit * feeRate;
        return {
          exitReason: "TP_HIT",
          exitPrice: +exitPrice.toFixed(4),
          exitMinute: Math.min(i + entryCandleIdx + 1, totalCandles - 1),
          pnl: +(grossProfit - fee).toFixed(4),
          shareEstimate: +sharePrice.toFixed(4),
        };
      }
    }

    const useRealRes = realResolution != null;
    const correct = useRealRes
      ? (side === "UP" && realResolution === "UP") || (side === "DOWN" && realResolution === "DOWN")
      : (() => { const fc = windowCandles[totalCandles - 1]; return (side === "UP" && fc.close >= windowOpen) || (side === "DOWN" && fc.close < windowOpen); })();

    if (correct) {
      const shares = 1 / entryPrice;
      const grossProfit = (1.0 - entryPrice) * shares;
      const fee = grossProfit * feeRate;
      return { exitReason: "RESOLVED_WIN", exitPrice: 1.0, exitMinute: totalCandles - 1, pnl: +(grossProfit - fee).toFixed(4), shareEstimate: 0.95 };
    }
    return { exitReason: "RESOLVED_LOSS", exitPrice: 0.0, exitMinute: totalCandles - 1, pnl: +(0 - 1).toFixed(4), shareEstimate: 0.05 };
  }

  for (let i = entryCandleIdx + 1; i < totalCandles; i++) {
    const candle = windowCandles[i];
    const minuteInWindow = i;
    const remainingRatio = (totalCandles - i) / totalCandles;

    const btcChangePct = (candle.close - windowOpen) / windowOpen;

    let sharePriceEstimate;
    if (side === "UP") {
      sharePriceEstimate = clamp(0.5 + btcChangePct * 150 * (0.5 + 0.5 * remainingRatio), 0.02, 0.98);
    } else {
      sharePriceEstimate = clamp(0.5 - btcChangePct * 150 * (0.5 + 0.5 * remainingRatio), 0.02, 0.98);
    }

    const btcHigh = candle.high;
    const btcLow = candle.low;
    const highChange = (btcHigh - windowOpen) / windowOpen;
    const lowChange = (btcLow - windowOpen) / windowOpen;

    let shareHigh, shareLow;
    if (side === "UP") {
      shareHigh = clamp(0.5 + highChange * 150 * (0.5 + 0.5 * remainingRatio), 0.02, 0.98);
      shareLow = clamp(0.5 + lowChange * 150 * (0.5 + 0.5 * remainingRatio), 0.02, 0.98);
    } else {
      shareHigh = clamp(0.5 - lowChange * 150 * (0.5 + 0.5 * remainingRatio), 0.02, 0.98);
      shareLow = clamp(0.5 - highChange * 150 * (0.5 + 0.5 * remainingRatio), 0.02, 0.98);
    }

    if (slPrice !== null && shareLow <= slPrice) {
      const exitPrice = slPrice;
      const shares = 1 / entryPrice;
      const rawPnl = (exitPrice - entryPrice) * shares;
      return {
        exitReason: "SL_HIT",
        exitPrice: +exitPrice.toFixed(4),
        exitMinute: minuteInWindow,
        pnl: +rawPnl.toFixed(4),
        shareEstimate: +sharePriceEstimate.toFixed(4),
      };
    }

    if (tpPrice !== null && shareHigh >= tpPrice) {
      const exitPrice = tpPrice;
      const shares = 1 / entryPrice;
      const grossProfit = (exitPrice - entryPrice) * shares;
      const fee = grossProfit * feeRate;
      return {
        exitReason: "TP_HIT",
        exitPrice: +exitPrice.toFixed(4),
        exitMinute: minuteInWindow,
        pnl: +(grossProfit - fee).toFixed(4),
        shareEstimate: +sharePriceEstimate.toFixed(4),
      };
    }
  }

  const useRealRes = realResolution != null;
  const finalCandle = windowCandles[totalCandles - 1];
  const actualUp = useRealRes ? realResolution === "UP" : finalCandle.close >= windowOpen;
  const correct = (side === "UP" && actualUp) || (side === "DOWN" && !actualUp);

  if (correct) {
    const resolutionPrice = 1.0;
    const shares = 1 / entryPrice;
    const grossProfit = (resolutionPrice - entryPrice) * shares;
    const fee = grossProfit * feeRate;
    return {
      exitReason: "RESOLVED_WIN",
      exitPrice: 1.0,
      exitMinute: totalCandles - 1,
      pnl: +(grossProfit - fee).toFixed(4),
      shareEstimate: correct ? 0.95 : 0.05,
    };
  }

  return {
    exitReason: "RESOLVED_LOSS",
    exitPrice: 0.0,
    exitMinute: totalCandles - 1,
    pnl: +(0 - 1).toFixed(4),
    shareEstimate: correct ? 0.95 : 0.05,
  };
}

/**
 * Build trade signal record for database storage.
 */
export function buildTradeSignals(tradeId, indicators, scored, ta) {
  return {
    trade_id: tradeId,
    rsi: indicators.rsi,
    rsi_slope: indicators.rsiSlope,
    vwap: indicators.vwap,
    vwap_dist_pct: indicators.vwap ? ((indicators.price - indicators.vwap) / indicators.vwap * 100) : null,
    vwap_slope: indicators.vwapSlope,
    macd_line: indicators.macd?.macd,
    macd_signal: indicators.macd?.signal,
    macd_hist: indicators.macd?.hist,
    macd_hist_delta: indicators.macd?.histDelta,
    heiken_color: indicators.heikenColor,
    heiken_count: indicators.heikenCount,
    bb_upper: indicators.bb?.upper,
    bb_middle: indicators.bb?.middle,
    bb_lower: indicators.bb?.lower,
    bb_position: indicators.bb?.position,
    bb_squeeze: indicators.squeeze?.isSqueeze,
    ema_bullish: indicators.emaCross?.bullish,
    ema_cross_up: indicators.emaCross?.crossUp,
    ema_cross_down: indicators.emaCross?.crossDown,
    ema_spread: indicators.emaCross?.spread,
    adx: indicators.adx?.adx,
    adx_plus_di: indicators.adx?.plusDi,
    adx_minus_di: indicators.adx?.minusDi,
    adx_trending: indicators.adx?.trending,
    stoch_k: indicators.stochRsi?.k,
    stoch_d: indicators.stochRsi?.d,
    stoch_cross_up: indicators.stochRsi?.crossUp,
    stoch_cross_down: indicators.stochRsi?.crossDown,
    obv_bullish: indicators.obvSignal?.bullish,
    obv_cross_up: indicators.obvSignal?.crossUp,
    atr: indicators.atrData?.atr,
    atr_ratio: indicators.atrData?.ratio,
    atr_expanding: indicators.atrData?.expanding,
    raw_up_score: scored.rawUp,
    time_decay: ta.timeDecay,
    adjusted_up: ta.adjustedUp,
    adjusted_down: ta.adjustedDown,
    filtered_reason: scored.filtered,
    volume_recent: indicators.volumeRecent,
    volume_avg: indicators.volumeAvg,
    volume_ratio: indicators.volumeRecent && indicators.volumeAvg
      ? indicators.volumeRecent / indicators.volumeAvg
      : null,
    signal_details: scored.signals ? JSON.stringify(scored.signals) : null,
  };
}

/**
 * Build a trade record for database insertion.
 */
export function buildTradeRecord({
  strategyId,
  side,
  entryPrice,
  cost,
  tpPct,
  slPct,
  windowStart,
  windowEnd,
  windowMinutes,
  tokenId,
  marketSlug,
  marketQuestion,
  btcPrice,
  btcWindowOpen,
  prices,
  modelUp,
  modelDown,
  confluence,
  regime,
  strength,
  phase,
  tradingMode,
}) {
  const { tpPrice, slPrice } = computeTpSlPrices(entryPrice, tpPct, slPct);
  const shares = cost / entryPrice;

  return {
    strategy_id: strategyId,
    market_slug: marketSlug || null,
    market_question: marketQuestion || null,
    window_start: new Date(windowStart).toISOString(),
    window_end: new Date(windowEnd).toISOString(),
    window_minutes: windowMinutes,
    side,
    entry_price: +entryPrice.toFixed(4),
    entry_size: +shares.toFixed(4),
    entry_cost: cost,
    entry_time: new Date().toISOString(),
    token_id: tokenId || null,
    tp_pct: tpPct ?? 0,
    sl_pct: slPct ?? 0,
    tp_price: tpPrice,
    sl_price: slPrice,
    status: "OPEN",
    btc_price_at_entry: btcPrice ? +btcPrice.toFixed(2) : null,
    btc_window_open: btcWindowOpen ? +btcWindowOpen.toFixed(2) : null,
    market_up_ask: prices?.upAsk ?? null,
    market_up_bid: prices?.upBid ?? null,
    market_down_ask: prices?.downAsk ?? null,
    market_down_bid: prices?.downBid ?? null,
    market_spread: prices?.spread ?? null,
    model_up: +modelUp.toFixed(4),
    model_down: +modelDown.toFixed(4),
    confluence,
    regime,
    strength,
    phase,
    trading_mode: tradingMode,
  };
}
