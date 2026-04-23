import { clamp } from "../utils.js";

export const DEFAULT_WEIGHTS = {
  vwap: 1.5,
  rsi: 1.2,
  macd: 1.3,
  heikenAshi: 0.8,
  bollingerBands: 1.4,
  emaCross: 1.0,
  stochRsi: 1.1,
  obv: 0.9,
  adxDir: 1.0,
  atrExpansion: 0.5,
  cci: 1.0,
  williamsR: 0.95,
  mfi: 1.05,
  keltner: 1.1,
};

export const DEFAULT_FILTERS = {
  minConfluence: 5,
  adxGate: 15,
  atrGateRatio: 0.5,
  sessionBoost: true,
  minProb: 0.60,
};

function signalVwap({ price, vwap, vwapSlope }) {
  if (price === null || vwap === null) return 0;
  const distPct = (price - vwap) / vwap;
  let sig = clamp(distPct * 200, -1, 1);
  if (vwapSlope !== null) {
    const slopeSig = clamp(vwapSlope * 0.5, -0.5, 0.5);
    sig = clamp(sig + slopeSig, -1, 1);
  }
  return sig;
}

function signalRsi({ rsi, rsiSlope }) {
  if (rsi === null) return 0;
  let sig = clamp((rsi - 50) / 25, -1, 1);
  if (rsiSlope !== null) {
    const slopeBias = clamp(rsiSlope * 0.3, -0.3, 0.3);
    sig = clamp(sig + slopeBias, -1, 1);
  }
  return sig;
}

function signalMacd({ macd }) {
  if (!macd || macd.hist === null) return 0;
  let sig = 0;
  if (macd.hist > 0) sig += 0.4;
  if (macd.hist < 0) sig -= 0.4;
  if (macd.histDelta !== null) {
    if (macd.hist > 0 && macd.histDelta > 0) sig += 0.3;
    if (macd.hist < 0 && macd.histDelta < 0) sig -= 0.3;
  }
  if (macd.macd > 0) sig += 0.2;
  if (macd.macd < 0) sig -= 0.2;
  return clamp(sig, -1, 1);
}

function signalHeikenAshi({ heikenColor, heikenCount }) {
  if (!heikenColor) return 0;
  const streak = Math.min(heikenCount || 0, 5);
  const intensity = clamp(streak / 3, 0, 1);
  return heikenColor === "green" ? intensity : heikenColor === "red" ? -intensity : 0;
}

function signalBollinger({ bb, squeeze }) {
  if (!bb) return 0;
  let sig = clamp((bb.position - 0.5) * 2, -1, 1);
  if (squeeze?.isSqueeze && Math.abs(sig) > 0.3) {
    sig *= 1.3;
  }
  return clamp(sig, -1, 1);
}

function signalEmaCross({ emaCross }) {
  if (!emaCross) return 0;
  let sig = emaCross.bullish ? 0.5 : -0.5;
  if (emaCross.crossUp) sig = 0.9;
  if (emaCross.crossDown) sig = -0.9;
  const spreadBias = clamp(emaCross.spread * 100, -0.4, 0.4);
  return clamp(sig + spreadBias, -1, 1);
}

function signalStochRsi({ stochRsi }) {
  if (!stochRsi) return 0;
  let sig = clamp((stochRsi.k - 50) / 50, -1, 1);
  if (stochRsi.crossUp && stochRsi.oversold) sig = 0.9;
  if (stochRsi.crossDown && stochRsi.overbought) sig = -0.9;
  if (stochRsi.crossUp) sig = Math.max(sig, 0.5);
  if (stochRsi.crossDown) sig = Math.min(sig, -0.5);
  return clamp(sig, -1, 1);
}

function signalObv({ obvSignal }) {
  if (!obvSignal) return 0;
  let sig = obvSignal.bullish ? 0.4 : -0.4;
  if (obvSignal.crossUp) sig = 0.8;
  if (obvSignal.crossDown) sig = -0.8;
  if (obvSignal.rising === true) sig += 0.2;
  if (obvSignal.rising === false) sig -= 0.2;
  return clamp(sig, -1, 1);
}

function signalAdxDir({ adx: adxData }) {
  if (!adxData) return 0;
  if (!adxData.trending) return 0;
  const strength = clamp((adxData.adx - 15) / 30, 0, 1);
  return adxData.bullish ? strength : -strength;
}

function signalAtrExpansion({ atrData }) {
  if (!atrData) return 0;
  if (atrData.expanding) return 0.5;
  if (atrData.contracting) return -0.3;
  return 0;
}

function signalCci({ cci }) {
  if (!cci || cci.value == null) return 0;
  let sig = cci.normalized != null ? cci.normalized : clamp(cci.value / 200, -1, 1);
  if (cci.extremeHigh) sig = Math.min(1, sig + 0.12);
  if (cci.extremeLow) sig = Math.max(-1, sig - 0.12);
  return clamp(sig, -1, 1);
}

function signalWilliamsR({ williamsR }) {
  if (!williamsR || williamsR.value == null) return 0;
  let sig = williamsR.normalized != null ? williamsR.normalized : clamp((williamsR.value + 50) / 50, -1, 1);
  if (williamsR.oversold) sig = Math.max(sig, 0.55);
  if (williamsR.overbought) sig = Math.min(sig, -0.55);
  return clamp(sig, -1, 1);
}

function signalMfi({ mfi }) {
  if (!mfi || mfi.value == null) return 0;
  let sig = mfi.normalized != null ? mfi.normalized : clamp((mfi.value - 50) / 50, -1, 1);
  if (mfi.oversold) sig = Math.max(sig, 0.45);
  if (mfi.overbought) sig = Math.min(sig, -0.45);
  return clamp(sig, -1, 1);
}

function signalKeltner({ keltner }) {
  if (!keltner || keltner.position == null) return 0;
  return clamp((keltner.position - 0.5) * 2, -1, 1);
}

function getSessionMultiplier() {
  const h = new Date().getUTCHours();
  if (h >= 13 && h < 17) return 1.15;
  if (h >= 7 && h < 13) return 1.05;
  if (h >= 17 && h < 22) return 1.0;
  return 0.85;
}

export function scoreDirectionV2(inputs, weights = DEFAULT_WEIGHTS, filters = DEFAULT_FILTERS) {
  const signals = [
    { name: "vwap", val: signalVwap(inputs) },
    { name: "rsi", val: signalRsi(inputs) },
    { name: "macd", val: signalMacd(inputs) },
    { name: "heikenAshi", val: signalHeikenAshi(inputs) },
    { name: "bollingerBands", val: signalBollinger(inputs) },
    { name: "emaCross", val: signalEmaCross(inputs) },
    { name: "stochRsi", val: signalStochRsi(inputs) },
    { name: "obv", val: signalObv(inputs) },
    { name: "adxDir", val: signalAdxDir(inputs) },
    { name: "atrExpansion", val: signalAtrExpansion(inputs) },
    { name: "cci", val: signalCci(inputs) },
    { name: "williamsR", val: signalWilliamsR(inputs) },
    { name: "mfi", val: signalMfi(inputs) },
    { name: "keltner", val: signalKeltner(inputs) },
  ];

  if (filters.adxGate > 0 && inputs.adx && inputs.adx.choppy && inputs.adx.adx < filters.adxGate) {
    return { rawUp: 0.5, upScore: 0, downScore: 0, filtered: "adx_choppy", signals, confluence: 0 };
  }

  if (filters.atrGateRatio > 0 && inputs.atrData && inputs.atrData.ratio < filters.atrGateRatio) {
    return { rawUp: 0.5, upScore: 0, downScore: 0, filtered: "atr_low_vol", signals, confluence: 0 };
  }

  const bullishCount = signals.filter((s) => s.val > 0.1).length;
  const bearishCount = signals.filter((s) => s.val < -0.1).length;
  const dominantCount = Math.max(bullishCount, bearishCount);

  if (filters.minConfluence > 0 && dominantCount < filters.minConfluence) {
    return { rawUp: 0.5, upScore: 0, downScore: 0, filtered: "low_confluence", signals, confluence: dominantCount };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  for (const s of signals) {
    const w = weights[s.name] ?? 1;
    weightedSum += s.val * w;
    totalWeight += w;
  }

  let rawScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  if (inputs.failedVwapReclaim === true) {
    rawScore -= 0.15;
  }

  if (filters.sessionBoost) {
    rawScore *= getSessionMultiplier();
  }

  rawScore = clamp(rawScore, -1, 1);
  const rawUp = clamp(0.5 + rawScore * 0.35, 0.15, 0.85);

  return {
    rawUp,
    upScore: rawUp,
    downScore: 1 - rawUp,
    filtered: null,
    signals,
    confluence: dominantCount,
  };
}

export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim
  } = inputs;

  let up = 1;
  let down = 1;

  if (price !== null && vwap !== null) {
    if (price > vwap) up += 2;
    if (price < vwap) down += 2;
  }

  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 2;
    if (vwapSlope < 0) down += 2;
  }

  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 2;
    if (rsi < 45 && rsiSlope < 0) down += 2;
  }

  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 2;
    if (expandingRed) down += 2;

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) up += 1;
    if (heikenColor === "red" && heikenCount >= 2) down += 1;
  }

  if (failedVwapReclaim === true) down += 3;

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const ratio = clamp(remainingMinutes / windowMinutes, 0, 1);
  const timeDecay = 0.5 + 0.5 * ratio;
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
