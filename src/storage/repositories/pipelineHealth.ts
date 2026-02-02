/**
 * Pipeline Health Repository
 * Persistent Tracking von Pipeline-Status und Data Freshness
 *
 * Ermöglicht:
 * - Tracking aller Pipelines (Polymarket, RSS, Dawum, etc.)
 * - Stale-Data Detection (Daten älter als Threshold)
 * - Health Dashboard für UI
 */

import { getDatabase, initDatabase, isDatabaseInitialized } from '../db.js';
import { logger } from '../../utils/logger.js';

function ensureDatabase(): ReturnType<typeof getDatabase> {
  if (!isDatabaseInitialized()) {
    initDatabase();
  }
  return getDatabase();
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface PipelineStatus {
  pipelineName: string;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
  consecutiveErrors: number;
  totalRuns: number;
  totalErrors: number;
  avgDurationMs: number | null;
  updatedAt: Date;
  isHealthy: boolean;
  isStale: boolean;
  staleMinutes: number | null;
}

export interface DataFreshness {
  sourceType: string;
  sourceId: string | null;
  asOf: Date;
  fetchedAt: Date;
  staleThresholdMinutes: number;
  isStale: boolean;
  minutesSinceUpdate: number;
}

// Stale Thresholds (in Minuten)
const STALE_THRESHOLDS: Record<string, number> = {
  polymarket: 5,
  rss: 15,
  dawum: 60,
  telegram: 5,
  scanner: 10,
};

// ═══════════════════════════════════════════════════════════════
// PIPELINE HEALTH FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Pipeline-Run erfolgreich abgeschlossen
 */
export function recordPipelineSuccess(
  pipelineName: string,
  durationMs: number
): void {
  const db = ensureDatabase();
  const now = new Date().toISOString();

  // Upsert: Update wenn existiert, Insert wenn nicht
  db.prepare(`
    INSERT INTO pipeline_health (
      pipeline_name, last_success_at, consecutive_errors, total_runs, avg_duration_ms, updated_at
    ) VALUES (?, ?, 0, 1, ?, ?)
    ON CONFLICT(pipeline_name) DO UPDATE SET
      last_success_at = excluded.last_success_at,
      consecutive_errors = 0,
      total_runs = total_runs + 1,
      avg_duration_ms = (COALESCE(avg_duration_ms, 0) * total_runs + ?) / (total_runs + 1),
      updated_at = excluded.updated_at
  `).run(pipelineName, now, durationMs, now, durationMs);

  logger.debug(`Pipeline ${pipelineName}: Success (${durationMs}ms)`);
}

/**
 * Pipeline-Run mit Fehler
 */
export function recordPipelineError(
  pipelineName: string,
  errorMessage: string
): void {
  const db = ensureDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO pipeline_health (
      pipeline_name, last_error_at, last_error_message, consecutive_errors, total_runs, total_errors, updated_at
    ) VALUES (?, ?, ?, 1, 1, 1, ?)
    ON CONFLICT(pipeline_name) DO UPDATE SET
      last_error_at = excluded.last_error_at,
      last_error_message = excluded.last_error_message,
      consecutive_errors = consecutive_errors + 1,
      total_runs = total_runs + 1,
      total_errors = total_errors + 1,
      updated_at = excluded.updated_at
  `).run(pipelineName, now, errorMessage, now);

  logger.warn(`Pipeline ${pipelineName}: Error - ${errorMessage}`);
}

/**
 * Alle Pipeline-Status abrufen
 */
export function getAllPipelineStatus(): PipelineStatus[] {
  const db = ensureDatabase();
  const now = new Date();

  const rows = db.prepare(`
    SELECT * FROM pipeline_health ORDER BY pipeline_name
  `).all() as Array<Record<string, unknown>>;

  return rows.map(row => {
    const lastSuccess = row.last_success_at ? new Date(row.last_success_at as string) : null;
    const staleThreshold = STALE_THRESHOLDS[row.pipeline_name as string] ?? 10;
    const minutesSinceSuccess = lastSuccess
      ? (now.getTime() - lastSuccess.getTime()) / 1000 / 60
      : null;
    const isStale = minutesSinceSuccess !== null && minutesSinceSuccess > staleThreshold;
    const isHealthy = (row.consecutive_errors as number) < 3 && !isStale;

    return {
      pipelineName: row.pipeline_name as string,
      lastSuccessAt: lastSuccess,
      lastErrorAt: row.last_error_at ? new Date(row.last_error_at as string) : null,
      lastErrorMessage: row.last_error_message as string | null,
      consecutiveErrors: row.consecutive_errors as number,
      totalRuns: row.total_runs as number,
      totalErrors: row.total_errors as number,
      avgDurationMs: row.avg_duration_ms as number | null,
      updatedAt: new Date(row.updated_at as string),
      isHealthy,
      isStale,
      staleMinutes: minutesSinceSuccess !== null ? Math.round(minutesSinceSuccess) : null,
    };
  });
}

/**
 * Pipeline-Status für eine spezifische Pipeline
 */
export function getPipelineStatus(pipelineName: string): PipelineStatus | null {
  const all = getAllPipelineStatus();
  return all.find(p => p.pipelineName === pipelineName) || null;
}

/**
 * Prüfe ob eine Pipeline als "stale" gilt
 */
export function isPipelineStale(pipelineName: string): boolean {
  const status = getPipelineStatus(pipelineName);
  if (!status) return true; // Unbekannte Pipeline = stale

  return status.isStale;
}

// ═══════════════════════════════════════════════════════════════
// DATA FRESHNESS FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Daten-Aktualität aufzeichnen
 */
export function recordDataFreshness(
  sourceType: string,
  asOf: Date,
  sourceId?: string
): void {
  const db = ensureDatabase();
  const now = new Date().toISOString();
  const threshold = STALE_THRESHOLDS[sourceType] ?? 5;

  db.prepare(`
    INSERT INTO data_freshness (source_type, source_id, as_of, fetched_at, stale_threshold_minutes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_type, source_id) DO UPDATE SET
      as_of = excluded.as_of,
      fetched_at = excluded.fetched_at,
      stale_threshold_minutes = excluded.stale_threshold_minutes
  `).run(sourceType, sourceId || null, asOf.toISOString(), now, threshold);
}

/**
 * Daten-Aktualität abrufen
 */
export function getDataFreshness(sourceType?: string): DataFreshness[] {
  const db = ensureDatabase();
  const now = new Date();

  let query = 'SELECT * FROM data_freshness';
  const params: string[] = [];

  if (sourceType) {
    query += ' WHERE source_type = ?';
    params.push(sourceType);
  }

  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

  return rows.map(row => {
    const asOf = new Date(row.as_of as string);
    const threshold = row.stale_threshold_minutes as number;
    const minutesSinceUpdate = (now.getTime() - asOf.getTime()) / 1000 / 60;
    const isStale = minutesSinceUpdate > threshold;

    return {
      sourceType: row.source_type as string,
      sourceId: row.source_id as string | null,
      asOf,
      fetchedAt: new Date(row.fetched_at as string),
      staleThresholdMinutes: threshold,
      isStale,
      minutesSinceUpdate: Math.round(minutesSinceUpdate),
    };
  });
}

/**
 * Prüfe ob spezifische Daten als "stale" gelten
 */
export function isDataStale(sourceType: string, sourceId?: string): boolean {
  const freshness = getDataFreshness(sourceType);
  const entry = freshness.find(f =>
    f.sourceType === sourceType && f.sourceId === (sourceId || null)
  );

  if (!entry) return true; // Keine Daten = stale
  return entry.isStale;
}

// ═══════════════════════════════════════════════════════════════
// HEALTH DASHBOARD
// ═══════════════════════════════════════════════════════════════

export interface SystemHealthDashboard {
  overall: 'healthy' | 'degraded' | 'critical';
  pipelines: PipelineStatus[];
  freshness: DataFreshness[];
  staleAlerts: string[];
  timestamp: Date;
}

/**
 * Vollständiges Health Dashboard
 */
export function getSystemHealthDashboard(): SystemHealthDashboard {
  const pipelines = getAllPipelineStatus();
  const freshness = getDataFreshness();
  const staleAlerts: string[] = [];

  // Stale Alerts sammeln
  for (const p of pipelines) {
    if (p.isStale) {
      staleAlerts.push(`Pipeline ${p.pipelineName}: Letzte Daten vor ${p.staleMinutes} Minuten`);
    }
    if (p.consecutiveErrors >= 3) {
      staleAlerts.push(`Pipeline ${p.pipelineName}: ${p.consecutiveErrors} aufeinanderfolgende Fehler`);
    }
  }

  for (const f of freshness) {
    if (f.isStale) {
      staleAlerts.push(`Daten ${f.sourceType}${f.sourceId ? `/${f.sourceId}` : ''}: ${f.minutesSinceUpdate} Minuten alt`);
    }
  }

  // Overall Status bestimmen
  const stalePipelines = pipelines.filter(p => p.isStale).length;
  const errorPipelines = pipelines.filter(p => p.consecutiveErrors >= 3).length;
  const totalPipelines = Math.max(pipelines.length, 1);

  let overall: 'healthy' | 'degraded' | 'critical' = 'healthy';

  if (errorPipelines > 0 || stalePipelines > totalPipelines / 2) {
    overall = 'critical';
  } else if (stalePipelines > 0 || staleAlerts.length > 0) {
    overall = 'degraded';
  }

  return {
    overall,
    pipelines,
    freshness,
    staleAlerts,
    timestamp: new Date(),
  };
}
