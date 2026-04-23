function wilderSmooth(values, period) {
  if (values.length < period) return [];
  const result = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result.push(sum);
  for (let i = period; i < values.length; i++) {
    result.push(result[result.length - 1] - result[result.length - 1] / period + values[i]);
  }
  return result;
}

export function computeAdx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return null;

  const plusDm = [];
  const minusDm = [];
  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const c = candles[i].close;
    const ph = candles[i - 1].high;
    const pl = candles[i - 1].low;
    const pc = candles[i - 1].close;

    const upMove = h - ph;
    const downMove = pl - l;

    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  const smoothTr = wilderSmooth(tr, period);
  const smoothPlusDm = wilderSmooth(plusDm, period);
  const smoothMinusDm = wilderSmooth(minusDm, period);

  const len = Math.min(smoothTr.length, smoothPlusDm.length, smoothMinusDm.length);
  if (len < period) return null;

  const dx = [];
  for (let i = 0; i < len; i++) {
    const plusDi = smoothTr[i] !== 0 ? (smoothPlusDm[i] / smoothTr[i]) * 100 : 0;
    const minusDi = smoothTr[i] !== 0 ? (smoothMinusDm[i] / smoothTr[i]) * 100 : 0;
    const diSum = plusDi + minusDi;
    dx.push(diSum !== 0 ? (Math.abs(plusDi - minusDi) / diSum) * 100 : 0);
  }

  const adxSmoothed = wilderSmooth(dx, period);
  if (!adxSmoothed.length) return null;

  const adx = adxSmoothed[adxSmoothed.length - 1] / period;

  const lastTr = smoothTr[len - 1];
  const plusDi = lastTr !== 0 ? (smoothPlusDm[len - 1] / lastTr) * 100 : 0;
  const minusDi = lastTr !== 0 ? (smoothMinusDm[len - 1] / lastTr) * 100 : 0;

  const trending = adx > 20;
  const strongTrend = adx > 25;
  const choppy = adx < 15;
  const bullish = plusDi > minusDi;

  return { adx, plusDi, minusDi, trending, strongTrend, choppy, bullish };
}
