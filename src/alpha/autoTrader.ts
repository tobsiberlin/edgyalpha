/**
 * AutoTrader Service
 * Automatische Trade-Ausführung bei Breaking News mit hohem Edge
 *
 * WICHTIG: Speed ist essentiell - Zeitvorsprung nur wertvoll wenn wir schnell handeln!
 *
 * Bedingungen für Auto-Trade:
 * 1. certainty === 'breaking_confirmed'
 * 2. edge > config.minEdge (default: 15%)
 * 3. riskChecks.passed
 * 4. !killSwitchActive
 * 5. autoTrade.enabled === true
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { AlphaSignalV2, Decision, Execution, RiskChecks, MarketQuality } from './types.js';
import { checkRiskGates, isKillSwitchActive, RiskCheckResult } from './riskGates.js';
import { calculateSizeWithCertainty, SizingResult } from './sizing.js';
import { config } from '../utils/config.js';
import { runtimeState } from '../runtime/state.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface AutoTradeConfig {
  enabled: boolean;
  minEdge: number;        // Minimum Edge für Auto-Trade (default: 0.15 = 15%)
  maxSize: number;        // Maximum Size pro Trade (default: 50 USDC)
  requireLiveMode: boolean; // Nur im Live-Mode auto-traden? (default: false für Tests)
}

export interface AutoTradeResult {
  executed: boolean;
  reason: string;
  execution?: Execution;
  decision?: Decision;
  signal: AlphaSignalV2;
}

export interface AutoTradeEvents {
  'auto_trade_executed': (result: AutoTradeResult) => void;
  'auto_trade_blocked': (result: AutoTradeResult) => void;
}

// ═══════════════════════════════════════════════════════════════
// AUTO TRADER CLASS
// ═══════════════════════════════════════════════════════════════

export class AutoTrader extends EventEmitter {
  private config: AutoTradeConfig;
  private tradingClient: any = null; // Lazy loaded to avoid circular deps

  constructor(autoTradeConfig?: Partial<AutoTradeConfig>) {
    super();

    // Config aus environment + übergebene Parameter
    this.config = {
      enabled: config.autoTrade?.enabled ?? false,
      minEdge: config.autoTrade?.minEdge ?? 0.15,
      maxSize: config.autoTrade?.maxSize ?? 50,
      requireLiveMode: false, // Auch in Paper/Shadow für Tests
      ...autoTradeConfig,
    };

    logger.info(`[AUTO_TRADER] Initialisiert mit Config:`, {
      enabled: this.config.enabled,
      minEdge: `${(this.config.minEdge * 100).toFixed(0)}%`,
      maxSize: `$${this.config.maxSize}`,
    });
  }

  /**
   * Lazy-Load Trading Client (vermeidet circular deps)
   */
  private async getTradingClient() {
    if (!this.tradingClient) {
      const { tradingClient } = await import('../api/trading.js');
      this.tradingClient = tradingClient;
    }
    return this.tradingClient;
  }

  /**
   * Prüft ob ein Signal für Auto-Trading qualifiziert ist
   * Gibt detaillierte Begründung zurück
   */
  evaluateForAutoTrade(signal: AlphaSignalV2): {
    qualifies: boolean;
    reasons: string[];
    blockers: string[];
  } {
    const reasons: string[] = [];
    const blockers: string[] = [];

    // 1. Auto-Trading aktiviert?
    if (!this.config.enabled) {
      blockers.push('Auto-Trading ist deaktiviert');
    } else {
      reasons.push('Auto-Trading aktiviert');
    }

    // 2. Breaking Confirmed?
    if (signal.certainty === 'breaking_confirmed') {
      reasons.push(`Certainty: BREAKING_CONFIRMED`);
    } else {
      blockers.push(`Certainty nur "${signal.certainty}" (braucht breaking_confirmed)`);
    }

    // 3. Edge hoch genug?
    if (signal.predictedEdge >= this.config.minEdge) {
      reasons.push(`Edge ${(signal.predictedEdge * 100).toFixed(1)}% >= ${(this.config.minEdge * 100).toFixed(0)}% Minimum`);
    } else {
      blockers.push(`Edge ${(signal.predictedEdge * 100).toFixed(1)}% < ${(this.config.minEdge * 100).toFixed(0)}% Minimum`);
    }

    // 4. Kill-Switch aktiv?
    if (isKillSwitchActive()) {
      blockers.push('Kill-Switch ist aktiv');
    } else {
      reasons.push('Kill-Switch inaktiv');
    }

    // 5. Execution Mode prüfen (optional)
    const state = runtimeState.getState();
    if (this.config.requireLiveMode && state.executionMode !== 'live') {
      blockers.push(`Execution Mode ist "${state.executionMode}" (braucht live)`);
    } else {
      reasons.push(`Execution Mode: ${state.executionMode}`);
    }

    const qualifies = blockers.length === 0;

    return { qualifies, reasons, blockers };
  }

  /**
   * Hauptmethode: Evaluiert und führt ggf. Auto-Trade aus
   * WICHTIG: Geschwindigkeit ist kritisch!
   */
  async processSignal(
    signal: AlphaSignalV2,
    marketQuality: MarketQuality
  ): Promise<AutoTradeResult> {
    const startTime = Date.now();

    logger.info(`[AUTO_TRADER] Processing Signal: ${signal.marketId.substring(0, 8)}...`, {
      certainty: signal.certainty,
      edge: `${(signal.predictedEdge * 100).toFixed(1)}%`,
      direction: signal.direction,
    });

    // 1. Quick Evaluation
    const evaluation = this.evaluateForAutoTrade(signal);

    if (!evaluation.qualifies) {
      const result: AutoTradeResult = {
        executed: false,
        reason: evaluation.blockers.join('; '),
        signal,
      };

      logger.info(`[AUTO_TRADER] Signal nicht qualifiziert:`, {
        blockers: evaluation.blockers,
        processingTime: `${Date.now() - startTime}ms`,
      });

      this.emit('auto_trade_blocked', result);
      return result;
    }

    // 2. Risk Gates prüfen
    const bankroll = config.trading.maxBankrollUsdc;
    const sizing: SizingResult = calculateSizeWithCertainty(
      signal.certainty || 'medium',
      bankroll,
      signal.predictedEdge,
      signal.confidence,
      marketQuality
    );

    // Cap bei maxSize
    const tradeSize = Math.min(sizing.size, this.config.maxSize);

    if (tradeSize < 1) {
      const result: AutoTradeResult = {
        executed: false,
        reason: `Berechnete Size zu klein: $${sizing.size.toFixed(2)}`,
        signal,
      };

      logger.info(`[AUTO_TRADER] Size zu klein:`, {
        calculatedSize: sizing.size,
        minSize: 1,
        processingTime: `${Date.now() - startTime}ms`,
      });

      this.emit('auto_trade_blocked', result);
      return result;
    }

    // Risk Gates
    const riskCheck: RiskCheckResult = checkRiskGates(tradeSize, signal.marketId, marketQuality);

    if (!riskCheck.passed) {
      const result: AutoTradeResult = {
        executed: false,
        reason: `Risk Gates: ${riskCheck.failedReasons.join('; ')}`,
        signal,
      };

      logger.warn(`[AUTO_TRADER] Risk Gates fehlgeschlagen:`, {
        failedReasons: riskCheck.failedReasons,
        processingTime: `${Date.now() - startTime}ms`,
      });

      this.emit('auto_trade_blocked', result);
      return result;
    }

    // 3. Decision erstellen
    const decision: Decision = {
      decisionId: uuidv4(),
      signalId: signal.signalId,
      action: 'trade',
      sizeUsdc: tradeSize,
      riskChecks: riskCheck.checks,
      rationale: {
        alphaType: signal.alphaType,
        edge: signal.predictedEdge,
        confidence: signal.confidence,
        topFeatures: [
          `BREAKING_CONFIRMED Auto-Trade`,
          `Edge: ${(signal.predictedEdge * 100).toFixed(1)}%`,
          `Size: $${tradeSize.toFixed(2)} (capped at $${this.config.maxSize})`,
          ...signal.reasoning.slice(0, 2),
        ],
      },
      createdAt: new Date(),
    };

    // 4. Trade ausführen
    const state = runtimeState.getState();

    try {
      const tradingClient = await this.getTradingClient();
      const execution = await tradingClient.executeWithMode(decision, state.executionMode);

      const processingTime = Date.now() - startTime;

      const result: AutoTradeResult = {
        executed: execution.status === 'filled',
        reason: execution.status === 'filled'
          ? `Auto-Trade erfolgreich in ${processingTime}ms`
          : `Execution Status: ${execution.status}`,
        execution,
        decision,
        signal,
      };

      logger.info(`[AUTO_TRADER] Trade ausgeführt!`, {
        executionId: execution.executionId,
        status: execution.status,
        mode: state.executionMode,
        size: tradeSize,
        direction: signal.direction,
        fillPrice: execution.fillPrice,
        processingTime: `${processingTime}ms`,
      });

      this.emit('auto_trade_executed', result);
      return result;

    } catch (err) {
      const error = err as Error;
      const processingTime = Date.now() - startTime;

      const result: AutoTradeResult = {
        executed: false,
        reason: `Execution Fehler: ${error.message}`,
        decision,
        signal,
      };

      logger.error(`[AUTO_TRADER] Execution fehlgeschlagen:`, {
        error: error.message,
        processingTime: `${processingTime}ms`,
      });

      this.emit('auto_trade_blocked', result);
      return result;
    }
  }

  /**
   * Aktualisiert die Config zur Laufzeit
   */
  updateConfig(newConfig: Partial<AutoTradeConfig>): void {
    this.config = { ...this.config, ...newConfig };

    logger.info(`[AUTO_TRADER] Config aktualisiert:`, {
      enabled: this.config.enabled,
      minEdge: `${(this.config.minEdge * 100).toFixed(0)}%`,
      maxSize: `$${this.config.maxSize}`,
    });
  }

  /**
   * Gibt aktuelle Config zurück
   */
  getConfig(): AutoTradeConfig {
    return { ...this.config };
  }

  /**
   * Aktiviert/Deaktiviert Auto-Trading
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info(`[AUTO_TRADER] ${enabled ? 'AKTIVIERT' : 'DEAKTIVIERT'}`);
  }

  /**
   * Prüft ob Auto-Trading aktiv ist
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

export const autoTrader = new AutoTrader();

export default autoTrader;
