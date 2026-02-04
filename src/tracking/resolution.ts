/**
 * Trade Resolution Service - V4.1
 *
 * Prüft Märkte auf Resolution und aktualisiert Trade-Status
 * Berechnet echte PnL basierend auf Markt-Outcomes
 */

import { EventEmitter } from 'events';
import { polymarketClient } from '../api/polymarket.js';
import { performanceTracker, TrackedTrade } from './index.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
//                     TYPES
// ═══════════════════════════════════════════════════════════════

export interface MarketResolution {
  marketId: string;
  resolved: boolean;
  outcome?: 'yes' | 'no';
  resolutionTime?: Date;
}

export interface ResolutionResult {
  tradeId: string;
  marketId: string;
  won: boolean;
  payout: number;
  profit: number;
  resolvedAt: Date;
}

// ═══════════════════════════════════════════════════════════════
//                     RESOLUTION SERVICE
// ═══════════════════════════════════════════════════════════════

export class TradeResolutionService extends EventEmitter {
  private checkInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private checkIntervalMs = 60000; // Check every minute

  // Cache für bereits geprüfte Märkte
  private resolvedMarkets: Map<string, MarketResolution> = new Map();

  constructor() {
    super();
    logger.info('[RESOLUTION] Trade Resolution Service initialisiert');
  }

  // ═══════════════════════════════════════════════════════════════
  //                     START / STOP
  // ═══════════════════════════════════════════════════════════════

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    logger.info('[RESOLUTION] ═══════════════════════════════════════════════════════');
    logger.info('[RESOLUTION] 🎯 TRADE RESOLUTION SERVICE GESTARTET');
    logger.info('[RESOLUTION] ═══════════════════════════════════════════════════════');

    // Erster Check sofort
    this.checkPendingTrades().catch(err =>
      logger.error(`[RESOLUTION] Check-Fehler: ${err.message}`)
    );

    // Regelmäßige Checks
    this.checkInterval = setInterval(() => {
      this.checkPendingTrades().catch(err =>
        logger.error(`[RESOLUTION] Check-Fehler: ${err.message}`)
      );
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    logger.info('[RESOLUTION] Service gestoppt');
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MAIN CHECK LOGIC
  // ═══════════════════════════════════════════════════════════════

  async checkPendingTrades(): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];

    // Hole alle pending/filled Trades
    const pendingTrades = performanceTracker.getPendingTrades();

    if (pendingTrades.length === 0) {
      return results;
    }

    logger.debug(`[RESOLUTION] Prüfe ${pendingTrades.length} offene Trades...`);

    // Gruppiere nach Market ID
    const tradesByMarket = new Map<string, TrackedTrade[]>();
    for (const trade of pendingTrades) {
      const existing = tradesByMarket.get(trade.marketId) || [];
      existing.push(trade);
      tradesByMarket.set(trade.marketId, existing);
    }

    // Prüfe jeden Markt
    for (const [marketId, trades] of tradesByMarket) {
      try {
        const resolution = await this.checkMarketResolution(marketId);

        if (resolution.resolved && resolution.outcome) {
          // Markt ist resolved - update alle Trades
          for (const trade of trades) {
            const result = this.resolveTrade(trade, resolution);
            if (result) {
              results.push(result);
              this.emit('trade_resolved', result);
            }
          }
        }
      } catch (err) {
        logger.debug(`[RESOLUTION] Markt ${marketId} check failed: ${(err as Error).message}`);
      }
    }

    if (results.length > 0) {
      logger.info(`[RESOLUTION] ✅ ${results.length} Trades resolved`);
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MARKET RESOLUTION CHECK
  // ═══════════════════════════════════════════════════════════════

  private async checkMarketResolution(marketId: string): Promise<MarketResolution> {
    // Check Cache first
    const cached = this.resolvedMarkets.get(marketId);
    if (cached?.resolved) {
      return cached;
    }

    // Fetch market from API
    try {
      const market = await polymarketClient.getMarketById(marketId);

      if (!market) {
        return { marketId, resolved: false };
      }

      // Check if market is resolved
      // Polymarket markets have 'closed' status when resolved
      const marketAny = market as { closed?: boolean; resolved?: boolean; resolutionSource?: string };
      const isResolved = marketAny.closed === true || marketAny.resolved === true;

      if (!isResolved) {
        return { marketId, resolved: false };
      }

      // Determine outcome
      let outcome: 'yes' | 'no' | undefined;

      if (market.outcomes && market.outcomes.length >= 2) {
        // Check which outcome won (price = 1.0 means it won)
        const yesOutcome = market.outcomes.find((o: { name: string; price: number }) => o.name.toLowerCase() === 'yes');
        const noOutcome = market.outcomes.find((o: { name: string; price: number }) => o.name.toLowerCase() === 'no');

        if (yesOutcome && yesOutcome.price >= 0.99) {
          outcome = 'yes';
        } else if (noOutcome && noOutcome.price >= 0.99) {
          outcome = 'no';
        } else if (yesOutcome && yesOutcome.price <= 0.01) {
          outcome = 'no';
        } else if (noOutcome && noOutcome.price <= 0.01) {
          outcome = 'yes';
        }
      }

      // Fallback: Check resolutionSource if available
      if (!outcome && marketAny.resolutionSource) {
        const resSource = marketAny.resolutionSource.toLowerCase();
        if (resSource.includes('yes')) outcome = 'yes';
        else if (resSource.includes('no')) outcome = 'no';
      }

      const resolution: MarketResolution = {
        marketId,
        resolved: true,
        outcome,
        resolutionTime: market.endDate ? new Date(market.endDate) : new Date(),
      };

      // Cache the result
      this.resolvedMarkets.set(marketId, resolution);

      logger.info(`[RESOLUTION] Markt ${marketId} resolved: ${outcome?.toUpperCase() || 'UNKNOWN'}`);

      return resolution;

    } catch (err) {
      logger.debug(`[RESOLUTION] API Error für ${marketId}: ${(err as Error).message}`);
      return { marketId, resolved: false };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                     TRADE RESOLUTION
  // ═══════════════════════════════════════════════════════════════

  private resolveTrade(trade: TrackedTrade, resolution: MarketResolution): ResolutionResult | null {
    if (!resolution.outcome) {
      logger.warn(`[RESOLUTION] Kein Outcome für Trade ${trade.id}`);
      return null;
    }

    // Bestimme ob gewonnen
    const won = trade.direction === resolution.outcome;

    // Berechne Payout
    // Gewonnen: $1 pro Share
    // Verloren: $0 (Entry verloren)
    const payout = won ? trade.size : 0;
    const profit = won
      ? (1 - trade.entryPrice) * trade.size  // Gewinn = (1 - Einkaufspreis) * Shares
      : -trade.entryPrice * trade.size;       // Verlust = Einkaufspreis * Shares

    // Update Trade im Tracker
    performanceTracker.resolveTrade(trade.id, won, won ? 1 : 0);

    const result: ResolutionResult = {
      tradeId: trade.id,
      marketId: trade.marketId,
      won,
      payout,
      profit,
      resolvedAt: resolution.resolutionTime || new Date(),
    };

    logger.info(
      `[RESOLUTION] Trade ${trade.id.substring(0, 8)}... ${won ? '✅ WON' : '❌ LOST'} | ` +
      `Profit: $${profit.toFixed(2)} | Direction: ${trade.direction} | Outcome: ${resolution.outcome}`
    );

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MANUAL RESOLUTION (for testing)
  // ═══════════════════════════════════════════════════════════════

  async manualResolve(tradeId: string, won: boolean): Promise<ResolutionResult | null> {
    const trades = performanceTracker.getTrades(1000);
    const trade = trades.find(t => t.id === tradeId);

    if (!trade) {
      logger.warn(`[RESOLUTION] Trade ${tradeId} nicht gefunden`);
      return null;
    }

    const payout = won ? trade.size : 0;
    const profit = won
      ? (1 - trade.entryPrice) * trade.size
      : -trade.entryPrice * trade.size;

    performanceTracker.resolveTrade(tradeId, won, won ? 1 : 0);

    const result: ResolutionResult = {
      tradeId,
      marketId: trade.marketId,
      won,
      payout,
      profit,
      resolvedAt: new Date(),
    };

    this.emit('trade_resolved', result);

    logger.info(`[RESOLUTION] Manual resolve: ${tradeId} → ${won ? 'WON' : 'LOST'}`);

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     SIMULATE RESOLUTION (Paper Mode)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Simuliert Resolution für Paper-Trades basierend auf Entry Price
   * Höhere Entry Prices haben höhere Win-Wahrscheinlichkeit
   */
  async simulateResolution(tradeId: string): Promise<ResolutionResult | null> {
    const trades = performanceTracker.getTrades(1000);
    const trade = trades.find(t => t.id === tradeId);

    if (!trade) return null;

    // Simuliere Win basierend auf Entry Price
    // Entry 0.70 YES = 70% Win Chance
    // Entry 0.30 NO = 70% Win Chance (inverted)
    const winProbability = trade.direction === 'yes'
      ? trade.entryPrice
      : (1 - trade.entryPrice);

    const won = Math.random() < winProbability;

    return this.manualResolve(tradeId, won);
  }

  // ═══════════════════════════════════════════════════════════════
  //                     GETTERS
  // ═══════════════════════════════════════════════════════════════

  isActive(): boolean {
    return this.isRunning;
  }

  getCachedResolutions(): MarketResolution[] {
    return Array.from(this.resolvedMarkets.values());
  }
}

// ═══════════════════════════════════════════════════════════════
//                     SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

export const tradeResolutionService = new TradeResolutionService();
export default tradeResolutionService;
