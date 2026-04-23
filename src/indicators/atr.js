export function computeAtr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trValues.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  if (trValues.length < period) return null;

  let atr = 0;
  for (let i = 0; i < period; i++) atr += trValues[trValues.length - period + i];
  atr /= period;

  return atr;
}

export function computeAtrWithAvg(candles, period = 14, avgLookback = 20) {
  if (!Array.isArray(candles) || candles.length < period + avgLookback + 1) return null;

  const atrSeries = [];
  for (let i = period + 1; i <= candles.length; i++) {
    const sub = candles.slice(0, i);
    const a = computeAtr(sub, period);
    if (a !== null) atrSeries.push(a);
  }

  if (atrSeries.length < avgLookback) return null;

  const current = atrSeries[atrSeries.length - 1];
  const avgSlice = atrSeries.slice(-avgLookback);
  const avg = avgSlice.reduce((a, b) => a + b, 0) / avgSlice.length;

  const ratio = avg > 0 ? current / avg : 1;
  const expanding = ratio > 1.2;
  const contracting = ratio < 0.7;
  const lowVolatility = contracting;

  return { atr: current, avgAtr: avg, ratio, expanding, contracting, lowVolatility };
}
