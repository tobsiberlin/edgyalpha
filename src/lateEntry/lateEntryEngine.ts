/**
 * Late-Entry V3 Strategy Engine
 *
 * Strategie: Einstieg in 15-Minuten Crypto-Märkte nur in den letzten 4 Minuten
 *
 * Regeln:
 * 1. Nur 15-Min Markets (BTC, ETH, SOL, XRP)
 * 2. Entry nur in letzten 240 Sekunden (4 Min)
 * 3. Min. 30% Confidence (Preis > 0.30 oder < 0.70)
 * 4. Dynamisches Sizing basierend auf Time + Confidence
 *
 * Inspiriert von:
 * - https://github.com/0xMuTwo/4coinsbot
 * - Top Trader Account88888 (15min BTC Focus)
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { polymarketClient } from '../api/polymarket.js';
import { Market } from '../types/index.js';
import logger from '../utils/logger.js';
import {
  SupportedCoin,
  MarketWindow,
  LateEntrySignal,
  LateEntryTrade,
  LateEntryConfig,
  LateEntryStats,
  DEFAULT_LATE_ENTRY_CONFIG,
  isCryptoMarket,
} from './types.js';

export class LateEntryEngine extends EventEmitter {
  private config: LateEntryConfig;
  private stats: LateEntryStats;
  private isRunning = false;
  private scanInterval: NodeJS.Timeout | null = null;

  // Aktive Market Windows (15-Min Markets im Entry-Fenster)
  private activeWindows: Map<string, MarketWindow> = new Map();

  // Pending und abgeschlossene Trades
  private pendingTrades: Map<string, LateEntryTrade> = new Map();
  private completedTrades: LateEntryTrade[] = [];

  constructor(config?: Partial<LateEntryConfig>) {
    super();
    this.config = { ...DEFAULT_LATE_ENTRY_CONFIG, ...config };
    this.stats = {
      marketsMonitored: 0,
      signalsGenerated: 0,
      tradesExecuted: 0,
      tradesWon: 0,
      tradesLost: 0,
      totalVolume: 0,
      totalPayout: 0,
      totalProfit: 0,
      winRate: 0,
      statsByCoin: {
        BTC: { trades: 0, wins: 0, profit: 0 },
        ETH: { trades: 0, wins: 0, profit: 0 },
        SOL: { trades: 0, wins: 0, profit: 0 },
        XRP: { trades: 0, wins: 0, profit: 0 },
      },
    };

    logger.info('[LATE-ENTRY] Engine initialisiert');
    logger.info(`[LATE-ENTRY] Config: entryWindow=${this.config.entryWindowSeconds}s, minConfidence=${(this.config.minConfidence * 100).toFixed(0)}%`);
    logger.info(`[LATE-ENTRY] Coins: ${this.config.enabledCoins.join(', ')}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                     START / STOP
  // ═══════════════════════════════════════════════════════════════

  start(): void {
    if (this.isRunning) {
      logger.warn('[LATE-ENTRY] Engine läuft bereits');
      return;
    }

    if (!this.config.enabled) {
      logger.warn('[LATE-ENTRY] Engine ist deaktiviert');
      return;
    }

    this.isRunning = true;
    logger.info('[LATE-ENTRY] ═══════════════════════════════════════════════════════');
    logger.info('[LATE-ENTRY] ⏱️ LATE-ENTRY V3 STRATEGY ENGINE GESTARTET');
    logger.info('[LATE-ENTRY] ═══════════════════════════════════════════════════════');

    // Schnelleres Scanning für Late-Entry (alle 5 Sekunden)
    this.scanInterval = setInterval(() => {
      this.scan().catch(err => logger.error(`[LATE-ENTRY] Scan-Fehler: ${err.message}`));
    }, 5000);

    // Erster Scan sofort
    this.scan().catch(err => logger.error(`[LATE-ENTRY] Scan-Fehler: ${err.message}`));
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.isRunning = false;
    logger.info('[LATE-ENTRY] Engine gestoppt');
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MAIN SCAN LOGIC
  // ═══════════════════════════════════════════════════════════════

  async scan(): Promise<LateEntrySignal[]> {
    const signals: LateEntrySignal[] = [];

    try {
      // 1. Hole aktive Märkte
      const markets = await polymarketClient.getActiveMarketsWithVolume(1000);

      // 2. Filtere auf Crypto 15-Min Markets
      const cryptoMarkets = this.filterCryptoMarkets(markets);
      this.stats.marketsMonitored = cryptoMarkets.length;

      // 3. Analysiere jeden Markt
      for (const market of cryptoMarkets) {
        const window = this.analyzeMarketWindow(market);
        if (!window) continue;

        // Speichere aktive Windows
        if (window.isInEntryWindow) {
          this.activeWindows.set(market.id, window);

          // Generiere Signal wenn Bedingungen erfüllt
          const signal = this.generateSignal(window);
          if (signal) {
            signals.push(signal);
            this.stats.signalsGenerated++;
            this.stats.lastSignalAt = new Date();

            this.emit('signal', signal);

            logger.info(
              `[LATE-ENTRY] 🎯 SIGNAL: ${window.coin} ${signal.direction.toUpperCase()} ` +
              `@ ${(signal.entryPrice * 100).toFixed(0)}% | ` +
              `${signal.secondsToClose}s remaining | ` +
              `Confidence: ${(signal.confidence * 100).toFixed(0)}%`
            );
          }
        } else {
          // Entferne aus aktiven Windows wenn außerhalb des Entry-Fensters
          this.activeWindows.delete(market.id);
        }
      }

      // 4. Cleanup alte Windows
      this.cleanupOldWindows();

    } catch (err) {
      logger.error(`[LATE-ENTRY] Scan-Fehler: ${(err as Error).message}`);
    }

    return signals;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MARKET FILTERING
  // ═══════════════════════════════════════════════════════════════

  private filterCryptoMarkets(markets: Market[]): Market[] {
    return markets.filter(market => {
      const coin = isCryptoMarket(market.question);
      if (!coin) return false;

      // Nur aktivierte Coins
      if (!this.config.enabledCoins.includes(coin)) return false;

      // Prüfe ob 15-Min Market (hat endDate in naher Zukunft)
      if (!market.endDate) return false;

      const endTime = new Date(market.endDate);
      const now = new Date();
      const minutesToClose = (endTime.getTime() - now.getTime()) / (60 * 1000);

      // Nur Märkte die in 0-15 Minuten enden
      return minutesToClose > 0 && minutesToClose <= 15;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MARKET WINDOW ANALYSIS
  // ═══════════════════════════════════════════════════════════════

  private analyzeMarketWindow(market: Market): MarketWindow | null {
    const coin = isCryptoMarket(market.question);
    if (!coin || !market.endDate) return null;

    const now = new Date();
    const endTime = new Date(market.endDate);
    const secondsRemaining = Math.max(0, (endTime.getTime() - now.getTime()) / 1000);

    // Berechne Start (15 Min vor End)
    const startTime = new Date(endTime.getTime() - 15 * 60 * 1000);
    const durationMinutes = 15;

    // YES Preis
    const yesOutcome = market.outcomes?.find(o => o.name.toLowerCase() === 'yes');
    const currentPrice = yesOutcome?.price || 0.5;

    // Richtung aus Preis ableiten
    let direction: 'up' | 'down' | 'neutral' = 'neutral';
    if (currentPrice > 0.6) direction = 'up';
    else if (currentPrice < 0.4) direction = 'down';

    // Entry Window: Letzte 4 Minuten
    const entryWindowStart = new Date(endTime.getTime() - this.config.entryWindowSeconds * 1000);
    const isInEntryWindow = now >= entryWindowStart && secondsRemaining > this.config.minSecondsRemaining;

    return {
      marketId: market.id,
      coin,
      question: market.question,
      slug: market.slug,

      startTime,
      endTime,
      durationMinutes,

      currentPrice,
      direction,

      secondsRemaining,
      isInEntryWindow,
      entryWindowStart,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //                     SIGNAL GENERATION
  // ═══════════════════════════════════════════════════════════════

  private generateSignal(window: MarketWindow): LateEntrySignal | null {
    // Confidence aus Preis-Distanz zur Mitte (0.5)
    const distanceFromMiddle = Math.abs(window.currentPrice - 0.5);
    const confidence = distanceFromMiddle * 2; // 0.5 Distance = 100% Confidence

    // Minimum Confidence Check
    if (confidence < this.config.minConfidence) {
      return null;
    }

    // Direction: Folge dem Trend
    const direction: 'yes' | 'no' = window.currentPrice > 0.5 ? 'yes' : 'no';
    const entryPrice = direction === 'yes' ? window.currentPrice : (1 - window.currentPrice);
    const targetPrice = 1; // Ziel ist immer $1 bei Gewinn

    // Urgency basierend auf verbleibender Zeit
    let urgency: 'high' | 'medium' | 'low' = 'low';
    if (window.secondsRemaining < 60) urgency = 'high';
    else if (window.secondsRemaining < 120) urgency = 'medium';

    // Sizing: Basis + Confidence Multiplier + Time Multiplier
    let recommendedSize = this.config.minTradeSize;

    if (this.config.sizingMultiplierByConfidence) {
      // Higher confidence = larger size (bis zu maxTradeSize)
      const confidenceMultiplier = 1 + (confidence * 2); // 1x bis 3x
      recommendedSize = Math.min(
        this.config.minTradeSize * confidenceMultiplier,
        this.config.maxTradeSize
      );
    }

    // Time-based sizing: Später = sicherer = größer
    const timeMultiplier = 1 + ((240 - window.secondsRemaining) / 240); // 1x bis 2x
    recommendedSize = Math.min(recommendedSize * timeMultiplier, this.config.maxTradeSize);

    const maxSize = this.config.maxTradeSize;

    const reasoning: string[] = [
      `Late-Entry V3: ${window.coin} 15-Min Market`,
      `Preis: ${(window.currentPrice * 100).toFixed(0)}% → ${direction.toUpperCase()}`,
      `Confidence: ${(confidence * 100).toFixed(0)}% (Distanz von 50%)`,
      `Verbleibend: ${window.secondsRemaining.toFixed(0)}s`,
      `Empfohlen: $${recommendedSize.toFixed(2)}`,
    ];

    return {
      id: `late-${window.marketId}-${Date.now()}`,
      window,
      direction,
      confidence,
      entryPrice,
      targetPrice,
      secondsToClose: window.secondsRemaining,
      urgency,
      recommendedSize,
      maxSize,
      reasoning,
      createdAt: new Date(),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //                     TRADE EXECUTION
  // ═══════════════════════════════════════════════════════════════

  async executeTrade(signal: LateEntrySignal): Promise<LateEntryTrade> {
    const trade: LateEntryTrade = {
      id: uuidv4(),
      signalId: signal.id,
      marketId: signal.window.marketId,
      coin: signal.window.coin,

      direction: signal.direction,
      size: signal.recommendedSize,
      entryPrice: signal.entryPrice,

      status: 'pending',
      resolved: false,

      createdAt: new Date(),
    };

    this.pendingTrades.set(trade.id, trade);
    this.stats.tradesExecuted++;
    this.stats.totalVolume += trade.size;
    this.stats.statsByCoin[trade.coin].trades++;
    this.stats.lastTradeAt = new Date();

    logger.info(
      `[LATE-ENTRY] 📝 Trade erstellt: ${trade.coin} ${trade.direction.toUpperCase()} ` +
      `| Size: $${trade.size.toFixed(2)} @ ${(trade.entryPrice * 100).toFixed(0)}%`
    );

    // TODO: Tatsächliche Order-Execution über CLOB API

    this.emit('trade_created', trade);

    return trade;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     CLEANUP & HELPERS
  // ═══════════════════════════════════════════════════════════════

  private cleanupOldWindows(): void {
    const now = Date.now();
    for (const [id, window] of this.activeWindows) {
      if (window.endTime.getTime() < now) {
        this.activeWindows.delete(id);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                     GETTERS & SETTERS
  // ═══════════════════════════════════════════════════════════════

  getStats(): LateEntryStats {
    // Update Win Rate
    const totalTrades = this.stats.tradesWon + this.stats.tradesLost;
    this.stats.winRate = totalTrades > 0 ? this.stats.tradesWon / totalTrades : 0;
    return { ...this.stats };
  }

  getConfig(): LateEntryConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<LateEntryConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('[LATE-ENTRY] Config aktualisiert:', this.config);
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (enabled && !this.isRunning) {
      this.start();
    } else if (!enabled && this.isRunning) {
      this.stop();
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getActiveWindows(): MarketWindow[] {
    return Array.from(this.activeWindows.values());
  }

  getPendingTrades(): LateEntryTrade[] {
    return Array.from(this.pendingTrades.values());
  }

  getCompletedTrades(limit = 50): LateEntryTrade[] {
    return this.completedTrades.slice(-limit);
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

export const lateEntryEngine = new LateEntryEngine();
export default lateEntryEngine;
