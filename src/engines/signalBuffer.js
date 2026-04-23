/**
 * SignalBuffer — rolling window consensus tracker.
 *
 * Tracks the last `windowSecs` seconds of decide() outputs and reports
 * whether a supermajority (≥ minRatio) of recent signals agree on a direction.
 *
 * Why it matters: at the start of a Polymarket window, regime detection
 * oscillates rapidly between RANGE and TREND_UP as price data stabilises.
 * This causes the recommendation to flip UP↔DOWN every 1–2 seconds,
 * making it impossible to distinguish a real signal from noise.
 *
 * Only enter a position when the buffer shows consistent agreement.
 */
export class SignalBuffer {
  /**
   * @param {object} opts
   * @param {number} [opts.windowSecs=60]  – look-back window in seconds
   * @param {number} [opts.minRatio=0.70]  – required fraction for consensus
   * @param {number} [opts.minCount=10]    – minimum samples before consensus is valid
   */
  constructor({ windowSecs = 60, minRatio = 0.70, minCount = 10 } = {}) {
    this.windowSecs = windowSecs;
    this.minRatio = minRatio;
    this.minCount = minCount;
    this._entries = [];
  }

  /**
   * Add a new signal to the buffer.
   * @param {{ action: string, side: string|null }} signal – output of decide()
   */
  push(signal) {
    const now = Date.now();
    this._entries.push({ action: signal.action, side: signal.side ?? null, ts: now });
    const cutoff = now - this.windowSecs * 1000;
    this._entries = this._entries.filter((e) => e.ts >= cutoff);
  }

  /**
   * Returns consensus statistics for the current window.
   * @returns {{
   *   ready: boolean,      – true if minCount samples are in the window
   *   agree: boolean,      – true if a supermajority agrees on one direction
   *   side: string|null,   – "UP" | "DOWN" | null
   *   ratio: number,       – fraction of signals on the dominant side
   *   count: number,       – total signals in window
   *   upCount: number,
   *   downCount: number,
   *   noTradeCount: number
   * }}
   */
  consensus() {
    const total = this._entries.length;

    if (total < this.minCount) {
      return { ready: false, agree: false, side: null, ratio: 0, count: total, upCount: 0, downCount: 0, noTradeCount: 0 };
    }

    const upCount = this._entries.filter((e) => e.action === "ENTER" && e.side === "UP").length;
    const downCount = this._entries.filter((e) => e.action === "ENTER" && e.side === "DOWN").length;
    const noTradeCount = this._entries.filter((e) => e.action === "NO_TRADE").length;

    const dominant = upCount > downCount ? "UP" : downCount > upCount ? "DOWN" : null;
    const dominantCount = dominant === "UP" ? upCount : dominant === "DOWN" ? downCount : 0;
    const ratio = dominantCount / total;

    const agree = dominant !== null && ratio >= this.minRatio;

    return { ready: true, agree, side: dominant, ratio, count: total, upCount, downCount, noTradeCount };
  }

  /** Most recent signal pushed, or null. */
  last() {
    return this._entries.length > 0 ? this._entries[this._entries.length - 1] : null;
  }

  /** Clear all buffered entries (call on detected window reset). */
  reset() {
    this._entries = [];
  }
}
