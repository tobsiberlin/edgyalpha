/**
 * Watchlist Sync Service
 * Synchronisiert die deutsche Markt-Watchlist mit Polymarket
 * Läuft beim Start und dann täglich um 6:00 Uhr
 */

import axios from 'axios';
import { initDatabase, isDatabaseInitialized, getDatabase } from '../storage/db.js';
import {
  bulkAddToWatchlist,
  getWatchlistStats,
  type AddWatchlistMarketInput,
  type WatchlistCategory,
} from '../storage/repositories/germanWatchlist.js';
import logger from '../utils/logger.js';

// Deutsche/EU-relevante Keywords für die Suche
const GERMAN_SEARCH_KEYWORDS = [
  // === POLITIK ===
  'merz', 'scholz', 'habeck', 'lindner', 'baerbock', 'weidel', 'wagenknecht',
  'söder', 'pistorius', 'faeser', 'steinmeier',
  'cdu', 'spd', 'grüne', 'fdp', 'afd', 'bsw', 'linke',
  'bundestag', 'bundesregierung', 'kanzler',
  'germany', 'german', 'deutschland', 'berlin',

  // === WIRTSCHAFT ===
  'volkswagen', 'siemens', 'basf', 'deutsche bank', 'allianz',
  'bmw', 'mercedes', 'daimler', 'porsche', 'sap', 'adidas', 'bayer',
  'telekom', 'lufthansa', 'continental', 'infineon',
  'dax', 'bundesbank', 'ifo',

  // === FUSSBALL/BUNDESLIGA ===
  'bundesliga', 'bayern munich', 'bayern münchen', 'borussia dortmund', 'bvb',
  'rb leipzig', 'bayer leverkusen', 'eintracht frankfurt',
  'dfb', 'dfb-pokal',
  'nagelsmann', 'tuchel', 'klopp', 'xabi alonso', 'kompany', 'terzic',
  'musiala', 'wirtz', 'havertz', 'sane', 'gundogan', 'kroos', 'muller', 'neuer',

  // === EU/GEOPOLITIK ===
  'european union', 'eu ', 'brussels', 'von der leyen',
  'ukraine', 'zelensky', 'selenskyj', 'ceasefire', 'nato',
  'russia', 'putin', 'crimea', 'donbas',
  'netherlands', 'wilders', 'france', 'macron', 'poland', 'austria',
];

function categorizeMarket(question: string, matchedKeywords: string[]): WatchlistCategory {
  const q = question.toLowerCase();
  const kws = matchedKeywords.map(k => k.toLowerCase());

  const footballKeywords = ['bundesliga', 'bayern', 'dortmund', 'bvb', 'leipzig', 'leverkusen',
    'frankfurt', 'dfb', 'nagelsmann', 'tuchel', 'klopp', 'xabi alonso', 'kompany', 'musiala', 'wirtz'];
  if (footballKeywords.some(k => kws.includes(k) || q.includes(k))) {
    return 'bundesliga';
  }

  const politikKeywords = ['merz', 'scholz', 'habeck', 'lindner', 'baerbock', 'weidel',
    'wagenknecht', 'bundestag', 'bundesregierung', 'kanzler', 'cdu', 'spd', 'grüne', 'fdp', 'afd', 'bsw'];
  if (politikKeywords.some(k => kws.includes(k) || q.includes(k))) {
    if (q.includes('germany') || q.includes('german') || q.includes('chancellor') ||
        q.includes('bundestag') || q.includes('bundesregierung')) {
      return 'politik';
    }
  }

  const euKeywords = ['ukraine', 'zelensky', 'selenskyj', 'ceasefire', 'nato', 'russia', 'putin',
    'crimea', 'donbas', 'european union', 'eu ', 'brussels', 'von der leyen'];
  if (euKeywords.some(k => kws.includes(k) || q.includes(k))) {
    return 'eu_ukraine';
  }

  const wirtschaftKeywords = ['dax', 'bundesbank', 'volkswagen', 'siemens', 'basf', 'deutsche bank',
    'bmw', 'mercedes', 'porsche', 'sap', 'adidas', 'bayer', 'lufthansa'];
  if (wirtschaftKeywords.some(k => kws.includes(k) || q.includes(k))) {
    return 'wirtschaft';
  }

  return 'sonstige';
}

function calculateRelevance(matchedKeywords: string[], category: WatchlistCategory): number {
  let score = 0.3;
  score += Math.min(matchedKeywords.length * 0.1, 0.3);
  if (category === 'politik') score += 0.2;
  if (category === 'bundesliga') score += 0.15;
  if (category === 'eu_ukraine') score += 0.1;
  return Math.min(score, 1.0);
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  markets: Array<{
    id: string;
    conditionId: string;
    question: string;
    slug: string;
    outcomePrices: string;
    volume: string;
    endDate: string;
    closed: boolean;
  }>;
}

class WatchlistSyncService {
  private syncInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastSyncAt: Date | null = null;

  /**
   * Startet den Service - führt sofortigen Sync aus und plant tägliche Updates
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[WATCHLIST_SYNC] Service läuft bereits');
      return;
    }

    this.isRunning = true;
    logger.info('[WATCHLIST_SYNC] Service gestartet');

    // Sofortiger Sync beim Start
    await this.syncWatchlist();

    // Täglicher Sync um 6:00 Uhr
    this.scheduleDailySync();
  }

  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.isRunning = false;
    logger.info('[WATCHLIST_SYNC] Service gestoppt');
  }

  private scheduleDailySync(): void {
    // Berechne Zeit bis 6:00 Uhr
    const now = new Date();
    const next6am = new Date();
    next6am.setHours(6, 0, 0, 0);

    if (now >= next6am) {
      next6am.setDate(next6am.getDate() + 1);
    }

    const msUntil6am = next6am.getTime() - now.getTime();
    const hoursUntil = (msUntil6am / 1000 / 60 / 60).toFixed(1);
    logger.info(`[WATCHLIST_SYNC] Nächster Sync in ${hoursUntil}h um 6:00 Uhr`);

    // Einmaliger Timer bis 6:00 Uhr, dann tägliches Intervall
    setTimeout(() => {
      this.syncWatchlist();

      // Dann alle 24 Stunden
      this.syncInterval = setInterval(() => {
        this.syncWatchlist();
      }, 24 * 60 * 60 * 1000);
    }, msUntil6am);
  }

  /**
   * Synchronisiert die Watchlist mit Polymarket
   */
  async syncWatchlist(): Promise<void> {
    logger.info('[WATCHLIST_SYNC] Starte Synchronisation...');
    const startTime = Date.now();

    try {
      const allMarkets = new Map<string, AddWatchlistMarketInput>();

      // Hole alle Events von Gamma API
      const response = await axios.get<GammaEvent[]>('https://gamma-api.polymarket.com/events', {
        params: {
          closed: false,
          limit: 500,
          _t: Date.now(),
        },
        headers: {
          'User-Agent': 'EdgyAlpha/1.0',
        },
        timeout: 30000,
      });

      for (const event of response.data) {
        const eventText = `${event.title} ${event.slug}`.toLowerCase();

        for (const market of event.markets) {
          if (market.closed) continue;

          const marketText = `${market.question} ${market.slug}`.toLowerCase();
          const allMatchedKeywords: string[] = [];

          // Sammle alle matchenden Keywords
          for (const kw of GERMAN_SEARCH_KEYWORDS) {
            if (marketText.includes(kw.toLowerCase()) || eventText.includes(kw.toLowerCase())) {
              allMatchedKeywords.push(kw);
            }
          }

          if (allMatchedKeywords.length === 0) continue;

          // Parse Preise
          let priceYes = 0.5;
          let priceNo = 0.5;
          try {
            const prices = JSON.parse(market.outcomePrices || '[]');
            if (prices.length >= 2) {
              priceYes = parseFloat(prices[0]) || 0.5;
              priceNo = parseFloat(prices[1]) || 0.5;
            }
          } catch {
            // Ignore
          }

          const category = categorizeMarket(market.question, allMatchedKeywords);
          const relevance = calculateRelevance(allMatchedKeywords, category);

          const existingMarket = allMarkets.get(market.id);
          if (existingMarket) {
            // Merge Keywords
            const mergedKeywords = [...new Set([...existingMarket.matchedKeywords || [], ...allMatchedKeywords])];
            existingMarket.matchedKeywords = mergedKeywords;
            existingMarket.relevanceScore = calculateRelevance(mergedKeywords, existingMarket.category);
          } else {
            allMarkets.set(market.id, {
              marketId: market.id,
              conditionId: market.conditionId,
              question: market.question,
              slug: market.slug,
              category,
              matchedKeywords: [...new Set(allMatchedKeywords)],
              relevanceScore: relevance,
              volumeTotal: parseFloat(market.volume) || 0,
              currentPriceYes: priceYes,
              currentPriceNo: priceNo,
              endDate: market.endDate ? new Date(market.endDate) : undefined,
            });
          }
        }
      }

      // In DB speichern
      const added = bulkAddToWatchlist(Array.from(allMarkets.values()));

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const stats = getWatchlistStats();

      this.lastSyncAt = new Date();

      logger.info(`[WATCHLIST_SYNC] ✅ Fertig in ${duration}s`);
      logger.info(`[WATCHLIST_SYNC] ${added} Märkte | ${stats.active} aktiv | $${(stats.totalVolume / 1000000).toFixed(2)}M Volume`);
      logger.info(`[WATCHLIST_SYNC] Bundesliga: ${stats.byCategory.bundesliga}, EU/Ukraine: ${stats.byCategory.eu_ukraine}, Politik: ${stats.byCategory.politik}`);

    } catch (err) {
      logger.error(`[WATCHLIST_SYNC] Fehler: ${(err as Error).message}`);
    }
  }

  getStatus(): { isRunning: boolean; lastSyncAt: Date | null } {
    return {
      isRunning: this.isRunning,
      lastSyncAt: this.lastSyncAt,
    };
  }
}

export const watchlistSyncService = new WatchlistSyncService();
