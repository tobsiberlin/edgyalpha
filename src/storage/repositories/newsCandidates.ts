/**
 * News Candidates Repository
 * Entkopplung von RSS-News und Push-Entscheidungen
 *
 * Flow: RSS News → Candidate (DB) → Gate Check → Push Queue → Telegram
 */

import { getDatabase, initDatabase, isDatabaseInitialized } from '../db.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

function ensureDatabase(): ReturnType<typeof getDatabase> {
  if (!isDatabaseInitialized()) {
    initDatabase();
  }
  return getDatabase();
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type CandidateStatus = 'new' | 'matching' | 'matched' | 'rejected' | 'expired' | 'pushed';

export interface GateResult {
  passed: boolean;
  value: number | string | boolean;
  threshold: number | string | boolean;
  reason?: string;
}

export interface GateResults {
  match_confidence?: GateResult;
  price_premove?: GateResult;
  expected_lag?: GateResult;
  total_volume?: GateResult;
  spread_proxy?: GateResult;
  liquidity_score?: GateResult;
  source_reliability?: GateResult;
  system_health?: GateResult;
  rate_limit?: GateResult;
}

export interface NewsCandidate {
  id: number;
  dedupeHash: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string | null;
  content: string | null;
  publishedAt: Date;
  ingestedAt: Date;
  categories: string[];
  keywords: string[];
  timeAdvantageSeconds: number | null;
  status: CandidateStatus;
  rejectionReason: string | null;
  // Matching
  matchedMarketId: string | null;
  matchedMarketQuestion: string | null;
  matchConfidence: number | null;
  matchMethod: string | null;
  // Gates
  gateResults: GateResults | null;
  gatesPassed: boolean;
  // Push
  pushQueuedAt: Date | null;
  pushSentAt: Date | null;
  pushMessageId: string | null;
  // TTL
  expiresAt: Date | null;
  updatedAt: Date;
}

export interface CreateCandidateInput {
  sourceId: string;
  sourceName: string;
  title: string;
  url?: string;
  content?: string;
  publishedAt: Date;
  categories?: string[];
  keywords?: string[];
  timeAdvantageSeconds?: number;
  ttlHours?: number;
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function generateDedupeHash(sourceId: string, title: string, publishedAt: Date): string {
  const input = `${sourceId}:${title}:${publishedAt.toISOString()}`;
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 32);
}

function rowToCandidate(row: Record<string, unknown>): NewsCandidate {
  return {
    id: row.id as number,
    dedupeHash: row.dedupe_hash as string,
    sourceId: row.source_id as string,
    sourceName: row.source_name as string,
    title: row.title as string,
    url: row.url as string | null,
    content: row.content as string | null,
    publishedAt: new Date(row.published_at as string),
    ingestedAt: new Date(row.ingested_at as string),
    categories: row.categories ? JSON.parse(row.categories as string) : [],
    keywords: row.keywords ? JSON.parse(row.keywords as string) : [],
    timeAdvantageSeconds: row.time_advantage_seconds as number | null,
    status: row.status as CandidateStatus,
    rejectionReason: row.rejection_reason as string | null,
    matchedMarketId: row.matched_market_id as string | null,
    matchedMarketQuestion: row.matched_market_question as string | null,
    matchConfidence: row.match_confidence as number | null,
    matchMethod: row.match_method as string | null,
    gateResults: row.gate_results ? JSON.parse(row.gate_results as string) : null,
    gatesPassed: (row.gates_passed as number) === 1,
    pushQueuedAt: row.push_queued_at ? new Date(row.push_queued_at as string) : null,
    pushSentAt: row.push_sent_at ? new Date(row.push_sent_at as string) : null,
    pushMessageId: row.push_message_id as string | null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    updatedAt: new Date(row.updated_at as string),
  };
}

// ═══════════════════════════════════════════════════════════════
// CREATE / UPDATE
// ═══════════════════════════════════════════════════════════════

/**
 * Erstellt einen neuen News-Kandidaten (falls noch nicht vorhanden)
 * Returns: Candidate oder null wenn Duplikat
 */
export function createCandidate(input: CreateCandidateInput): NewsCandidate | null {
  const db = ensureDatabase();
  const dedupeHash = generateDedupeHash(input.sourceId, input.title, input.publishedAt);

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM news_candidates WHERE dedupe_hash = ?').get(dedupeHash);
  if (existing) {
    logger.debug(`[NEWS_CANDIDATE] Duplikat übersprungen: ${input.title.substring(0, 50)}...`);
    return null;
  }

  const ttlHours = input.ttlHours ?? 6;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  const stmt = db.prepare(`
    INSERT INTO news_candidates (
      dedupe_hash, source_id, source_name, title, url, content,
      published_at, categories, keywords, time_advantage_seconds,
      status, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `);

  const result = stmt.run(
    dedupeHash,
    input.sourceId,
    input.sourceName,
    input.title,
    input.url || null,
    input.content || null,
    input.publishedAt.toISOString(),
    JSON.stringify(input.categories || []),
    JSON.stringify(input.keywords || []),
    input.timeAdvantageSeconds ?? null,
    expiresAt
  );

  logger.info(`[NEWS_CANDIDATE] Neu erstellt: ${input.title.substring(0, 50)}...`);

  return getCandidateById(result.lastInsertRowid as number);
}

/**
 * Setzt Matching-Ergebnisse auf einen Kandidaten
 */
export function setMatchResult(
  candidateId: number,
  marketId: string | null,
  marketQuestion: string | null,
  confidence: number | null,
  method: string | null
): void {
  const db = ensureDatabase();
  const status = marketId ? 'matched' : 'rejected';
  const rejection = marketId ? null : 'Kein passender Markt gefunden';

  db.prepare(`
    UPDATE news_candidates SET
      status = ?,
      matched_market_id = ?,
      matched_market_question = ?,
      match_confidence = ?,
      match_method = ?,
      rejection_reason = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, marketId, marketQuestion, confidence, method, rejection, candidateId);

  logger.debug(`[NEWS_CANDIDATE] Match Result für #${candidateId}: ${status}`);
}

/**
 * Setzt Gate-Check Ergebnisse
 */
export function setGateResults(
  candidateId: number,
  gateResults: GateResults,
  allPassed: boolean
): void {
  const db = ensureDatabase();
  const status = allPassed ? 'matched' : 'rejected';
  const rejection = allPassed ? null : formatGateFailures(gateResults);

  db.prepare(`
    UPDATE news_candidates SET
      gate_results = ?,
      gates_passed = ?,
      status = CASE WHEN status = 'matching' THEN ? ELSE status END,
      rejection_reason = CASE WHEN ? = 0 THEN ? ELSE rejection_reason END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    JSON.stringify(gateResults),
    allPassed ? 1 : 0,
    status,
    allPassed ? 1 : 0,
    rejection,
    candidateId
  );

  logger.debug(`[NEWS_CANDIDATE] Gate Results für #${candidateId}: ${allPassed ? 'PASSED' : 'FAILED'}`);
}

function formatGateFailures(gateResults: GateResults): string {
  const failures: string[] = [];
  for (const [name, result] of Object.entries(gateResults)) {
    if (result && !result.passed) {
      failures.push(`${name}: ${result.value} (min: ${result.threshold})`);
    }
  }
  return failures.join(', ') || 'Unknown gate failure';
}

/**
 * Markiert Kandidat als zur Push-Queue hinzugefügt
 */
export function queueForPush(candidateId: number): void {
  const db = ensureDatabase();
  db.prepare(`
    UPDATE news_candidates SET
      push_queued_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(candidateId);
}

/**
 * Markiert Kandidat als gepusht
 */
export function markAsPushed(candidateId: number, messageId?: string): void {
  const db = ensureDatabase();
  db.prepare(`
    UPDATE news_candidates SET
      status = 'pushed',
      push_sent_at = CURRENT_TIMESTAMP,
      push_message_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(messageId || null, candidateId);

  logger.info(`[NEWS_CANDIDATE] Push gesendet für #${candidateId}`);
}

/**
 * Markiert Kandidat als rejected
 */
export function rejectCandidate(candidateId: number, reason: string): void {
  const db = ensureDatabase();
  db.prepare(`
    UPDATE news_candidates SET
      status = 'rejected',
      rejection_reason = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason, candidateId);
}

/**
 * Markiert abgelaufene Kandidaten als expired
 */
export function expireOldCandidates(): number {
  const db = ensureDatabase();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE news_candidates SET
      status = 'expired',
      updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('new', 'matching', 'matched')
      AND expires_at < ?
  `).run(now);

  if (result.changes > 0) {
    logger.info(`[NEWS_CANDIDATE] ${result.changes} Kandidaten abgelaufen`);
  }

  return result.changes;
}

// ═══════════════════════════════════════════════════════════════
// QUERIES
// ═══════════════════════════════════════════════════════════════

export function getCandidateById(id: number): NewsCandidate | null {
  const db = ensureDatabase();
  const row = db.prepare('SELECT * FROM news_candidates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : null;
}

export function getCandidateByHash(dedupeHash: string): NewsCandidate | null {
  const db = ensureDatabase();
  const row = db.prepare('SELECT * FROM news_candidates WHERE dedupe_hash = ?').get(dedupeHash) as Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : null;
}

/**
 * Holt Kandidaten, die für Matching bereit sind
 */
export function getCandidatesForMatching(limit = 20): NewsCandidate[] {
  const db = ensureDatabase();
  const rows = db.prepare(`
    SELECT * FROM news_candidates
    WHERE status = 'new'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ORDER BY published_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];

  return rows.map(rowToCandidate);
}

/**
 * Holt Kandidaten, die für Push bereit sind (matched + gates passed)
 */
export function getCandidatesForPush(): NewsCandidate[] {
  const db = ensureDatabase();
  const rows = db.prepare(`
    SELECT * FROM news_candidates
    WHERE status = 'matched'
      AND gates_passed = 1
      AND push_sent_at IS NULL
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ORDER BY published_at DESC
  `).all() as Record<string, unknown>[];

  return rows.map(rowToCandidate);
}

/**
 * Holt Recent Candidates für Dashboard
 */
export function getRecentCandidates(limit = 50): NewsCandidate[] {
  const db = ensureDatabase();
  const rows = db.prepare(`
    SELECT * FROM news_candidates
    ORDER BY ingested_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];

  return rows.map(rowToCandidate);
}

/**
 * Sucht Candidate nach Titel (für Ticker-Integration)
 */
export function getCandidateByTitle(title: string): NewsCandidate | null {
  const db = ensureDatabase();
  const row = db.prepare(`
    SELECT * FROM news_candidates
    WHERE title = ? AND status = 'new'
    ORDER BY ingested_at DESC
    LIMIT 1
  `).get(title) as Record<string, unknown> | undefined;

  return row ? rowToCandidate(row) : null;
}

/**
 * Statistiken über Candidates
 */
export interface CandidateStats {
  total: number;
  byStatus: Record<CandidateStatus, number>;
  matchedToday: number;
  pushedToday: number;
  rejectedToday: number;
}

export function getCandidateStats(): CandidateStats {
  const db = ensureDatabase();
  const today = new Date().toISOString().split('T')[0];

  const totalRow = db.prepare('SELECT COUNT(*) as count FROM news_candidates').get() as { count: number };

  const statusRows = db.prepare(`
    SELECT status, COUNT(*) as count FROM news_candidates GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const byStatus: Record<string, number> = {
    new: 0,
    matching: 0,
    matched: 0,
    rejected: 0,
    expired: 0,
    pushed: 0,
  };
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
  }

  const matchedTodayRow = db.prepare(`
    SELECT COUNT(*) as count FROM news_candidates
    WHERE status IN ('matched', 'pushed') AND DATE(updated_at) = ?
  `).get(today) as { count: number };

  const pushedTodayRow = db.prepare(`
    SELECT COUNT(*) as count FROM news_candidates
    WHERE status = 'pushed' AND DATE(push_sent_at) = ?
  `).get(today) as { count: number };

  const rejectedTodayRow = db.prepare(`
    SELECT COUNT(*) as count FROM news_candidates
    WHERE status = 'rejected' AND DATE(updated_at) = ?
  `).get(today) as { count: number };

  return {
    total: totalRow.count,
    byStatus: byStatus as Record<CandidateStatus, number>,
    matchedToday: matchedTodayRow.count,
    pushedToday: pushedTodayRow.count,
    rejectedToday: rejectedTodayRow.count,
  };
}

/**
 * Löscht alte Kandidaten (älter als X Tage)
 */
export function cleanupOldCandidates(daysOld = 7): number {
  const db = ensureDatabase();
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    DELETE FROM news_candidates
    WHERE ingested_at < ?
  `).run(cutoff);

  if (result.changes > 0) {
    logger.info(`[NEWS_CANDIDATE] ${result.changes} alte Kandidaten gelöscht`);
  }

  return result.changes;
}
