export function computeObv(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;

  const obvSeries = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = obvSeries[obvSeries.length - 1];
    if (candles[i].close > candles[i - 1].close) {
      obvSeries.push(prev + candles[i].volume);
    } else if (candles[i].close < candles[i - 1].close) {
      obvSeries.push(prev - candles[i].volume);
    } else {
      obvSeries.push(prev);
    }
  }

  return obvSeries;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function computeObvSignal(candles, fastPeriod = 6, slowPeriod = 24) {
  const obvSeries = computeObv(candles);
  if (!obvSeries || obvSeries.length < slowPeriod) return null;

  const fastEma = ema(obvSeries, fastPeriod);
  const slowEma = ema(obvSeries, slowPeriod);

  if (fastEma === null || slowEma === null) return null;

  const prevObv = obvSeries.slice(0, -1);
  const prevFast = ema(prevObv, fastPeriod);
  const prevSlow = ema(prevObv, slowPeriod);

  const bullish = fastEma > slowEma;
  const crossUp = prevFast !== null && prevSlow !== null && prevFast <= prevSlow && fastEma > slowEma;
  const crossDown = prevFast !== null && prevSlow !== null && prevFast >= prevSlow && fastEma < slowEma;

  const obvNow = obvSeries[obvSeries.length - 1];
  const obvPrev = obvSeries.length >= 6 ? obvSeries[obvSeries.length - 6] : null;
  const rising = obvPrev !== null ? obvNow > obvPrev : null;

  return { obv: obvNow, fastEma, slowEma, bullish, crossUp, crossDown, rising };
}
