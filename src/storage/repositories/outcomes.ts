/**
 * Repository für outcomes Tabelle
 * Trade-Outcomes für Kalibrierung und Performance-Tracking
 */

import { getDatabase } from '../db.js';
import type { Outcome } from '../../alpha/types.js';

/**
 * Konvertiert Datenbank-Row zu Outcome
 */
function rowToOutcome(row: Record<string, unknown>): Outcome {
  return {
    executionId: row.execution_id as string,
    marketId: row.market_id as string,
    resolution: row.resolution as Outcome['resolution'],
    exitPrice: row.exit_price as number | null,
    pnlUsdc: row.pnl_usdc as number | null,
    predictedProb: row.predicted_prob as number,
    actualOutcome: row.actual_outcome as 0 | 1 | null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
  };
}

/**
 * Fügt ein Outcome ein
 */
export function insertOutcome(outcome: Outcome): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO outcomes (
      execution_id, market_id, resolution, exit_price, pnl_usdc,
      predicted_prob, actual_outcome, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(execution_id) DO UPDATE SET
      resolution = excluded.resolution,
      exit_price = excluded.exit_price,
      pnl_usdc = excluded.pnl_usdc,
      actual_outcome = excluded.actual_outcome,
      resolved_at = excluded.resolved_at
  `);

  stmt.run(
    outcome.executionId,
    outcome.marketId,
    outcome.resolution,
    outcome.exitPrice,
    outcome.pnlUsdc,
    outcome.predictedProb,
    outcome.actualOutcome,
    outcome.resolvedAt?.toISOString() ?? null
  );
}

/**
 * Holt ein Outcome anhand der Execution-ID
 */
export function getOutcomeByExecution(executionId: string): Outcome | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM outcomes WHERE execution_id = ?
  `);

  const row = stmt.get(executionId) as Record<string, unknown> | undefined;

  return row ? rowToOutcome(row) : null;
}

/**
 * Holt alle Outcomes für einen Markt
 */
export function getOutcomesByMarket(marketId: string): Outcome[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM outcomes
    WHERE market_id = ?
    ORDER BY resolved_at DESC NULLS LAST
  `);

  const rows = stmt.all(marketId) as Record<string, unknown>[];

  return rows.map(rowToOutcome);
}

/**
 * Kalibrierungsdaten-Interface
 */
export interface CalibrationDataPoint {
  predictedProb: number;
  actualOutcome: 0 | 1;
  alphaType: string | null;
}

/**
 * Holt Kalibrierungsdaten (predicted vs actual)
 */
export function getCalibrationData(alphaType?: string): CalibrationDataPoint[] {
  const db = getDatabase();

  let stmt;
  let rows;

  if (alphaType) {
    stmt = db.prepare(`
      SELECT o.predicted_prob, o.actual_outcome, s.alpha_type
      FROM outcomes o
      JOIN executions e ON o.execution_id = e.execution_id
      JOIN decisions d ON e.decision_id = d.decision_id
      JOIN signals s ON d.signal_id = s.signal_id
      WHERE o.actual_outcome IS NOT NULL
        AND s.alpha_type = ?
      ORDER BY o.resolved_at DESC
    `);
    rows = stmt.all(alphaType) as Record<string, unknown>[];
  } else {
    stmt = db.prepare(`
      SELECT o.predicted_prob, o.actual_outcome, s.alpha_type
      FROM outcomes o
      JOIN executions e ON o.execution_id = e.execution_id
      JOIN decisions d ON e.decision_id = d.decision_id
      JOIN signals s ON d.signal_id = s.signal_id
      WHERE o.actual_outcome IS NOT NULL
      ORDER BY o.resolved_at DESC
    `);
    rows = stmt.all() as Record<string, unknown>[];
  }

  return rows.map((row) => ({
    predictedProb: row.predicted_prob as number,
    actualOutcome: row.actual_outcome as 0 | 1,
    alphaType: row.alpha_type as string | null,
  }));
}
