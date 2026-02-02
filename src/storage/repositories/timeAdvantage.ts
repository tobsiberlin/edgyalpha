/**
 * Repository für time_advantage_tracking Tabelle
 * Zeitvorsprung-Messung: Deutsche News → Polymarket Bewegung
 */

import { getDatabase, isDatabaseInitialized } from '../db.js';
import logger from '../../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface TimeAdvantageRecord {
  id: number;
  newsId: string;
  newsSource: string;
  newsTitle: string;
  newsUrl: string | null;
  newsCategory: string | null;
  newsKeywords: string[];
  publishedAt: Date;
  detectedAt: Date;
  englishVersionAt: Date | null;
  matchedMarketId: string | null;
  matchedMarketQuestion: string | null;
  matchConfidence: number | null;
  matchMethod: string | null;
  priceAtNews: number | null;
  priceAfter5min: number | null;
  priceAfter15min: number | null;
  priceAfter30min: number | null;
  priceAfter60min: number | null;
  priceAfter4h: number | null;
  priceFinal: number | null;
  timeAdvantageMinutes: number | null;
  priceMove5min: number | null;
  priceMove15min: number | null;
  priceMove30min: number | null;
  priceMove60min: number | null;
  firstSignificantMoveAt: Date | null;
  significantMoveDeltaMinutes: number | null;
  predictionCorrect: boolean | null;
  newsSentiment: 'positive' | 'negative' | 'neutral' | null;
  marketDirection: 'up' | 'down' | 'flat' | null;
  edgeCaptured: number | null;
  status: 'tracking' | 'completed' | 'expired' | 'no_match';
  lastPriceCheckAt: Date | null;
  priceChecksRemaining: number;
  createdAt: Date;
  completedAt: Date | null;
}

export interface TimeAdvantageInput {
  newsId: string;
  newsSource: string;
  newsTitle: string;
  newsUrl?: string;
  newsCategory?: string;
  newsKeywords?: string[];
  publishedAt: Date;
  detectedAt: Date;
  matchedMarketId?: string;
  matchedMarketQuestion?: string;
  matchConfidence?: number;
  matchMethod?: string;
  priceAtNews?: number;
  newsSentiment?: 'positive' | 'negative' | 'neutral';
}

export interface TimeAdvantageStats {
  sourceName: string;
  period: 'daily' | 'weekly' | 'monthly' | 'all_time';
  periodStart: Date;
  periodEnd: Date;
  newsCount: number;
  matchedCount: number;
  significantMoveCount: number;
  avgTimeAdvantageMinutes: number | null;
  medianTimeAdvantageMinutes: number | null;
  maxTimeAdvantageMinutes: number | null;
  predictionAccuracy: number | null;
  avgPriceMove: number | null;
}

export interface PriceCheckItem {
  id: number;
  trackingId: number;
  checkType: '5min' | '15min' | '30min' | '60min' | '4h' | 'final';
  scheduledAt: Date;
  status: 'pending' | 'executed' | 'skipped';
}

export interface TimeAdvantageDashboard {
  totalTracked: number;
  totalMatched: number;
  totalWithSignificantMove: number;
  avgTimeAdvantageMinutes: number;
  avgPriceMove: number;
  predictionAccuracy: number;
  bySource: Array<{
    source: string;
    count: number;
    avgAdvantage: number;
    accuracy: number;
  }>;
  recentEntries: TimeAdvantageRecord[];
  pendingPriceChecks: number;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function rowToRecord(row: Record<string, unknown>): TimeAdvantageRecord {
  return {
    id: row.id as number,
    newsId: row.news_id as string,
    newsSource: row.news_source as string,
    newsTitle: row.news_title as string,
    newsUrl: row.news_url as string | null,
    newsCategory: row.news_category as string | null,
    newsKeywords: row.news_keywords ? JSON.parse(row.news_keywords as string) : [],
    publishedAt: new Date(row.published_at as string),
    detectedAt: new Date(row.detected_at as string),
    englishVersionAt: row.english_version_at ? new Date(row.english_version_at as string) : null,
    matchedMarketId: row.matched_market_id as string | null,
    matchedMarketQuestion: row.matched_market_question as string | null,
    matchConfidence: row.match_confidence as number | null,
    matchMethod: row.match_method as string | null,
    priceAtNews: row.price_at_news as number | null,
    priceAfter5min: row.price_after_5min as number | null,
    priceAfter15min: row.price_after_15min as number | null,
    priceAfter30min: row.price_after_30min as number | null,
    priceAfter60min: row.price_after_60min as number | null,
    priceAfter4h: row.price_after_4h as number | null,
    priceFinal: row.price_final as number | null,
    timeAdvantageMinutes: row.time_advantage_minutes as number | null,
    priceMove5min: row.price_move_5min as number | null,
    priceMove15min: row.price_move_15min as number | null,
    priceMove30min: row.price_move_30min as number | null,
    priceMove60min: row.price_move_60min as number | null,
    firstSignificantMoveAt: row.first_significant_move_at ? new Date(row.first_significant_move_at as string) : null,
    significantMoveDeltaMinutes: row.significant_move_delta_minutes as number | null,
    predictionCorrect: row.prediction_correct === 1 ? true : row.prediction_correct === 0 ? false : null,
    newsSentiment: row.news_sentiment as 'positive' | 'negative' | 'neutral' | null,
    marketDirection: row.market_direction as 'up' | 'down' | 'flat' | null,
    edgeCaptured: row.edge_captured as number | null,
    status: row.status as 'tracking' | 'completed' | 'expired' | 'no_match',
    lastPriceCheckAt: row.last_price_check_at ? new Date(row.last_price_check_at as string) : null,
    priceChecksRemaining: row.price_checks_remaining as number,
    createdAt: new Date(row.created_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Erstellt einen neuen Tracking-Eintrag für eine News
 */
export function createTrackingEntry(input: TimeAdvantageInput): number {
  if (!isDatabaseInitialized()) {
    logger.warn('[TIME_ADVANTAGE] DB nicht initialisiert, überspringe createTrackingEntry');
    return -1;
  }

  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO time_advantage_tracking (
      news_id, news_source, news_title, news_url, news_category, news_keywords,
      published_at, detected_at, matched_market_id, matched_market_question,
      match_confidence, match_method, price_at_news, news_sentiment, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracking')
    ON CONFLICT(news_id) DO UPDATE SET
      matched_market_id = excluded.matched_market_id,
      matched_market_question = excluded.matched_market_question,
      match_confidence = excluded.match_confidence,
      match_method = excluded.match_method,
      price_at_news = excluded.price_at_news
  `);

  const result = stmt.run(
    input.newsId,
    input.newsSource,
    input.newsTitle,
    input.newsUrl ?? null,
    input.newsCategory ?? null,
    JSON.stringify(input.newsKeywords ?? []),
    input.publishedAt.toISOString(),
    input.detectedAt.toISOString(),
    input.matchedMarketId ?? null,
    input.matchedMarketQuestion ?? null,
    input.matchConfidence ?? null,
    input.matchMethod ?? null,
    input.priceAtNews ?? null,
    input.newsSentiment ?? null
  );

  const trackingId = result.lastInsertRowid as number;

  // Erstelle Price Check Queue wenn Markt gematcht wurde
  if (input.matchedMarketId && input.priceAtNews !== undefined) {
    schedulePriceChecks(trackingId, input.detectedAt);
  }

  logger.debug(`[TIME_ADVANTAGE] Tracking erstellt: ${input.newsTitle.substring(0, 50)}... (ID: ${trackingId})`);

  return trackingId;
}

/**
 * Schedulet die Preis-Checks für einen Tracking-Eintrag
 */
function schedulePriceChecks(trackingId: number, startTime: Date): void {
  const db = getDatabase();

  const checkIntervals: Array<{ type: string; minutes: number }> = [
    { type: '5min', minutes: 5 },
    { type: '15min', minutes: 15 },
    { type: '30min', minutes: 30 },
    { type: '60min', minutes: 60 },
    { type: '4h', minutes: 240 },
    { type: 'final', minutes: 1440 }, // 24h
  ];

  const stmt = db.prepare(`
    INSERT INTO price_check_queue (tracking_id, check_type, scheduled_at, status)
    VALUES (?, ?, ?, 'pending')
  `);

  for (const check of checkIntervals) {
    const scheduledAt = new Date(startTime.getTime() + check.minutes * 60 * 1000);
    stmt.run(trackingId, check.type, scheduledAt.toISOString());
  }

  logger.debug(`[TIME_ADVANTAGE] 6 Price-Checks für Tracking ${trackingId} geplant`);
}

/**
 * Holt einen Tracking-Eintrag anhand der News-ID
 */
export function getTrackingByNewsId(newsId: string): TimeAdvantageRecord | null {
  if (!isDatabaseInitialized()) return null;

  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM time_advantage_tracking WHERE news_id = ?');
  const row = stmt.get(newsId) as Record<string, unknown> | undefined;

  return row ? rowToRecord(row) : null;
}

/**
 * Holt Einträge die auf Preis-Checks warten
 */
export function getPendingPriceChecks(limit: number = 50): PriceCheckItem[] {
  if (!isDatabaseInitialized()) return [];

  const db = getDatabase();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    SELECT * FROM price_check_queue
    WHERE status = 'pending' AND scheduled_at <= ?
    ORDER BY scheduled_at ASC
    LIMIT ?
  `);

  const rows = stmt.all(now, limit) as Record<string, unknown>[];

  return rows.map(row => ({
    id: row.id as number,
    trackingId: row.tracking_id as number,
    checkType: row.check_type as PriceCheckItem['checkType'],
    scheduledAt: new Date(row.scheduled_at as string),
    status: row.status as PriceCheckItem['status'],
  }));
}

/**
 * Aktualisiert den Preis für einen bestimmten Check-Typ
 */
export function updatePriceCheck(
  trackingId: number,
  checkType: string,
  price: number
): void {
  if (!isDatabaseInitialized()) return;

  const db = getDatabase();

  // Mapping von checkType zu Spaltenname
  const columnMap: Record<string, string> = {
    '5min': 'price_after_5min',
    '15min': 'price_after_15min',
    '30min': 'price_after_30min',
    '60min': 'price_after_60min',
    '4h': 'price_after_4h',
    'final': 'price_final',
  };

  const column = columnMap[checkType];
  if (!column) {
    logger.warn(`[TIME_ADVANTAGE] Unbekannter checkType: ${checkType}`);
    return;
  }

  // Update Tracking-Eintrag
  const updateStmt = db.prepare(`
    UPDATE time_advantage_tracking
    SET ${column} = ?, last_price_check_at = ?, price_checks_remaining = price_checks_remaining - 1
    WHERE id = ?
  `);
  updateStmt.run(price, new Date().toISOString(), trackingId);

  // Mark Queue-Eintrag als executed
  const queueStmt = db.prepare(`
    UPDATE price_check_queue
    SET status = 'executed', executed_at = ?
    WHERE tracking_id = ? AND check_type = ?
  `);
  queueStmt.run(new Date().toISOString(), trackingId, checkType);

  // Berechne Price-Move
  const tracking = getTrackingById(trackingId);
  if (tracking && tracking.priceAtNews !== null) {
    const priceMove = price - tracking.priceAtNews;
    const priceMoveColumn = `price_move_${checkType.replace('min', 'min').replace('h', 'h')}`;

    // Nur für 5/15/30/60min Moves speichern
    if (['5min', '15min', '30min', '60min'].includes(checkType)) {
      const moveStmt = db.prepare(`
        UPDATE time_advantage_tracking
        SET ${priceMoveColumn.replace('price_move_', 'price_move_')} = ?
        WHERE id = ?
      `);
      try {
        moveStmt.run(priceMove, trackingId);
      } catch {
        // Spalte existiert möglicherweise nicht für alle Typen
      }
    }

    // Prüfe auf signifikante Bewegung (>2%)
    if (Math.abs(priceMove) >= 0.02 && !tracking.firstSignificantMoveAt) {
      const now = new Date();
      const deltaMinutes = Math.round((now.getTime() - tracking.publishedAt.getTime()) / (60 * 1000));

      const sigStmt = db.prepare(`
        UPDATE time_advantage_tracking
        SET first_significant_move_at = ?, significant_move_delta_minutes = ?, time_advantage_minutes = ?
        WHERE id = ?
      `);
      sigStmt.run(now.toISOString(), deltaMinutes, deltaMinutes, trackingId);

      logger.info(`[TIME_ADVANTAGE] Signifikante Bewegung erkannt! Delta: ${deltaMinutes}min, Move: ${(priceMove * 100).toFixed(1)}%`);
    }
  }

  logger.debug(`[TIME_ADVANTAGE] Price-Check ${checkType} für Tracking ${trackingId}: ${price.toFixed(4)}`);
}

/**
 * Holt einen Tracking-Eintrag anhand der ID
 */
export function getTrackingById(id: number): TimeAdvantageRecord | null {
  if (!isDatabaseInitialized()) return null;

  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM time_advantage_tracking WHERE id = ?');
  const row = stmt.get(id) as Record<string, unknown> | undefined;

  return row ? rowToRecord(row) : null;
}

/**
 * Markiert einen Tracking-Eintrag als abgeschlossen
 */
export function completeTracking(
  trackingId: number,
  marketDirection: 'up' | 'down' | 'flat',
  predictionCorrect: boolean,
  edgeCaptured?: number
): void {
  if (!isDatabaseInitialized()) return;

  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE time_advantage_tracking
    SET status = 'completed',
        completed_at = ?,
        market_direction = ?,
        prediction_correct = ?,
        edge_captured = ?
    WHERE id = ?
  `);

  stmt.run(
    new Date().toISOString(),
    marketDirection,
    predictionCorrect ? 1 : 0,
    edgeCaptured ?? null,
    trackingId
  );

  logger.info(`[TIME_ADVANTAGE] Tracking ${trackingId} abgeschlossen: ${marketDirection}, korrekt=${predictionCorrect}`);
}

/**
 * Holt aktive Tracking-Einträge
 */
export function getActiveTrackings(limit: number = 100): TimeAdvantageRecord[] {
  if (!isDatabaseInitialized()) return [];

  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM time_advantage_tracking
    WHERE status = 'tracking'
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const rows = stmt.all(limit) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Holt kürzliche Tracking-Einträge
 */
export function getRecentTrackings(limit: number = 20): TimeAdvantageRecord[] {
  if (!isDatabaseInitialized()) return [];

  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM time_advantage_tracking
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const rows = stmt.all(limit) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Setzt abgelaufene Trackings auf 'expired'
 */
export function expireOldTrackings(maxAgeHours: number = 48): number {
  if (!isDatabaseInitialized()) return 0;

  const db = getDatabase();
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

  const stmt = db.prepare(`
    UPDATE time_advantage_tracking
    SET status = 'expired', completed_at = ?
    WHERE status = 'tracking' AND created_at < ?
  `);

  const result = stmt.run(new Date().toISOString(), cutoff.toISOString());

  if (result.changes > 0) {
    logger.info(`[TIME_ADVANTAGE] ${result.changes} Trackings abgelaufen`);
  }

  return result.changes;
}

// ═══════════════════════════════════════════════════════════════
// STATISTIKEN
// ═══════════════════════════════════════════════════════════════

/**
 * Berechnet das Dashboard mit allen Statistiken
 */
export function getTimeAdvantageDashboard(): TimeAdvantageDashboard {
  if (!isDatabaseInitialized()) {
    return {
      totalTracked: 0,
      totalMatched: 0,
      totalWithSignificantMove: 0,
      avgTimeAdvantageMinutes: 0,
      avgPriceMove: 0,
      predictionAccuracy: 0,
      bySource: [],
      recentEntries: [],
      pendingPriceChecks: 0,
    };
  }

  const db = getDatabase();

  // Gesamtstatistiken
  const totalStmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(matched_market_id) as matched,
      COUNT(first_significant_move_at) as significant,
      AVG(CASE WHEN time_advantage_minutes IS NOT NULL THEN time_advantage_minutes END) as avg_advantage,
      AVG(CASE WHEN price_move_60min IS NOT NULL THEN ABS(price_move_60min) END) as avg_move,
      AVG(CASE WHEN prediction_correct IS NOT NULL THEN prediction_correct END) as accuracy
    FROM time_advantage_tracking
  `);

  const totals = totalStmt.get() as Record<string, unknown>;

  // Statistiken pro Quelle
  const sourceStmt = db.prepare(`
    SELECT
      news_source as source,
      COUNT(*) as count,
      AVG(CASE WHEN time_advantage_minutes IS NOT NULL THEN time_advantage_minutes END) as avg_advantage,
      AVG(CASE WHEN prediction_correct IS NOT NULL THEN prediction_correct END) as accuracy
    FROM time_advantage_tracking
    WHERE matched_market_id IS NOT NULL
    GROUP BY news_source
    ORDER BY count DESC
    LIMIT 10
  `);

  const sourceRows = sourceStmt.all() as Record<string, unknown>[];

  // Pending Price Checks
  const pendingStmt = db.prepare(`
    SELECT COUNT(*) as count FROM price_check_queue WHERE status = 'pending'
  `);
  const pending = pendingStmt.get() as Record<string, unknown>;

  // Kürzliche Einträge
  const recent = getRecentTrackings(10);

  return {
    totalTracked: (totals.total as number) || 0,
    totalMatched: (totals.matched as number) || 0,
    totalWithSignificantMove: (totals.significant as number) || 0,
    avgTimeAdvantageMinutes: (totals.avg_advantage as number) || 0,
    avgPriceMove: (totals.avg_move as number) || 0,
    predictionAccuracy: ((totals.accuracy as number) || 0) * 100,
    bySource: sourceRows.map(row => ({
      source: row.source as string,
      count: row.count as number,
      avgAdvantage: (row.avg_advantage as number) || 0,
      accuracy: ((row.accuracy as number) || 0) * 100,
    })),
    recentEntries: recent,
    pendingPriceChecks: (pending.count as number) || 0,
  };
}

/**
 * Berechnet Statistiken für einen bestimmten Zeitraum und Quelle
 */
export function calculateStats(
  sourceName: string | null,
  periodDays: number
): TimeAdvantageStats {
  if (!isDatabaseInitialized()) {
    return {
      sourceName: sourceName || 'all',
      period: 'all_time',
      periodStart: new Date(),
      periodEnd: new Date(),
      newsCount: 0,
      matchedCount: 0,
      significantMoveCount: 0,
      avgTimeAdvantageMinutes: null,
      medianTimeAdvantageMinutes: null,
      maxTimeAdvantageMinutes: null,
      predictionAccuracy: null,
      avgPriceMove: null,
    };
  }

  const db = getDatabase();
  const now = new Date();
  const start = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

  let whereClause = 'WHERE created_at >= ?';
  const params: (string | number)[] = [start.toISOString()];

  if (sourceName) {
    whereClause += ' AND news_source = ?';
    params.push(sourceName);
  }

  const stmt = db.prepare(`
    SELECT
      COUNT(*) as news_count,
      COUNT(matched_market_id) as matched_count,
      COUNT(first_significant_move_at) as significant_count,
      AVG(CASE WHEN time_advantage_minutes IS NOT NULL THEN time_advantage_minutes END) as avg_advantage,
      MAX(CASE WHEN time_advantage_minutes IS NOT NULL THEN time_advantage_minutes END) as max_advantage,
      AVG(CASE WHEN prediction_correct IS NOT NULL THEN prediction_correct END) as accuracy,
      AVG(CASE WHEN price_move_60min IS NOT NULL THEN ABS(price_move_60min) END) as avg_move
    FROM time_advantage_tracking
    ${whereClause}
  `);

  const row = stmt.get(...params) as Record<string, unknown>;

  // Median berechnen
  const medianStmt = db.prepare(`
    SELECT time_advantage_minutes
    FROM time_advantage_tracking
    ${whereClause} AND time_advantage_minutes IS NOT NULL
    ORDER BY time_advantage_minutes
  `);
  const medianRows = medianStmt.all(...params) as Array<{ time_advantage_minutes: number }>;

  let median: number | null = null;
  if (medianRows.length > 0) {
    const mid = Math.floor(medianRows.length / 2);
    median = medianRows.length % 2 !== 0
      ? medianRows[mid].time_advantage_minutes
      : (medianRows[mid - 1].time_advantage_minutes + medianRows[mid].time_advantage_minutes) / 2;
  }

  return {
    sourceName: sourceName || 'all',
    period: periodDays === 1 ? 'daily' : periodDays === 7 ? 'weekly' : periodDays === 30 ? 'monthly' : 'all_time',
    periodStart: start,
    periodEnd: now,
    newsCount: (row.news_count as number) || 0,
    matchedCount: (row.matched_count as number) || 0,
    significantMoveCount: (row.significant_count as number) || 0,
    avgTimeAdvantageMinutes: row.avg_advantage as number | null,
    medianTimeAdvantageMinutes: median,
    maxTimeAdvantageMinutes: row.max_advantage as number | null,
    predictionAccuracy: row.accuracy !== null ? (row.accuracy as number) * 100 : null,
    avgPriceMove: row.avg_move as number | null,
  };
}

/**
 * Speichert aggregierte Statistiken
 */
export function saveStats(stats: TimeAdvantageStats): void {
  if (!isDatabaseInitialized()) return;

  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO time_advantage_stats (
      source_name, period, period_start, period_end,
      news_count, matched_count, significant_move_count,
      avg_time_advantage_minutes, median_time_advantage_minutes, max_time_advantage_minutes,
      prediction_accuracy, avg_price_move, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_name, period, period_start) DO UPDATE SET
      news_count = excluded.news_count,
      matched_count = excluded.matched_count,
      significant_move_count = excluded.significant_move_count,
      avg_time_advantage_minutes = excluded.avg_time_advantage_minutes,
      median_time_advantage_minutes = excluded.median_time_advantage_minutes,
      max_time_advantage_minutes = excluded.max_time_advantage_minutes,
      prediction_accuracy = excluded.prediction_accuracy,
      avg_price_move = excluded.avg_price_move,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    stats.sourceName,
    stats.period,
    stats.periodStart.toISOString(),
    stats.periodEnd.toISOString(),
    stats.newsCount,
    stats.matchedCount,
    stats.significantMoveCount,
    stats.avgTimeAdvantageMinutes,
    stats.medianTimeAdvantageMinutes,
    stats.maxTimeAdvantageMinutes,
    stats.predictionAccuracy,
    stats.avgPriceMove,
    new Date().toISOString()
  );
}
