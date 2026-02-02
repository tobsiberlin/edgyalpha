/**
 * Notification Rate Limiter
 * Zentrales Modul für Push-Rate-Limiting mit Persistence
 *
 * Features:
 * - Cooldown zwischen Pushes (z.B. 10-15 min)
 * - Daily Cap (z.B. max 8 Pushes/Tag)
 * - Quiet Hours (z.B. 23:00-07:00)
 * - Batching mehrerer gleichzeitiger Candidates
 * - State persistent in SQLite
 */

import { getDatabase, initDatabase, isDatabaseInitialized } from '../storage/db.js';
import { logger } from '../utils/logger.js';

function ensureDatabase(): ReturnType<typeof getDatabase> {
  if (!isDatabaseInitialized()) {
    initDatabase();
  }
  return getDatabase();
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface NotificationState {
  lastPushAt: Date | null;
  pushesToday: number;
  pushesTodayDate: string;
  quietHoursQueue: QueuedNotification[];
}

export interface QueuedNotification {
  candidateId: number;
  queuedAt: string;
  priority: number;
  title: string;
}

export interface NotificationSettings {
  chatId: string;
  pushMode: PushMode;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
  minMatchConfidence: number;
  minEdge: number;
  minVolume: number;
  categoryPolitics: boolean;
  categoryEconomy: boolean;
  categorySports: boolean;
  categoryGeopolitics: boolean;
  categoryCrypto: boolean;
  cooldownMinutes: number;
  maxPerDay: number;
}

export type PushMode = 'OFF' | 'TIME_DELAY_ONLY' | 'SYSTEM_ONLY' | 'DIGEST_ONLY' | 'FULL';

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMinutes?: number;
  queuedForQuietHours?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function initNotificationState(): void {
  const db = ensureDatabase();
  const today = new Date().toISOString().split('T')[0];

  const existing = db.prepare('SELECT id FROM notification_state WHERE id = 1').get();
  if (!existing) {
    db.prepare(`
      INSERT INTO notification_state (id, pushes_today, pushes_today_date, quiet_hours_queue)
      VALUES (1, 0, ?, '[]')
    `).run(today);
    logger.info('[RATE_LIMITER] Notification State initialisiert');
  }
}

export function getNotificationState(): NotificationState {
  const db = ensureDatabase();
  initNotificationState();

  const row = db.prepare('SELECT * FROM notification_state WHERE id = 1').get() as Record<string, unknown>;
  const today = new Date().toISOString().split('T')[0];

  // Daily Reset wenn neuer Tag
  if (row.pushes_today_date !== today) {
    db.prepare(`
      UPDATE notification_state SET
        pushes_today = 0,
        pushes_today_date = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(today);
    return {
      lastPushAt: row.last_push_at ? new Date(row.last_push_at as string) : null,
      pushesToday: 0,
      pushesTodayDate: today,
      quietHoursQueue: JSON.parse(row.quiet_hours_queue as string || '[]'),
    };
  }

  return {
    lastPushAt: row.last_push_at ? new Date(row.last_push_at as string) : null,
    pushesToday: row.pushes_today as number,
    pushesTodayDate: row.pushes_today_date as string,
    quietHoursQueue: JSON.parse(row.quiet_hours_queue as string || '[]'),
  };
}

export function recordPush(): void {
  const db = ensureDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE notification_state SET
      last_push_at = ?,
      pushes_today = pushes_today + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(now);

  logger.debug('[RATE_LIMITER] Push recorded');
}

export function addToQuietHoursQueue(notification: QueuedNotification): void {
  const db = ensureDatabase();
  const state = getNotificationState();
  const queue = [...state.quietHoursQueue, notification];

  // Limit queue size
  while (queue.length > 20) {
    queue.shift();
  }

  db.prepare(`
    UPDATE notification_state SET
      quiet_hours_queue = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(JSON.stringify(queue));

  logger.info(`[RATE_LIMITER] Added to quiet hours queue: ${notification.title.substring(0, 40)}...`);
}

export function getAndClearQuietHoursQueue(): QueuedNotification[] {
  const db = ensureDatabase();
  const state = getNotificationState();
  const queue = state.quietHoursQueue;

  if (queue.length > 0) {
    db.prepare(`
      UPDATE notification_state SET
        quiet_hours_queue = '[]',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();
    logger.info(`[RATE_LIMITER] Quiet hours queue cleared: ${queue.length} items`);
  }

  return queue;
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export function getNotificationSettings(chatId: string): NotificationSettings {
  const db = ensureDatabase();

  const row = db.prepare('SELECT * FROM notification_settings WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined;

  if (!row) {
    // Return defaults
    return {
      chatId,
      pushMode: 'TIME_DELAY_ONLY',
      quietHoursEnabled: true,
      quietHoursStart: '23:00',
      quietHoursEnd: '07:00',
      timezone: 'Europe/Berlin',
      minMatchConfidence: 0.75,
      minEdge: 0.03,
      minVolume: 50000,
      categoryPolitics: true,
      categoryEconomy: true,
      categorySports: false,
      categoryGeopolitics: true,
      categoryCrypto: false,
      cooldownMinutes: 15,
      maxPerDay: 8,
    };
  }

  return {
    chatId: row.chat_id as string,
    pushMode: row.push_mode as PushMode,
    quietHoursEnabled: (row.quiet_hours_enabled as number) === 1,
    quietHoursStart: row.quiet_hours_start as string,
    quietHoursEnd: row.quiet_hours_end as string,
    timezone: row.timezone as string,
    minMatchConfidence: row.min_match_confidence as number,
    minEdge: row.min_edge as number,
    minVolume: row.min_volume as number,
    categoryPolitics: (row.category_politics as number) === 1,
    categoryEconomy: (row.category_economy as number) === 1,
    categorySports: (row.category_sports as number) === 1,
    categoryGeopolitics: (row.category_geopolitics as number) === 1,
    categoryCrypto: (row.category_crypto as number) === 1,
    cooldownMinutes: row.cooldown_minutes as number,
    maxPerDay: row.max_per_day as number,
  };
}

export function updateNotificationSettings(
  chatId: string,
  updates: Partial<Omit<NotificationSettings, 'chatId'>>
): NotificationSettings {
  const db = ensureDatabase();
  const current = getNotificationSettings(chatId);

  const merged = { ...current, ...updates };

  db.prepare(`
    INSERT INTO notification_settings (
      chat_id, push_mode, quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
      timezone, min_match_confidence, min_edge, min_volume,
      category_politics, category_economy, category_sports, category_geopolitics, category_crypto,
      cooldown_minutes, max_per_day
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      push_mode = excluded.push_mode,
      quiet_hours_enabled = excluded.quiet_hours_enabled,
      quiet_hours_start = excluded.quiet_hours_start,
      quiet_hours_end = excluded.quiet_hours_end,
      timezone = excluded.timezone,
      min_match_confidence = excluded.min_match_confidence,
      min_edge = excluded.min_edge,
      min_volume = excluded.min_volume,
      category_politics = excluded.category_politics,
      category_economy = excluded.category_economy,
      category_sports = excluded.category_sports,
      category_geopolitics = excluded.category_geopolitics,
      category_crypto = excluded.category_crypto,
      cooldown_minutes = excluded.cooldown_minutes,
      max_per_day = excluded.max_per_day,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    chatId,
    merged.pushMode,
    merged.quietHoursEnabled ? 1 : 0,
    merged.quietHoursStart,
    merged.quietHoursEnd,
    merged.timezone,
    merged.minMatchConfidence,
    merged.minEdge,
    merged.minVolume,
    merged.categoryPolitics ? 1 : 0,
    merged.categoryEconomy ? 1 : 0,
    merged.categorySports ? 1 : 0,
    merged.categoryGeopolitics ? 1 : 0,
    merged.categoryCrypto ? 1 : 0,
    merged.cooldownMinutes,
    merged.maxPerDay
  );

  logger.info(`[RATE_LIMITER] Settings aktualisiert für Chat ${chatId}`);
  return merged;
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMITING CHECKS
// ═══════════════════════════════════════════════════════════════

/**
 * Prüft ob ein Push aktuell erlaubt ist
 */
export function canPush(chatId: string, notificationType: 'TIME_DELAY' | 'MISPRICING' | 'SYSTEM'): RateLimitResult {
  const settings = getNotificationSettings(chatId);
  const state = getNotificationState();

  // 1. Push Mode Check
  if (settings.pushMode === 'OFF') {
    return { allowed: false, reason: 'Push-Benachrichtigungen deaktiviert' };
  }

  if (settings.pushMode === 'TIME_DELAY_ONLY' && notificationType !== 'TIME_DELAY' && notificationType !== 'SYSTEM') {
    return { allowed: false, reason: 'Nur TIME_DELAY Alerts aktiviert' };
  }

  if (settings.pushMode === 'SYSTEM_ONLY' && notificationType !== 'SYSTEM') {
    return { allowed: false, reason: 'Nur System Alerts aktiviert' };
  }

  if (settings.pushMode === 'DIGEST_ONLY' && notificationType !== 'SYSTEM') {
    return { allowed: false, reason: 'Nur Digest-Modus - nutze /digest für Alerts' };
  }

  // 2. Daily Cap Check
  if (state.pushesToday >= settings.maxPerDay) {
    return {
      allowed: false,
      reason: `Tageslimit erreicht (${settings.maxPerDay} Pushes)`,
    };
  }

  // 3. Cooldown Check (außer für System-Alerts)
  if (notificationType !== 'SYSTEM' && state.lastPushAt) {
    const minutesSinceLastPush = (Date.now() - state.lastPushAt.getTime()) / 1000 / 60;
    if (minutesSinceLastPush < settings.cooldownMinutes) {
      const retryAfter = Math.ceil(settings.cooldownMinutes - minutesSinceLastPush);
      return {
        allowed: false,
        reason: `Cooldown aktiv - noch ${retryAfter} Minuten`,
        retryAfterMinutes: retryAfter,
      };
    }
  }

  // 4. Quiet Hours Check (außer für System-Alerts)
  if (notificationType !== 'SYSTEM' && settings.quietHoursEnabled) {
    const inQuietHours = isInQuietHours(settings.quietHoursStart, settings.quietHoursEnd, settings.timezone);
    if (inQuietHours) {
      return {
        allowed: false,
        reason: `Quiet Hours (${settings.quietHoursStart}-${settings.quietHoursEnd})`,
        queuedForQuietHours: true,
      };
    }
  }

  return { allowed: true };
}

/**
 * Prüft ob eine bestimmte Kategorie aktiviert ist
 */
export function isCategoryEnabled(chatId: string, category: string): boolean {
  const settings = getNotificationSettings(chatId);

  const categoryMap: Record<string, boolean> = {
    politics: settings.categoryPolitics,
    economy: settings.categoryEconomy,
    sports: settings.categorySports,
    geopolitics: settings.categoryGeopolitics,
    crypto: settings.categoryCrypto,
  };

  // Unknown category = enabled by default
  return categoryMap[category.toLowerCase()] ?? true;
}

/**
 * Prüft Quiet Hours
 */
function isInQuietHours(start: string, end: string, timezone: string): boolean {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const timeStr = formatter.format(now);
    const [hours, minutes] = timeStr.split(':').map(Number);
    const currentMinutes = hours * 60 + minutes;

    const [startHours, startMins] = start.split(':').map(Number);
    const [endHours, endMins] = end.split(':').map(Number);

    const startMinutes = startHours * 60 + startMins;
    const endMinutes = endHours * 60 + endMins;

    // Handle overnight quiet hours (e.g., 23:00-07:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } catch (err) {
    logger.warn(`[RATE_LIMITER] Timezone Fehler: ${err}`);
    return false;
  }
}

/**
 * Gibt die Zeit bis zum Ende der Quiet Hours zurück (in Minuten)
 */
export function minutesUntilQuietHoursEnd(chatId: string): number | null {
  const settings = getNotificationSettings(chatId);
  if (!settings.quietHoursEnabled) return null;

  if (!isInQuietHours(settings.quietHoursStart, settings.quietHoursEnd, settings.timezone)) {
    return null;
  }

  const now = new Date();
  const [endHours, endMins] = settings.quietHoursEnd.split(':').map(Number);

  // Create target time in local timezone
  const target = new Date(now);
  target.setHours(endHours, endMins, 0, 0);

  // If end is before now, it's tomorrow
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  return Math.ceil((target.getTime() - now.getTime()) / 1000 / 60);
}

// ═══════════════════════════════════════════════════════════════
// BATCHING
// ═══════════════════════════════════════════════════════════════

interface BatchedNotification {
  primary: QueuedNotification;
  additional: QueuedNotification[];
}

const pendingBatch: QueuedNotification[] = [];
let batchTimeout: NodeJS.Timeout | null = null;

const BATCH_WINDOW_MS = 5 * 60 * 1000; // 5 Minuten

/**
 * Fügt eine Notification zur Batch-Queue hinzu
 * Returns: true wenn batch ready ist
 */
export function addToBatch(notification: QueuedNotification): boolean {
  pendingBatch.push(notification);

  // Start batch timer wenn erste Notification
  if (!batchTimeout) {
    batchTimeout = setTimeout(() => {
      // Timer abgelaufen - Batch ist ready
      batchTimeout = null;
    }, BATCH_WINDOW_MS);
  }

  return pendingBatch.length > 1;
}

/**
 * Holt das aktuelle Batch und leert es
 */
export function getBatchAndClear(): BatchedNotification | null {
  if (pendingBatch.length === 0) return null;

  // Sort by priority (highest first)
  pendingBatch.sort((a, b) => b.priority - a.priority);

  const result: BatchedNotification = {
    primary: pendingBatch[0],
    additional: pendingBatch.slice(1),
  };

  pendingBatch.length = 0;

  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }

  return result;
}

/**
 * Prüft ob Batch ready zum Senden ist
 */
export function isBatchReady(): boolean {
  return pendingBatch.length > 0 && batchTimeout === null;
}

export function getPendingBatchCount(): number {
  return pendingBatch.length;
}
