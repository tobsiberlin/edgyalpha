/**
 * Runtime State Manager
 * Zentrale Verwaltung aller zur Laufzeit änderbaren Systemzustände
 *
 * WICHTIG: Dieser State ist das "Gehirn" des Systems.
 * Alle Kontrollen (Web, Telegram) ändern hier den Zustand.
 *
 * PERSISTENZ: Risk State wird in SQLite gespeichert und überlebt Server-Restarts.
 * Kill-Switch, Daily PnL, Positions - alles bleibt erhalten.
 */

import { EventEmitter } from 'events';
import { ExecutionMode, AlphaEngine } from '../types/index.js';
import { config, WALLET_PRIVATE_KEY, WALLET_ADDRESS } from '../utils/config.js';
import logger from '../utils/logger.js';
import {
  loadRiskState,
  saveRiskState,
  writeAuditLog,
  type PersistedRiskState,
  type AuditLogEntry,
} from '../storage/repositories/riskState.js';
import { getConsecutiveFailures } from '../alpha/riskGates.js';

// ═══════════════════════════════════════════════════════════════
//                         INTERFACES
// ═══════════════════════════════════════════════════════════════

// Trade-Eintrag für Rolling Window
export interface TradeEntry {
  timestamp: Date;
  pnl: number;
  marketId: string;
  sizeUsdc: number;
}

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

  // INTRADAY DRAWDOWN TRACKING (NEU)
  recentTrades: TradeEntry[];           // Rolling Window letzte N Trades
  intradayHighWaterMark: number;        // Höchster PnL des Tages
  intradayDrawdown: number;             // Aktueller Drawdown vom High
  consecutiveLosses: number;            // Aufeinanderfolgende Verluste
  cooldownUntil: Date | null;           // Cooldown aktiv bis
  cooldownReason: string | null;        // Grund für Cooldown

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
  private persistedState: PersistedRiskState | null = null;

  constructor() {
    super();

    // Lade persistierten Risk State aus SQLite
    let persisted: PersistedRiskState | null = null;
    try {
      persisted = loadRiskState();
      this.persistedState = persisted;
      logger.info('[RUNTIME] Risk State aus SQLite geladen');
      logger.info(`[RUNTIME] Mode: ${persisted.executionMode}, Kill-Switch: ${persisted.killSwitchActive}, Daily PnL: ${persisted.dailyPnL.toFixed(2)}`);
    } catch (err) {
      logger.warn(`[RUNTIME] SQLite Risk State konnte nicht geladen werden: ${(err as Error).message}`);
      logger.warn('[RUNTIME] Starte mit Default-Werten');
    }

    // Initialisiere mit Config-Werten, aber ÜBERSCHREIBE mit persistierten Werten
    this.state = {
      // Execution Control - aus DB oder Config
      executionMode: persisted?.executionMode || config.executionMode,
      alphaEngine: config.alphaEngine,

      // Risk Control - KRITISCH: aus DB laden!
      killSwitchActive: persisted?.killSwitchActive ?? false,
      killSwitchReason: persisted?.killSwitchReason ?? null,
      killSwitchActivatedAt: persisted?.killSwitchActivatedAt ?? null,

      // Daily Risk Tracking - aus DB laden!
      dailyPnL: persisted?.dailyPnL ?? 0,
      dailyTrades: persisted?.dailyTrades ?? 0,
      dailyWins: persisted?.dailyWins ?? 0,
      dailyLosses: persisted?.dailyLosses ?? 0,

      // Intraday Drawdown Tracking - immer frisch starten
      recentTrades: [],
      intradayHighWaterMark: persisted?.dailyPnL ?? 0,
      intradayDrawdown: 0,
      consecutiveLosses: 0,
      cooldownUntil: null,
      cooldownReason: null,

      // Position Tracking - aus DB laden!
      openPositions: persisted ? Object.keys(persisted.positions).length : 0,
      positionsPerMarket: persisted
        ? new Map(Object.entries(persisted.positions).map(([k, v]) => [k, v.size]))
        : new Map(),
      totalExposure: persisted?.totalExposure ?? 0,

      // Settings - aus DB oder Config
      maxBetUsdc: persisted?.settings?.maxBetUsdc ?? config.trading.maxBetUsdc,
      riskPerTradePercent: persisted?.settings?.riskPerTradePercent ?? config.trading.riskPerTradePercent,
      minEdge: persisted?.settings?.minEdge ?? config.germany.minEdge * 100,
      minAlpha: persisted?.settings?.minAlpha ?? config.trading.minAlphaForTrade * 100,
      minVolumeUsd: persisted?.settings?.minVolumeUsd ?? config.scanner.minVolumeUsd,
      maxDailyLoss: persisted?.settings?.maxDailyLoss ?? 100,
      maxPositions: persisted?.settings?.maxPositions ?? 10,
      maxPerMarket: persisted?.settings?.maxPerMarket ?? 50,

      // System Health - immer frisch starten
      lastScanAt: null,
      lastSignalAt: null,
      lastTradeAt: null,
      lastResetAt: new Date(),

      // Pipeline Health - starte mit UNKNOWN (nicht healthy ohne Daten!)
      pipelineHealth: {
        polymarket: { healthy: false, lastSuccess: null, errorCount: 0 },
        rss: { healthy: false, lastSuccess: null, errorCount: 0 },
        dawum: { healthy: false, lastSuccess: null, errorCount: 0 },
        telegram: { healthy: false, lastSuccess: null, errorCount: 0 },
      },
    };

    // Log wenn Kill-Switch aktiv aus DB geladen wurde
    if (this.state.killSwitchActive) {
      logger.warn(`[RUNTIME] ⚠️ KILL-SWITCH WAR AKTIV: ${this.state.killSwitchReason}`);
      logger.warn(`[RUNTIME] Aktiviert seit: ${this.state.killSwitchActivatedAt?.toISOString()}`);
    }

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

    // INTRADAY DRAWDOWN prüfen (50% des Daily Limits)
    const intradayDrawdownLimit = this.state.maxDailyLoss * 0.5;
    if (this.state.intradayDrawdown >= intradayDrawdownLimit) {
      return {
        allowed: false,
        reason: `Intraday Drawdown-Limit erreicht: ${this.state.intradayDrawdown.toFixed(2)} USDC (Max: ${intradayDrawdownLimit.toFixed(0)})`,
      };
    }

    // COOLDOWN prüfen
    if (this.state.cooldownUntil && this.state.cooldownUntil > new Date()) {
      const minutesLeft = Math.ceil((this.state.cooldownUntil.getTime() - Date.now()) / 60000);
      return {
        allowed: false,
        reason: `Cooldown aktiv: ${this.state.cooldownReason} (noch ${minutesLeft} Min)`,
      };
    }

    // CONSECUTIVE LOSSES prüfen (Max 3 in Folge = 15 Min Pause)
    if (this.state.consecutiveLosses >= 3) {
      return {
        allowed: false,
        reason: `Verlustserie: ${this.state.consecutiveLosses} Losses in Folge - warte auf Reset oder manuellen Resume`,
      };
    }

    // ROLLING WINDOW: Prüfe Verluste in letzten 15 Minuten
    const recentLosses = this.getRecentLosses(15);
    const recentLossTotal = recentLosses.reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    const rapidLossLimit = this.state.maxDailyLoss * 0.3; // 30% in 15 Min = zu schnell
    if (recentLossTotal >= rapidLossLimit) {
      return {
        allowed: false,
        reason: `Schnelle Verlustserie: ${recentLossTotal.toFixed(2)} USDC in 15 Min (Max: ${rapidLossLimit.toFixed(0)})`,
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

  // Hilfsfunktion: Verluste der letzten N Minuten
  private getRecentLosses(minutes: number): TradeEntry[] {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    return this.state.recentTrades.filter(
      t => t.timestamp >= cutoff && t.pnl < 0
    );
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

    // PERSISTIEREN in SQLite
    this.persistRiskState();

    // AUDIT LOG
    this.writeAudit({
      eventType: 'mode_change',
      actor: source,
      action: `Execution Mode gewechselt: ${oldMode} → ${mode}`,
      riskStateBefore: { executionMode: oldMode as 'paper' | 'shadow' | 'live' },
      riskStateAfter: { executionMode: mode as 'paper' | 'shadow' | 'live' },
    });

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

    // PERSISTIEREN - KRITISCH: Kill-Switch muss Restart überleben!
    this.persistRiskState();

    // AUDIT LOG
    this.writeAudit({
      eventType: 'kill_switch',
      actor: source,
      action: `KILL-SWITCH AKTIVIERT: ${reason}`,
      riskStateBefore: { killSwitchActive: false },
      riskStateAfter: { killSwitchActive: true, killSwitchReason: reason },
    });
  }

  deactivateKillSwitch(source: StateChangeEvent['source'] = 'api'): void {
    if (!this.state.killSwitchActive) return;

    const previousReason = this.state.killSwitchReason;
    this.state.killSwitchActive = false;
    this.state.killSwitchReason = null;
    this.state.killSwitchActivatedAt = null;

    this.emitChange('killSwitchActive', true, false, source);

    logger.info(`[KILL-SWITCH] Deaktiviert (via ${source})`);
    this.emit('killSwitchDeactivated', { previousReason, source });

    // PERSISTIEREN
    this.persistRiskState();

    // AUDIT LOG
    this.writeAudit({
      eventType: 'kill_switch',
      actor: source,
      action: `KILL-SWITCH DEAKTIVIERT (vorheriger Grund: ${previousReason})`,
      riskStateBefore: { killSwitchActive: true, killSwitchReason: previousReason },
      riskStateAfter: { killSwitchActive: false },
    });
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
  // COOLDOWN MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  /**
   * Reset Cooldown manuell (via Telegram/Web)
   * Erlaubt Trading wieder nach Verlustserie
   */
  resetCooldown(source: StateChangeEvent['source'] = 'api'): void {
    if (!this.state.cooldownUntil && this.state.consecutiveLosses < 3) {
      logger.info('[RISK] Kein aktiver Cooldown zum Resetten');
      return;
    }

    const previousCooldown = this.state.cooldownReason;
    const previousLosses = this.state.consecutiveLosses;

    this.state.cooldownUntil = null;
    this.state.cooldownReason = null;
    this.state.consecutiveLosses = 0;

    logger.info(`[RISK] Cooldown manuell zurückgesetzt (via ${source})`);
    this.emit('cooldownReset', { source, previousCooldown, previousLosses });

    // AUDIT LOG
    this.writeAudit({
      eventType: 'cooldown_reset',
      actor: source,
      action: `Cooldown manuell zurückgesetzt (${previousCooldown}, ${previousLosses} Losses)`,
      details: { previousCooldown, previousLosses },
    });
  }

  /**
   * Gibt Cooldown-Status zurück
   */
  getCooldownStatus(): { active: boolean; reason: string | null; minutesLeft: number | null } {
    if (!this.state.cooldownUntil || this.state.cooldownUntil <= new Date()) {
      return { active: false, reason: null, minutesLeft: null };
    }

    const minutesLeft = Math.ceil((this.state.cooldownUntil.getTime() - Date.now()) / 60000);
    return {
      active: true,
      reason: this.state.cooldownReason,
      minutesLeft,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // RISK TRACKING
  // ─────────────────────────────────────────────────────────────

  recordTrade(pnl: number, marketId: string, sizeUsdc: number, signalId?: string): void {
    const previousPnL = this.state.dailyPnL;
    const previousTrades = this.state.dailyTrades;

    // PnL aktualisieren
    this.state.dailyPnL += pnl;
    this.state.dailyTrades += 1;

    if (pnl > 0) {
      this.state.dailyWins += 1;
      // Reset consecutive losses bei Win
      this.state.consecutiveLosses = 0;
    } else if (pnl < 0) {
      this.state.dailyLosses += 1;
      // Track consecutive losses
      this.state.consecutiveLosses += 1;
    }

    // ═══════════════════════════════════════════════════════════════
    // INTRADAY DRAWDOWN TRACKING
    // ═══════════════════════════════════════════════════════════════

    // Trade zur Rolling Window Historie hinzufügen
    const tradeEntry: TradeEntry = {
      timestamp: new Date(),
      pnl,
      marketId,
      sizeUsdc,
    };
    this.state.recentTrades.push(tradeEntry);

    // Rolling Window: Nur letzte 100 Trades behalten
    while (this.state.recentTrades.length > 100) {
      this.state.recentTrades.shift();
    }

    // High Water Mark aktualisieren
    if (this.state.dailyPnL > this.state.intradayHighWaterMark) {
      this.state.intradayHighWaterMark = this.state.dailyPnL;
      this.state.intradayDrawdown = 0;
    } else {
      // Drawdown berechnen
      this.state.intradayDrawdown = this.state.intradayHighWaterMark - this.state.dailyPnL;
    }

    // Auto-Cooldown bei 3 Consecutive Losses
    if (this.state.consecutiveLosses >= 3 && !this.state.cooldownUntil) {
      this.state.cooldownUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 Min
      this.state.cooldownReason = `${this.state.consecutiveLosses} Verluste in Folge`;
      logger.warn(`[RISK] Auto-Cooldown aktiviert: ${this.state.cooldownReason}`);
      this.emit('cooldownActivated', {
        reason: this.state.cooldownReason,
        until: this.state.cooldownUntil,
      });
    }

    // Position Tracking
    const currentExposure = this.state.positionsPerMarket.get(marketId) || 0;
    this.state.positionsPerMarket.set(marketId, currentExposure + sizeUsdc);
    this.state.totalExposure += sizeUsdc;

    this.state.lastTradeAt = new Date();

    // PERSISTIEREN - Jeder Trade wird gespeichert
    this.persistRiskState();

    // AUDIT LOG - Jeder Trade auditierbar
    this.writeAudit({
      eventType: 'trade',
      actor: 'system',
      action: `Trade ausgeführt: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC auf Markt ${marketId}`,
      marketId,
      signalId,
      pnlImpact: pnl,
      riskStateBefore: { dailyPnL: previousPnL, dailyTrades: previousTrades },
      riskStateAfter: {
        dailyPnL: this.state.dailyPnL,
        dailyTrades: this.state.dailyTrades,
        intradayDrawdown: this.state.intradayDrawdown,
        consecutiveLosses: this.state.consecutiveLosses,
      },
    });

    // ═══════════════════════════════════════════════════════════════
    // AUTO KILL-SWITCH CHECKS
    // ═══════════════════════════════════════════════════════════════

    // Daily Loss Limit
    if (this.state.dailyPnL <= -this.state.maxDailyLoss) {
      this.activateKillSwitch(
        `Tägliches Verlust-Limit erreicht: ${this.state.dailyPnL.toFixed(2)} USDC`,
        'system'
      );
    }

    // Intraday Drawdown Limit (50% des Daily Limits)
    const intradayDrawdownLimit = this.state.maxDailyLoss * 0.5;
    if (this.state.intradayDrawdown >= intradayDrawdownLimit && !this.state.killSwitchActive) {
      this.activateKillSwitch(
        `Intraday Drawdown-Limit: ${this.state.intradayDrawdown.toFixed(2)} USDC vom Tageshoch`,
        'system'
      );
    }

    this.emit('tradeRecorded', {
      pnl,
      marketId,
      sizeUsdc,
      dailyPnL: this.state.dailyPnL,
      intradayDrawdown: this.state.intradayDrawdown,
      consecutiveLosses: this.state.consecutiveLosses,
    });
  }

  closePosition(marketId: string): void {
    const exposure = this.state.positionsPerMarket.get(marketId) || 0;
    this.state.positionsPerMarket.delete(marketId);
    this.state.totalExposure -= exposure;
    this.state.openPositions = Math.max(0, this.state.openPositions - 1);

    // PERSISTIEREN
    this.persistRiskState();
  }

  openPosition(marketId: string, sizeUsdc: number, direction: 'yes' | 'no' = 'yes', entryPrice: number = 0): void {
    const current = this.state.positionsPerMarket.get(marketId) || 0;
    this.state.positionsPerMarket.set(marketId, current + sizeUsdc);
    this.state.openPositions += 1;
    this.state.totalExposure += sizeUsdc;

    // PERSISTIEREN mit vollständigen Position-Details
    this.persistRiskState(marketId, { size: sizeUsdc, entryPrice, direction });
  }

  /**
   * Synchronisiert Positionen von der Polymarket API
   * ERSETZT den kompletten Position State (kein Addieren!)
   * Wird beim Server-Start aufgerufen
   */
  syncPositionsFromApi(
    positionsPerMarket: Map<string, number>,
    totalExposure: number
  ): void {
    const previousOpen = this.state.openPositions;
    const previousExposure = this.state.totalExposure;

    // Komplett ersetzen, nicht addieren!
    this.state.positionsPerMarket = new Map(positionsPerMarket);
    this.state.openPositions = positionsPerMarket.size;
    this.state.totalExposure = totalExposure;

    logger.info(`[RUNTIME] Positionen synchronisiert:`, {
      vorher: { openPositions: previousOpen, totalExposure: previousExposure.toFixed(2) },
      nachher: { openPositions: this.state.openPositions, totalExposure: this.state.totalExposure.toFixed(2) },
    });

    // PERSISTIEREN
    this.persistRiskState();

    this.emit('positionsSynced', {
      openPositions: this.state.openPositions,
      totalExposure: this.state.totalExposure,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SETTINGS
  // ─────────────────────────────────────────────────────────────

  updateSettings(updates: Partial<Pick<RuntimeState,
    'maxBetUsdc' | 'riskPerTradePercent' | 'minEdge' | 'minAlpha' | 'minVolumeUsd' |
    'maxDailyLoss' | 'maxPositions' | 'maxPerMarket'
  >>, source: StateChangeEvent['source'] = 'api'): void {
    type SettingsKey = 'maxBetUsdc' | 'riskPerTradePercent' | 'minEdge' | 'minAlpha' | 'minVolumeUsd' | 'maxDailyLoss' | 'maxPositions' | 'maxPerMarket';
    const changes: Record<string, { old: number; new: number }> = {};

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && key in this.state) {
        const typedKey = key as SettingsKey;
        const oldValue = this.state[typedKey];
        this.state[typedKey] = value;
        this.emitChange(key, oldValue, value, source);
        changes[key] = { old: oldValue, new: value };
      }
    }

    // PERSISTIEREN
    this.persistRiskState();

    // AUDIT LOG
    if (Object.keys(changes).length > 0) {
      this.writeAudit({
        eventType: 'settings',
        actor: source,
        action: `Settings geändert: ${Object.entries(changes).map(([k, v]) => `${k}: ${v.old} → ${v.new}`).join(', ')}`,
        details: changes,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PIPELINE HEALTH
  // ─────────────────────────────────────────────────────────────

  recordPipelineSuccess(pipeline: keyof RuntimeState['pipelineHealth']): void {
    const now = new Date();
    this.state.pipelineHealth[pipeline].healthy = true;
    this.state.pipelineHealth[pipeline].lastSuccess = now;
    this.state.pipelineHealth[pipeline].errorCount = 0;
    logger.debug(`[PIPELINE] ${pipeline}: Success at ${now.toISOString()}`);
  }

  recordPipelineError(pipeline: keyof RuntimeState['pipelineHealth'], errorMessage?: string): void {
    this.state.pipelineHealth[pipeline].errorCount += 1;
    const errorCount = this.state.pipelineHealth[pipeline].errorCount;

    // Nach 3 Fehlern als unhealthy markieren
    if (errorCount >= 3) {
      this.state.pipelineHealth[pipeline].healthy = false;
      this.emit('pipelineUnhealthy', { pipeline, errorCount, errorMessage });
    }

    logger.warn(`[PIPELINE] ${pipeline}: Error #${errorCount}${errorMessage ? ` - ${errorMessage}` : ''}`);
  }

  /**
   * Prüft ob eine Pipeline als healthy gilt:
   * - Muss mindestens einmal erfolgreich gelaufen sein (lastSuccess != null)
   * - lastSuccess darf nicht älter als staleThreshold sein
   * - Weniger als 3 aufeinanderfolgende Fehler
   */
  isPipelineHealthy(pipeline: keyof RuntimeState['pipelineHealth'], staleThresholdMs: number = 10 * 60 * 1000): boolean {
    const health = this.state.pipelineHealth[pipeline];

    // Nie erfolgreich gelaufen = unhealthy
    if (!health.lastSuccess) {
      return false;
    }

    // Zu viele Fehler = unhealthy
    if (health.errorCount >= 3) {
      return false;
    }

    // Stale-Check: Letzte Success älter als Threshold = unhealthy
    const ageMs = Date.now() - health.lastSuccess.getTime();
    if (ageMs > staleThresholdMs) {
      return false;
    }

    return true;
  }

  /**
   * Gibt ehrlichen Pipeline-Health-Status zurück
   */
  getPipelineHealthStatus(pipeline: keyof RuntimeState['pipelineHealth']): 'healthy' | 'stale' | 'error' | 'unknown' {
    const health = this.state.pipelineHealth[pipeline];

    // Nie gelaufen = unknown
    if (!health.lastSuccess) {
      return 'unknown';
    }

    // Zu viele Fehler = error
    if (health.errorCount >= 3) {
      return 'error';
    }

    // Stale-Check: Letzte Success älter als 10 Minuten
    const ageMs = Date.now() - health.lastSuccess.getTime();
    const staleThresholdMs = 10 * 60 * 1000; // 10 Minuten
    if (ageMs > staleThresholdMs) {
      return 'stale';
    }

    return 'healthy';
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
    const previousWins = this.state.dailyWins;
    const previousLosses = this.state.dailyLosses;

    this.state.dailyPnL = 0;
    this.state.dailyTrades = 0;
    this.state.dailyWins = 0;
    this.state.dailyLosses = 0;
    this.state.lastResetAt = new Date();

    // Intraday Drawdown Tracking zurücksetzen
    this.state.recentTrades = [];
    this.state.intradayHighWaterMark = 0;
    this.state.intradayDrawdown = 0;
    this.state.consecutiveLosses = 0;
    this.state.cooldownUntil = null;
    this.state.cooldownReason = null;

    // Kill-Switch NICHT automatisch deaktivieren - das muss manuell passieren
    // this.state.killSwitchActive = false;

    // PERSISTIEREN - Resetten auch in DB
    this.persistRiskState();

    // AUDIT LOG
    this.writeAudit({
      eventType: 'daily_reset',
      actor: 'scheduler',
      action: `Täglicher Reset durchgeführt`,
      details: {
        previousPnL,
        previousTrades,
        previousWins,
        previousLosses,
      },
      riskStateBefore: {
        dailyPnL: previousPnL,
        dailyTrades: previousTrades,
        dailyWins: previousWins,
        dailyLosses: previousLosses,
      },
      riskStateAfter: {
        dailyPnL: 0,
        dailyTrades: 0,
        dailyWins: 0,
        dailyLosses: 0,
      },
    });

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
  //                      PERSISTENCE (SQLite)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Persistiere aktuellen Risk State in SQLite
   * Wird bei JEDER relevanten State-Änderung aufgerufen
   */
  private persistRiskState(newPositionMarketId?: string, newPosition?: { size: number; entryPrice: number; direction: 'yes' | 'no' }): void {
    try {
      // Positions in DB-Format konvertieren
      const positions: Record<string, { size: number; entryPrice: number; direction: 'yes' | 'no' }> =
        this.persistedState?.positions || {};

      // Existierende Positions aus Memory aktualisieren
      for (const [marketId, size] of this.state.positionsPerMarket.entries()) {
        if (positions[marketId]) {
          positions[marketId].size = size;
        }
      }

      // Neue Position hinzufügen wenn angegeben
      if (newPositionMarketId && newPosition) {
        positions[newPositionMarketId] = newPosition;
      }

      // Geschlossene Positions entfernen
      for (const marketId of Object.keys(positions)) {
        if (!this.state.positionsPerMarket.has(marketId)) {
          delete positions[marketId];
        }
      }

      // Settings in DB-Format
      const settings: Record<string, number> = {
        maxBetUsdc: this.state.maxBetUsdc,
        riskPerTradePercent: this.state.riskPerTradePercent,
        minEdge: this.state.minEdge,
        minAlpha: this.state.minAlpha,
        minVolumeUsd: this.state.minVolumeUsd,
        maxDailyLoss: this.state.maxDailyLoss,
        maxPositions: this.state.maxPositions,
        maxPerMarket: this.state.maxPerMarket,
      };

      // In SQLite speichern
      saveRiskState({
        executionMode: this.state.executionMode as 'paper' | 'shadow' | 'live',
        killSwitchActive: this.state.killSwitchActive,
        killSwitchReason: this.state.killSwitchReason,
        killSwitchActivatedAt: this.state.killSwitchActivatedAt,
        dailyPnL: this.state.dailyPnL,
        dailyTrades: this.state.dailyTrades,
        dailyWins: this.state.dailyWins,
        dailyLosses: this.state.dailyLosses,
        totalExposure: this.state.totalExposure,
        positions,
        settings,
      });

      // Lokalen Cache aktualisieren
      if (this.persistedState) {
        this.persistedState.positions = positions;
        this.persistedState.settings = settings;
      }

      logger.debug('[RUNTIME] Risk State in SQLite persistiert');
    } catch (err) {
      logger.error(`[RUNTIME] Fehler beim Persistieren des Risk State: ${(err as Error).message}`);
    }
  }

  /**
   * Schreibe Audit-Log Eintrag
   */
  private writeAudit(entry: Omit<AuditLogEntry, 'actor'> & { actor: StateChangeEvent['source'] | AuditLogEntry['actor'] }): void {
    try {
      writeAuditLog({
        ...entry,
        actor: entry.actor as AuditLogEntry['actor'],
      });
    } catch (err) {
      logger.error(`[RUNTIME] Fehler beim Schreiben des Audit-Logs: ${(err as Error).message}`);
    }
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
    consecutiveFailures: number;
    isKillSwitchActive: boolean;
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
      // Phase 3 Observability
      consecutiveFailures: getConsecutiveFailures(),
      isKillSwitchActive: this.state.killSwitchActive,
    };
  }
}

// Singleton Export
export const runtimeState = new RuntimeStateManager();
export default runtimeState;
