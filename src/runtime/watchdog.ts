// ═══════════════════════════════════════════════════════════════
//                    WATCHDOG SERVICE
//         Überwacht Systemzustand und initiiert Selbstheilung
// ═══════════════════════════════════════════════════════════════

import logger from '../utils/logger.js';
import { EventEmitter } from 'events';

interface WatchdogCheck {
  name: string;
  check: () => Promise<boolean> | boolean;
  heal?: () => Promise<void> | void;
  critical: boolean;
  lastCheck?: Date;
  lastSuccess?: Date;
  consecutiveFailures: number;
  maxFailures: number;
}

interface WatchdogStats {
  running: boolean;
  checks: Array<{
    name: string;
    healthy: boolean;
    lastCheck: Date | null;
    lastSuccess: Date | null;
    consecutiveFailures: number;
    critical: boolean;
  }>;
  lastFullCheck: Date | null;
  totalChecks: number;
  totalHealAttempts: number;
  uptimeSeconds: number;
}

class WatchdogService extends EventEmitter {
  private checks: Map<string, WatchdogCheck> = new Map();
  private running = false;
  private intervalHandle: NodeJS.Timeout | null = null;
  private checkIntervalMs = 30_000; // 30 Sekunden
  private startTime: Date | null = null;
  private totalChecks = 0;
  private totalHealAttempts = 0;
  private lastFullCheck: Date | null = null;

  constructor() {
    super();
    this.registerDefaultChecks();
  }

  private registerDefaultChecks(): void {
    // 1. Scanner Check - ist der Scanner aktiv?
    this.register({
      name: 'scanner',
      check: async () => {
        try {
          const { scanner } = await import('../scanner/index.js');
          const status = scanner.getStatus();
          // Scanner ist OK wenn er läuft ODER wenn er mindestens 1x gescannt hat
          return status.isScanning || status.totalScans > 0;
        } catch {
          return false;
        }
      },
      heal: async () => {
        try {
          const { scanner } = await import('../scanner/index.js');
          logger.warn('[Watchdog] Attempting to restart scanner...');
          scanner.stop();
          await new Promise(resolve => setTimeout(resolve, 1000));
          await scanner.start();
          logger.info('[Watchdog] Scanner restarted successfully');
        } catch (err) {
          logger.error(`[Watchdog] Scanner heal failed: ${(err as Error).message}`);
        }
      },
      critical: true,
      consecutiveFailures: 0,
      maxFailures: 3,
    });

    // 2. News Ticker Check
    this.register({
      name: 'ticker',
      check: async () => {
        try {
          const { newsTicker } = await import('../ticker/index.js');
          const stats = newsTicker.getStats();
          const marketCount = newsTicker.getMarketCount();
          // Ticker ist OK wenn er Märkte tracked oder aktive Quellen hat
          return marketCount > 0 || stats.sourcesActive > 0;
        } catch {
          return false;
        }
      },
      heal: async () => {
        try {
          const { newsTicker } = await import('../ticker/index.js');
          logger.warn('[Watchdog] Attempting to restart ticker...');
          newsTicker.stop();
          await new Promise(resolve => setTimeout(resolve, 500));
          await newsTicker.start();
          logger.info('[Watchdog] Ticker restarted successfully');
        } catch (err) {
          logger.error(`[Watchdog] Ticker heal failed: ${(err as Error).message}`);
        }
      },
      critical: false,
      consecutiveFailures: 0,
      maxFailures: 5,
    });

    // 3. Database Check
    this.register({
      name: 'database',
      check: () => {
        try {
          const { isSqliteAvailable, getDatabase } = require('../storage/db.js');
          if (!isSqliteAvailable()) return true; // OK wenn nicht verfügbar (optional)
          getDatabase();
          return true;
        } catch {
          return false;
        }
      },
      critical: true,
      consecutiveFailures: 0,
      maxFailures: 3,
    });

    // 4. Memory Check - nicht mehr als 90% des Limits
    this.register({
      name: 'memory',
      check: () => {
        const used = process.memoryUsage();
        const heapUsedMB = used.heapUsed / 1024 / 1024;
        const maxHeapMB = 500; // PM2 Limit
        return heapUsedMB < maxHeapMB * 0.9;
      },
      heal: async () => {
        // Force garbage collection wenn möglich
        if (global.gc) {
          logger.warn('[Watchdog] Forcing garbage collection...');
          global.gc();
        }
      },
      critical: false,
      consecutiveFailures: 0,
      maxFailures: 5,
    });

    // 5. Event Loop Check - nicht blockiert
    this.register({
      name: 'eventLoop',
      check: async () => {
        return new Promise<boolean>((resolve) => {
          const start = Date.now();
          setImmediate(() => {
            const lag = Date.now() - start;
            // Event Loop Lag sollte unter 100ms sein
            resolve(lag < 100);
          });
        });
      },
      critical: false,
      consecutiveFailures: 0,
      maxFailures: 10,
    });
  }

  register(check: WatchdogCheck): void {
    this.checks.set(check.name, check);
    logger.debug(`[Watchdog] Check registered: ${check.name}`);
  }

  async runChecks(): Promise<boolean> {
    this.totalChecks++;
    this.lastFullCheck = new Date();
    let allHealthy = true;

    for (const [name, check] of this.checks) {
      try {
        const healthy = await check.check();
        check.lastCheck = new Date();

        if (healthy) {
          check.lastSuccess = new Date();
          check.consecutiveFailures = 0;
        } else {
          check.consecutiveFailures++;
          logger.warn(`[Watchdog] Check "${name}" failed (${check.consecutiveFailures}/${check.maxFailures})`);

          if (check.consecutiveFailures >= check.maxFailures) {
            logger.error(`[Watchdog] Check "${name}" exceeded max failures!`);
            this.emit('checkFailed', { name, check, critical: check.critical });

            // Versuche zu heilen
            if (check.heal) {
              this.totalHealAttempts++;
              this.emit('healAttempt', { name });
              try {
                await check.heal();
                logger.info(`[Watchdog] Heal attempt for "${name}" completed`);
                // Reset nach erfolgreichem Heal
                check.consecutiveFailures = 0;
              } catch (err) {
                logger.error(`[Watchdog] Heal failed for "${name}": ${(err as Error).message}`);
              }
            }
          }

          if (check.critical) {
            allHealthy = false;
          }
        }
      } catch (err) {
        logger.error(`[Watchdog] Error checking "${name}": ${(err as Error).message}`);
        check.consecutiveFailures++;
        if (check.critical) {
          allHealthy = false;
        }
      }
    }

    this.emit('checksCompleted', { healthy: allHealthy, timestamp: new Date() });
    return allHealthy;
  }

  start(): void {
    if (this.running) {
      logger.warn('[Watchdog] Already running');
      return;
    }

    this.running = true;
    this.startTime = new Date();
    logger.info(`[Watchdog] Started with ${this.checks.size} checks, interval: ${this.checkIntervalMs / 1000}s`);

    // Initial check nach kurzer Verzögerung
    setTimeout(() => {
      this.runChecks().catch(err => {
        logger.error(`[Watchdog] Initial check error: ${(err as Error).message}`);
      });
    }, 5000);

    // Periodische Checks
    this.intervalHandle = setInterval(() => {
      this.runChecks().catch(err => {
        logger.error(`[Watchdog] Check error: ${(err as Error).message}`);
      });
    }, this.checkIntervalMs);

    this.emit('started');
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    logger.info('[Watchdog] Stopped');
    this.emit('stopped');
  }

  getStats(): WatchdogStats {
    const checks = Array.from(this.checks.entries()).map(([name, check]) => ({
      name,
      healthy: check.consecutiveFailures === 0,
      lastCheck: check.lastCheck || null,
      lastSuccess: check.lastSuccess || null,
      consecutiveFailures: check.consecutiveFailures,
      critical: check.critical,
    }));

    return {
      running: this.running,
      checks,
      lastFullCheck: this.lastFullCheck,
      totalChecks: this.totalChecks,
      totalHealAttempts: this.totalHealAttempts,
      uptimeSeconds: this.startTime ? (Date.now() - this.startTime.getTime()) / 1000 : 0,
    };
  }

  isHealthy(): boolean {
    for (const check of this.checks.values()) {
      if (check.critical && check.consecutiveFailures >= check.maxFailures) {
        return false;
      }
    }
    return true;
  }
}

export const watchdog = new WatchdogService();
export default watchdog;
