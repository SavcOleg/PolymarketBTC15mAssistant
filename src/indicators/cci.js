import { clamp } from "../utils.js";

/**
 * Commodity Channel Index (standard 0.015 scaling).
 */
export function computeCci(highs, lows, closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  if (highs.length !== closes.length || lows.length !== closes.length) return null;

  let tpSum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    tpSum += (highs[i] + lows[i] + closes[i]) / 3;
  }
  const smaTp = tpSum / period;

  let meanDev = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    meanDev += Math.abs(tp - smaTp);
  }
  meanDev /= period;

  const last = closes.length - 1;
  const lastTp = (highs[last] + lows[last] + closes[last]) / 3;

  if (meanDev === 0) return null;

  const raw = (lastTp - smaTp) / (0.015 * meanDev);
  return {
    value: raw,
    extremeHigh: raw > 100,
    extremeLow: raw < -100,
    normalized: clamp(raw / 200, -1, 1),
  };
}
