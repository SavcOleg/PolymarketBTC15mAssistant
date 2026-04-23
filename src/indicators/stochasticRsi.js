import { clamp } from "../utils.js";
import { computeRsi } from "./rsi.js";

export function computeStochRsi(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  if (!Array.isArray(closes) || closes.length < rsiPeriod + stochPeriod + kSmooth) return null;

  const rsiValues = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    const r = computeRsi(closes.slice(0, i), rsiPeriod);
    if (r !== null) rsiValues.push(r);
  }

  if (rsiValues.length < stochPeriod + kSmooth) return null;

  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const high = Math.max(...window);
    const low = Math.min(...window);
    const range = high - low;
    rawK.push(range > 0 ? ((rsiValues[i] - low) / range) * 100 : 50);
  }

  if (rawK.length < kSmooth) return null;

  const kValues = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    const slice = rawK.slice(i - kSmooth + 1, i + 1);
    kValues.push(slice.reduce((a, b) => a + b, 0) / kSmooth);
  }

  if (kValues.length < dSmooth) return null;

  const dValues = [];
  for (let i = dSmooth - 1; i < kValues.length; i++) {
    const slice = kValues.slice(i - dSmooth + 1, i + 1);
    dValues.push(slice.reduce((a, b) => a + b, 0) / dSmooth);
  }

  const k = clamp(kValues[kValues.length - 1], 0, 100);
  const d = clamp(dValues[dValues.length - 1], 0, 100);

  const prevK = kValues.length >= 2 ? kValues[kValues.length - 2] : null;
  const prevD = dValues.length >= 2 ? dValues[dValues.length - 2] : null;

  const overbought = k > 80;
  const oversold = k < 20;
  const crossUp = prevK !== null && prevD !== null && prevK <= prevD && k > d;
  const crossDown = prevK !== null && prevD !== null && prevK >= prevD && k < d;
  const bullish = k > d;

  return { k, d, overbought, oversold, crossUp, crossDown, bullish };
}
