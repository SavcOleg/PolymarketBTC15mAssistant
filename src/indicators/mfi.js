import { clamp } from "../utils.js";

/**
 * Money Flow Index (volume-weighted RSI-style oscillator, 0–100).
 */
export function computeMfi(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  let posFlow = 0;
  let negFlow = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = (candles[i - 1].high + candles[i - 1].low + candles[i - 1].close) / 3;
    const rmf = tp * (candles[i].volume || 0);

    if (tp > prevTp) posFlow += rmf;
    else if (tp < prevTp) negFlow += rmf;
  }

  if (posFlow + negFlow === 0) return { value: 50, oversold: false, overbought: false };

  const mfr = posFlow / negFlow;
  const value = 100 - 100 / (1 + mfr);

  return {
    value,
    oversold: value < 20,
    overbought: value > 80,
    normalized: clamp((value - 50) / 50, -1, 1),
  };
}
