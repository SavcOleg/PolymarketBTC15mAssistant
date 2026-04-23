/**
 * Shared rolling stats for Strategy Arena (CLI + HTTP).
 */

export function rollingSingleSided(trades, cycles) {
  const closed = (trades || []).filter(
    (t) => t.pnl != null && !t.noEntry && t.side && t.side !== "DUAL",
  );
  const slice = closed.slice(-cycles);
  const wins = slice.filter((t) => t.pnl > 0).length;
  const losses = slice.length - wins;
  const winRatePct = slice.length ? +((wins / slice.length) * 100).toFixed(1) : 0;
  const pnlUsd = +slice.reduce((s, t) => s + t.pnl, 0).toFixed(2);
  return { sample: slice.length, wins, losses, winRatePct, pnlUsd, totalClosed: closed.length };
}

export function dualByWindow(trades, cycles) {
  const byWin = new Map();
  for (const t of trades || []) {
    const k = t.windowStart;
    if (k == null) continue;

    if (t.noEntry && t.skipReason === "NO_ENTRY") {
      const row = byWin.get(k) || { windowStart: k, legs: [], noEntryOnly: false };
      row.noEntryOnly = row.legs.length === 0;
      byWin.set(k, row);
      continue;
    }
    if (t.side !== "UP" && t.side !== "DOWN") continue;

    const row = byWin.get(k) || { windowStart: k, legs: [], noEntryOnly: false };
    row.noEntryOnly = false;
    row.legs.push(t);
    byWin.set(k, row);
  }

  const withLegs = [...byWin.values()].filter((w) => w.legs.length > 0);
  const resolved = withLegs
    .filter((w) => w.legs.every((l) => l.pnl != null))
    .sort((a, b) => a.windowStart - b.windowStart);
  const slice = resolved.slice(-cycles);
  const positiveWindows = slice.filter((w) => w.legs.reduce((s, l) => s + l.pnl, 0) > 0).length;
  const nonPositiveWindows = slice.length - positiveWindows;
  const pctPositiveWindows = slice.length ? +((positiveWindows / slice.length) * 100).toFixed(1) : 0;
  const pnlUsd = +slice.reduce((s, w) => s + w.legs.reduce((ss, l) => ss + l.pnl, 0), 0).toFixed(2);
  const openWindows = withLegs.filter((w) => w.legs.some((l) => l.pnl == null)).length;
  return {
    sample: slice.length,
    positiveWindows,
    nonPositiveWindows,
    pctPositiveWindows,
    pnlUsd,
    totalResolved: resolved.length,
    openWindows,
  };
}

/** @param {number} cycles */
export function rollingSummaryForStrategy(s, cycles) {
  const bank = s.bank ?? 0;
  const balance = s.balance ?? bank;
  const sessionPnl = +(balance - bank).toFixed(2);
  if (s.strategyType === "dual_position") {
    return {
      id: s.id,
      name: s.name,
      asset: s.asset,
      strategyType: s.strategyType,
      kind: "dual_windows",
      dual: dualByWindow(s.trades, cycles),
      sessionPnl,
    };
  }
  return {
    id: s.id,
    name: s.name,
    asset: s.asset,
    strategyType: s.strategyType,
    kind: "directional_trades",
    directional: rollingSingleSided(s.trades, cycles),
    sessionPnl,
  };
}

export function summarizeArenaStrategies(strategies, cycles) {
  return (strategies || []).map((s) => rollingSummaryForStrategy(s, cycles));
}
