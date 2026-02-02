/**
 * German Market Watchlist Repository
 * Verwaltet die Liste von deutschen/EU-relevanten Märkten
 * für gezieltes News-Matching
 */

import { getDatabase, initDatabase, isDatabaseInitialized } from '../db.js';
import { logger } from '../../utils/logger.js';

function ensureDatabase(): ReturnType<typeof getDatabase> {
  if (!isDatabaseInitialized()) {
    initDatabase();
  }
  return getDatabase();
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type WatchlistCategory = 'bundesliga' | 'politik' | 'eu_ukraine' | 'wirtschaft' | 'sonstige';

export interface GermanWatchlistMarket {
  id: number;
  marketId: string;
  conditionId: string | null;
  question: string;
  slug: string | null;
  category: WatchlistCategory;
  matchedKeywords: string[];
  relevanceScore: number;
  volumeTotal: number | null;
  currentPriceYes: number | null;
  currentPriceNo: number | null;
  endDate: Date | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
  addedAt: Date;
  updatedAt: Date;
}

export interface AddWatchlistMarketInput {
  marketId: string;
  conditionId?: string;
  question: string;
  slug?: string;
  category: WatchlistCategory;
  matchedKeywords?: string[];
  relevanceScore?: number;
  volumeTotal?: number;
  currentPriceYes?: number;
  currentPriceNo?: number;
  endDate?: Date;
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function rowToMarket(row: Record<string, unknown>): GermanWatchlistMarket {
  return {
    id: row.id as number,
    marketId: row.market_id as string,
    conditionId: row.condition_id as string | null,
    question: row.question as string,
    slug: row.slug as string | null,
    category: row.category as WatchlistCategory,
    matchedKeywords: row.matched_keywords ? JSON.parse(row.matched_keywords as string) : [],
    relevanceScore: row.relevance_score as number,
    volumeTotal: row.volume_total as number | null,
    currentPriceYes: row.current_price_yes as number | null,
    currentPriceNo: row.current_price_no as number | null,
    endDate: row.end_date ? new Date(row.end_date as string) : null,
    isActive: (row.is_active as number) === 1,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at as string) : null,
    addedAt: new Date(row.added_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// ═══════════════════════════════════════════════════════════════
// CREATE / UPDATE
// ═══════════════════════════════════════════════════════════════

/**
 * Fügt einen Markt zur Watchlist hinzu (oder aktualisiert ihn)
 */
export function addToWatchlist(input: AddWatchlistMarketInput): GermanWatchlistMarket | null {
  const db = ensureDatabase();

  const stmt = db.prepare(`
    INSERT INTO german_market_watchlist (
      market_id, condition_id, question, slug, category,
      matched_keywords, relevance_score, volume_total,
      current_price_yes, current_price_no, end_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id) DO UPDATE SET
      condition_id = excluded.condition_id,
      question = excluded.question,
      slug = excluded.slug,
      category = excluded.category,
      matched_keywords = excluded.matched_keywords,
      relevance_score = excluded.relevance_score,
      volume_total = excluded.volume_total,
      current_price_yes = excluded.current_price_yes,
      current_price_no = excluded.current_price_no,
      end_date = excluded.end_date,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(
    input.marketId,
    input.conditionId || null,
    input.question,
    input.slug || null,
    input.category,
    JSON.stringify(input.matchedKeywords || []),
    input.relevanceScore ?? 0.5,
    input.volumeTotal ?? null,
    input.currentPriceYes ?? null,
    input.currentPriceNo ?? null,
    input.endDate?.toISOString() || null
  );

  return getWatchlistMarket(input.marketId);
}

/**
 * Bulk-Import von Märkten
 */
export function bulkAddToWatchlist(markets: AddWatchlistMarketInput[]): number {
  const db = ensureDatabase();
  let added = 0;

  const stmt = db.prepare(`
    INSERT INTO german_market_watchlist (
      market_id, condition_id, question, slug, category,
      matched_keywords, relevance_score, volume_total,
      current_price_yes, current_price_no, end_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id) DO UPDATE SET
      condition_id = excluded.condition_id,
      question = excluded.question,
      slug = excluded.slug,
      category = excluded.category,
      matched_keywords = excluded.matched_keywords,
      relevance_score = excluded.relevance_score,
      volume_total = excluded.volume_total,
      current_price_yes = excluded.current_price_yes,
      current_price_no = excluded.current_price_no,
      end_date = excluded.end_date,
      updated_at = CURRENT_TIMESTAMP
  `);

  const insertMany = db.transaction((items: AddWatchlistMarketInput[]) => {
    for (const input of items) {
      stmt.run(
        input.marketId,
        input.conditionId || null,
        input.question,
        input.slug || null,
        input.category,
        JSON.stringify(input.matchedKeywords || []),
        input.relevanceScore ?? 0.5,
        input.volumeTotal ?? null,
        input.currentPriceYes ?? null,
        input.currentPriceNo ?? null,
        input.endDate?.toISOString() || null
      );
      added++;
    }
  });

  insertMany(markets);
  logger.info(`[WATCHLIST] ${added} Märkte zur Watchlist hinzugefügt/aktualisiert`);

  return added;
}

/**
 * Aktualisiert Preise für einen Markt
 */
export function updateWatchlistPrices(
  marketId: string,
  priceYes: number,
  priceNo: number,
  volume?: number
): void {
  const db = ensureDatabase();
  db.prepare(`
    UPDATE german_market_watchlist SET
      current_price_yes = ?,
      current_price_no = ?,
      volume_total = COALESCE(?, volume_total),
      last_synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE market_id = ?
  `).run(priceYes, priceNo, volume ?? null, marketId);
}

/**
 * Markiert Markt als inaktiv (geschlossen/resolved)
 */
export function deactivateWatchlistMarket(marketId: string): void {
  const db = ensureDatabase();
  db.prepare(`
    UPDATE german_market_watchlist SET
      is_active = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE market_id = ?
  `).run(marketId);
}

/**
 * Entfernt Markt von der Watchlist
 */
export function removeFromWatchlist(marketId: string): boolean {
  const db = ensureDatabase();
  const result = db.prepare('DELETE FROM german_market_watchlist WHERE market_id = ?').run(marketId);
  return result.changes > 0;
}

// ═══════════════════════════════════════════════════════════════
// QUERIES
// ═══════════════════════════════════════════════════════════════

export function getWatchlistMarket(marketId: string): GermanWatchlistMarket | null {
  const db = ensureDatabase();
  const row = db.prepare('SELECT * FROM german_market_watchlist WHERE market_id = ?')
    .get(marketId) as Record<string, unknown> | undefined;
  return row ? rowToMarket(row) : null;
}

/**
 * Holt alle aktiven Märkte auf der Watchlist
 */
export function getActiveWatchlistMarkets(): GermanWatchlistMarket[] {
  const db = ensureDatabase();
  const rows = db.prepare(`
    SELECT * FROM german_market_watchlist
    WHERE is_active = 1
    ORDER BY relevance_score DESC, volume_total DESC
  `).all() as Record<string, unknown>[];

  return rows.map(rowToMarket);
}

/**
 * Holt Märkte nach Kategorie
 */
export function getWatchlistByCategory(category: WatchlistCategory): GermanWatchlistMarket[] {
  const db = ensureDatabase();
  const rows = db.prepare(`
    SELECT * FROM german_market_watchlist
    WHERE category = ? AND is_active = 1
    ORDER BY relevance_score DESC, volume_total DESC
  `).all(category) as Record<string, unknown>[];

  return rows.map(rowToMarket);
}

/**
 * Holt nur Market IDs für schnelles Matching
 */
export function getWatchlistMarketIds(): string[] {
  const db = ensureDatabase();
  const rows = db.prepare(`
    SELECT market_id FROM german_market_watchlist
    WHERE is_active = 1
  `).all() as Array<{ market_id: string }>;

  return rows.map(r => r.market_id);
}

/**
 * Sucht in der Watchlist nach Keyword
 */
export function searchWatchlist(query: string): GermanWatchlistMarket[] {
  const db = ensureDatabase();
  const searchPattern = `%${query.toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT * FROM german_market_watchlist
    WHERE is_active = 1
      AND (LOWER(question) LIKE ? OR LOWER(matched_keywords) LIKE ?)
    ORDER BY relevance_score DESC
    LIMIT 50
  `).all(searchPattern, searchPattern) as Record<string, unknown>[];

  return rows.map(rowToMarket);
}

/**
 * Statistiken über die Watchlist
 */
export interface WatchlistStats {
  total: number;
  active: number;
  byCategory: Record<WatchlistCategory, number>;
  totalVolume: number;
  avgRelevance: number;
}

export function getWatchlistStats(): WatchlistStats {
  const db = ensureDatabase();

  const totalRow = db.prepare('SELECT COUNT(*) as count FROM german_market_watchlist')
    .get() as { count: number };

  const activeRow = db.prepare('SELECT COUNT(*) as count FROM german_market_watchlist WHERE is_active = 1')
    .get() as { count: number };

  const categoryRows = db.prepare(`
    SELECT category, COUNT(*) as count FROM german_market_watchlist
    WHERE is_active = 1
    GROUP BY category
  `).all() as Array<{ category: string; count: number }>;

  const byCategory: Record<string, number> = {
    bundesliga: 0,
    politik: 0,
    eu_ukraine: 0,
    wirtschaft: 0,
    sonstige: 0,
  };
  for (const row of categoryRows) {
    byCategory[row.category] = row.count;
  }

  const volumeRow = db.prepare(`
    SELECT SUM(volume_total) as total, AVG(relevance_score) as avg_relevance
    FROM german_market_watchlist WHERE is_active = 1
  `).get() as { total: number | null; avg_relevance: number | null };

  return {
    total: totalRow.count,
    active: activeRow.count,
    byCategory: byCategory as Record<WatchlistCategory, number>,
    totalVolume: volumeRow.total || 0,
    avgRelevance: volumeRow.avg_relevance || 0,
  };
}

/**
 * Prüft ob ein Markt auf der Watchlist ist
 */
export function isOnWatchlist(marketId: string): boolean {
  const db = ensureDatabase();
  const row = db.prepare('SELECT 1 FROM german_market_watchlist WHERE market_id = ? AND is_active = 1')
    .get(marketId);
  return !!row;
}

/**
 * Löscht inaktive Märkte älter als X Tage
 */
export function cleanupOldWatchlistMarkets(daysOld = 30): number {
  const db = ensureDatabase();
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    DELETE FROM german_market_watchlist
    WHERE is_active = 0 AND updated_at < ?
  `).run(cutoff);

  if (result.changes > 0) {
    logger.info(`[WATCHLIST] ${result.changes} alte inaktive Märkte gelöscht`);
  }

  return result.changes;
}
