import { liveTrader } from "./liveTrader.js";

/**
 * Dual Position Strategy (All BTC Markets)
 * 
 * Strategy:
 * - Buy both UP and DOWN at the start of each BTC market (5m or 15m)
 * - ONLY when odds are near 50/50 (between 35-65%)
 * - Each position has a 5% take-profit order
 * - Exit only via take-profit or market resolution
 * - Minimum $5 per position ($10 total per market)
 */

const STRATEGY_NAME = "DualPosition";
const TRADE_SIZE_USD = 5.0;
const MIN_ODDS = 0.35; // Minimum price to enter (35¢)
const MAX_ODDS = 0.65; // Maximum price to enter (65¢)

class DualPositionStrategy {
  constructor() {
    this.activeMarkets = new Map(); // marketSlug -> market info
    this.lastTradeTime = new Map(); // marketSlug -> timestamp
  }

  /**
   * Check if we should enter this market
   * @param {Object} market - Polymarket market object
   * @returns {boolean}
   */
  /**
   * @param {Object} market - Polymarket market object
   * @param {Object} [prices] - { up, down } in decimal (0-1)
   */
  shouldEnter(market, prices) {
    if (!market || !market.slug) return false;

    if (this.activeMarkets.has(market.slug)) return false;

    const slug = market.slug.toLowerCase();
    if (!slug.includes("btc") || !slug.includes("updown")) return false;

    // Only enter when odds are near 50/50
    if (prices) {
      const up = Number(prices.up);
      const down = Number(prices.down);
      if (up < MIN_ODDS || up > MAX_ODDS || down < MIN_ODDS || down > MAX_ODDS) {
        return false;
      }
    }

    const now = Date.now();
    const startTime = market.eventStartTime
      ? new Date(market.eventStartTime).getTime()
      : now;

    if (now - startTime > 5 * 60_000) return false;

    if (market.closed || !market.active) return false;

    return true;
  }

  /**
   * Execute dual position entry
   * @param {Object} params
   * @param {Object} params.market - Market object
   * @param {Object} params.tokens - { upTokenId, downTokenId }
   * @param {Object} params.prices - { up, down } prices in cents
   * @returns {Object} - Trade result
   */
  async enter({ market, tokens, prices }) {
    if (!market || !tokens || !prices) {
      return { 
        ok: false, 
        error: "Missing required parameters" 
      };
    }

    const { upTokenId, downTokenId } = tokens;
    const { up: upPrice, down: downPrice } = prices;

    if (!upPrice || !downPrice || upPrice <= 0 || downPrice <= 0) {
      return { ok: false, error: "Invalid prices" };
    }

    // Only enter when odds are near 50/50 (35-65%)
    if (upPrice < MIN_ODDS || upPrice > MAX_ODDS || downPrice < MIN_ODDS || downPrice > MAX_ODDS) {
      return {
        ok: false,
        error: `Odds too skewed: UP ${(upPrice*100).toFixed(0)}¢ / DOWN ${(downPrice*100).toFixed(0)}¢ — need 35-65¢ range`
      };
    }

    const canTrade = await liveTrader.canTrade(TRADE_SIZE_USD * 2);
    if (!canTrade) {
      return { 
        ok: false, 
        error: "Insufficient balance" 
      };
    }

    console.log(`\n[${STRATEGY_NAME}] Entering dual position on ${market.slug}`);
    console.log(`  UP price: ${(upPrice * 100).toFixed(2)}¢ | DOWN price: ${(downPrice * 100).toFixed(2)}¢`);

    const results = {
      market: market.slug,
      timestamp: new Date().toISOString(),
      trades: []
    };

    // Place UP position
    const upResult = await liveTrader.placeBuy({
      tokenId: upTokenId,
      price: upPrice,
      side: "UP",
      market
    });

    results.trades.push({
      side: "UP",
      success: upResult.ok,
      error: upResult.error,
      orderId: upResult.order?.id
    });

    if (upResult.ok) {
      console.log(`  ✓ UP position opened (buy + TP sell placed together)`);
    } else {
      console.error(`  ✗ UP position failed: ${upResult.error}`);
    }

    // Place DOWN position
    const downResult = await liveTrader.placeBuy({
      tokenId: downTokenId,
      price: downPrice,
      side: "DOWN",
      market
    });

    results.trades.push({
      side: "DOWN",
      success: downResult.ok,
      error: downResult.error,
      orderId: downResult.order?.id
    });

    if (downResult.ok) {
      console.log(`  ✓ DOWN position opened (buy + TP sell placed together)`);
    } else {
      console.error(`  ✗ DOWN position failed: ${downResult.error}`);
    }

    // Track market entry
    const allSuccess = upResult.ok && downResult.ok;
    if (allSuccess) {
      this.activeMarkets.set(market.slug, {
        slug: market.slug,
        enteredAt: Date.now(),
        endDate: market.endDate,
        upTokenId,
        downTokenId,
        prices: { up: upPrice, down: downPrice }
      });

      this.lastTradeTime.set(market.slug, Date.now());
    }

    results.ok = allSuccess;
    results.partialSuccess = upResult.ok || downResult.ok;

    return results;
  }

  /**
   * Clean up completed markets
   */
  cleanup() {
    const now = Date.now();
    
    for (const [slug, marketInfo] of this.activeMarkets.entries()) {
      const endTime = marketInfo.endDate 
        ? new Date(marketInfo.endDate).getTime() 
        : marketInfo.enteredAt + (20 * 60_000); // Default 20 min if no end date
      
      // Remove markets that ended more than 1 minute ago
      if (now > endTime + 60_000) {
        console.log(`[${STRATEGY_NAME}] Cleaning up completed market: ${slug}`);
        this.activeMarkets.delete(slug);
        this.lastTradeTime.delete(slug);
      }
    }
  }

  /**
   * Get strategy status
   */
  getStatus() {
    return {
      name: STRATEGY_NAME,
      activeMarkets: this.activeMarkets.size,
      markets: Array.from(this.activeMarkets.values()).map(m => ({
        slug: m.slug,
        age: Math.floor((Date.now() - m.enteredAt) / 1000),
        prices: m.prices
      }))
    };
  }
}

// Singleton instance
export const dualPositionStrategy = new DualPositionStrategy();
