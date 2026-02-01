/**
 * Repository für signals Tabelle
 * Alpha-Signale aus den verschiedenen Engines
 */

import { getDatabase } from '../db.js';
import type { AlphaSignalV2 } from '../../alpha/types.js';

/**
 * Konvertiert Datenbank-Row zu AlphaSignalV2
 */
function rowToSignal(row: Record<string, unknown>): AlphaSignalV2 {
  const features = JSON.parse(row.features as string);

  return {
    signalId: row.signal_id as string,
    alphaType: row.alpha_type as 'timeDelay' | 'mispricing',
    marketId: row.market_id as string,
    question: features.question || '',
    direction: row.direction as 'yes' | 'no',
    predictedEdge: row.predicted_edge as number,
    confidence: row.confidence as number,
    features: features,
    reasoning: features.reasoning || [],
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Fügt ein Signal ein
 */
export function insertSignal(signal: AlphaSignalV2): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO signals (
      signal_id, alpha_type, market_id, features, predicted_edge,
      confidence, direction, model_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signal_id) DO UPDATE SET
      features = excluded.features,
      predicted_edge = excluded.predicted_edge,
      confidence = excluded.confidence,
      direction = excluded.direction
  `);

  // Features mit zusätzlichen Infos für Rekonstruktion
  const featuresWithMeta = {
    ...signal.features,
    question: signal.question,
    reasoning: signal.reasoning,
  };

  stmt.run(
    signal.signalId,
    signal.alphaType,
    signal.marketId,
    JSON.stringify(featuresWithMeta),
    signal.predictedEdge,
    signal.confidence,
    signal.direction,
    signal.features.version,
    signal.createdAt.toISOString()
  );
}

/**
 * Holt ein Signal anhand der ID
 */
export function getSignalById(signalId: string): AlphaSignalV2 | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM signals WHERE signal_id = ?
  `);

  const row = stmt.get(signalId) as Record<string, unknown> | undefined;

  return row ? rowToSignal(row) : null;
}

/**
 * Holt alle Signale für einen Markt
 */
export function getSignalsByMarket(marketId: string): AlphaSignalV2[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM signals
    WHERE market_id = ?
    ORDER BY created_at DESC
  `);

  const rows = stmt.all(marketId) as Record<string, unknown>[];

  return rows.map(rowToSignal);
}

/**
 * Holt Signale nach Alpha-Typ
 */
export function getSignalsByType(alphaType: string, limit: number): AlphaSignalV2[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM signals
    WHERE alpha_type = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const rows = stmt.all(alphaType, limit) as Record<string, unknown>[];

  return rows.map(rowToSignal);
}

/**
 * Holt die neuesten Signale
 */
export function getRecentSignals(limit: number): AlphaSignalV2[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM signals
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const rows = stmt.all(limit) as Record<string, unknown>[];

  return rows.map(rowToSignal);
}
