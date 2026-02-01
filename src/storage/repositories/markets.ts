/**
 * Repository für markets_snapshot Tabelle
 * Market-Snapshots und historische Preisdaten
 */

import { getDatabase } from '../db.js';
import type { MarketSnapshot } from '../../alpha/types.js';

/**
 * Konvertiert Datenbank-Row zu MarketSnapshot
 */
function rowToSnapshot(row: Record<string, unknown>): MarketSnapshot {
  return {
    marketId: row.market_id as string,
    conditionId: row.condition_id as string | null,
    question: row.question as string,
    category: row.category as string | null,
    outcomes: JSON.parse(row.outcomes as string),
    prices: JSON.parse(row.prices as string),
    volume24h: row.volume_24h as number | null,
    volumeTotal: row.volume_total as number | null,
    spreadProxy: row.spread_proxy as number | null,
    liquidityScore: row.liquidity_score as number | null,
    endDate: row.end_date ? new Date(row.end_date as string) : null,
    snapshotAt: new Date(row.snapshot_at as string),
  };
}

/**
 * Fügt einen Market-Snapshot ein
 */
export function insertSnapshot(snapshot: MarketSnapshot): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO markets_snapshot (
      market_id, condition_id, question, category, outcomes, prices,
      volume_24h, volume_total, spread_proxy, liquidity_score, end_date, snapshot_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id, snapshot_at) DO UPDATE SET
      condition_id = excluded.condition_id,
      question = excluded.question,
      category = excluded.category,
      outcomes = excluded.outcomes,
      prices = excluded.prices,
      volume_24h = excluded.volume_24h,
      volume_total = excluded.volume_total,
      spread_proxy = excluded.spread_proxy,
      liquidity_score = excluded.liquidity_score,
      end_date = excluded.end_date
  `);

  stmt.run(
    snapshot.marketId,
    snapshot.conditionId,
    snapshot.question,
    snapshot.category,
    JSON.stringify(snapshot.outcomes),
    JSON.stringify(snapshot.prices),
    snapshot.volume24h,
    snapshot.volumeTotal,
    snapshot.spreadProxy,
    snapshot.liquidityScore,
    snapshot.endDate?.toISOString() ?? null,
    snapshot.snapshotAt.toISOString()
  );
}

/**
 * Holt den neuesten Snapshot für einen Markt
 */
export function getLatestSnapshot(marketId: string): MarketSnapshot | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM markets_snapshot
    WHERE market_id = ?
    ORDER BY snapshot_at DESC
    LIMIT 1
  `);

  const row = stmt.get(marketId) as Record<string, unknown> | undefined;

  return row ? rowToSnapshot(row) : null;
}

/**
 * Holt die Snapshot-Historie für einen Markt
 */
export function getSnapshotHistory(marketId: string, limit: number): MarketSnapshot[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM markets_snapshot
    WHERE market_id = ?
    ORDER BY snapshot_at DESC
    LIMIT ?
  `);

  const rows = stmt.all(marketId, limit) as Record<string, unknown>[];

  return rows.map(rowToSnapshot);
}

/**
 * Holt alle aktiven Märkte (neueste Snapshots)
 */
export function getActiveMarkets(): MarketSnapshot[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT m.* FROM markets_snapshot m
    INNER JOIN (
      SELECT market_id, MAX(snapshot_at) as max_snapshot
      FROM markets_snapshot
      GROUP BY market_id
    ) latest ON m.market_id = latest.market_id AND m.snapshot_at = latest.max_snapshot
    WHERE m.end_date IS NULL OR m.end_date > datetime('now')
    ORDER BY m.volume_24h DESC NULLS LAST
  `);

  const rows = stmt.all() as Record<string, unknown>[];

  return rows.map(rowToSnapshot);
}
