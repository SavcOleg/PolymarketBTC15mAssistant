import { clamp } from "../utils.js";

/**
 * Williams %R (-100 … 0). Below -80 often treated oversold; above -20 overbought.
 */
export function computeWilliamsR(highs, lows, closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  if (highs.length !== closes.length || lows.length !== closes.length) return null;

  const sliceH = highs.slice(-period);
  const sliceL = lows.slice(-period);
  const hh = Math.max(...sliceH);
  const ll = Math.min(...sliceL);
  const c = closes[closes.length - 1];

  if (hh === ll) return { value: -50, oversold: false, overbought: false, normalized: 0 };

  const r = ((hh - c) / (hh - ll)) * -100;
  return {
    value: r,
    oversold: r <= -80,
    overbought: r >= -20,
    normalized: clamp((r + 50) / 50, -1, 1),
  };
}
