/**
 * Time Advantage Service
 * Orchestriert das Tracking des "Alman Zeitvorsprungs"
 *
 * Workflow:
 * 1. Deutsche News wird erkannt → createTrackingEntry()
 * 2. News wird mit Polymarket gematcht → updateMatch()
 * 3. Preis-Snapshot wird gemacht → Initialer Preis gespeichert
 * 4. Price-Checks laufen: 5min, 15min, 30min, 60min, 4h, 24h
 * 5. Signifikante Bewegung erkannt → Zeitvorsprung berechnet
 * 6. Dashboard zeigt Statistiken
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { polymarketClient } from '../api/polymarket.js';
import { Market } from '../types/index.js';
import {
  createTrackingEntry,
  updatePriceCheck,
  getPendingPriceChecks,
  getTrackingById,
  getTimeAdvantageDashboard,
  calculateStats,
  saveStats,
  expireOldTrackings,
  getActiveTrackings,
  type TimeAdvantageInput,
  type TimeAdvantageDashboard,
  type TimeAdvantageStats,
} from '../storage/repositories/timeAdvantage.js';
import { isDatabaseInitialized } from '../storage/db.js';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const PRICE_CHECK_INTERVAL_MS = 60 * 1000; // Jede Minute prüfen
const STATS_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // Jede Stunde Stats updaten
const SIGNIFICANT_MOVE_THRESHOLD = 0.02; // 2% gilt als signifikante Bewegung

// ═══════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════

export class TimeAdvantageService extends EventEmitter {
  private priceCheckInterval: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private marketCache: Map<string, Market> = new Map();

  constructor() {
    super();
  }

  // ═══════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Startet den Service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('[TIME_ADVANTAGE_SERVICE] Bereits gestartet');
      return;
    }

    if (!isDatabaseInitialized()) {
      logger.warn('[TIME_ADVANTAGE_SERVICE] DB nicht initialisiert, Service deaktiviert');
      return;
    }

    this.isRunning = true;

    // Starte Price-Check Loop
    this.priceCheckInterval = setInterval(
      () => this.processPriceChecks(),
      PRICE_CHECK_INTERVAL_MS
    );

    // Starte Stats-Update Loop
    this.statsInterval = setInterval(
      () => this.updateAllStats(),
      STATS_UPDATE_INTERVAL_MS
    );

    // Initiale Cleanup
    expireOldTrackings(48);

    logger.info('[TIME_ADVANTAGE_SERVICE] Gestartet');
    logger.info(`   Price-Check Intervall: ${PRICE_CHECK_INTERVAL_MS / 1000}s`);
    logger.info(`   Stats-Update Intervall: ${STATS_UPDATE_INTERVAL_MS / 60000}min`);
  }

  /**
   * Stoppt den Service
   */
  stop(): void {
    if (this.priceCheckInterval) {
      clearInterval(this.priceCheckInterval);
      this.priceCheckInterval = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    this.isRunning = false;
    logger.info('[TIME_ADVANTAGE_SERVICE] Gestoppt');
  }

  // ═══════════════════════════════════════════════════════════════
  // NEWS TRACKING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Startet Tracking für eine deutsche News
   * Wird von germany/index.ts aufgerufen wenn Breaking News erkannt wird
   */
  async trackNews(
    newsId: string,
    newsSource: string,
    newsTitle: string,
    newsUrl: string | undefined,
    newsCategory: string | undefined,
    newsKeywords: string[],
    publishedAt: Date,
    detectedAt: Date,
    sentiment?: 'positive' | 'negative' | 'neutral'
  ): Promise<number> {
    const input: TimeAdvantageInput = {
      newsId,
      newsSource,
      newsTitle,
      newsUrl,
      newsCategory,
      newsKeywords,
      publishedAt,
      detectedAt,
      newsSentiment: sentiment,
    };

    const trackingId = createTrackingEntry(input);

    logger.info(`[TIME_ADVANTAGE_SERVICE] Tracking gestartet: ${newsTitle.substring(0, 50)}...`);

    this.emit('tracking_started', { trackingId, newsTitle, newsSource });

    return trackingId;
  }

  /**
   * Verknüpft News mit einem Polymarket-Markt
   * Wird aufgerufen wenn ein Match gefunden wird
   */
  async linkNewsToMarket(
    newsId: string,
    market: Market,
    matchConfidence: number,
    matchMethod: string
  ): Promise<void> {
    if (!isDatabaseInitialized()) return;

    // Hole aktuellen Preis
    const yesPrice = market.outcomes.find(o => o.name.toLowerCase() === 'yes')?.price
      ?? market.outcomes[0]?.price
      ?? 0.5;

    // Cache Markt für spätere Price-Checks
    this.marketCache.set(market.id, market);

    // Update Tracking mit Markt-Info
    const input: TimeAdvantageInput = {
      newsId,
      newsSource: '', // Wird nicht überschrieben
      newsTitle: '', // Wird nicht überschrieben
      publishedAt: new Date(), // Wird nicht überschrieben
      detectedAt: new Date(), // Wird nicht überschrieben
      matchedMarketId: market.id,
      matchedMarketQuestion: market.question,
      matchConfidence,
      matchMethod,
      priceAtNews: yesPrice,
    };

    createTrackingEntry(input);

    logger.info(
      `[TIME_ADVANTAGE_SERVICE] Markt verknüpft: ${market.question.substring(0, 40)}... ` +
      `(${(matchConfidence * 100).toFixed(0)}% confidence, Preis: ${(yesPrice * 100).toFixed(1)}%)`
    );

    this.emit('market_linked', {
      newsId,
      marketId: market.id,
      marketQuestion: market.question,
      priceAtNews: yesPrice,
      matchConfidence,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // PRICE CHECKING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Verarbeitet ausstehende Price-Checks
   */
  private async processPriceChecks(): Promise<void> {
    const pendingChecks = getPendingPriceChecks(20);

    if (pendingChecks.length === 0) {
      return;
    }

    logger.debug(`[TIME_ADVANTAGE_SERVICE] ${pendingChecks.length} Price-Checks ausstehend`);

    for (const check of pendingChecks) {
      try {
        await this.executePriceCheck(check.trackingId, check.checkType);
      } catch (err) {
        logger.error(`[TIME_ADVANTAGE_SERVICE] Price-Check Fehler: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Führt einen einzelnen Price-Check aus
   */
  private async executePriceCheck(
    trackingId: number,
    checkType: string
  ): Promise<void> {
    const tracking = getTrackingById(trackingId);

    if (!tracking || !tracking.matchedMarketId) {
      logger.debug(`[TIME_ADVANTAGE_SERVICE] Tracking ${trackingId} hat keinen Markt`);
      return;
    }

    // Versuche Markt aus Cache, sonst neu laden
    let market: Market | undefined = this.marketCache.get(tracking.matchedMarketId);

    if (!market) {
      const fetchedMarket = await polymarketClient.getMarketById(tracking.matchedMarketId);
      market = fetchedMarket ?? undefined;

      if (!market) {
        logger.warn(`[TIME_ADVANTAGE_SERVICE] Markt ${tracking.matchedMarketId} nicht gefunden`);
        return;
      }

      this.marketCache.set(market.id, market);
    }

    // Aktuellen Preis holen
    const currentPrice = market.outcomes.find(o => o.name.toLowerCase() === 'yes')?.price
      ?? market.outcomes[0]?.price
      ?? 0.5;

    // Update speichern
    updatePriceCheck(trackingId, checkType, currentPrice);

    // Berechne Move falls Initialpreis vorhanden
    if (tracking.priceAtNews !== null) {
      const priceMove = currentPrice - tracking.priceAtNews;

      logger.debug(
        `[TIME_ADVANTAGE_SERVICE] ${checkType}-Check: ${tracking.newsTitle.substring(0, 30)}... ` +
        `| ${(tracking.priceAtNews * 100).toFixed(1)}% → ${(currentPrice * 100).toFixed(1)}% ` +
        `(${priceMove >= 0 ? '+' : ''}${(priceMove * 100).toFixed(1)}%)`
      );

      // Emittiere Event bei signifikanter Bewegung
      if (Math.abs(priceMove) >= SIGNIFICANT_MOVE_THRESHOLD && !tracking.firstSignificantMoveAt) {
        const timeAdvantage = Math.round(
          (new Date().getTime() - tracking.publishedAt.getTime()) / (60 * 1000)
        );

        this.emit('significant_move', {
          trackingId,
          newsTitle: tracking.newsTitle,
          newsSource: tracking.newsSource,
          marketQuestion: tracking.matchedMarketQuestion,
          priceMove,
          timeAdvantageMinutes: timeAdvantage,
          checkType,
        });

        logger.info(
          `[TIME_ADVANTAGE_SERVICE] SIGNIFIKANTE BEWEGUNG!\n` +
          `   News: ${tracking.newsTitle.substring(0, 50)}...\n` +
          `   Quelle: ${tracking.newsSource}\n` +
          `   Bewegung: ${(priceMove * 100).toFixed(1)}%\n` +
          `   Zeitvorsprung: ${timeAdvantage} Minuten`
        );
      }
    }
  }

  /**
   * Erzwingt einen sofortigen Preis-Check für alle aktiven Trackings
   */
  async forceAllPriceChecks(): Promise<void> {
    const activeTrackings = getActiveTrackings(100);

    logger.info(`[TIME_ADVANTAGE_SERVICE] Force-Check für ${activeTrackings.length} Trackings`);

    for (const tracking of activeTrackings) {
      if (tracking.matchedMarketId) {
        await this.executePriceCheck(tracking.id, 'manual');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STATISTIKEN
  // ═══════════════════════════════════════════════════════════════

  /**
   * Aktualisiert alle Statistiken
   */
  private updateAllStats(): void {
    try {
      // Expire alte Trackings
      expireOldTrackings(48);

      // Berechne und speichere Stats für verschiedene Perioden
      const periods: Array<{ days: number; name: 'daily' | 'weekly' | 'monthly' | 'all_time' }> = [
        { days: 1, name: 'daily' },
        { days: 7, name: 'weekly' },
        { days: 30, name: 'monthly' },
        { days: 365, name: 'all_time' },
      ];

      for (const period of periods) {
        // Gesamt-Stats
        const allStats = calculateStats(null, period.days);
        saveStats(allStats);

        // Stats pro Quelle (nur für weekly und monthly)
        if (period.name === 'weekly' || period.name === 'monthly') {
          const sources = this.getUniqueSources();
          for (const source of sources) {
            const sourceStats = calculateStats(source, period.days);
            saveStats(sourceStats);
          }
        }
      }

      logger.debug('[TIME_ADVANTAGE_SERVICE] Stats aktualisiert');
    } catch (err) {
      logger.error(`[TIME_ADVANTAGE_SERVICE] Stats-Update Fehler: ${(err as Error).message}`);
    }
  }

  /**
   * Holt eindeutige News-Quellen
   */
  private getUniqueSources(): string[] {
    const dashboard = getTimeAdvantageDashboard();
    return dashboard.bySource.map(s => s.source);
  }

  /**
   * Gibt das Dashboard zurück
   */
  getDashboard(): TimeAdvantageDashboard {
    return getTimeAdvantageDashboard();
  }

  /**
   * Gibt Stats für eine Periode zurück
   */
  getStats(sourceName: string | null, periodDays: number): TimeAdvantageStats {
    return calculateStats(sourceName, periodDays);
  }

  /**
   * Formatiert das Dashboard für Telegram
   */
  formatDashboardForTelegram(): string {
    const dashboard = this.getDashboard();

    if (dashboard.totalTracked === 0) {
      return `
*ZEITVORSPRUNG TRACKER*

Noch keine Daten. Der Tracker sammelt automatisch Daten wenn deutsche News mit Polymarket-Maerkten gematcht werden.

_Warte auf Breaking News..._`;
    }

    let message = `
*ZEITVORSPRUNG DASHBOARD*

*Gesamt-Statistiken:*
\`\`\`
Getrackte News:     ${dashboard.totalTracked}
Mit Markt-Match:    ${dashboard.totalMatched}
Signifikante Moves: ${dashboard.totalWithSignificantMove}
\`\`\`

*Performance:*
\`\`\`
Avg. Zeitvorsprung: ${dashboard.avgTimeAdvantageMinutes.toFixed(0)} min
Avg. Preisbewegung: ${(dashboard.avgPriceMove * 100).toFixed(1)}%
Vorhersage-Genauig: ${dashboard.predictionAccuracy.toFixed(1)}%
\`\`\``;

    if (dashboard.bySource.length > 0) {
      message += `\n*Top Quellen:*\n\`\`\``;

      for (const source of dashboard.bySource.slice(0, 5)) {
        const avgStr = source.avgAdvantage > 0 ? `${source.avgAdvantage.toFixed(0)}min` : '-';
        const accStr = source.accuracy > 0 ? `${source.accuracy.toFixed(0)}%` : '-';
        message += `\n${source.source.padEnd(15)} ${source.count.toString().padStart(3)} | ${avgStr.padStart(6)} | ${accStr.padStart(4)}`;
      }

      message += `\n\`\`\``;
    }

    if (dashboard.recentEntries.length > 0) {
      message += `\n*Letzte Trackings:*`;

      for (const entry of dashboard.recentEntries.slice(0, 3)) {
        const statusEmoji = entry.status === 'completed'
          ? (entry.predictionCorrect ? '✅' : '❌')
          : entry.status === 'tracking'
            ? '⏳'
            : '⏰';

        const moveStr = entry.priceMove60min !== null
          ? `${(entry.priceMove60min * 100).toFixed(1)}%`
          : '-';

        message += `\n${statusEmoji} _${entry.newsSource}_: ${entry.newsTitle.substring(0, 40)}... (${moveStr})`;
      }
    }

    message += `\n\n_${dashboard.pendingPriceChecks} Price-Checks ausstehend_`;

    return message;
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════

export const timeAdvantageService = new TimeAdvantageService();
export default timeAdvantageService;
