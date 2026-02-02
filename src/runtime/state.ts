/**
 * Runtime State Manager
 * Zentrale Verwaltung aller zur Laufzeit änderbaren Systemzustände
 *
 * WICHTIG: Dieser State ist das "Gehirn" des Systems.
 * Alle Kontrollen (Web, Telegram) ändern hier den Zustand.
 */

import { EventEmitter } from 'events';
import { ExecutionMode, AlphaEngine } from '../types/index.js';
import { config, WALLET_PRIVATE_KEY, WALLET_ADDRESS } from '../utils/config.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
//                         INTERFACES
// ═══════════════════════════════════════════════════════════════

export interface RuntimeState {
  // Execution Control
  executionMode: ExecutionMode;
  alphaEngine: AlphaEngine;

  // Risk Control
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  killSwitchActivatedAt: Date | null;

  // Daily Risk Tracking
  dailyPnL: number;
  dailyTrades: number;
  dailyWins: number;
  dailyLosses: number;

  // Position Tracking
  openPositions: number;
  positionsPerMarket: Map<string, number>;
  totalExposure: number;

  // Settings (runtime-änderbar)
  maxBetUsdc: number;
  riskPerTradePercent: number;
  minEdge: number;
  minAlpha: number;
  minVolumeUsd: number;
  maxDailyLoss: number;
  maxPositions: number;
  maxPerMarket: number;

  // System Health
  lastScanAt: Date | null;
  lastSignalAt: Date | null;
  lastTradeAt: Date | null;
  lastResetAt: Date;

  // Pipeline Health
  pipelineHealth: {
    polymarket: { healthy: boolean; lastSuccess: Date | null; errorCount: number };
    rss: { healthy: boolean; lastSuccess: Date | null; errorCount: number };
    dawum: { healthy: boolean; lastSuccess: Date | null; errorCount: number };
    telegram: { healthy: boolean; lastSuccess: Date | null; errorCount: number };
  };
}

export interface StateChangeEvent {
  field: keyof RuntimeState | string;
  oldValue: unknown;
  newValue: unknown;
  source: 'web' | 'telegram' | 'system' | 'api';
  timestamp: Date;
}

// ═══════════════════════════════════════════════════════════════
//                      RUNTIME STATE CLASS
// ═══════════════════════════════════════════════════════════════

class RuntimeStateManager extends EventEmitter {
  private state: RuntimeState;

  constructor() {
    super();

    // Initialisiere mit Config-Werten
    this.state = {
      // Execution Control
      executionMode: config.executionMode,
      alphaEngine: config.alphaEngine,

      // Risk Control
      killSwitchActive: false,
      killSwitchReason: null,
      killSwitchActivatedAt: null,

      // Daily Risk Tracking
      dailyPnL: 0,
      dailyTrades: 0,
      dailyWins: 0,
      dailyLosses: 0,

      // Position Tracking
      openPositions: 0,
      positionsPerMarket: new Map(),
      totalExposure: 0,

      // Settings
      maxBetUsdc: config.trading.maxBetUsdc,
      riskPerTradePercent: config.trading.riskPerTradePercent,
      minEdge: config.germany.minEdge * 100, // Als Prozent
      minAlpha: config.trading.minAlphaForTrade * 100, // Als Prozent
      minVolumeUsd: config.scanner.minVolumeUsd,
      maxDailyLoss: 100, // Default
      maxPositions: 10,
      maxPerMarket: 50,

      // System Health
      lastScanAt: null,
      lastSignalAt: null,
      lastTradeAt: null,
      lastResetAt: new Date(),

      // Pipeline Health
      pipelineHealth: {
        polymarket: { healthy: true, lastSuccess: null, errorCount: 0 },
        rss: { healthy: true, lastSuccess: null, errorCount: 0 },
        dawum: { healthy: true, lastSuccess: null, errorCount: 0 },
        telegram: { healthy: true, lastSuccess: null, errorCount: 0 },
      },
    };

    // Täglicher Reset um Mitternacht
    this.scheduleDailyReset();
  }

  // ═══════════════════════════════════════════════════════════════
  //                      GETTERS
  // ═══════════════════════════════════════════════════════════════

  getState(): RuntimeState {
    return {
      ...this.state,
      positionsPerMarket: new Map(this.state.positionsPerMarket),
    };
  }

  getExecutionMode(): ExecutionMode {
    return this.state.executionMode;
  }

  isKillSwitchActive(): boolean {
    return this.state.killSwitchActive;
  }

  canTrade(): { allowed: boolean; reason: string } {
    // Kill-Switch prüfen
    if (this.state.killSwitchActive) {
      return {
        allowed: false,
        reason: `Kill-Switch aktiv: ${this.state.killSwitchReason || 'Manuell aktiviert'}`,
      };
    }

    // Mode prüfen
    if (this.state.executionMode === 'paper') {
      return {
        allowed: true,
        reason: 'Paper Mode - Trades werden nur simuliert',
      };
    }

    // Live Mode: Wallet prüfen
    if (this.state.executionMode === 'live') {
      if (!WALLET_PRIVATE_KEY || !WALLET_ADDRESS) {
        return {
          allowed: false,
          reason: 'Live Mode verweigert: Wallet nicht konfiguriert',
        };
      }
    }

    // Daily Loss prüfen
    if (this.state.dailyPnL <= -this.state.maxDailyLoss) {
      return {
        allowed: false,
        reason: `Tägliches Verlust-Limit erreicht: ${this.state.dailyPnL.toFixed(2)} USDC`,
      };
    }

    // Max Positions prüfen
    if (this.state.openPositions >= this.state.maxPositions) {
      return {
        allowed: false,
        reason: `Maximale Positionen erreicht: ${this.state.openPositions}/${this.state.maxPositions}`,
      };
    }

    return { allowed: true, reason: 'OK' };
  }

  // ═══════════════════════════════════════════════════════════════
  //                      SETTERS
  // ═══════════════════════════════════════════════════════════════

  private emitChange(field: string, oldValue: unknown, newValue: unknown, source: StateChangeEvent['source']): void {
    const event: StateChangeEvent = {
      field,
      oldValue,
      newValue,
      source,
      timestamp: new Date(),
    };
    this.emit('stateChange', event);
    logger.info(`[RUNTIME] ${field} geändert: ${JSON.stringify(oldValue)} → ${JSON.stringify(newValue)} (via ${source})`);
  }

  // ─────────────────────────────────────────────────────────────
  // EXECUTION MODE
  // ─────────────────────────────────────────────────────────────

  setExecutionMode(mode: ExecutionMode, source: StateChangeEvent['source'] = 'api'): { success: boolean; message: string } {
    // Validierung für Live-Mode
    if (mode === 'live') {
      if (!WALLET_PRIVATE_KEY || !WALLET_ADDRESS) {
        return {
          success: false,
          message: 'Live Mode verweigert: Wallet nicht konfiguriert. Setze WALLET_PRIVATE_KEY und WALLET_ADDRESS.',
        };
      }
    }

    const oldMode = this.state.executionMode;
    if (oldMode === mode) {
      return { success: true, message: `Bereits im ${mode} Mode` };
    }

    this.state.executionMode = mode;
    this.emitChange('executionMode', oldMode, mode, source);

    return {
      success: true,
      message: `Execution Mode gewechselt: ${oldMode} → ${mode}`,
    };
  }

  setAlphaEngine(engine: AlphaEngine, source: StateChangeEvent['source'] = 'api'): void {
    const oldEngine = this.state.alphaEngine;
    this.state.alphaEngine = engine;
    this.emitChange('alphaEngine', oldEngine, engine, source);
  }

  // ─────────────────────────────────────────────────────────────
  // KILL-SWITCH
  // ─────────────────────────────────────────────────────────────

  activateKillSwitch(reason: string, source: StateChangeEvent['source'] = 'api'): void {
    if (this.state.killSwitchActive) return;

    this.state.killSwitchActive = true;
    this.state.killSwitchReason = reason;
    this.state.killSwitchActivatedAt = new Date();

    this.emitChange('killSwitchActive', false, true, source);

    logger.warn(`[KILL-SWITCH] AKTIVIERT: ${reason} (via ${source})`);
    this.emit('killSwitchActivated', { reason, source });
  }

  deactivateKillSwitch(source: StateChangeEvent['source'] = 'api'): void {
    if (!this.state.killSwitchActive) return;

    const reason = this.state.killSwitchReason;
    this.state.killSwitchActive = false;
    this.state.killSwitchReason = null;
    this.state.killSwitchActivatedAt = null;

    this.emitChange('killSwitchActive', true, false, source);

    logger.info(`[KILL-SWITCH] Deaktiviert (via ${source})`);
    this.emit('killSwitchDeactivated', { previousReason: reason, source });
  }

  toggleKillSwitch(source: StateChangeEvent['source'] = 'api'): boolean {
    if (this.state.killSwitchActive) {
      this.deactivateKillSwitch(source);
      return false;
    } else {
      this.activateKillSwitch('Manuell aktiviert', source);
      return true;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RISK TRACKING
  // ─────────────────────────────────────────────────────────────

  recordTrade(pnl: number, marketId: string, sizeUsdc: number): void {
    // PnL aktualisieren
    this.state.dailyPnL += pnl;
    this.state.dailyTrades += 1;

    if (pnl > 0) {
      this.state.dailyWins += 1;
    } else if (pnl < 0) {
      this.state.dailyLosses += 1;
    }

    // Position Tracking
    const currentExposure = this.state.positionsPerMarket.get(marketId) || 0;
    this.state.positionsPerMarket.set(marketId, currentExposure + sizeUsdc);
    this.state.totalExposure += sizeUsdc;

    this.state.lastTradeAt = new Date();

    // Auto Kill-Switch bei großem Verlust
    if (this.state.dailyPnL <= -this.state.maxDailyLoss) {
      this.activateKillSwitch(
        `Tägliches Verlust-Limit erreicht: ${this.state.dailyPnL.toFixed(2)} USDC`,
        'system'
      );
    }

    this.emit('tradeRecorded', { pnl, marketId, sizeUsdc, dailyPnL: this.state.dailyPnL });
  }

  closePosition(marketId: string): void {
    const exposure = this.state.positionsPerMarket.get(marketId) || 0;
    this.state.positionsPerMarket.delete(marketId);
    this.state.totalExposure -= exposure;
    this.state.openPositions = Math.max(0, this.state.openPositions - 1);
  }

  openPosition(marketId: string, sizeUsdc: number): void {
    const current = this.state.positionsPerMarket.get(marketId) || 0;
    this.state.positionsPerMarket.set(marketId, current + sizeUsdc);
    this.state.openPositions += 1;
    this.state.totalExposure += sizeUsdc;
  }

  // ─────────────────────────────────────────────────────────────
  // SETTINGS
  // ─────────────────────────────────────────────────────────────

  updateSettings(updates: Partial<Pick<RuntimeState,
    'maxBetUsdc' | 'riskPerTradePercent' | 'minEdge' | 'minAlpha' | 'minVolumeUsd' |
    'maxDailyLoss' | 'maxPositions' | 'maxPerMarket'
  >>, source: StateChangeEvent['source'] = 'api'): void {
    type SettingsKey = 'maxBetUsdc' | 'riskPerTradePercent' | 'minEdge' | 'minAlpha' | 'minVolumeUsd' | 'maxDailyLoss' | 'maxPositions' | 'maxPerMarket';
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && key in this.state) {
        const typedKey = key as SettingsKey;
        const oldValue = this.state[typedKey];
        this.state[typedKey] = value;
        this.emitChange(key, oldValue, value, source);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PIPELINE HEALTH
  // ─────────────────────────────────────────────────────────────

  recordPipelineSuccess(pipeline: keyof RuntimeState['pipelineHealth']): void {
    this.state.pipelineHealth[pipeline].healthy = true;
    this.state.pipelineHealth[pipeline].lastSuccess = new Date();
    this.state.pipelineHealth[pipeline].errorCount = 0;
  }

  recordPipelineError(pipeline: keyof RuntimeState['pipelineHealth']): void {
    this.state.pipelineHealth[pipeline].errorCount += 1;

    // Nach 3 Fehlern als unhealthy markieren
    if (this.state.pipelineHealth[pipeline].errorCount >= 3) {
      this.state.pipelineHealth[pipeline].healthy = false;
      this.emit('pipelineUnhealthy', { pipeline, errorCount: this.state.pipelineHealth[pipeline].errorCount });
    }
  }

  recordScan(): void {
    this.state.lastScanAt = new Date();
  }

  recordSignal(): void {
    this.state.lastSignalAt = new Date();
  }

  // ─────────────────────────────────────────────────────────────
  // DAILY RESET
  // ─────────────────────────────────────────────────────────────

  resetDaily(): void {
    const previousPnL = this.state.dailyPnL;
    const previousTrades = this.state.dailyTrades;

    this.state.dailyPnL = 0;
    this.state.dailyTrades = 0;
    this.state.dailyWins = 0;
    this.state.dailyLosses = 0;
    this.state.lastResetAt = new Date();

    // Kill-Switch NICHT automatisch deaktivieren - das muss manuell passieren
    // this.state.killSwitchActive = false;

    logger.info(`[RUNTIME] Täglicher Reset: PnL ${previousPnL.toFixed(2)} → 0, Trades ${previousTrades} → 0`);
    this.emit('dailyReset', { previousPnL, previousTrades });
  }

  private scheduleDailyReset(): void {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      this.resetDaily();
      // Nächsten Reset planen
      setInterval(() => this.resetDaily(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);

    logger.info(`[RUNTIME] Täglicher Reset geplant in ${Math.round(msUntilMidnight / 1000 / 60)} Minuten`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                      SERIALIZATION
  // ═══════════════════════════════════════════════════════════════

  toJSON(): Record<string, unknown> {
    const { positionsPerMarket, ...rest } = this.state;
    return {
      ...rest,
      positionsPerMarket: Object.fromEntries(positionsPerMarket),
    } as Record<string, unknown>;
  }

  getRiskDashboard(): {
    mode: ExecutionMode;
    killSwitch: { active: boolean; reason: string | null; since: Date | null };
    daily: { pnl: number; trades: number; wins: number; losses: number; winRate: number };
    positions: { open: number; max: number; totalExposure: number };
    limits: { dailyLossLimit: number; dailyLossRemaining: number; positionLimit: number };
    canTrade: { allowed: boolean; reason: string };
  } {
    const winRate = this.state.dailyTrades > 0
      ? (this.state.dailyWins / this.state.dailyTrades) * 100
      : 0;

    return {
      mode: this.state.executionMode,
      killSwitch: {
        active: this.state.killSwitchActive,
        reason: this.state.killSwitchReason,
        since: this.state.killSwitchActivatedAt,
      },
      daily: {
        pnl: this.state.dailyPnL,
        trades: this.state.dailyTrades,
        wins: this.state.dailyWins,
        losses: this.state.dailyLosses,
        winRate,
      },
      positions: {
        open: this.state.openPositions,
        max: this.state.maxPositions,
        totalExposure: this.state.totalExposure,
      },
      limits: {
        dailyLossLimit: this.state.maxDailyLoss,
        dailyLossRemaining: this.state.maxDailyLoss + this.state.dailyPnL,
        positionLimit: this.state.maxPositions - this.state.openPositions,
      },
      canTrade: this.canTrade(),
    };
  }
}

// Singleton Export
export const runtimeState = new RuntimeStateManager();
export default runtimeState;
