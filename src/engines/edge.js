import { clamp } from "../utils.js";

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

/**
 * decide() — determines whether to enter a position and on which side.
 *
 * Parameters added vs original:
 *   entryMinute  – elapsed minutes since window open; skip first 2 min while indicators stabilise
 *   regime       – current market regime string (TREND_UP | TREND_DOWN | RANGE | CHOP)
 *
 * Key improvements:
 *   1. 2-minute warm-up guard — prevents trades during the noisy window-open period
 *   2. Higher EARLY/MID edge thresholds — eliminates weak OPTIONAL signals
 *   3. Regime-direction alignment — weak counter-trend signals are suppressed
 *   4. Contrarian mode — extreme market mispricing (edge ≥ 0.20, model ≥ 0.40) allowed
 *      even when model probability is below the normal minProb gate
 */
export function decide({
  remainingMinutes,
  edgeUp,
  edgeDown,
  modelUp = null,
  modelDown = null,
  entryMinute = null,
  regime = null,
}) {
  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";

  // Guard 1: skip the first 2 minutes — indicators (VWAP, RSI, MACD) are still
  // stabilising and the regime detector thrashes, producing contradictory signals.
  if (entryMinute !== null && entryMinute < 2) {
    return { action: "NO_TRADE", side: null, phase, reason: "window_warmup" };
  }

  // Raised thresholds: EARLY 0.05→0.10, MID 0.10→0.12.
  // This eliminates the OPTIONAL signal band (edge 0.05–0.10) that had poor win rates.
  const threshold = phase === "EARLY" ? 0.10 : phase === "MID" ? 0.12 : 0.20;

  const minProb = phase === "EARLY" ? 0.55 : phase === "MID" ? 0.60 : 0.65;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  }

  // Guard 2: regime-direction alignment.
  // Suppress weak counter-trend signals (edge < 0.15) that go against a confirmed trend.
  if (regime !== null) {
    if (bestSide === "UP" && regime === "TREND_DOWN" && bestEdge < 0.15) {
      return { action: "NO_TRADE", side: null, phase, reason: "weak_up_in_downtrend" };
    }
    if (bestSide === "DOWN" && regime === "TREND_UP" && bestEdge < 0.15) {
      return { action: "NO_TRADE", side: null, phase, reason: "weak_down_in_uptrend" };
    }
    // Never enter in either direction during a CHOP regime without a very large edge.
    if (regime === "CHOP" && bestEdge < 0.20) {
      return { action: "NO_TRADE", side: null, phase, reason: "chop_regime" };
    }
  }

  if (bestModel !== null && bestModel < minProb) {
    // Guard 3: contrarian mode.
    // When the market is severely mispricing a side (edge ≥ 0.20) and our model still
    // gives it at least 40% probability, the expected value is positive even though the
    // model probability is below the normal gate. Example: market prices DOWN at 9¢
    // while our model says 29% → EV ≈ +$0.20 per dollar risked.
    // Only activate when: large edge + model not catastrophically wrong + not in LATE phase.
    const contrarian =
      bestEdge >= 0.20 &&
      bestModel !== null &&
      bestModel >= 0.40 &&
      phase !== "LATE";

    if (!contrarian) {
      return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
    }

    return { action: "ENTER", side: bestSide, phase, strength: "CONTRARIAN", edge: bestEdge };
  }

  const strength = bestEdge >= 0.20 ? "STRONG" : "GOOD";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}

export function decideV2({ remainingMinutes, modelUp, modelDown, confluence, filtered, minProbOverride }) {
  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";

  if (filtered) {
    return { action: "NO_TRADE", side: null, phase, reason: filtered, strength: null };
  }

  const defaultMinProb = phase === "EARLY" ? 0.54 : phase === "MID" ? 0.56 : 0.58;
  const minProb = minProbOverride != null ? minProbOverride : defaultMinProb;

  const bestSide = modelUp >= modelDown ? "UP" : "DOWN";
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}`, strength: null };
  }

  const strength = confluence >= 7 ? "STRONG" : confluence >= 5 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, confluence };
}
