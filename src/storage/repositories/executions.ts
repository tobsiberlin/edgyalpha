/**
 * Repository für executions Tabelle
 * Trade-Executions (Paper, Shadow, Live)
 */

import { getDatabase } from '../db.js';
import type { Execution } from '../../alpha/types.js';

/**
 * Konvertiert Datenbank-Row zu Execution
 */
function rowToExecution(row: Record<string, unknown>): Execution {
  return {
    executionId: row.execution_id as string,
    decisionId: row.decision_id as string,
    mode: row.mode as Execution['mode'],
    status: row.status as Execution['status'],
    fillPrice: row.fill_price as number | null,
    fillSize: row.fill_size as number | null,
    slippage: row.slippage as number | null,
    fees: row.fees as number | null,
    txHash: row.tx_hash as string | null,
    createdAt: new Date(row.created_at as string),
    filledAt: row.filled_at ? new Date(row.filled_at as string) : null,
  };
}

/**
 * Fügt eine Execution ein
 */
export function insertExecution(execution: Execution): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO executions (
      execution_id, decision_id, mode, status, fill_price, fill_size,
      slippage, fees, tx_hash, created_at, filled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(execution_id) DO UPDATE SET
      status = excluded.status,
      fill_price = excluded.fill_price,
      fill_size = excluded.fill_size,
      slippage = excluded.slippage,
      fees = excluded.fees,
      tx_hash = excluded.tx_hash,
      filled_at = excluded.filled_at
  `);

  stmt.run(
    execution.executionId,
    execution.decisionId,
    execution.mode,
    execution.status,
    execution.fillPrice,
    execution.fillSize,
    execution.slippage,
    execution.fees,
    execution.txHash,
    execution.createdAt.toISOString(),
    execution.filledAt?.toISOString() ?? null
  );
}

/**
 * Aktualisiert eine Execution
 */
export function updateExecution(executionId: string, updates: Partial<Execution>): void {
  const db = getDatabase();

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.fillPrice !== undefined) {
    fields.push('fill_price = ?');
    values.push(updates.fillPrice);
  }
  if (updates.fillSize !== undefined) {
    fields.push('fill_size = ?');
    values.push(updates.fillSize);
  }
  if (updates.slippage !== undefined) {
    fields.push('slippage = ?');
    values.push(updates.slippage);
  }
  if (updates.fees !== undefined) {
    fields.push('fees = ?');
    values.push(updates.fees);
  }
  if (updates.txHash !== undefined) {
    fields.push('tx_hash = ?');
    values.push(updates.txHash);
  }
  if (updates.filledAt !== undefined) {
    fields.push('filled_at = ?');
    values.push(updates.filledAt?.toISOString() ?? null);
  }

  if (fields.length === 0) {
    return;
  }

  values.push(executionId);

  const stmt = db.prepare(`
    UPDATE executions SET ${fields.join(', ')} WHERE execution_id = ?
  `);

  stmt.run(...values);
}

/**
 * Holt eine Execution anhand der ID
 */
export function getExecutionById(executionId: string): Execution | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM executions WHERE execution_id = ?
  `);

  const row = stmt.get(executionId) as Record<string, unknown> | undefined;

  return row ? rowToExecution(row) : null;
}

/**
 * Holt alle pending Executions (status = 'pending')
 */
export function getPendingExecutions(): Execution[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM executions
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `);

  const rows = stmt.all() as Record<string, unknown>[];

  return rows.map(rowToExecution);
}

/**
 * Holt Executions nach Mode
 */
export function getExecutionsByMode(mode: string): Execution[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM executions
    WHERE mode = ?
    ORDER BY created_at DESC
  `);

  const rows = stmt.all(mode) as Record<string, unknown>[];

  return rows.map(rowToExecution);
}
