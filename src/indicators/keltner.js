import { computeAtr } from "./atr.js";
import { computeEma } from "./ema.js";

/**
 * Keltner channels (EMA mid + ATR envelopes). `position` matches Bollinger-style 0..1 band placement.
 */
export function computeKeltner(candles, closes, emaPeriod = 20, atrPeriod = 10, mult = 2) {
  if (!Array.isArray(candles) || !Array.isArray(closes)) return null;
  if (candles.length < Math.max(emaPeriod, atrPeriod) + 2 || closes.length < emaPeriod) return null;

  const middle = computeEma(closes, emaPeriod);
  const atr = computeAtr(candles, atrPeriod);
  if (middle == null || atr == null) return null;

  const upper = middle + mult * atr;
  const lower = middle - mult * atr;
  const last = closes[closes.length - 1];
  const span = upper - lower;
  const position = span > 0 ? (last - lower) / span : 0.5;

  return { upper, lower, middle, atr, position: Math.max(0, Math.min(1, position)) };
}
