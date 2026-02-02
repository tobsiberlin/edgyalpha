/**
 * Risk State Repository
 * Persistent Risk State in SQLite
 *
 * KRITISCH: Dieser Code überlebt Server-Restarts.
 * Alle Risk-Daten (Kill-Switch, Daily PnL, Positions) werden hier persistiert.
 */

import { getDatabase, initDatabase, isDatabaseInitialized } from '../db.js';
import { logger } from '../../utils/logger.js';

/**
 * Stellt sicher, dass die Datenbank initialisiert ist
 */
function ensureDatabase(): ReturnType<typeof getDatabase> {
  if (!isDatabaseInitialized()) {
    initDatabase();
  }
  return getDatabase();
}

export interface PersistedRiskState {
  executionMode: 'paper' | 'shadow' | 'live';
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  killSwitchActivatedAt: Date | null;
  dailyPnL: number;
  dailyTrades: number;
  dailyWins: number;
  dailyLosses: number;
  dailyDate: string;
  totalExposure: number;
  positions: Record<string, { size: number; entryPrice: number; direction: 'yes' | 'no' }>;
  settings: Record<string, number>;
  updatedAt: Date;
}

export interface AuditLogEntry {
  eventType: 'trade' | 'mode_change' | 'kill_switch' | 'settings' | 'login' | 'error' | 'daily_reset';
  actor: 'web' | 'telegram' | 'system' | 'scheduler';
  action: string;
  details?: Record<string, unknown>;
  marketId?: string;
  signalId?: string;
  pnlImpact?: number;
  riskStateBefore?: Partial<PersistedRiskState>;
  riskStateAfter?: Partial<PersistedRiskState>;
}

/**
 * Initialisiere Risk State (erstelle Zeile wenn nicht vorhanden)
 */
export function initRiskState(): void {
  const db = ensureDatabase();
  const today = new Date().toISOString().slice(0, 10);

  // Prüfe ob Singleton existiert
  const existing = db.prepare('SELECT id FROM risk_state WHERE id = 1').get();

  if (!existing) {
    db.prepare(`
      INSERT INTO risk_state (
        id, execution_mode, kill_switch_active, daily_pnl, daily_trades,
        daily_wins, daily_losses, daily_date, total_exposure, positions, settings
      ) VALUES (1, 'paper', 0, 0, 0, 0, 0, ?, 0, '{}', '{}')
    `).run(today);

    logger.info('Risk State initialisiert (neue DB)');
  }
}

/**
 * Lade Risk State aus DB
 */
export function loadRiskState(): PersistedRiskState {
  const db = ensureDatabase();
  initRiskState();

  const row = db.prepare('SELECT * FROM risk_state WHERE id = 1').get() as Record<string, unknown>;

  const today = new Date().toISOString().slice(0, 10);
  const storedDate = row.daily_date as string;

  // Daily Reset wenn neuer Tag
  if (storedDate !== today) {
    logger.info(`Daily Reset: ${storedDate} → ${today}`);
    resetDailyInDb();
    return loadRiskState(); // Rekursiv laden nach Reset
  }

  return {
    executionMode: row.execution_mode as 'paper' | 'shadow' | 'live',
    killSwitchActive: Boolean(row.kill_switch_active),
    killSwitchReason: row.kill_switch_reason as string | null,
    killSwitchActivatedAt: row.kill_switch_activated_at
      ? new Date(row.kill_switch_activated_at as string)
      : null,
    dailyPnL: row.daily_pnl as number,
    dailyTrades: row.daily_trades as number,
    dailyWins: row.daily_wins as number,
    dailyLosses: row.daily_losses as number,
    dailyDate: row.daily_date as string,
    totalExposure: row.total_exposure as number,
    positions: JSON.parse(row.positions as string || '{}'),
    settings: JSON.parse(row.settings as string || '{}'),
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Speichere Risk State in DB
 */
export function saveRiskState(state: Partial<PersistedRiskState>): void {
  const db = ensureDatabase();

  const updates: string[] = [];
  const values: unknown[] = [];

  if (state.executionMode !== undefined) {
    updates.push('execution_mode = ?');
    values.push(state.executionMode);
  }

  if (state.killSwitchActive !== undefined) {
    updates.push('kill_switch_active = ?');
    values.push(state.killSwitchActive ? 1 : 0);
  }

  if (state.killSwitchReason !== undefined) {
    updates.push('kill_switch_reason = ?');
    values.push(state.killSwitchReason);
  }

  if (state.killSwitchActivatedAt !== undefined) {
    updates.push('kill_switch_activated_at = ?');
    values.push(state.killSwitchActivatedAt?.toISOString() || null);
  }

  if (state.dailyPnL !== undefined) {
    updates.push('daily_pnl = ?');
    values.push(state.dailyPnL);
  }

  if (state.dailyTrades !== undefined) {
    updates.push('daily_trades = ?');
    values.push(state.dailyTrades);
  }

  if (state.dailyWins !== undefined) {
    updates.push('daily_wins = ?');
    values.push(state.dailyWins);
  }

  if (state.dailyLosses !== undefined) {
    updates.push('daily_losses = ?');
    values.push(state.dailyLosses);
  }

  if (state.totalExposure !== undefined) {
    updates.push('total_exposure = ?');
    values.push(state.totalExposure);
  }

  if (state.positions !== undefined) {
    updates.push('positions = ?');
    values.push(JSON.stringify(state.positions));
  }

  if (state.settings !== undefined) {
    updates.push('settings = ?');
    values.push(JSON.stringify(state.settings));
  }

  if (updates.length === 0) return;

  updates.push('updated_at = CURRENT_TIMESTAMP');

  db.prepare(`UPDATE risk_state SET ${updates.join(', ')} WHERE id = 1`).run(...values);
}

/**
 * Daily Reset in DB
 */
export function resetDailyInDb(): void {
  const db = ensureDatabase();
  const today = new Date().toISOString().slice(0, 10);

  // Audit Log BEVOR Reset
  const before = loadRiskStateRaw();

  db.prepare(`
    UPDATE risk_state SET
      daily_pnl = 0,
      daily_trades = 0,
      daily_wins = 0,
      daily_losses = 0,
      daily_date = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(today);

  // Kill-Switch bleibt aktiv! (überlebt Daily Reset)

  writeAuditLog({
    eventType: 'daily_reset',
    actor: 'scheduler',
    action: `Daily Reset: ${before.daily_date} → ${today}`,
    details: {
      previousPnL: before.daily_pnl,
      previousTrades: before.daily_trades,
    },
    riskStateBefore: {
      dailyPnL: before.daily_pnl as number,
      dailyTrades: before.daily_trades as number,
    },
    riskStateAfter: {
      dailyPnL: 0,
      dailyTrades: 0,
    },
  });
}

/**
 * Raw Load ohne Daily-Check (für Audit)
 */
function loadRiskStateRaw(): Record<string, unknown> {
  const db = ensureDatabase();
  return db.prepare('SELECT * FROM risk_state WHERE id = 1').get() as Record<string, unknown>;
}

/**
 * Schreibe Audit Log Entry
 */
export function writeAuditLog(entry: AuditLogEntry): void {
  const db = ensureDatabase();

  db.prepare(`
    INSERT INTO audit_log (
      event_type, actor, action, details, market_id, signal_id,
      pnl_impact, risk_state_before, risk_state_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.eventType,
    entry.actor,
    entry.action,
    entry.details ? JSON.stringify(entry.details) : null,
    entry.marketId || null,
    entry.signalId || null,
    entry.pnlImpact || null,
    entry.riskStateBefore ? JSON.stringify(entry.riskStateBefore) : null,
    entry.riskStateAfter ? JSON.stringify(entry.riskStateAfter) : null
  );
}

/**
 * Lese Audit Log (letzte N Einträge)
 */
export function getAuditLog(limit: number = 100): AuditLogEntry[] {
  const db = ensureDatabase();

  const rows = db.prepare(`
    SELECT * FROM audit_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    eventType: row.event_type as AuditLogEntry['eventType'],
    actor: row.actor as AuditLogEntry['actor'],
    action: row.action as string,
    details: row.details ? JSON.parse(row.details as string) : undefined,
    marketId: row.market_id as string | undefined,
    signalId: row.signal_id as string | undefined,
    pnlImpact: row.pnl_impact as number | undefined,
    riskStateBefore: row.risk_state_before ? JSON.parse(row.risk_state_before as string) : undefined,
    riskStateAfter: row.risk_state_after ? JSON.parse(row.risk_state_after as string) : undefined,
  }));
}
