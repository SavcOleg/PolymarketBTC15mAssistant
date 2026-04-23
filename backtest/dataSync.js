import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const SERIES_ID_15M = "10192";
const GAMMA = CONFIG.gammaBaseUrl;
const CLOB = CONFIG.clobBaseUrl;
const PARALLEL = 6;
const DELAY_MS = 150;

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } }
function writeJSON(p, d) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(d)); }

function marketDir(wm) { return path.join(DATA_DIR, wm <= 5 ? "5m" : "15m"); }
function marketsPath(wm) { return path.join(marketDir(wm), "markets.json"); }
function pricesDir(wm) { return path.join(marketDir(wm), "prices"); }
function pricePath(wm, dateStr) { return path.join(pricesDir(wm), `${dateStr}.json`); }
const syncStatePath = path.join(DATA_DIR, "sync-state.json");

function dateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function parseResolution(market) {
  try {
    const outcomes = JSON.parse(market.outcomes || "[]");
    const prices = JSON.parse(market.outcomePrices || "[]");
    const upIdx = outcomes.findIndex(o => o.toLowerCase() === "up");
    const downIdx = outcomes.findIndex(o => o.toLowerCase() === "down");
    if (upIdx < 0 || downIdx < 0) return null;
    const upPrice = parseFloat(prices[upIdx]);
    const downPrice = parseFloat(prices[downIdx]);
    if (!Number.isFinite(upPrice) || !Number.isFinite(downPrice)) return null;
    if (upPrice >= 0.995 && downPrice <= 0.005) return "UP";
    if (downPrice >= 0.995 && upPrice <= 0.005) return "DOWN";
    if (upPrice === 1 && downPrice === 0) return "UP";
    if (upPrice === 0 && downPrice === 1) return "DOWN";
    return null;
  } catch { return null; }
}

function parseTokenIds(market) {
  try {
    const ids = JSON.parse(market.clobTokenIds || "[]");
    return { upTokenId: ids[0] || null, downTokenId: ids[1] || null };
  } catch { return { upTokenId: null, downTokenId: null }; }
}

function normalizeMarket(raw) {
  const { upTokenId, downTokenId } = parseTokenIds(raw);
  const resolution = parseResolution(raw);
  const eventStartMs = raw.eventStartTime ? new Date(raw.eventStartTime).getTime() : null;
  const endMs = raw.endDate ? new Date(raw.endDate).getTime() : null;
  return {
    slug: raw.slug,
    conditionId: raw.conditionId,
    question: raw.question,
    eventStartMs,
    endMs,
    upTokenId,
    downTokenId,
    resolution,
    volume: raw.volumeNum || parseFloat(raw.volume) || 0,
    lastTradePrice: raw.lastTradePrice ?? null,
    closed: !!raw.closed,
  };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ── 15m market discovery via Gamma events API (paginated) ──

async function fetch15mResolvedMarkets(onProgress) {
  const existing = readJSON(marketsPath(15)) || [];
  const existingSlugs = new Set(existing.map(m => m.slug));
  const latestStartMs = existing.reduce((mx, m) => Math.max(mx, m.eventStartMs || 0), 0);

  let offset = 0;
  const newMarkets = [];
  let page = 0;

  while (true) {
    const url = `${GAMMA}/events?series_id=${SERIES_ID_15M}&closed=true&active=false&limit=500&offset=${offset}`;
    const events = await fetchJSON(url);
    if (!Array.isArray(events) || events.length === 0) break;

    let allOlderThanExisting = true;
    for (const ev of events) {
      const mkts = Array.isArray(ev.markets) ? ev.markets : [];
      for (const raw of mkts) {
        if (existingSlugs.has(raw.slug)) continue;
        const nm = normalizeMarket(raw);
        if (!nm.eventStartMs || !nm.upTokenId) continue;
        if (nm.eventStartMs > latestStartMs) allOlderThanExisting = false;
        newMarkets.push(nm);
        existingSlugs.add(nm.slug);
      }
    }

    offset += events.length;
    page++;
    if (onProgress) onProgress({ type: "discover", market: "15m", page, found: newMarkets.length });

    if (allOlderThanExisting && latestStartMs > 0) break;
    if (events.length < 500) break;
    await sleep(100);
  }

  if (newMarkets.length > 0) {
    const all = [...existing, ...newMarkets].sort((a, b) => a.eventStartMs - b.eventStartMs);
    writeJSON(marketsPath(15), all);
  }

  return newMarkets.length;
}

// ── 5m market discovery via slug-based individual lookup ──

async function fetch5mResolvedMarkets(daysBack, onProgress) {
  const existing = readJSON(marketsPath(5)) || [];
  const existingSlugs = new Set(existing.map(m => m.slug));

  const now = Date.now();
  const startMs = now - daysBack * 86_400_000;
  const windowMs = 5 * 60_000;

  const slugsToCheck = [];
  for (let t = startMs; t < now - windowMs; t += windowMs) {
    const aligned = Math.floor(t / windowMs) * windowMs;
    const sec = Math.round(aligned / 1000);
    const slug = `btc-updown-5m-${sec}`;
    if (!existingSlugs.has(slug)) slugsToCheck.push({ slug, sec, ms: aligned });
  }

  const deduped = [...new Map(slugsToCheck.map(s => [s.slug, s])).values()];
  const newMarkets = [];
  let completed = 0;

  for (let i = 0; i < deduped.length; i += PARALLEL) {
    const batch = deduped.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(
      batch.map(async ({ slug }) => {
        const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
        if (Array.isArray(data) && data[0]) return normalizeMarket(data[0]);
        return null;
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value && r.value.upTokenId) {
        if (!existingSlugs.has(r.value.slug)) {
          newMarkets.push(r.value);
          existingSlugs.add(r.value.slug);
        }
      }
    }
    completed += batch.length;
    if (onProgress) onProgress({ type: "discover", market: "5m", completed, total: deduped.length, found: newMarkets.length });
    if (i + PARALLEL < deduped.length) await sleep(DELAY_MS);
  }

  if (newMarkets.length > 0) {
    const all = [...existing, ...newMarkets].sort((a, b) => (a.eventStartMs || 0) - (b.eventStartMs || 0));
    writeJSON(marketsPath(5), all);
  }

  return newMarkets.length;
}

// ── CLOB price history fetching ──

async function fetchPriceHistory(upTokenId) {
  try {
    const data = await fetchJSON(`${CLOB}/prices-history?market=${upTokenId}&interval=all&fidelity=1`);
    return Array.isArray(data?.history) ? data.history : [];
  } catch { return []; }
}

const CLOB_DATA_WINDOW_MS = 30 * 86_400_000;

async function syncPricesForMarkets(markets, wm, onProgress) {
  const cutoff = Date.now() - CLOB_DATA_WINDOW_MS;
  const byDate = new Map();
  for (const m of markets) {
    if (!m.eventStartMs || !m.upTokenId || !m.closed) continue;
    if (m.eventStartMs < cutoff) continue;
    const ds = dateStr(m.eventStartMs);
    if (ds === dateStr(Date.now())) continue;
    if (!byDate.has(ds)) byDate.set(ds, []);
    byDate.get(ds).push(m);
  }

  let fetched = 0;
  const totalToFetch = [];

  for (const [ds, mkts] of byDate) {
    const existing = readJSON(pricePath(wm, ds)) || {};
    const missing = mkts.filter(m => !existing[m.slug]);
    if (missing.length > 0) totalToFetch.push({ ds, missing, existing });
  }

  const grandTotal = totalToFetch.reduce((s, t) => s + t.missing.length, 0);

  for (const { ds, missing, existing } of totalToFetch) {
    const updated = { ...existing };
    for (let i = 0; i < missing.length; i += PARALLEL) {
      const batch = missing.slice(i, i + PARALLEL);
      const results = await Promise.allSettled(
        batch.map(async m => {
          const hist = await fetchPriceHistory(m.upTokenId);
          return { slug: m.slug, hist };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.hist.length > 0) {
          updated[r.value.slug] = r.value.hist;
        }
        fetched++;
      }
      if (onProgress) onProgress({ type: "prices", market: wm + "m", fetched, total: grandTotal });
      if (i + PARALLEL < missing.length) await sleep(DELAY_MS);
    }
    writeJSON(pricePath(wm, ds), updated);
  }
  return fetched;
}

// ── In-memory data store ──

const store = {
  markets15m: [],
  markets5m: [],
  priceIndex15m: new Map(),
  priceIndex5m: new Map(),
  syncState: { lastSync15m: 0, lastSync5m: 0 },
  loaded: false,
};

function loadFromDisk() {
  store.markets15m = readJSON(marketsPath(15)) || [];
  store.markets5m = readJSON(marketsPath(5)) || [];
  store.syncState = readJSON(syncStatePath) || { lastSync15m: 0, lastSync5m: 0 };

  store.priceIndex15m.clear();
  store.priceIndex5m.clear();

  for (const wm of [5, 15]) {
    const dir = pricesDir(wm);
    const idx = wm === 5 ? store.priceIndex5m : store.priceIndex15m;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
        const data = readJSON(path.join(dir, f));
        if (data) {
          for (const [slug, hist] of Object.entries(data)) {
            idx.set(slug, hist);
          }
        }
      }
    }
  }

  marketIndex["5"] = null;
  marketIndex["15"] = null;
  store.loaded = true;
}

export function getStore() {
  if (!store.loaded) loadFromDisk();
  return store;
}

const marketIndex = { "5": null, "15": null };

function buildMarketIndex(wm) {
  const s = getStore();
  const markets = wm <= 5 ? s.markets5m : s.markets15m;
  const idx = new Map();
  for (const m of markets) {
    if (m.eventStartMs) idx.set(m.eventStartMs, m);
    if (m.slug) idx.set(m.slug, m);
  }
  marketIndex[wm <= 5 ? "5" : "15"] = idx;
  return idx;
}

export function getMarketByWindow(windowStartMs, windowMinutes) {
  const key = windowMinutes <= 5 ? "5" : "15";
  let idx = marketIndex[key];
  if (!idx) idx = buildMarketIndex(windowMinutes);

  const byMs = idx.get(windowStartMs);
  if (byMs) return byMs;

  const sec = Math.round(windowStartMs / 1000);
  const slug = windowMinutes <= 5 ? `btc-updown-5m-${sec}` : `btc-updown-15m-${sec}`;
  return idx.get(slug) || null;
}

export function getPriceHistory(slug, windowMinutes) {
  const s = getStore();
  const idx = windowMinutes <= 5 ? s.priceIndex5m : s.priceIndex15m;
  return idx.get(slug) || null;
}

export function getPriceAtTime(slug, windowMinutes, targetTimeSec) {
  const hist = getPriceHistory(slug, windowMinutes);
  if (!hist || hist.length === 0) return null;

  let closestBefore = null;
  let closestAfter = null;
  let bestBeforeDist = Infinity;
  let bestAfterDist = Infinity;

  for (const pt of hist) {
    const diff = pt.t - targetTimeSec;
    if (diff <= 0 && -diff < bestBeforeDist) { bestBeforeDist = -diff; closestBefore = pt; }
    if (diff > 0 && diff < bestAfterDist) { bestAfterDist = diff; closestAfter = pt; }
  }

  const maxLookback = windowMinutes * 60 + 120;
  if (closestAfter && bestAfterDist <= 120) return closestAfter.p;
  if (closestBefore && bestBeforeDist <= maxLookback) return closestBefore.p;
  return null;
}

export function getPricePath(slug, windowMinutes, startSec, endSec) {
  const hist = getPriceHistory(slug, windowMinutes);
  if (!hist) return null;
  const lookback = 60;
  return hist.filter(pt => pt.t >= startSec - lookback && pt.t <= endSec);
}

// ── Main sync function ──

export async function runSync({ windowMinutes, daysBack = 60, onProgress } = {}) {
  if (!store.loaded) loadFromDisk();

  const targets = windowMinutes ? [windowMinutes] : [15, 5];
  const result = { markets15m: 0, markets5m: 0, prices15m: 0, prices5m: 0 };

  for (const wm of targets) {
    if (wm === 15 || wm > 5) {
      const newMkts = await fetch15mResolvedMarkets(onProgress);
      result.markets15m = newMkts;
      store.markets15m = readJSON(marketsPath(15)) || [];

      const priceFetched = await syncPricesForMarkets(store.markets15m, 15, onProgress);
      result.prices15m = priceFetched;
    }

    if (wm === 5 || wm <= 5) {
      const days5m = Math.min(daysBack, 14);
      const newMkts = await fetch5mResolvedMarkets(days5m, onProgress);
      result.markets5m = newMkts;
      store.markets5m = readJSON(marketsPath(5)) || [];

      const priceFetched = await syncPricesForMarkets(store.markets5m, 5, onProgress);
      result.prices5m = priceFetched;
    }
  }

  store.syncState = { lastSync15m: Date.now(), lastSync5m: Date.now() };
  writeJSON(syncStatePath, store.syncState);

  loadFromDisk();
  return result;
}

export function getSyncStatus() {
  const s = getStore();
  return {
    lastSync15m: s.syncState.lastSync15m,
    lastSync5m: s.syncState.lastSync5m,
    markets15m: s.markets15m.length,
    markets5m: s.markets5m.length,
    prices15m: s.priceIndex15m.size,
    prices5m: s.priceIndex5m.size,
  };
}
