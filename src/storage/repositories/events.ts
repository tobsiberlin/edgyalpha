/**
 * Repository für sources_events Tabelle
 * Event-Dedupe und Source-Reliability Tracking
 */

import { getDatabase } from '../db.js';
import type { SourceEvent } from '../../alpha/types.js';

/**
 * Konvertiert Datenbank-Row zu SourceEvent
 */
function rowToEvent(row: Record<string, unknown>): SourceEvent {
  return {
    eventHash: row.event_hash as string,
    sourceId: row.source_id as string,
    sourceName: row.source_name as string,
    url: row.url as string | null,
    title: row.title as string,
    content: row.content as string | null,
    category: row.category as string | null,
    keywords: row.keywords ? JSON.parse(row.keywords as string) : [],
    publishedAt: row.published_at ? new Date(row.published_at as string) : null,
    ingestedAt: new Date(row.ingested_at as string),
    reliabilityScore: row.reliability_score as number,
  };
}

/**
 * Fügt ein Event ein (UPSERT mit event_hash)
 */
export function insertEvent(event: SourceEvent): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO sources_events (
      event_hash, source_id, source_name, url, title, content,
      category, keywords, published_at, ingested_at, reliability_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_hash) DO UPDATE SET
      source_name = excluded.source_name,
      url = excluded.url,
      title = excluded.title,
      content = excluded.content,
      category = excluded.category,
      keywords = excluded.keywords,
      reliability_score = excluded.reliability_score
  `);

  stmt.run(
    event.eventHash,
    event.sourceId,
    event.sourceName,
    event.url,
    event.title,
    event.content,
    event.category,
    JSON.stringify(event.keywords),
    event.publishedAt?.toISOString() ?? null,
    event.ingestedAt.toISOString(),
    event.reliabilityScore
  );
}

/**
 * Holt ein Event anhand des Hash
 */
export function getEventByHash(hash: string): SourceEvent | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM sources_events WHERE event_hash = ?
  `);

  const row = stmt.get(hash) as Record<string, unknown> | undefined;

  return row ? rowToEvent(row) : null;
}

/**
 * Holt kürzliche Events
 */
export function getRecentEvents(limit: number, since?: Date): SourceEvent[] {
  const db = getDatabase();

  let stmt;
  let rows;

  if (since) {
    stmt = db.prepare(`
      SELECT * FROM sources_events
      WHERE ingested_at >= ?
      ORDER BY ingested_at DESC
      LIMIT ?
    `);
    rows = stmt.all(since.toISOString(), limit) as Record<string, unknown>[];
  } else {
    stmt = db.prepare(`
      SELECT * FROM sources_events
      ORDER BY ingested_at DESC
      LIMIT ?
    `);
    rows = stmt.all(limit) as Record<string, unknown>[];
  }

  return rows.map(rowToEvent);
}

/**
 * Aktualisiert den Reliability-Score eines Events
 */
export function updateReliability(eventHash: string, score: number): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE sources_events SET reliability_score = ? WHERE event_hash = ?
  `);

  stmt.run(score, eventHash);
}

/**
 * Prüft ob ein Event existiert
 */
export function eventExists(hash: string): boolean {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT 1 FROM sources_events WHERE event_hash = ? LIMIT 1
  `);

  return stmt.get(hash) !== undefined;
}
