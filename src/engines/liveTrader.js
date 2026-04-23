import { initClobClient, placeBuyOrder, placeSellOrder, cancelOrder, getBalances, fetchPolymarketAccountSnapshot } from "../../backtest/clobTrader.js";
import { insertTrade, updateTrade, insertSession, updateSession } from "../db/supabase.js";

/**
 * Live Trading Engine
 * 
 * Key features:
 * - Minimum $5 per trade
 * - Resolution-based exit only (no early exit)
 * - Position tracking and management
 * - Order management with retry logic
 * - Database tracking for all trades and positions
 */

const MIN_TRADE_SIZE_USD = 5.0;
const TAKE_PROFIT_PERCENT = 0.05; // 5% profit target

class LiveTrader {
  constructor() {
    this.client = null;
    this.positions = new Map(); // tokenId -> position info
    this.openOrders = new Map(); // orderId -> order info
    this.initialized = false;
    this.sessionId = null;
    this.sessionStats = {
      tradesOpened: 0,
      tradesClosed: 0,
      totalPnl: 0,
      winCount: 0,
      lossCount: 0
    };
  }

  async init() {
    if (this.initialized) return true;
    
    this.client = await initClobClient();
    if (!this.client) {
      console.error("[LiveTrader] Failed to initialize CLOB client");
      return false;
    }
    
    this.initialized = true;
    console.log("[LiveTrader] Initialized successfully");
    
    // Create a new session in database
    try {
      const session = await insertSession({
        started_at: new Date().toISOString(),
        strategy: "LiveTrading_v1",
        status: "RUNNING"
      });
      
      if (session) {
        this.sessionId = session.id;
        console.log(`[LiveTrader] Session created: ${this.sessionId}`);
      }
    } catch (err) {
      console.warn("[LiveTrader] Failed to create session in database:", err.message);
    }
    
    return true;
  }

  /**
   * Calculate position size based on minimum trade size and current price
   * @param {number} price - Current market price (decimal 0-1, where 0.5 = 50 cents)
   * @param {number} minUsd - Minimum trade size in USD
   * @returns {number} - Position size in contracts
   */
  calculatePositionSize(price, minUsd = MIN_TRADE_SIZE_USD) {
    if (!price || price <= 0) return 0;
    
    // Price is already in dollar terms (0.5 = $0.50)
    // Calculate minimum size needed
    const minSize = minUsd / price;
    
    // Round up to ensure we meet minimum
    return Math.ceil(minSize);
  }

  /**
   * Place a buy order with minimum size validation
   * @param {Object} params
   * @param {string} params.tokenId - Token ID to buy
   * @param {number} params.price - Price in decimal (0-1, where 0.5 = 50 cents)
   * @param {string} params.side - "UP" or "DOWN"
   * @param {Object} params.market - Market object
   * @returns {Object} - Order result
   */
  async placeBuy({ tokenId, price, side, market }) {
    if (!this.initialized) {
      return { ok: false, error: "Trader not initialized" };
    }

    // Calculate position size
    const size = this.calculatePositionSize(price);
    
    if (size <= 0) {
      return { ok: false, error: "Invalid position size" };
    }

    const costUsd = size * price;
    
    console.log(`[LiveTrader] Placing BUY order: ${side} ${size} contracts @ ${(price * 100).toFixed(2)}¢ ($${costUsd.toFixed(2)})`);

    // Step 1: Place the buy order
    const result = await placeBuyOrder({
      tokenId,
      price,
      size,
      tickSize: 0.01,
      negRisk: false
    });

    if (result.ok) {
      // Step 2: Immediately place take-profit sell order
      const takeProfitPrice = Math.min(+(price * (1 + TAKE_PROFIT_PERCENT)).toFixed(4), 0.99);
      console.log(`[LiveTrader] Placing TP sell order: ${side} ${size} @ ${(takeProfitPrice * 100).toFixed(2)}¢`);
      
      const tpResult = await placeSellOrder({
        tokenId,
        price: takeProfitPrice,
        size,
        tickSize: 0.01,
        negRisk: false
      });

      if (tpResult.ok) {
        console.log(`[LiveTrader] TP sell order placed: ${side} @ ${(takeProfitPrice * 100).toFixed(2)}¢`);
      } else {
        console.error(`[LiveTrader] TP sell order FAILED: ${tpResult.error}`);
      }

      // Track the position
      const position = {
        tokenId,
        side,
        entryPrice: price,
        size,
        costUsd,
        takeProfitPrice,
        tpOrderId: tpResult.ok ? tpResult.order?.id : null,
        marketSlug: market?.slug,
        marketEndDate: market?.endDate,
        openedAt: Date.now(),
        orderId: result.order?.id,
        tradeId: null
      };
      
      this.positions.set(tokenId, position);

      // Save to database
      try {
        const trade = await insertTrade({
          session_id: this.sessionId,
          market_slug: market?.slug,
          market_end_date: market?.endDate,
          side,
          entry_price: price,  // Already in decimal format (0.5 = 50 cents)
          size,
          cost_usd: costUsd,
          entry_time: new Date().toISOString(),
          status: "OPEN",
          order_id: result.order?.id,
          token_id: tokenId,
          strategy: "LiveTrading"
        });
        
        if (trade) {
          position.tradeId = trade.id;
          this.sessionStats.tradesOpened++;
          
          // Update session stats
          await this.updateSessionStats();
        }
      } catch (err) {
        console.warn("[LiveTrader] Failed to save trade to database:", err.message);
      }

      // Calculate and log take-profit target
      const takeProfitPrice = price * (1 + TAKE_PROFIT_PERCENT);
      console.log(`[LiveTrader] Position opened. Take-profit target: ${(takeProfitPrice * 100).toFixed(2)}¢`);
    }

    return result;
  }

  /**
   * Place a take-profit sell order
   * @param {string} tokenId - Token ID
   * @param {number} entryPrice - Entry price (decimal 0-1)
   * @param {number} size - Position size
   */
  async placeTakeProfitOrder(tokenId, entryPrice, size) {
    if (!this.initialized) {
      return { ok: false, error: "Trader not initialized" };
    }

    // Calculate take-profit price (5% above entry)
    const takeProfitPrice = Math.min(entryPrice * (1 + TAKE_PROFIT_PERCENT), 0.999);
    
    console.log(`[LiveTrader] Placing TAKE-PROFIT sell order: ${size} @ ${(takeProfitPrice * 100).toFixed(2)}¢`);

    const result = await placeSellOrder({
      tokenId,
      price: takeProfitPrice,
      size,
      tickSize: 0.01,
      negRisk: false
    });

    if (result.ok && result.order?.id) {
      this.openOrders.set(result.order.id, {
        orderId: result.order.id,
        tokenId,
        type: "TAKE_PROFIT",
        price: takeProfitPrice,
        size,
        placedAt: Date.now()
      });
    }

    return result;
  }

  /**
   * Check and update position status
   * Monitors for resolution and take-profit fills
   */
  async updatePositions() {
    if (!this.initialized || this.positions.size === 0) {
      return;
    }

    try {
      const snapshot = await fetchPolymarketAccountSnapshot();
      
      if (!snapshot.ok) {
        console.warn("[LiveTrader] Failed to fetch account snapshot");
        return;
      }

      // Check for filled take-profit orders
      for (const [orderId, orderInfo] of this.openOrders.entries()) {
        const found = snapshot.openOrders.find(o => o.id === orderId);
        
        if (!found) {
          // Order no longer open - likely filled
          console.log(`[LiveTrader] Take-profit order filled: ${orderId}`);
          
          // Remove position and update database
          if (this.positions.has(orderInfo.tokenId)) {
            const pos = this.positions.get(orderInfo.tokenId);
            const profit = ((orderInfo.price - pos.entryPrice) / pos.entryPrice) * 100;
            const pnl = (orderInfo.price / 100 * pos.size) - pos.costUsd;
            
            console.log(`[LiveTrader] Position closed with profit: ${profit.toFixed(2)}% ($${pnl.toFixed(2)})`);
            
            // Update trade in database
            if (pos.tradeId) {
              try {
                await updateTrade(pos.tradeId, {
                  exit_price: orderInfo.price,  // Already in decimal format
                  exit_time: new Date().toISOString(),
                  status: "CLOSED",
                  pnl,
                  exit_reason: "TAKE_PROFIT"
                });
                
                this.sessionStats.tradesClosed++;
                this.sessionStats.totalPnl += pnl;
                if (pnl > 0) this.sessionStats.winCount++;
                else if (pnl < 0) this.sessionStats.lossCount++;
                
                await this.updateSessionStats();
              } catch (err) {
                console.warn("[LiveTrader] Failed to update trade in database:", err.message);
              }
            }
            
            this.positions.delete(orderInfo.tokenId);
          }
          
          this.openOrders.delete(orderId);
        }
      }

      // Check for market resolution
      for (const [tokenId, position] of this.positions.entries()) {
        if (position.marketEndDate) {
          const endTime = new Date(position.marketEndDate).getTime();
          const now = Date.now();
          
          if (now >= endTime) {
            console.log(`[LiveTrader] Market resolved: ${position.marketSlug}`);
            
            // Update trade in database
            if (position.tradeId) {
              try {
                await updateTrade(position.tradeId, {
                  exit_time: new Date().toISOString(),
                  status: "RESOLVED",
                  exit_reason: "MARKET_RESOLUTION"
                });
                
                this.sessionStats.tradesClosed++;
                await this.updateSessionStats();
              } catch (err) {
                console.warn("[LiveTrader] Failed to update resolved trade:", err.message);
              }
            }
            
            // Position will be auto-redeemed by the redeem function
            this.positions.delete(tokenId);
          }
        }
      }

    } catch (err) {
      console.error("[LiveTrader] Error updating positions:", err.message);
    }
  }

  /**
   * Get current trading balance
   */
  async getBalance() {
    if (!this.initialized) {
      return { ok: false, error: "Trader not initialized" };
    }

    const result = await getBalances();
    
    if (result.ok && result.balances?.balance) {
      const balanceUsd = parseFloat(result.balances.balance);
      return { ok: true, balance: balanceUsd };
    }

    return { ok: false, error: "Failed to fetch balance" };
  }

  /**
   * Check if we have sufficient balance for a trade
   */
  async canTrade(requiredUsd = MIN_TRADE_SIZE_USD) {
    const balResult = await this.getBalance();
    
    if (!balResult.ok) {
      return false;
    }

    return balResult.balance >= requiredUsd;
  }

  /**
   * Update session statistics in database
   */
  async updateSessionStats() {
    if (!this.sessionId) return;
    
    try {
      await updateSession(this.sessionId, {
        trades_opened: this.sessionStats.tradesOpened,
        trades_closed: this.sessionStats.tradesClosed,
        total_pnl: this.sessionStats.totalPnl,
        win_count: this.sessionStats.winCount,
        loss_count: this.sessionStats.lossCount,
        open_positions: this.positions.size
      });
    } catch (err) {
      console.warn("[LiveTrader] Failed to update session stats:", err.message);
    }
  }

  /**
   * Get current positions summary
   */
  getPositionsSummary() {
    const positions = Array.from(this.positions.values());
    return {
      count: positions.length,
      positions: positions.map(p => ({
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        costUsd: p.costUsd,
        market: p.marketSlug,
        age: Math.floor((Date.now() - p.openedAt) / 1000)
      }))
    };
  }

  /**
   * Get session statistics
   */
  getSessionStats() {
    return {
      sessionId: this.sessionId,
      ...this.sessionStats,
      openPositions: this.positions.size,
      winRate: this.sessionStats.tradesClosed > 0 
        ? (this.sessionStats.winCount / this.sessionStats.tradesClosed * 100).toFixed(2) + '%'
        : 'N/A'
    };
  }

  /**
   * Close the trading session
   */
  async closeSession() {
    if (!this.sessionId) return;
    
    try {
      await updateSession(this.sessionId, {
        ended_at: new Date().toISOString(),
        status: "STOPPED"
      });
      
      console.log(`[LiveTrader] Session ${this.sessionId} closed`);
    } catch (err) {
      console.warn("[LiveTrader] Failed to close session:", err.message);
    }
  }
}

// Singleton instance
export const liveTrader = new LiveTrader();
