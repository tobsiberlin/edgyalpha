/**
 * Dutch-Book Arbitrage Engine
 *
 * Strategie: Kaufe YES + NO wenn die Summe < $1.00
 * → Garantierter Gewinn = $1.00 - (YES + NO)
 *
 * Beispiel:
 *   YES @ $0.48
 *   NO @ $0.50
 *   Total: $0.98
 *   Profit: $0.02 pro Share (2% risikofrei)
 *
 * Inspiriert von:
 * - https://github.com/0xMuTwo/collectmarkets2
 * - Top Trader Strategien (gabagool22, 0x8dxd)
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { polymarketClient } from '../api/polymarket.js';
import { Market } from '../types/index.js';
import logger from '../utils/logger.js';
import {
  ArbitrageOpportunity,
  ArbitrageSignal,
  ArbitrageTrade,
  ArbitrageConfig,
  ArbitrageStats,
  DEFAULT_ARBITRAGE_CONFIG,
} from './types.js';

export class DutchBookEngine extends EventEmitter {
  private config: ArbitrageConfig;
  private stats: ArbitrageStats;
  private isScanning = false;
  private scanInterval: NodeJS.Timeout | null = null;

  // Cache für aktive Opportunities
  private activeOpportunities: Map<string, ArbitrageOpportunity> = new Map();

  // Pending Trades
  private pendingTrades: Map<string, ArbitrageTrade> = new Map();

  constructor(config?: Partial<ArbitrageConfig>) {
    super();
    this.config = { ...DEFAULT_ARBITRAGE_CONFIG, ...config };
    this.stats = {
      scansTotal: 0,
      opportunitiesFound: 0,
      signalsGenerated: 0,
      tradesExecuted: 0,
      tradesFailed: 0,
      totalVolume: 0,
      totalProfit: 0,
      avgProfitPercent: 0,
    };

    logger.info('[DUTCH-BOOK] Engine initialisiert');
    logger.info(`[DUTCH-BOOK] Config: minSpread=${(this.config.minSpread * 100).toFixed(1)}%, minLiquidity=$${this.config.minLiquidity}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                     START / STOP
  // ═══════════════════════════════════════════════════════════════

  start(): void {
    if (this.isScanning) {
      logger.warn('[DUTCH-BOOK] Engine läuft bereits');
      return;
    }

    if (!this.config.enabled) {
      logger.warn('[DUTCH-BOOK] Engine ist deaktiviert - setze enabled=true zum Starten');
      return;
    }

    this.isScanning = true;
    logger.info('[DUTCH-BOOK] ═══════════════════════════════════════════════════════');
    logger.info('[DUTCH-BOOK] 🎯 DUTCH-BOOK ARBITRAGE ENGINE GESTARTET');
    logger.info('[DUTCH-BOOK] ═══════════════════════════════════════════════════════');

    // Erster Scan sofort
    this.scan().catch(err => logger.error(`[DUTCH-BOOK] Scan-Fehler: ${err.message}`));

    // Regelmäßige Scans
    this.scanInterval = setInterval(() => {
      this.scan().catch(err => logger.error(`[DUTCH-BOOK] Scan-Fehler: ${err.message}`));
    }, this.config.scanIntervalMs);
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.isScanning = false;
    logger.info('[DUTCH-BOOK] Engine gestoppt');
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MAIN SCAN LOGIC
  // ═══════════════════════════════════════════════════════════════

  async scan(): Promise<ArbitrageOpportunity[]> {
    const startTime = Date.now();
    this.stats.scansTotal++;
    this.stats.lastScanAt = new Date();

    const opportunities: ArbitrageOpportunity[] = [];

    try {
      // 1. Hole aktive Märkte
      const markets = await polymarketClient.getActiveMarketsWithVolume(1000);
      const marketsToScan = markets.slice(0, this.config.maxMarketsPerScan);

      logger.debug(`[DUTCH-BOOK] Scanne ${marketsToScan.length} Märkte...`);

      // 2. Analysiere jeden Markt auf Arbitrage-Opportunity
      for (const market of marketsToScan) {
        const opportunity = this.analyzeMarket(market);
        if (opportunity) {
          opportunities.push(opportunity);
          this.activeOpportunities.set(opportunity.id, opportunity);
          this.stats.opportunitiesFound++;
          this.stats.lastOpportunityAt = new Date();

          // Event emittieren
          this.emit('opportunity', opportunity);

          logger.info(
            `[DUTCH-BOOK] 💰 OPPORTUNITY: ${opportunity.question.substring(0, 40)}... ` +
            `| Spread: ${(opportunity.spread * 100).toFixed(2)}% ` +
            `| MaxSize: $${opportunity.maxSize.toFixed(2)}`
          );
        }
      }

      // 3. Alte Opportunities entfernen (älter als 60 Sekunden)
      const now = Date.now();
      for (const [id, opp] of this.activeOpportunities) {
        if (now - opp.detectedAt.getTime() > 60000) {
          this.activeOpportunities.delete(id);
        }
      }

      const duration = Date.now() - startTime;
      logger.debug(`[DUTCH-BOOK] Scan abgeschlossen: ${opportunities.length} Opportunities in ${duration}ms`);

    } catch (err) {
      logger.error(`[DUTCH-BOOK] Scan-Fehler: ${(err as Error).message}`);
    }

    return opportunities;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MARKET ANALYSIS
  // ═══════════════════════════════════════════════════════════════

  private analyzeMarket(market: Market): ArbitrageOpportunity | null {
    // Binary Markets only (YES/NO)
    if (!market.outcomes || market.outcomes.length !== 2) {
      return null;
    }

    const yesOutcome = market.outcomes.find(o => o.name.toLowerCase() === 'yes');
    const noOutcome = market.outcomes.find(o => o.name.toLowerCase() === 'no');

    if (!yesOutcome || !noOutcome) {
      return null;
    }

    const yesPrice = yesOutcome.price;
    const noPrice = noOutcome.price;
    const totalCost = yesPrice + noPrice;

    // Dutch Book existiert nur wenn totalCost < 1.00
    if (totalCost >= 1.0) {
      return null;
    }

    const spread = 1.0 - totalCost;

    // Minimum Spread Check
    if (spread < this.config.minSpread) {
      return null;
    }

    // Liquidität Check (vereinfacht: nutze Volume als Proxy)
    const yesLiquidity = yesOutcome.volume24h || 0;
    const noLiquidity = noOutcome.volume24h || 0;
    const minLiquidity = Math.min(yesLiquidity, noLiquidity);

    // Minimum Liquidity Check
    if (minLiquidity < this.config.minLiquidity) {
      return null;
    }

    // Max Size = Minimum der beiden Seiten (begrenzt durch Config)
    const maxSize = Math.min(
      minLiquidity * 0.1, // Max 10% der verfügbaren Liquidität
      this.config.maxTradeSize
    );

    // Quality Score (0-1): Kombination aus Spread und Liquidität
    const spreadScore = Math.min(spread / 0.05, 1); // Max bei 5% Spread
    const liquidityScore = Math.min(minLiquidity / 10000, 1); // Max bei $10k
    const qualityScore = (spreadScore * 0.7) + (liquidityScore * 0.3);

    const opportunity: ArbitrageOpportunity = {
      id: `arb-${market.id}-${Date.now()}`,
      marketId: market.id,
      question: market.question,
      slug: market.slug,

      yesPrice,
      noPrice,
      totalCost,
      spread,

      yesLiquidity,
      noLiquidity,
      maxSize,

      profitPercent: spread * 100,
      qualityScore,

      detectedAt: new Date(),
    };

    return opportunity;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     SIGNAL GENERATION
  // ═══════════════════════════════════════════════════════════════

  generateSignal(opportunity: ArbitrageOpportunity, bankroll: number): ArbitrageSignal | null {
    // Size berechnen
    const maxBankrollSize = bankroll * this.config.maxBankrollPercent;
    const recommendedSize = Math.min(
      opportunity.maxSize,
      maxBankrollSize,
      this.config.maxTradeSize
    );

    if (recommendedSize < this.config.minTradeSize) {
      return null;
    }

    const expectedProfit = recommendedSize * opportunity.spread;

    // Confidence basierend auf Quality Score
    const confidence = opportunity.qualityScore;

    const reasoning: string[] = [
      `Dutch-Book Arbitrage: YES ($${opportunity.yesPrice.toFixed(2)}) + NO ($${opportunity.noPrice.toFixed(2)}) = $${opportunity.totalCost.toFixed(3)}`,
      `Garantierter Spread: ${(opportunity.spread * 100).toFixed(2)}%`,
      `Empfohlene Size: $${recommendedSize.toFixed(2)}`,
      `Erwarteter Profit: $${expectedProfit.toFixed(2)} (${(expectedProfit / recommendedSize * 100).toFixed(2)}%)`,
    ];

    const signal: ArbitrageSignal = {
      opportunity,
      recommendedSize,
      expectedProfit,
      confidence,
      reasoning,
    };

    this.stats.signalsGenerated++;
    this.emit('signal', signal);

    return signal;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     TRADE EXECUTION
  // Hinweis: Tatsächliche Execution über Trading API
  // ═══════════════════════════════════════════════════════════════

  async executeTrade(signal: ArbitrageSignal): Promise<ArbitrageTrade> {
    const trade: ArbitrageTrade = {
      id: uuidv4(),
      signalId: signal.opportunity.id,
      marketId: signal.opportunity.marketId,

      yesSize: signal.recommendedSize / 2, // Halbe Size für YES
      noSize: signal.recommendedSize / 2,  // Halbe Size für NO
      totalCost: signal.recommendedSize,

      status: 'pending',
      yesFilled: false,
      noFilled: false,

      createdAt: new Date(),
    };

    this.pendingTrades.set(trade.id, trade);

    logger.info(
      `[DUTCH-BOOK] 📝 Trade erstellt: ${trade.id.substring(0, 8)}... ` +
      `| Size: $${trade.totalCost.toFixed(2)} ` +
      `| Spread: ${(signal.opportunity.spread * 100).toFixed(2)}%`
    );

    // TODO: Tatsächliche Order-Execution über CLOB API
    // Dies erfordert Integration mit tradingClient

    // Emit Event für externe Handler (z.B. Telegram)
    this.emit('trade_created', trade);

    return trade;
  }

  // ═══════════════════════════════════════════════════════════════
  //                     GETTERS & SETTERS
  // ═══════════════════════════════════════════════════════════════

  getStats(): ArbitrageStats {
    return { ...this.stats };
  }

  getConfig(): ArbitrageConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<ArbitrageConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('[DUTCH-BOOK] Config aktualisiert:', this.config);
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (enabled && !this.isScanning) {
      this.start();
    } else if (!enabled && this.isScanning) {
      this.stop();
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  isRunning(): boolean {
    return this.isScanning;
  }

  getActiveOpportunities(): ArbitrageOpportunity[] {
    return Array.from(this.activeOpportunities.values());
  }

  getPendingTrades(): ArbitrageTrade[] {
    return Array.from(this.pendingTrades.values());
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

export const dutchBookEngine = new DutchBookEngine();
export default dutchBookEngine;
