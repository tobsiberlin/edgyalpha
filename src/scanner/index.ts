import { polymarketClient } from '../api/polymarket.js';
import { germanySources } from '../germany/index.js';
import { config } from '../utils/config.js';

// scanner/alpha.js wurde entfernt (V4.0) - Trading über neue Strategien (Arbitrage/Late-Entry)
// Einfache Fallback-Funktionen für Kompatibilität
import {
  Market,
  AlphaSignal,
  TradeRecommendation,
  ScanResult,
  MarketCategory,
} from '../types/index.js';

function createAlphaSignal(market: Market, _options: unknown): AlphaSignal | null {
  // Vereinfachtes Alpha-Signal für Kompatibilität
  const yesOutcome = market.outcomes?.find(o => o.name?.toLowerCase() === 'yes');
  const price = yesOutcome?.price || 0.5;

  // Nur ein Signal wenn Preis weit von 50% entfernt (potentielles Edge)
  const edge = Math.abs(price - 0.5);
  if (edge < 0.1) return null;

  return {
    id: `alpha-${market.id}-${Date.now()}`,
    market,
    score: edge,
    edge,
    confidence: 0.5 + edge,
    direction: price < 0.5 ? 'YES' : 'NO',
    reasoning: 'Preis-basiertes Alpha (vereinfacht)',
    sources: ['scanner'],
    timestamp: new Date(),
  };
}

function analyzeNewsForMarket(_market: Market, _news: unknown[]): { matchCount: number } {
  // Vereinfachte News-Analyse - die eigentliche Logik ist im Ticker
  return { matchCount: 0 };
}

function createTradeRecommendation(signal: AlphaSignal, maxBankroll: number): TradeRecommendation {
  const positionSize = Math.min(maxBankroll * signal.edge * 0.25, maxBankroll * 0.1);
  return {
    signal,
    positionSize,
    kellyFraction: signal.edge * 0.25,
    expectedValue: signal.edge * positionSize,
    maxLoss: positionSize,
    riskRewardRatio: signal.edge > 0 ? (1 / signal.edge) : 2,
  };
}
import logger from '../utils/logger.js';
import { EventEmitter } from 'events';
import { runtimeState } from '../runtime/state.js';
import { timeDelayEngine } from '../alpha/timeDelayEngine.js';
import { SourceEvent } from '../alpha/types.js';

export class AlphaScanner extends EventEmitter {
  private isScanning = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private lastScanResult: ScanResult | null = null;
  private totalScans = 0;

  constructor() {
    super();
  }

  async start(): Promise<void> {
    logger.info('Alpha Scanner wird gestartet...');
    logger.info(`Scan-Intervall: ${config.scanner.intervalMs / 1000}s`);
    logger.info(`Min. Volume: $${config.scanner.minVolumeUsd.toLocaleString()}`);
    logger.info(`Kategorien: ${config.scanner.categories.join(', ')}`);
    logger.info(`Deutschland-Modus: ${config.germany.enabled ? 'Aktiv' : 'Inaktiv'}`);

    // Erster Scan sofort
    await this.scan();

    // Regelmäßige Scans
    this.scanInterval = setInterval(() => {
      this.scan().catch((err) => {
        logger.error(`Scan-Fehler: ${err.message}`);
      });
    }, config.scanner.intervalMs);
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    logger.info('Alpha Scanner gestoppt');
  }

  async scan(): Promise<ScanResult> {
    if (this.isScanning) {
      logger.warn('Scan bereits aktiv, überspringe...');
      return this.lastScanResult || this.emptyResult();
    }

    this.isScanning = true;
    this.emit('scan_started');
    const startTime = Date.now();

    const signals: AlphaSignal[] = [];
    const recommendations: TradeRecommendation[] = [];
    const errors: string[] = [];
    let marketsScanned = 0;

    try {
      // 1. Märkte von Polymarket holen
      logger.info('Scanne Polymarket Märkte...');
      let allMarkets;
      try {
        allMarkets = await polymarketClient.getActiveMarketsWithVolume(
          config.scanner.minVolumeUsd
        );
        // Pipeline Success: Polymarket Daten erfolgreich geladen
        runtimeState.recordPipelineSuccess('polymarket');
      } catch (polyErr) {
        const error = polyErr as Error;
        runtimeState.recordPipelineError('polymarket', error.message);
        throw error;
      }

      // 2. Nach Kategorien filtern
      const markets = this.filterByCategories(allMarkets);
      marketsScanned = markets.length;
      logger.info(`${marketsScanned} Märkte nach Kategorie-Filter`);

      // 3. ALLE News laden (DE + International) für Alpha-Analyse
      const allNews = germanySources.getLatestNews();
      logger.info(`📰 ${allNews.length} News für Alpha-Analyse verfügbar`);

      // 4. Deutschland-Daten holen (falls aktiviert)
      let germanData: Map<string, { relevance: number; direction: 'YES' | 'NO' }[]> | null = null;

      if (config.germany.enabled) {
        try {
          logger.info('Lade Deutschland-Informationen...');
          germanData = await germanySources.matchMarketsWithGermanData(markets);
          logger.info(`${germanData.size} Märkte mit DE-Daten angereichert`);
        } catch (err) {
          const error = err as Error;
          logger.error(`Deutschland-Quellen Fehler: ${error.message}`);
          errors.push(`DE-Quellen: ${error.message}`);
        }
      }

      // 5. Alpha Scoring für jeden Markt (mit ALLEN Quellen!)
      let newsMatches = 0;
      for (const market of markets) {
        try {
          const germanSourcesData = germanData?.get(market.id);

          // NEWS-ALPHA: Alle News gegen diesen Markt matchen
          const newsAlpha = analyzeNewsForMarket(market, allNews);
          if (newsAlpha.matchCount > 0) {
            newsMatches++;
          }

          const signal = createAlphaSignal(market, {
            germanSources: germanSourcesData,
            newsAlpha, // NEU: News-basierte Alpha-Daten
          });

          if (signal) {
            signals.push(signal);
            this.emit('signal_found', signal);

            // Trade Recommendation erstellen
            const recommendation = createTradeRecommendation(
              signal,
              config.trading.maxBankrollUsdc
            );

            if (recommendation.positionSize > 0) {
              recommendations.push(recommendation);
            }
          }
        } catch (err) {
          const error = err as Error;
          logger.debug(`Markt-Analyse Fehler: ${error.message}`);
        }
      }

      logger.info(`📊 ${newsMatches} Märkte mit News-Matches`);

      // ═══════════════════════════════════════════════════════════════
      // TIME_DELAY ENGINE: Bessere Signal-Generierung
      // Nutzt die neue TimeDelayEngine für strukturierte Signale
      // ═══════════════════════════════════════════════════════════════
      try {
        // News zu SourceEvents konvertieren
        const sourceEvents: SourceEvent[] = allNews.map(n => ({
          eventHash: (n.data.hash as string) || `${n.data.source}:${n.title}`.substring(0, 200),
          sourceId: (n.data.source as string) || 'unknown',
          sourceName: (n.data.source as string) || 'Deutsche Quelle',
          url: n.url || null,
          title: n.title,
          content: (n.data.content as string) || null,
          category: (n.data.category as string) || 'news',
          keywords: (n.data.keywords as string[]) || [],
          publishedAt: n.publishedAt || null,
          ingestedAt: new Date(),
          reliabilityScore: 0.8, // Standard für kuratierte Quellen
        }));

        // Market-Preise zum Zeitpunkt der News (vereinfacht: aktuelle Preise)
        const marketPricesAtNews = new Map<string, number>();
        for (const market of markets) {
          const yesOutcome = market.outcomes.find(o => o.name.toLowerCase() === 'yes');
          if (yesOutcome) {
            marketPricesAtNews.set(market.id, yesOutcome.price);
          }
        }

        // TimeDelayEngine Signale generieren
        const timeDelaySignals = await timeDelayEngine.generateSignals(
          sourceEvents,
          markets,
          marketPricesAtNews
        );

        logger.info(`⏱️ TimeDelayEngine: ${timeDelaySignals.length} Signale generiert`);

        // TimeDelay Signale als Events emittieren
        for (const signal of timeDelaySignals) {
          this.emit('time_delay_signal', signal);
        }
      } catch (err) {
        const error = err as Error;
        logger.error(`TimeDelayEngine Fehler: ${error.message}`);
        errors.push(`TimeDelayEngine: ${error.message}`);
      }

      // Signale nach Score sortieren
      signals.sort((a, b) => b.score - a.score);
      recommendations.sort((a, b) => b.signal.score - a.signal.score);

    } catch (err) {
      const error = err as Error;
      logger.error(`Scan-Fehler: ${error.message}`);
      errors.push(error.message);
    } finally {
      // KRITISCH: isScanning Flag IMMER zurücksetzen, auch bei Fehlern
      this.isScanning = false;
    }

    const duration = Date.now() - startTime;
    this.totalScans++;

    const result: ScanResult = {
      timestamp: new Date(),
      marketsScanned,
      signalsFound: signals,
      recommendations,
      duration,
      errors,
    };

    this.lastScanResult = result;
    this.emit('scan_completed', result);

    logger.info(
      `Scan abgeschlossen: ${marketsScanned} Märkte | ${signals.length} Signale | ${duration}ms`
    );

    return result;
  }

  private filterByCategories(markets: Market[]): Market[] {
    if (config.scanner.categories.length === 0) {
      return markets;
    }

    return markets.filter((m) =>
      config.scanner.categories.includes(m.category as MarketCategory)
    );
  }

  private emptyResult(): ScanResult {
    return {
      timestamp: new Date(),
      marketsScanned: 0,
      signalsFound: [],
      recommendations: [],
      duration: 0,
      errors: [],
    };
  }

  getStatus() {
    return {
      isScanning: this.isScanning,
      totalScans: this.totalScans,
      lastScan: this.lastScanResult?.timestamp || null,
      lastSignalsCount: this.lastScanResult?.signalsFound.length || 0,
    };
  }

  getLastResult(): ScanResult | null {
    return this.lastScanResult;
  }
}

export const scanner = new AlphaScanner();
export default scanner;
