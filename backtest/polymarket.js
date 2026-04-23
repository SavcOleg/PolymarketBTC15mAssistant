import {
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  pickNextUpcomingMarket,
  fetchOrderBook,
  summarizeOrderBook,
  resolveLiveWindowBounds,
} from "../src/data/polymarket.js";

/** Gamma series: BTC Up or Down 15m */
const SERIES_ID_15M = "10192";
/** Gamma series: BTC Up or Down 5m */
const SERIES_ID_5M = "10684";

const ARENA_SERIES = {
  15: {
    BTC:  { seriesId: "10192", symbol: "BTCUSDT", name: "Bitcoin" },
    ETH:  { seriesId: "10191", symbol: "ETHUSDT", name: "Ethereum" },
    XRP:  { seriesId: "10422", symbol: "XRPUSDT", name: "XRP" },
    BNB:  { seriesId: "11330", symbol: "BNBUSDT", name: "BNB" },
    DOGE: { seriesId: "11328", symbol: "DOGEUSDT", name: "Dogecoin" },
  },
  5: {
    BTC:  { seriesId: "10684", symbol: "BTCUSDT", name: "Bitcoin" },
    ETH:  { seriesId: "10683", symbol: "ETHUSDT", name: "Ethereum" },
    XRP:  { seriesId: "10685", symbol: "XRPUSDT", name: "XRP" },
  },
};

export { resolveLiveWindowBounds, ARENA_SERIES };
const REDISCOVER_MS = 5 * 60_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let cachedMarket = null;
let cacheExpiry = 0;
let lastDiscoveryMs = 0;

function parseTokenIds(market) {
  try {
    const ids = JSON.parse(market.clobTokenIds || "[]");
    return { upTokenId: ids[0] || null, downTokenId: ids[1] || null };
  } catch {
    return { upTokenId: null, downTokenId: null };
  }
}

function gammaSeriesIdForWindow(windowMinutes = 15) {
  return windowMinutes <= 5 ? SERIES_ID_5M : SERIES_ID_15M;
}

export async function discoverCurrentMarket(forceRefresh = false, windowMinutes = 15) {
  const now = Date.now();
  const seriesId = gammaSeriesIdForWindow(windowMinutes);

  if (
    !forceRefresh
    && cachedMarket
    && cachedMarket.seriesId === seriesId
    && now < cacheExpiry
    && now - lastDiscoveryMs < REDISCOVER_MS
  ) {
    return cachedMarket;
  }

  let lastErr = null;
  let events = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      events = await fetchLiveEventsBySeriesId({ seriesId, limit: 20 });
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(350 * (attempt + 1));
    }
  }
  if (!events) {
    console.error("discoverCurrentMarket: Gamma API failed after retries:", lastErr?.message);
    return null;
  }

  const markets = flattenEventMarkets(events);
  const best = pickLatestLiveMarket(markets, now);

  if (!best) {
    cachedMarket = null;
    cacheExpiry = 0;
    return null;
  }

  const { upTokenId, downTokenId } = parseTokenIds(best);
  const endMs = new Date(best.endDate).getTime();

  cachedMarket = {
    seriesId,
    market: best,
    slug: best.slug,
    question: best.question,
    upTokenId,
    downTokenId,
    tickSize: best.orderPriceMinTickSize || 0.01,
    negRisk: best.negRisk || false,
    endDate: best.endDate,
    endMs,
    eventStartTime: best.eventStartTime,
  };
  cacheExpiry = endMs;
  lastDiscoveryMs = now;

  return cachedMarket;
}

let nextMarketCache = null;
let nextMarketCacheExpiry = 0;

export async function discoverNextMarket(windowMinutes = 15) {
  const now = Date.now();
  if (nextMarketCache && now < nextMarketCacheExpiry && nextMarketCache.windowMinutes === windowMinutes) {
    if (nextMarketCache.effectiveStartMs > now) return nextMarketCache;
    nextMarketCache = null;
  }

  const seriesId = gammaSeriesIdForWindow(windowMinutes);
  let events = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      events = await fetchLiveEventsBySeriesId({ seriesId, limit: 20 });
      break;
    } catch (e) {
      if (attempt < 2) await sleep(350 * (attempt + 1));
    }
  }
  if (!events) return null;

  const markets = flattenEventMarkets(events);
  const next = pickNextUpcomingMarket(markets, now);
  if (!next) return null;

  const { upTokenId, downTokenId } = parseTokenIds(next);
  const endMs = new Date(next.endDate).getTime();
  const slugInfo = (await import("../src/data/polymarket.js")).parseBtcUpDownSlug(next.slug);
  const effectiveStartMs = slugInfo?.startMs ?? new Date(next.eventStartTime ?? next.startDate).getTime();

  nextMarketCache = {
    windowMinutes,
    market: next,
    slug: next.slug,
    question: next.question,
    upTokenId,
    downTokenId,
    tickSize: next.orderPriceMinTickSize || 0.01,
    negRisk: next.negRisk || false,
    endDate: next.endDate,
    endMs,
    effectiveStartMs,
    startsInMs: effectiveStartMs - now,
  };
  nextMarketCacheExpiry = effectiveStartMs;

  return nextMarketCache;
}

export async function fetchRealPrices(upTokenId, downTokenId) {
  const fallback = { upBid: null, upAsk: null, downBid: null, downAsk: null, upMid: null, downMid: null, spread: null };

  if (!upTokenId || !downTokenId) return fallback;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [upBook, downBook] = await Promise.all([
        fetchOrderBook({ tokenId: upTokenId }),
        fetchOrderBook({ tokenId: downTokenId }),
      ]);

      const upSummary = summarizeOrderBook(upBook);
      const downSummary = summarizeOrderBook(downBook);

      const upMid = upSummary.bestBid != null && upSummary.bestAsk != null
        ? +((upSummary.bestBid + upSummary.bestAsk) / 2).toFixed(4) : null;
      const downMid = downSummary.bestBid != null && downSummary.bestAsk != null
        ? +((downSummary.bestBid + downSummary.bestAsk) / 2).toFixed(4) : null;

      return {
        upBid: upSummary.bestBid,
        upAsk: upSummary.bestAsk,
        downBid: downSummary.bestBid,
        downAsk: downSummary.bestAsk,
        upMid,
        downMid,
        spread: upSummary.spread != null ? +upSummary.spread.toFixed(4) : null,
        upLiquidity: upSummary.bidLiquidity + upSummary.askLiquidity,
        downLiquidity: downSummary.bidLiquidity + downSummary.askLiquidity,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(300 * (attempt + 1));
    }
  }
  console.error("fetchRealPrices error after retries:", lastErr?.message);
  return fallback;
}

export function clearMarketCache() {
  cachedMarket = null;
  cacheExpiry = 0;
  lastDiscoveryMs = 0;
}

const arenaMarketCache = new Map();

export async function discoverMarketBySeries(seriesId, forceRefresh = false) {
  const now = Date.now();
  const cached = arenaMarketCache.get(seriesId);
  if (!forceRefresh && cached && now < cached.expiry && now - cached.discoveredAt < REDISCOVER_MS) {
    return cached.data;
  }

  let events = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      events = await fetchLiveEventsBySeriesId({ seriesId, limit: 10 });
      break;
    } catch (e) {
      if (attempt < 1) await sleep(300);
    }
  }
  if (!events) return null;

  const markets = flattenEventMarkets(events);
  const best = pickLatestLiveMarket(markets, now);
  if (!best) {
    arenaMarketCache.delete(seriesId);
    return null;
  }

  const { upTokenId, downTokenId } = parseTokenIds(best);
  const endMs = new Date(best.endDate).getTime();
  const data = {
    seriesId,
    market: best,
    slug: best.slug,
    question: best.question,
    upTokenId,
    downTokenId,
    tickSize: best.orderPriceMinTickSize || 0.01,
    negRisk: best.negRisk || false,
    endDate: best.endDate,
    endMs,
    eventStartTime: best.eventStartTime,
  };
  arenaMarketCache.set(seriesId, { data, expiry: endMs, discoveredAt: now });
  return data;
}

export async function discoverAllArenaMarkets(windowMinutes = 15) {
  const wKey = windowMinutes <= 5 ? 5 : 15;
  const seriesMap = ARENA_SERIES[wKey] || {};
  const results = {};

  const entries = Object.entries(seriesMap);
  const settled = await Promise.allSettled(
    entries.map(([asset, info]) =>
      discoverMarketBySeries(info.seriesId).then(mkt => ({ asset, info, mkt }))
    )
  );

  for (const r of settled) {
    if (r.status === "fulfilled" && r.value.mkt) {
      const { asset, info, mkt } = r.value;
      results[asset] = { ...mkt, asset, symbol: info.symbol, assetName: info.name };
    }
  }
  return results;
}

export function clearArenaMarketCache() {
  arenaMarketCache.clear();
}
