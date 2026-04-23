export function computeBollingerBands(closes, period = 20, mult = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;

  const slice = closes.slice(closes.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;

  let sumSq = 0;
  for (const v of slice) sumSq += (v - mean) ** 2;
  const std = Math.sqrt(sumSq / period);

  const upper = mean + mult * std;
  const lower = mean - mult * std;
  const bandwidth = std > 0 ? (upper - lower) / mean : 0;

  const last = closes[closes.length - 1];
  const position = std > 0 ? (last - lower) / (upper - lower) : 0.5;

  return { upper, lower, middle: mean, std, bandwidth, position };
}

export function detectSqueeze(closes, period = 20, mult = 2, lookback = 20) {
  if (!Array.isArray(closes) || closes.length < period + lookback) return null;

  const bandwidths = [];
  for (let i = lookback; i >= 0; i--) {
    const sub = closes.slice(0, closes.length - i || closes.length);
    const bb = computeBollingerBands(sub, period, mult);
    if (bb) bandwidths.push(bb.bandwidth);
  }

  if (bandwidths.length < 2) return null;

  const avgBw = bandwidths.reduce((a, b) => a + b, 0) / bandwidths.length;
  const currentBw = bandwidths[bandwidths.length - 1];
  const isSqueeze = currentBw < avgBw * 0.75;
  const isExpanding = currentBw > avgBw * 1.2;

  return { isSqueeze, isExpanding, bandwidth: currentBw, avgBandwidth: avgBw };
}
