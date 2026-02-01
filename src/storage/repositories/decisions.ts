/**
 * Repository für decisions Tabelle
 * Trading-Entscheidungen mit Risk-Checks
 */

import { getDatabase } from '../db.js';
import type { Decision, RiskChecks, Rationale } from '../../alpha/types.js';

/**
 * Konvertiert Datenbank-Row zu Decision
 */
function rowToDecision(row: Record<string, unknown>): Decision {
  return {
    decisionId: row.decision_id as string,
    signalId: row.signal_id as string,
    action: row.action as Decision['action'],
    sizeUsdc: row.size_usdc as number | null,
    riskChecks: JSON.parse(row.risk_checks as string) as RiskChecks,
    rationale: JSON.parse(row.rationale as string) as Rationale,
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Fügt eine Decision ein
 */
export function insertDecision(decision: Decision): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO decisions (
      decision_id, signal_id, action, size_usdc, risk_checks, rationale, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(decision_id) DO UPDATE SET
      action = excluded.action,
      size_usdc = excluded.size_usdc,
      risk_checks = excluded.risk_checks,
      rationale = excluded.rationale
  `);

  stmt.run(
    decision.decisionId,
    decision.signalId,
    decision.action,
    decision.sizeUsdc,
    JSON.stringify(decision.riskChecks),
    JSON.stringify(decision.rationale),
    decision.createdAt.toISOString()
  );
}

/**
 * Holt eine Decision anhand der ID
 */
export function getDecisionById(decisionId: string): Decision | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM decisions WHERE decision_id = ?
  `);

  const row = stmt.get(decisionId) as Record<string, unknown> | undefined;

  return row ? rowToDecision(row) : null;
}

/**
 * Holt alle Decisions für ein Signal
 */
export function getDecisionsBySignal(signalId: string): Decision[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM decisions
    WHERE signal_id = ?
    ORDER BY created_at DESC
  `);

  const rows = stmt.all(signalId) as Record<string, unknown>[];

  return rows.map(rowToDecision);
}

/**
 * Holt alle pending Decisions (action = 'trade' oder 'high_conviction' ohne Execution)
 */
export function getPendingDecisions(): Decision[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT d.* FROM decisions d
    LEFT JOIN executions e ON d.decision_id = e.decision_id
    WHERE d.action IN ('trade', 'high_conviction')
      AND e.execution_id IS NULL
    ORDER BY d.created_at ASC
  `);

  const rows = stmt.all() as Record<string, unknown>[];

  return rows.map(rowToDecision);
}
