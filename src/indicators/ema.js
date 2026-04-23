export function computeEma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function computeEmaCrossover(closes, fastPeriod = 9, slowPeriod = 21) {
  if (!Array.isArray(closes) || closes.length < slowPeriod + 1) return null;

  const fastNow = computeEma(closes, fastPeriod);
  const slowNow = computeEma(closes, slowPeriod);

  const prev = closes.slice(0, -1);
  const fastPrev = computeEma(prev, fastPeriod);
  const slowPrev = computeEma(prev, slowPeriod);

  if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) return null;

  const bullish = fastNow > slowNow;
  const crossUp = fastPrev <= slowPrev && fastNow > slowNow;
  const crossDown = fastPrev >= slowPrev && fastNow < slowNow;
  const spread = slowNow !== 0 ? (fastNow - slowNow) / slowNow : 0;

  return { fastEma: fastNow, slowEma: slowNow, bullish, crossUp, crossDown, spread };
}
