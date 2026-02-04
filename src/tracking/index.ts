/**
 * Performance Tracking Module - V4.0
 *
 * Persistentes Tracking aller Trades (Paper & Live)
 * Ermöglicht Beobachtung der Bot-Performance über Zeit
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
//                     TYPES
// ═══════════════════════════════════════════════════════════════

export type TradeStrategy = 'arbitrage' | 'lateEntry' | 'timeDelay' | 'manual';
export type TradeStatus = 'pending' | 'filled' | 'won' | 'lost' | 'expired';
export type ExecutionType = 'auto' | 'manual';

export interface TrackedTrade {
  id: string;
  strategy: TradeStrategy;
  executionType: ExecutionType;

  // Market Info
  marketId: string;
  question: string;
  direction: 'yes' | 'no';

  // Pricing
  entryPrice: number;
  exitPrice?: number;
  size: number;

  // Performance
  expectedProfit: number;
  actualProfit?: number;
  confidence: number;

  // Timing
  createdAt: Date;
  filledAt?: Date;
  resolvedAt?: Date;

  // Status
  status: TradeStatus;
  isPaper: boolean;

  // Reasoning
  reasoning: string[];
}

export interface PerformanceStats {
  // Overall
  totalTrades: number;
  paperTrades: number;
  liveTrades: number;

  // By Status
  pending: number;
  filled: number;
  won: number;
  lost: number;
  expired: number;

  // Financials (simuliert)
  totalVolume: number;
  totalExpectedProfit: number;
  totalActualProfit: number;

  // Rates
  winRate: number;
  avgConfidence: number;
  avgEdge: number;
  roi: number;

  // By Strategy
  byStrategy: Record<TradeStrategy, {
    trades: number;
    volume: number;
    profit: number;
    winRate: number;
  }>;

  // Time-based
  today: {
    trades: number;
    volume: number;
    profit: number;
  };
  thisWeek: {
    trades: number;
    volume: number;
    profit: number;
  };

  // Timestamps
  firstTradeAt?: Date;
  lastTradeAt?: Date;
  lastUpdated: Date;
}

export interface BotSettings {
  // Execution Mode
  executionMode: 'paper' | 'shadow' | 'live';

  // Auto-Trade Settings
  autoTradeEnabled: boolean;
  autoTradeMinConfidence: number; // Default: 0.80 (80%)
  fullAutoMode: boolean; // Option C: Alle Trades automatisch

  // Strategy Toggles
  arbitrageEnabled: boolean;
  lateEntryEnabled: boolean;
  timeDelayEnabled: boolean;

  // Limits
  maxTradeSize: number;
  maxDailyVolume: number;
  maxDailyLoss: number;

  // Notifications
  notifyOnAutoTrade: boolean;
  notifyOnManualSignal: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;

  // Misc
  germanyOnly: boolean;

  // Timestamps
  lastUpdated: Date;
}

// ═══════════════════════════════════════════════════════════════
//                     DEFAULT VALUES
// ═══════════════════════════════════════════════════════════════

const DEFAULT_SETTINGS: BotSettings = {
  executionMode: 'paper',
  autoTradeEnabled: true,
  autoTradeMinConfidence: 0.80,
  fullAutoMode: false,

  arbitrageEnabled: false,
  lateEntryEnabled: false,
  timeDelayEnabled: true,

  maxTradeSize: 50,
  maxDailyVolume: 500,
  maxDailyLoss: 100,

  notifyOnAutoTrade: true,
  notifyOnManualSignal: true,
  quietHoursEnabled: false,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',

  germanyOnly: true,

  lastUpdated: new Date(),
};

const DEFAULT_STATS: PerformanceStats = {
  totalTrades: 0,
  paperTrades: 0,
  liveTrades: 0,

  pending: 0,
  filled: 0,
  won: 0,
  lost: 0,
  expired: 0,

  totalVolume: 0,
  totalExpectedProfit: 0,
  totalActualProfit: 0,

  winRate: 0,
  avgConfidence: 0,
  avgEdge: 0,
  roi: 0,

  byStrategy: {
    arbitrage: { trades: 0, volume: 0, profit: 0, winRate: 0 },
    lateEntry: { trades: 0, volume: 0, profit: 0, winRate: 0 },
    timeDelay: { trades: 0, volume: 0, profit: 0, winRate: 0 },
    manual: { trades: 0, volume: 0, profit: 0, winRate: 0 },
  },

  today: { trades: 0, volume: 0, profit: 0 },
  thisWeek: { trades: 0, volume: 0, profit: 0 },

  lastUpdated: new Date(),
};

// ═══════════════════════════════════════════════════════════════
//                     PERFORMANCE TRACKER
// ═══════════════════════════════════════════════════════════════

export class PerformanceTracker extends EventEmitter {
  private dataDir: string;
  private settingsPath: string;
  private tradesPath: string;
  private statsPath: string;

  private settings: BotSettings;
  private trades: TrackedTrade[] = [];
  private stats: PerformanceStats;

  constructor(dataDir = './data') {
    super();
    this.dataDir = dataDir;
    this.settingsPath = path.join(dataDir, 'settings.json');
    this.tradesPath = path.join(dataDir, 'trades.json');
    this.statsPath = path.join(dataDir, 'stats.json');

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Load persisted data
    this.settings = this.loadSettings();
    this.trades = this.loadTrades();
    this.stats = this.loadStats();

    logger.info('[TRACKER] Performance Tracker initialisiert');
    logger.info(`[TRACKER] Mode: ${this.settings.executionMode.toUpperCase()} | Auto-Trade: ${this.settings.autoTradeEnabled ? 'AN' : 'AUS'} | Min Confidence: ${(this.settings.autoTradeMinConfidence * 100).toFixed(0)}%`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                     SETTINGS MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  private loadSettings(): BotSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'));
        return { ...DEFAULT_SETTINGS, ...data, lastUpdated: new Date(data.lastUpdated) };
      }
    } catch (err) {
      logger.warn(`[TRACKER] Fehler beim Laden der Settings: ${(err as Error).message}`);
    }
    return { ...DEFAULT_SETTINGS };
  }

  private saveSettings(): void {
    try {
      this.settings.lastUpdated = new Date();
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      logger.error(`[TRACKER] Fehler beim Speichern der Settings: ${(err as Error).message}`);
    }
  }

  getSettings(): BotSettings {
    return { ...this.settings };
  }

  updateSettings(updates: Partial<BotSettings>): BotSettings {
    this.settings = { ...this.settings, ...updates };
    this.saveSettings();
    this.emit('settings_changed', this.settings);
    logger.info(`[TRACKER] Settings aktualisiert: ${JSON.stringify(updates)}`);
    return this.settings;
  }

  // Convenience Methods
  isPaperMode(): boolean {
    return this.settings.executionMode === 'paper';
  }

  isLiveMode(): boolean {
    return this.settings.executionMode === 'live';
  }

  shouldAutoTrade(confidence: number): boolean {
    if (!this.settings.autoTradeEnabled) return false;
    if (this.settings.fullAutoMode) return true; // Option C
    return confidence >= this.settings.autoTradeMinConfidence; // Option B
  }

  // ═══════════════════════════════════════════════════════════════
  //                     TRADE TRACKING
  // ═══════════════════════════════════════════════════════════════

  private loadTrades(): TrackedTrade[] {
    try {
      if (fs.existsSync(this.tradesPath)) {
        const data = JSON.parse(fs.readFileSync(this.tradesPath, 'utf-8'));
        return data.map((t: TrackedTrade) => ({
          ...t,
          createdAt: new Date(t.createdAt),
          filledAt: t.filledAt ? new Date(t.filledAt) : undefined,
          resolvedAt: t.resolvedAt ? new Date(t.resolvedAt) : undefined,
        }));
      }
    } catch (err) {
      logger.warn(`[TRACKER] Fehler beim Laden der Trades: ${(err as Error).message}`);
    }
    return [];
  }

  private saveTrades(): void {
    try {
      // Keep only last 1000 trades to prevent file bloat
      const tradesToSave = this.trades.slice(-1000);
      fs.writeFileSync(this.tradesPath, JSON.stringify(tradesToSave, null, 2));
    } catch (err) {
      logger.error(`[TRACKER] Fehler beim Speichern der Trades: ${(err as Error).message}`);
    }
  }

  recordTrade(trade: Omit<TrackedTrade, 'id' | 'createdAt' | 'isPaper'>): TrackedTrade {
    const newTrade: TrackedTrade = {
      ...trade,
      id: `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date(),
      isPaper: this.isPaperMode(),
    };

    this.trades.push(newTrade);
    this.saveTrades();
    this.updateStats();

    this.emit('trade_recorded', newTrade);

    logger.info(
      `[TRACKER] Trade recorded: ${newTrade.strategy} | ${newTrade.direction.toUpperCase()} | ` +
      `$${newTrade.size.toFixed(2)} | ${newTrade.isPaper ? 'PAPER' : 'LIVE'} | ` +
      `${newTrade.executionType.toUpperCase()}`
    );

    return newTrade;
  }

  updateTrade(tradeId: string, updates: Partial<TrackedTrade>): TrackedTrade | null {
    const index = this.trades.findIndex(t => t.id === tradeId);
    if (index === -1) return null;

    this.trades[index] = { ...this.trades[index], ...updates };
    this.saveTrades();
    this.updateStats();

    this.emit('trade_updated', this.trades[index]);
    return this.trades[index];
  }

  resolveTrade(tradeId: string, won: boolean, exitPrice: number): TrackedTrade | null {
    const trade = this.trades.find(t => t.id === tradeId);
    if (!trade) return null;

    const actualProfit = won
      ? (1 - trade.entryPrice) * trade.size  // Won: Get $1 per share
      : -trade.entryPrice * trade.size;       // Lost: Lose entry cost

    return this.updateTrade(tradeId, {
      status: won ? 'won' : 'lost',
      exitPrice,
      actualProfit,
      resolvedAt: new Date(),
    });
  }

  getTrades(limit = 50, offset = 0): TrackedTrade[] {
    const reversed = [...this.trades].reverse();
    return reversed.slice(offset, offset + limit);
  }

  getTradesByStrategy(strategy: TradeStrategy, limit = 50): TrackedTrade[] {
    return this.trades.filter(t => t.strategy === strategy).slice(-limit).reverse();
  }

  getPendingTrades(): TrackedTrade[] {
    return this.trades.filter(t => t.status === 'pending' || t.status === 'filled');
  }

  // ═══════════════════════════════════════════════════════════════
  //                     STATS CALCULATION
  // ═══════════════════════════════════════════════════════════════

  private loadStats(): PerformanceStats {
    try {
      if (fs.existsSync(this.statsPath)) {
        const data = JSON.parse(fs.readFileSync(this.statsPath, 'utf-8'));
        return {
          ...DEFAULT_STATS,
          ...data,
          firstTradeAt: data.firstTradeAt ? new Date(data.firstTradeAt) : undefined,
          lastTradeAt: data.lastTradeAt ? new Date(data.lastTradeAt) : undefined,
          lastUpdated: new Date(data.lastUpdated),
        };
      }
    } catch (err) {
      logger.warn(`[TRACKER] Fehler beim Laden der Stats: ${(err as Error).message}`);
    }
    return { ...DEFAULT_STATS };
  }

  private saveStats(): void {
    try {
      fs.writeFileSync(this.statsPath, JSON.stringify(this.stats, null, 2));
    } catch (err) {
      logger.error(`[TRACKER] Fehler beim Speichern der Stats: ${(err as Error).message}`);
    }
  }

  private updateStats(): void {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());

    // Reset stats
    this.stats = { ...DEFAULT_STATS };

    // Calculate from trades
    for (const trade of this.trades) {
      this.stats.totalTrades++;

      if (trade.isPaper) this.stats.paperTrades++;
      else this.stats.liveTrades++;

      // By status
      this.stats[trade.status]++;

      // Financials
      this.stats.totalVolume += trade.size;
      this.stats.totalExpectedProfit += trade.expectedProfit;
      if (trade.actualProfit !== undefined) {
        this.stats.totalActualProfit += trade.actualProfit;
      }

      // By strategy
      const stratStats = this.stats.byStrategy[trade.strategy];
      stratStats.trades++;
      stratStats.volume += trade.size;
      if (trade.actualProfit !== undefined) {
        stratStats.profit += trade.actualProfit;
      }

      // Today
      if (trade.createdAt >= todayStart) {
        this.stats.today.trades++;
        this.stats.today.volume += trade.size;
        if (trade.actualProfit !== undefined) {
          this.stats.today.profit += trade.actualProfit;
        }
      }

      // This week
      if (trade.createdAt >= weekStart) {
        this.stats.thisWeek.trades++;
        this.stats.thisWeek.volume += trade.size;
        if (trade.actualProfit !== undefined) {
          this.stats.thisWeek.profit += trade.actualProfit;
        }
      }

      // Timestamps
      if (!this.stats.firstTradeAt || trade.createdAt < this.stats.firstTradeAt) {
        this.stats.firstTradeAt = trade.createdAt;
      }
      if (!this.stats.lastTradeAt || trade.createdAt > this.stats.lastTradeAt) {
        this.stats.lastTradeAt = trade.createdAt;
      }
    }

    // Calculate rates
    const resolvedTrades = this.stats.won + this.stats.lost;
    this.stats.winRate = resolvedTrades > 0 ? this.stats.won / resolvedTrades : 0;

    if (this.stats.totalTrades > 0) {
      const totalConfidence = this.trades.reduce((sum, t) => sum + t.confidence, 0);
      this.stats.avgConfidence = totalConfidence / this.stats.totalTrades;

      const totalEdge = this.trades.reduce((sum, t) => sum + t.expectedProfit / t.size, 0);
      this.stats.avgEdge = totalEdge / this.stats.totalTrades;
    }

    this.stats.roi = this.stats.totalVolume > 0
      ? (this.stats.totalActualProfit / this.stats.totalVolume) * 100
      : 0;

    // Strategy win rates
    for (const strategy of Object.keys(this.stats.byStrategy) as TradeStrategy[]) {
      const stratTrades = this.trades.filter(t => t.strategy === strategy);
      const stratResolved = stratTrades.filter(t => t.status === 'won' || t.status === 'lost');
      const stratWins = stratTrades.filter(t => t.status === 'won');
      this.stats.byStrategy[strategy].winRate = stratResolved.length > 0
        ? stratWins.length / stratResolved.length
        : 0;
    }

    this.stats.lastUpdated = now;
    this.saveStats();
  }

  getStats(): PerformanceStats {
    return { ...this.stats };
  }

  // ═══════════════════════════════════════════════════════════════
  //                     FORMATTED OUTPUT
  // ═══════════════════════════════════════════════════════════════

  getStatsFormatted(): string {
    const s = this.stats;
    const settings = this.settings;

    const modeEmoji = settings.executionMode === 'live' ? '🚀' : settings.executionMode === 'shadow' ? '👻' : '📝';
    const autoEmoji = settings.autoTradeEnabled ? '🤖' : '⏸️';

    return `
╔═══════════════════════════════════════╗
║     PERFORMANCE DASHBOARD V4.0        ║
╠═══════════════════════════════════════╣
║ ${modeEmoji} Mode: ${settings.executionMode.toUpperCase().padEnd(8)} ${autoEmoji} Auto: ${settings.autoTradeEnabled ? 'AN' : 'AUS'}    ║
║ Min Confidence: ${(settings.autoTradeMinConfidence * 100).toFixed(0)}%               ║
╠═══════════════════════════════════════╣
║ TRADES                                ║
├───────────────────────────────────────┤
║ Total:    ${String(s.totalTrades).padEnd(6)} (${s.paperTrades} Paper / ${s.liveTrades} Live) ║
║ Pending:  ${String(s.pending).padEnd(6)}                     ║
║ Won:      ${String(s.won).padEnd(6)} Lost: ${String(s.lost).padEnd(6)}       ║
║ Win Rate: ${(s.winRate * 100).toFixed(1)}%                     ║
╠═══════════════════════════════════════╣
║ FINANCIALS                            ║
├───────────────────────────────────────┤
║ Volume:   $${s.totalVolume.toFixed(2).padEnd(10)}              ║
║ Expected: $${s.totalExpectedProfit.toFixed(2).padEnd(10)}              ║
║ Actual:   $${s.totalActualProfit.toFixed(2).padEnd(10)}              ║
║ ROI:      ${s.roi.toFixed(2)}%                       ║
╠═══════════════════════════════════════╣
║ TODAY                                 ║
├───────────────────────────────────────┤
║ Trades: ${s.today.trades}  Volume: $${s.today.volume.toFixed(0)}  P/L: $${s.today.profit.toFixed(2)} ║
╠═══════════════════════════════════════╣
║ BY STRATEGY                           ║
├───────────────────────────────────────┤
║ Arbitrage:  ${String(s.byStrategy.arbitrage.trades).padEnd(4)} | $${s.byStrategy.arbitrage.profit.toFixed(2).padEnd(8)} ║
║ Late-Entry: ${String(s.byStrategy.lateEntry.trades).padEnd(4)} | $${s.byStrategy.lateEntry.profit.toFixed(2).padEnd(8)} ║
║ Time-Delay: ${String(s.byStrategy.timeDelay.trades).padEnd(4)} | $${s.byStrategy.timeDelay.profit.toFixed(2).padEnd(8)} ║
╚═══════════════════════════════════════╝`;
  }
}

// ═══════════════════════════════════════════════════════════════
//                     SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

export const performanceTracker = new PerformanceTracker();
export default performanceTracker;

// Re-export resolution service
export * from './resolution.js';
