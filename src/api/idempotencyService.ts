/**
 * Idempotency Service
 * Verhindert doppelte Order-Ausführungen durch einzigartige Keys
 */

import { getDatabase } from '../storage/db.js';
import { logger } from '../utils/logger.js';

// Idempotency Key Ablaufzeit: 24 Stunden
const KEY_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyParams {
  decisionId: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  sizeUsdc: number;
}

export interface IdempotencyCheckResult {
  exists: boolean;
  existingExecutionId?: string;
  status?: 'pending' | 'completed' | 'failed' | 'expired';
  createdAt?: Date;
}

interface IdempotencyRow {
  key: string;
  decision_id: string;
  market_id: string;
  side: string;
  size_usdc: number;
  created_at: string;
  execution_id: string | null;
  status: string;
  expires_at: string;
}

/**
 * Generiert einen Idempotency Key aus den Order-Parametern
 */
export function generateIdempotencyKey(params: IdempotencyParams): string {
  return `${params.decisionId}:${params.marketId}:${params.side}:${params.sizeUsdc.toFixed(2)}`;
}

/**
 * Idempotency Service Klasse
 */
export class IdempotencyService {
  /**
   * Prüft ob ein Key bereits existiert, oder erstellt einen neuen
   * Atomare Operation: Wenn Key nicht existiert, wird er sofort erstellt
   */
  async checkOrCreate(params: IdempotencyParams): Promise<IdempotencyCheckResult> {
    const db = getDatabase();
    const key = generateIdempotencyKey(params);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + KEY_EXPIRY_MS);

    // Zuerst prüfen ob Key existiert und nicht abgelaufen ist
    const existingStmt = db.prepare(`
      SELECT * FROM idempotency_keys
      WHERE key = ? AND expires_at > datetime('now')
    `);
    const existing = existingStmt.get(key) as IdempotencyRow | undefined;

    if (existing) {
      logger.warn(`[IDEMPOTENCY] Doppelte Order erkannt`, {
        key,
        existingExecutionId: existing.execution_id,
        status: existing.status,
        createdAt: existing.created_at,
      });

      return {
        exists: true,
        existingExecutionId: existing.execution_id || undefined,
        status: existing.status as IdempotencyCheckResult['status'],
        createdAt: new Date(existing.created_at),
      };
    }

    // Key existiert nicht - erstelle neuen
    try {
      const insertStmt = db.prepare(`
        INSERT INTO idempotency_keys (key, decision_id, market_id, side, size_usdc, created_at, status, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `);

      insertStmt.run(
        key,
        params.decisionId,
        params.marketId,
        params.side,
        params.sizeUsdc,
        now.toISOString(),
        expiresAt.toISOString()
      );

      logger.info(`[IDEMPOTENCY] Neuer Key erstellt`, {
        key,
        decisionId: params.decisionId,
        expiresAt: expiresAt.toISOString(),
      });

      return { exists: false };
    } catch (err) {
      // UNIQUE constraint violation = Race Condition, Key wurde zwischenzeitlich erstellt
      const error = err as Error;
      if (error.message.includes('UNIQUE constraint failed')) {
        logger.warn(`[IDEMPOTENCY] Race Condition erkannt, Key wurde parallel erstellt`, { key });

        // Nochmal abfragen
        const raceStmt = db.prepare(`SELECT * FROM idempotency_keys WHERE key = ?`);
        const raceResult = raceStmt.get(key) as IdempotencyRow | undefined;

        return {
          exists: true,
          existingExecutionId: raceResult?.execution_id || undefined,
          status: raceResult?.status as IdempotencyCheckResult['status'],
          createdAt: raceResult ? new Date(raceResult.created_at) : undefined,
        };
      }

      throw err;
    }
  }

  /**
   * Prüft ob ein Key existiert (ohne zu erstellen)
   */
  async check(params: IdempotencyParams): Promise<IdempotencyCheckResult> {
    const db = getDatabase();
    const key = generateIdempotencyKey(params);

    const stmt = db.prepare(`
      SELECT * FROM idempotency_keys
      WHERE key = ? AND expires_at > datetime('now')
    `);
    const row = stmt.get(key) as IdempotencyRow | undefined;

    if (!row) {
      return { exists: false };
    }

    return {
      exists: true,
      existingExecutionId: row.execution_id || undefined,
      status: row.status as IdempotencyCheckResult['status'],
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * Markiert einen Key als completed mit der Execution ID
   */
  async markCompleted(params: IdempotencyParams, executionId: string): Promise<void> {
    const db = getDatabase();
    const key = generateIdempotencyKey(params);

    const stmt = db.prepare(`
      UPDATE idempotency_keys
      SET status = 'completed', execution_id = ?
      WHERE key = ?
    `);

    const result = stmt.run(executionId, key);

    if (result.changes === 0) {
      logger.warn(`[IDEMPOTENCY] Key nicht gefunden beim Markieren als completed`, { key, executionId });
    } else {
      logger.info(`[IDEMPOTENCY] Key als completed markiert`, { key, executionId });
    }
  }

  /**
   * Markiert einen Key als failed
   */
  async markFailed(params: IdempotencyParams, executionId?: string): Promise<void> {
    const db = getDatabase();
    const key = generateIdempotencyKey(params);

    const stmt = db.prepare(`
      UPDATE idempotency_keys
      SET status = 'failed', execution_id = ?
      WHERE key = ?
    `);

    stmt.run(executionId || null, key);
    logger.info(`[IDEMPOTENCY] Key als failed markiert`, { key, executionId });
  }

  /**
   * Löscht einen Key (z.B. nach Ablehnung vor Ausführung)
   */
  async remove(params: IdempotencyParams): Promise<void> {
    const db = getDatabase();
    const key = generateIdempotencyKey(params);

    const stmt = db.prepare(`DELETE FROM idempotency_keys WHERE key = ?`);
    stmt.run(key);

    logger.debug(`[IDEMPOTENCY] Key gelöscht`, { key });
  }

  /**
   * Cleanup: Entfernt abgelaufene Keys (älter als 24h)
   * Sollte periodisch aufgerufen werden
   */
  async cleanup(): Promise<number> {
    const db = getDatabase();

    const stmt = db.prepare(`
      DELETE FROM idempotency_keys
      WHERE expires_at < datetime('now')
    `);

    const result = stmt.run();
    const deleted = result.changes;

    if (deleted > 0) {
      logger.info(`[IDEMPOTENCY] ${deleted} abgelaufene Keys gelöscht`);
    }

    return deleted;
  }

  /**
   * Gibt alle pending Keys zurück (für Restart-Reconciliation)
   */
  async getPendingKeys(): Promise<IdempotencyParams[]> {
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT decision_id, market_id, side, size_usdc
      FROM idempotency_keys
      WHERE status = 'pending' AND expires_at > datetime('now')
    `);

    const rows = stmt.all() as Array<{
      decision_id: string;
      market_id: string;
      side: string;
      size_usdc: number;
    }>;

    return rows.map((row) => ({
      decisionId: row.decision_id,
      marketId: row.market_id,
      side: row.side as 'BUY' | 'SELL',
      sizeUsdc: row.size_usdc,
    }));
  }

  /**
   * Statistiken für Monitoring
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    completed: number;
    failed: number;
    expired: number;
  }> {
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' AND expires_at > datetime('now') THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN expires_at <= datetime('now') THEN 1 ELSE 0 END) as expired
      FROM idempotency_keys
    `);

    const result = stmt.get() as {
      total: number;
      pending: number;
      completed: number;
      failed: number;
      expired: number;
    };

    return result;
  }
}

// Singleton Export
export const idempotencyService = new IdempotencyService();
export default idempotencyService;
