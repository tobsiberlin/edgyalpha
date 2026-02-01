import { polymarketClient } from '../api/polymarket.js';
import { germanySources } from '../germany/index.js';
import { createAlphaSignal, createTradeRecommendation } from './alpha.js';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';
import {
  Market,
  AlphaSignal,
  TradeRecommendation,
  ScanResult,
  MarketCategory,
} from '../types/index.js';
import { EventEmitter } from 'events';

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
      const allMarkets = await polymarketClient.getActiveMarketsWithVolume(
        config.scanner.minVolumeUsd
      );

      // 2. Nach Kategorien filtern
      const markets = this.filterByCategories(allMarkets);
      marketsScanned = markets.length;
      logger.info(`${marketsScanned} Märkte nach Kategorie-Filter`);

      // 3. Deutschland-Daten holen (falls aktiviert)
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

      // 4. Alpha Scoring für jeden Markt
      for (const market of markets) {
        try {
          const germanSources = germanData?.get(market.id);

          const signal = createAlphaSignal(market, {
            germanSources,
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

      // Signale nach Score sortieren
      signals.sort((a, b) => b.score - a.score);
      recommendations.sort((a, b) => b.signal.score - a.signal.score);

    } catch (err) {
      const error = err as Error;
      logger.error(`Scan-Fehler: ${error.message}`);
      errors.push(error.message);
    }

    const duration = Date.now() - startTime;
    this.totalScans++;
    this.isScanning = false;

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
