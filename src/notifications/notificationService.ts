/**
 * Notification Service
 * Orchestriert die neue Push-Pipeline: News → Candidate → Gate Check → Push
 *
 * WICHTIG: breaking_news Events führen NICHT mehr direkt zu Pushes!
 * Stattdessen: News → Candidate (DB) → Gate Check → Rate Limit → Push
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import {
  createCandidate,
  setMatchResult,
  setGateResults,
  markAsPushed,
  rejectCandidate,
  queueForPush,
  getCandidatesForPush,
  getCandidatesForMatching,
  expireOldCandidates,
  NewsCandidate,
  CreateCandidateInput,
  CandidateStats,
  getCandidateStats,
} from '../storage/repositories/newsCandidates.js';
import {
  canPush,
  recordPush,
  addToQuietHoursQueue,
  getAndClearQuietHoursQueue,
  minutesUntilQuietHoursEnd,
  getNotificationSettings,
  QueuedNotification,
  addToBatch,
  getBatchAndClear,
  isBatchReady,
  getPendingBatchCount,
  RateLimitResult,
} from './rateLimiter.js';
import {
  evaluateGates,
  generateWhyNow,
  GateEvaluationInput,
  MarketInfo,
  SourceInfo,
} from './pushGates.js';
import { BreakingNewsEvent } from '../germany/index.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface PushReadyNotification {
  candidate: NewsCandidate;
  market: MarketInfo;
  whyNow: string[];
  asOf: Date;
  type: 'TIME_DELAY' | 'MISPRICING' | 'SYSTEM';
}

export interface NotificationServiceEvents {
  'push_ready': (notification: PushReadyNotification) => void;
  'push_batched': (notifications: PushReadyNotification[]) => void;
  'candidate_rejected': (candidate: NewsCandidate, reason: string) => void;
  'quiet_hours_queue': (count: number) => void;
}

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION SERVICE
// ═══════════════════════════════════════════════════════════════

class NotificationService extends EventEmitter {
  private chatId: string;
  private processingInterval: NodeJS.Timeout | null = null;
  private quietHoursCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.chatId = ''; // Will be set during init
  }

  /**
   * Initialisiert den Service mit der Chat-ID
   */
  init(chatId: string): void {
    this.chatId = chatId;
    logger.info(`[NOTIFICATION_SERVICE] Initialisiert für Chat ${chatId}`);
  }

  /**
   * Startet Background-Processing für Candidates
   */
  start(): void {
    if (!this.chatId) {
      logger.warn('[NOTIFICATION_SERVICE] Nicht gestartet - keine Chat ID');
      return;
    }

    // Process candidates every 2 minutes
    this.processingInterval = setInterval(() => {
      this.processPendingCandidates().catch(err => {
        logger.error(`[NOTIFICATION_SERVICE] Processing Error: ${err.message}`);
      });
    }, 2 * 60 * 1000);

    // Check quiet hours every 5 minutes
    this.quietHoursCheckInterval = setInterval(() => {
      this.processQuietHoursQueue().catch(err => {
        logger.error(`[NOTIFICATION_SERVICE] Quiet Hours Error: ${err.message}`);
      });
    }, 5 * 60 * 1000);

    // Cleanup old candidates every hour
    setInterval(() => {
      expireOldCandidates();
    }, 60 * 60 * 1000);

    logger.info('[NOTIFICATION_SERVICE] Background-Processing gestartet');
  }

  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    if (this.quietHoursCheckInterval) {
      clearInterval(this.quietHoursCheckInterval);
      this.quietHoursCheckInterval = null;
    }
    logger.info('[NOTIFICATION_SERVICE] Gestoppt');
  }

  // ═══════════════════════════════════════════════════════════════
  // NEWS INTAKE (ersetzt direkten Push)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Verarbeitet eine Breaking News - erstellt Candidate statt direktem Push
   * Dies ist der neue Entry-Point für breaking_news Events
   */
  async processBreakingNews(news: BreakingNewsEvent): Promise<NewsCandidate | null> {
    logger.info(`[NOTIFICATION_SERVICE] Breaking News eingegangen: ${news.title.substring(0, 50)}...`);

    // 1. Erstelle Candidate
    const input: CreateCandidateInput = {
      sourceId: news.source,
      sourceName: news.source,
      title: news.title,
      url: news.url,
      content: news.content,
      publishedAt: new Date(news.publishedAt),
      categories: news.keywords || [],
      keywords: news.keywords || [],
      timeAdvantageSeconds: news.timeAdvantageSeconds,
      ttlHours: 6, // Candidate verfällt nach 6 Stunden
    };

    const candidate = createCandidate(input);

    if (!candidate) {
      logger.debug('[NOTIFICATION_SERVICE] Duplikat - übersprungen');
      return null;
    }

    // 2. Trigger Matching (wird vom Ticker/TIME_DELAY Engine gemacht)
    // Der Candidate bleibt im Status 'new' bis ein Match gefunden wird

    return candidate;
  }

  /**
   * Setzt Match-Ergebnis für einen Kandidaten und prüft Gates
   */
  async setMatchAndEvaluate(
    candidateId: number,
    market: MarketInfo | null,
    source: SourceInfo,
    expectedLagMinutes?: number
  ): Promise<boolean> {
    // 1. Setze Match-Ergebnis
    if (!market) {
      setMatchResult(candidateId, null, null, null, null);
      return false;
    }

    setMatchResult(
      candidateId,
      market.marketId,
      market.question,
      0.8, // Default confidence wenn nicht anders angegeben
      'keyword'
    );

    // 2. Hole aktualisierten Kandidaten
    const candidate = await this.getCandidateById(candidateId);
    if (!candidate) return false;

    // 3. Evaluiere Gates
    const gateInput: GateEvaluationInput = {
      candidate,
      market,
      source,
      expectedLagMinutes,
    };

    const gateResult = evaluateGates(gateInput, this.chatId);

    // 4. Speichere Gate-Ergebnisse
    setGateResults(candidateId, gateResult.gateResults, gateResult.allPassed);

    if (!gateResult.allPassed) {
      logger.info(`[NOTIFICATION_SERVICE] Gates nicht bestanden: ${gateResult.summary}`);
      this.emit('candidate_rejected', candidate, gateResult.summary);
      return false;
    }

    // 5. Candidate ist push-ready - zur Queue hinzufügen
    await this.queueCandidateForPush(candidateId, market);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // PUSH QUEUE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fügt einen Kandidaten zur Push-Queue hinzu
   */
  private async queueCandidateForPush(candidateId: number, market: MarketInfo): Promise<void> {
    const candidate = await this.getCandidateById(candidateId);
    if (!candidate) return;

    // Prüfe Rate Limits
    const limitResult = canPush(this.chatId, 'TIME_DELAY');

    if (!limitResult.allowed) {
      if (limitResult.queuedForQuietHours) {
        // Zur Quiet-Hours Queue hinzufügen
        const queuedNotification: QueuedNotification = {
          candidateId,
          queuedAt: new Date().toISOString(),
          priority: this.calculatePriority(candidate, market),
          title: candidate.title,
        };
        addToQuietHoursQueue(queuedNotification);
        queueForPush(candidateId);
        logger.info(`[NOTIFICATION_SERVICE] Zu Quiet-Hours Queue hinzugefügt: ${candidate.title.substring(0, 40)}...`);
        return;
      }

      // Rate Limit - Batching versuchen
      const queuedNotification: QueuedNotification = {
        candidateId,
        queuedAt: new Date().toISOString(),
        priority: this.calculatePriority(candidate, market),
        title: candidate.title,
      };

      addToBatch(queuedNotification);
      queueForPush(candidateId);
      logger.info(`[NOTIFICATION_SERVICE] Zum Batch hinzugefügt (${limitResult.reason}): ${candidate.title.substring(0, 40)}...`);
      return;
    }

    // Push erlaubt - senden
    await this.sendPush(candidate, market);
  }

  /**
   * Sendet einen Push (emittiert Event für Telegram Bot)
   */
  private async sendPush(candidate: NewsCandidate, market: MarketInfo): Promise<void> {
    const whyNow = generateWhyNow(candidate, market, candidate.gateResults || {});

    const notification: PushReadyNotification = {
      candidate,
      market,
      whyNow,
      asOf: candidate.publishedAt,
      type: 'TIME_DELAY',
    };

    // Record in rate limiter
    recordPush();

    // Emit event for Telegram Bot
    this.emit('push_ready', notification);

    logger.info(`[NOTIFICATION_SERVICE] Push Ready: ${candidate.title.substring(0, 50)}...`);
  }

  // ═══════════════════════════════════════════════════════════════
  // BACKGROUND PROCESSING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Verarbeitet ausstehende Candidates
   */
  private async processPendingCandidates(): Promise<void> {
    // 1. Expire alte Candidates
    expireOldCandidates();

    // 2. Check ob Batch ready
    if (isBatchReady()) {
      await this.processBatch();
    }

    // 3. Check ausstehende push-ready Candidates
    const pushReady = getCandidatesForPush();
    for (const candidate of pushReady) {
      if (!candidate.matchedMarketId) continue;

      // Re-check rate limits
      const limitResult = canPush(this.chatId, 'TIME_DELAY');
      if (!limitResult.allowed) {
        logger.debug(`[NOTIFICATION_SERVICE] Push verzögert: ${limitResult.reason}`);
        continue;
      }

      // Create minimal market info from candidate
      const market: MarketInfo = {
        marketId: candidate.matchedMarketId,
        question: candidate.matchedMarketQuestion || '',
        currentPrice: 0.5, // Placeholder
        totalVolume: 50000, // Placeholder
      };

      await this.sendPush(candidate, market);
    }
  }

  /**
   * Verarbeitet gesammeltes Batch
   */
  private async processBatch(): Promise<void> {
    const batch = getBatchAndClear();
    if (!batch) return;

    // Prüfe Rate Limits nochmal
    const limitResult = canPush(this.chatId, 'TIME_DELAY');
    if (!limitResult.allowed) {
      // Quiet Hours? Queue alle
      if (limitResult.queuedForQuietHours) {
        addToQuietHoursQueue(batch.primary);
        for (const item of batch.additional) {
          addToQuietHoursQueue(item);
        }
        return;
      }
      return;
    }

    // Sende Primary + Info über Additional
    const primaryCandidate = await this.getCandidateById(batch.primary.candidateId);
    if (!primaryCandidate) return;

    const market: MarketInfo = {
      marketId: primaryCandidate.matchedMarketId || '',
      question: primaryCandidate.matchedMarketQuestion || '',
      currentPrice: 0.5,
      totalVolume: 50000,
    };

    const whyNow = generateWhyNow(primaryCandidate, market, primaryCandidate.gateResults || {});

    const notification: PushReadyNotification = {
      candidate: primaryCandidate,
      market,
      whyNow,
      asOf: primaryCandidate.publishedAt,
      type: 'TIME_DELAY',
    };

    recordPush();

    // Bei mehreren Candidates: Batch-Notification
    if (batch.additional.length > 0) {
      const allNotifications = [notification];

      for (const item of batch.additional.slice(0, 3)) {
        const candidate = await this.getCandidateById(item.candidateId);
        if (candidate) {
          allNotifications.push({
            candidate,
            market: {
              marketId: candidate.matchedMarketId || '',
              question: candidate.matchedMarketQuestion || '',
              currentPrice: 0.5,
              totalVolume: 50000,
            },
            whyNow: [],
            asOf: candidate.publishedAt,
            type: 'TIME_DELAY',
          });
        }
      }

      this.emit('push_batched', allNotifications);
      logger.info(`[NOTIFICATION_SERVICE] Batch Push: ${allNotifications.length} Notifications`);
    } else {
      this.emit('push_ready', notification);
    }

    // Mark all as pushed
    markAsPushed(batch.primary.candidateId);
    for (const item of batch.additional) {
      markAsPushed(item.candidateId);
    }
  }

  /**
   * Verarbeitet Quiet-Hours Queue wenn Quiet Hours enden
   */
  private async processQuietHoursQueue(): Promise<void> {
    const remaining = minutesUntilQuietHoursEnd(this.chatId);

    // Noch in Quiet Hours
    if (remaining !== null && remaining > 0) {
      return;
    }

    // Quiet Hours sind vorbei - Queue verarbeiten
    const queue = getAndClearQuietHoursQueue();
    if (queue.length === 0) return;

    logger.info(`[NOTIFICATION_SERVICE] Quiet Hours vorbei - verarbeite ${queue.length} geparkete Notifications`);
    this.emit('quiet_hours_queue', queue.length);

    // Nur Top-Priority senden (Rate-Limited)
    queue.sort((a, b) => b.priority - a.priority);

    const limitResult = canPush(this.chatId, 'TIME_DELAY');
    if (!limitResult.allowed) {
      logger.warn(`[NOTIFICATION_SERVICE] Rate Limit nach Quiet Hours: ${limitResult.reason}`);
      return;
    }

    const topItem = queue[0];
    const candidate = await this.getCandidateById(topItem.candidateId);
    if (candidate && candidate.status !== 'pushed') {
      const market: MarketInfo = {
        marketId: candidate.matchedMarketId || '',
        question: candidate.matchedMarketQuestion || '',
        currentPrice: 0.5,
        totalVolume: 50000,
      };

      await this.sendPush(candidate, market);

      // Info über weitere geparkete
      if (queue.length > 1) {
        logger.info(`[NOTIFICATION_SERVICE] +${queue.length - 1} weitere geparkete Notifications (nutze /digest)`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SYSTEM ALERTS (bypass Rate Limits)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Sendet System-Alert (Kill-Switch, Pipeline Down, etc.)
   * Bypassed die meisten Rate Limits, aber respektiert Push Mode
   */
  emitSystemAlert(type: string, message: string, details?: Record<string, unknown>): void {
    const limitResult = canPush(this.chatId, 'SYSTEM');

    if (!limitResult.allowed && limitResult.reason !== 'Quiet Hours') {
      logger.warn(`[NOTIFICATION_SERVICE] System Alert blockiert: ${limitResult.reason}`);
      return;
    }

    this.emit('system_alert', { type, message, details, asOf: new Date() });
    logger.info(`[NOTIFICATION_SERVICE] System Alert: ${type} - ${message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  private async getCandidateById(id: number): Promise<NewsCandidate | null> {
    // Import dynamisch um Circular Dependencies zu vermeiden
    const { getCandidateById } = await import('../storage/repositories/newsCandidates.js');
    return getCandidateById(id);
  }

  private calculatePriority(candidate: NewsCandidate, market: MarketInfo): number {
    let priority = 0;

    // Time advantage
    if (candidate.timeAdvantageSeconds && candidate.timeAdvantageSeconds > 300) {
      priority += 20;
    }

    // Match confidence
    if (candidate.matchConfidence && candidate.matchConfidence >= 0.9) {
      priority += 30;
    } else if (candidate.matchConfidence && candidate.matchConfidence >= 0.8) {
      priority += 15;
    }

    // Market volume
    if (market.totalVolume >= 200000) {
      priority += 20;
    } else if (market.totalVolume >= 100000) {
      priority += 10;
    }

    return priority;
  }

  /**
   * Gibt aktuelle Stats zurück
   */
  getStats(): CandidateStats & { pendingBatch: number } {
    const stats = getCandidateStats();
    return {
      ...stats,
      pendingBatch: getPendingBatchCount(),
    };
  }
}

// Singleton Instance
export const notificationService = new NotificationService();
