/**
 * Drift Detection für Meta-Combiner
 * Erkennt instabile Coefficients und Regime-Wechsel
 *
 * Drift-Typen:
 * - Coefficient Drift: Feature-Coefficients ändern sich zu stark
 * - Weight Drift: Engine-Weights flippen plötzlich
 * - Performance Drift: Accuracy verschlechtert sich
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface DriftConfig {
  // Coefficient Drift
  coefficientChangeThreshold: number;     // Max Änderung pro Update (0.5 = 50%)
  coefficientVolatilityWindow: number;    // Anzahl Updates für Volatilitäts-Berechnung
  coefficientVolatilityThreshold: number; // Max Volatilität (Std-Dev)

  // Weight Drift
  weightChangeThreshold: number;          // Max Änderung pro Update (0.1 = 10%)
  weightFlipThreshold: number;            // Ab wann gilt als "Flip" (z.B. 0.3 Swing)

  // Performance Drift
  performanceWindow: number;              // Rolling Window für Performance
  minAccuracyThreshold: number;           // Unter dieser Accuracy = Alarm
  accuracyDropThreshold: number;          // Relativer Drop = Alarm

  // Drosselung
  throttleAfterDrifts: number;            // Nach N Drifts: Drosselung
  throttleDurationMinutes: number;        // Wie lange gedrosselt?
}

export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  coefficientChangeThreshold: 0.5,
  coefficientVolatilityWindow: 20,
  coefficientVolatilityThreshold: 0.3,
  weightChangeThreshold: 0.15,
  weightFlipThreshold: 0.3,
  performanceWindow: 50,
  minAccuracyThreshold: 0.45,
  accuracyDropThreshold: 0.15,
  throttleAfterDrifts: 3,
  throttleDurationMinutes: 30,
};

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type DriftType = 'coefficient' | 'weight' | 'performance' | 'regime';

export interface DriftEvent {
  type: DriftType;
  severity: 'warning' | 'critical';
  message: string;
  details: Record<string, unknown>;
  timestamp: Date;
}

export interface DriftStatus {
  healthy: boolean;
  throttled: boolean;
  throttledUntil: Date | null;
  throttleReason: string | null;
  recentDrifts: DriftEvent[];
  coefficientVolatility: Record<string, number>;
  weightHistory: Array<{ timeDelay: number; mispricing: number; timestamp: Date }>;
  performanceHistory: Array<{ correct: boolean; timestamp: Date }>;
  currentAccuracy: number;
}

// ═══════════════════════════════════════════════════════════════
// DRIFT DETECTOR CLASS
// ═══════════════════════════════════════════════════════════════

export class DriftDetector extends EventEmitter {
  private config: DriftConfig;

  // Historische Daten
  private coefficientHistory: Map<string, number[]> = new Map();
  private weightHistory: Array<{ timeDelay: number; mispricing: number; timestamp: Date }> = [];
  private performanceHistory: Array<{ correct: boolean; timestamp: Date }> = [];
  private recentDrifts: DriftEvent[] = [];

  // Throttling State
  private throttled = false;
  private throttledUntil: Date | null = null;
  private throttleReason: string | null = null;

  // Previous State (für Change Detection)
  private previousWeights: { timeDelay: number; mispricing: number } | null = null;
  private previousCoefficients: Map<string, number> = new Map();

  constructor(config?: Partial<DriftConfig>) {
    super();
    this.config = { ...DEFAULT_DRIFT_CONFIG, ...config };
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN UPDATE METHOD
  // ═══════════════════════════════════════════════════════════════

  /**
   * Wird nach jedem Meta-Combiner Update aufgerufen
   */
  recordUpdate(
    weights: { timeDelay: number; mispricing: number },
    coefficients: Map<string, number>,
    prediction: number,
    actualOutcome: 0 | 1
  ): DriftEvent[] {
    const drifts: DriftEvent[] = [];

    // 1. Coefficient Drift Check
    const coeffDrift = this.checkCoefficientDrift(coefficients);
    if (coeffDrift) drifts.push(coeffDrift);

    // 2. Weight Drift Check
    const weightDrift = this.checkWeightDrift(weights);
    if (weightDrift) drifts.push(weightDrift);

    // 3. Performance Drift Check
    const perfDrift = this.checkPerformanceDrift(prediction, actualOutcome);
    if (perfDrift) drifts.push(perfDrift);

    // Speichere aktuelle Werte für nächsten Vergleich
    this.previousWeights = { ...weights };
    for (const [key, value] of coefficients.entries()) {
      this.previousCoefficients.set(key, value);

      // Historie aktualisieren
      if (!this.coefficientHistory.has(key)) {
        this.coefficientHistory.set(key, []);
      }
      const history = this.coefficientHistory.get(key)!;
      history.push(value);
      // Rolling Window
      while (history.length > this.config.coefficientVolatilityWindow) {
        history.shift();
      }
    }

    // Weight History
    this.weightHistory.push({ ...weights, timestamp: new Date() });
    while (this.weightHistory.length > 100) {
      this.weightHistory.shift();
    }

    // Performance History
    const correct = (prediction >= 0.5 && actualOutcome === 1) ||
                   (prediction < 0.5 && actualOutcome === 0);
    this.performanceHistory.push({ correct, timestamp: new Date() });
    while (this.performanceHistory.length > this.config.performanceWindow * 2) {
      this.performanceHistory.shift();
    }

    // Drifts verarbeiten
    if (drifts.length > 0) {
      this.recentDrifts.push(...drifts);

      // Nur letzte 20 Drifts behalten
      while (this.recentDrifts.length > 20) {
        this.recentDrifts.shift();
      }

      // Emit Events
      for (const drift of drifts) {
        this.emit('drift', drift);
        logger.warn(`[DRIFT] ${drift.type}: ${drift.message}`);
      }

      // Auto-Throttle Check
      this.checkAutoThrottle();
    }

    return drifts;
  }

  // ═══════════════════════════════════════════════════════════════
  // DRIFT CHECKS
  // ═══════════════════════════════════════════════════════════════

  private checkCoefficientDrift(coefficients: Map<string, number>): DriftEvent | null {
    if (this.previousCoefficients.size === 0) return null;

    const changes: Record<string, { old: number; new: number; change: number }> = {};
    let maxChange = 0;
    let maxChangeKey = '';

    for (const [key, value] of coefficients.entries()) {
      const prev = this.previousCoefficients.get(key);
      if (prev === undefined) continue;

      const change = Math.abs(value - prev);
      const relativeChange = Math.abs(prev) > 0.01
        ? change / Math.abs(prev)
        : change;

      if (relativeChange > this.config.coefficientChangeThreshold) {
        changes[key] = { old: prev, new: value, change: relativeChange };
      }

      if (change > maxChange) {
        maxChange = change;
        maxChangeKey = key;
      }
    }

    if (Object.keys(changes).length === 0) return null;

    const severity = Object.keys(changes).length >= 3 ? 'critical' : 'warning';

    return {
      type: 'coefficient',
      severity,
      message: `Coefficient-Drift erkannt: ${Object.keys(changes).length} Features instabil`,
      details: {
        changes,
        maxChange,
        maxChangeKey,
      },
      timestamp: new Date(),
    };
  }

  private checkWeightDrift(weights: { timeDelay: number; mispricing: number }): DriftEvent | null {
    if (!this.previousWeights) return null;

    const tdChange = Math.abs(weights.timeDelay - this.previousWeights.timeDelay);
    const mpChange = Math.abs(weights.mispricing - this.previousWeights.mispricing);

    // Check für plötzlichen Flip
    if (tdChange >= this.config.weightFlipThreshold) {
      const direction = weights.timeDelay > this.previousWeights.timeDelay
        ? 'TimeDelay steigt'
        : 'TimeDelay sinkt';

      return {
        type: 'weight',
        severity: 'critical',
        message: `Weight-Flip erkannt: ${direction} um ${(tdChange * 100).toFixed(1)}%`,
        details: {
          before: this.previousWeights,
          after: weights,
          tdChange,
          mpChange,
        },
        timestamp: new Date(),
      };
    }

    // Check für kontinuierliche Drift
    if (tdChange >= this.config.weightChangeThreshold) {
      return {
        type: 'weight',
        severity: 'warning',
        message: `Weight-Drift: TimeDelay ${this.previousWeights.timeDelay.toFixed(2)} → ${weights.timeDelay.toFixed(2)}`,
        details: {
          before: this.previousWeights,
          after: weights,
          tdChange,
          mpChange,
        },
        timestamp: new Date(),
      };
    }

    return null;
  }

  private checkPerformanceDrift(prediction: number, actualOutcome: 0 | 1): DriftEvent | null {
    const correct = (prediction >= 0.5 && actualOutcome === 1) ||
                   (prediction < 0.5 && actualOutcome === 0);

    // Brauchen mindestens N Samples
    if (this.performanceHistory.length < this.config.performanceWindow) {
      return null;
    }

    // Berechne Rolling Accuracy
    const recentPerf = this.performanceHistory.slice(-this.config.performanceWindow);
    const currentAccuracy = recentPerf.filter(p => p.correct).length / recentPerf.length;

    // Check absolute Threshold
    if (currentAccuracy < this.config.minAccuracyThreshold) {
      return {
        type: 'performance',
        severity: 'critical',
        message: `Performance-Drift: Accuracy ${(currentAccuracy * 100).toFixed(1)}% unter Minimum`,
        details: {
          currentAccuracy,
          threshold: this.config.minAccuracyThreshold,
          sampleSize: recentPerf.length,
        },
        timestamp: new Date(),
      };
    }

    // Check relativer Drop (vergleiche mit älterer Performance)
    if (this.performanceHistory.length >= this.config.performanceWindow * 2) {
      const oldPerf = this.performanceHistory.slice(
        -this.config.performanceWindow * 2,
        -this.config.performanceWindow
      );
      const oldAccuracy = oldPerf.filter(p => p.correct).length / oldPerf.length;

      const drop = oldAccuracy - currentAccuracy;
      if (drop >= this.config.accuracyDropThreshold) {
        return {
          type: 'performance',
          severity: 'warning',
          message: `Performance-Drop: ${(oldAccuracy * 100).toFixed(1)}% → ${(currentAccuracy * 100).toFixed(1)}%`,
          details: {
            oldAccuracy,
            currentAccuracy,
            drop,
            threshold: this.config.accuracyDropThreshold,
          },
          timestamp: new Date(),
        };
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // THROTTLING
  // ═══════════════════════════════════════════════════════════════

  private checkAutoThrottle(): void {
    // Zähle kritische Drifts in letzter Stunde
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCritical = this.recentDrifts.filter(
      d => d.timestamp >= oneHourAgo && d.severity === 'critical'
    );

    if (recentCritical.length >= this.config.throttleAfterDrifts) {
      this.activateThrottle(
        `${recentCritical.length} kritische Drifts in 1 Stunde`
      );
    }
  }

  activateThrottle(reason: string): void {
    if (this.throttled) return;

    this.throttled = true;
    this.throttledUntil = new Date(Date.now() + this.config.throttleDurationMinutes * 60 * 1000);
    this.throttleReason = reason;

    const event: DriftEvent = {
      type: 'regime',
      severity: 'critical',
      message: `Auto-Drosselung aktiviert: ${reason}`,
      details: {
        throttledUntil: this.throttledUntil,
        durationMinutes: this.config.throttleDurationMinutes,
      },
      timestamp: new Date(),
    };

    this.recentDrifts.push(event);
    this.emit('throttle', event);
    logger.warn(`[DRIFT] THROTTLE AKTIVIERT: ${reason} (${this.config.throttleDurationMinutes} Min)`);
  }

  deactivateThrottle(): void {
    if (!this.throttled) return;

    this.throttled = false;
    this.throttledUntil = null;
    this.throttleReason = null;

    logger.info('[DRIFT] Throttle deaktiviert');
    this.emit('throttle_off');
  }

  isThrottled(): boolean {
    // Prüfe ob Throttle abgelaufen
    if (this.throttled && this.throttledUntil && this.throttledUntil <= new Date()) {
      this.deactivateThrottle();
    }
    return this.throttled;
  }

  // ═══════════════════════════════════════════════════════════════
  // STATUS & DIAGNOSTICS
  // ═══════════════════════════════════════════════════════════════

  getStatus(): DriftStatus {
    // Berechne aktuelle Accuracy
    const recentPerf = this.performanceHistory.slice(-this.config.performanceWindow);
    const currentAccuracy = recentPerf.length > 0
      ? recentPerf.filter(p => p.correct).length / recentPerf.length
      : 0;

    // Berechne Coefficient Volatility
    const coefficientVolatility: Record<string, number> = {};
    for (const [key, history] of this.coefficientHistory.entries()) {
      if (history.length >= 5) {
        const mean = history.reduce((a, b) => a + b, 0) / history.length;
        const variance = history.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / history.length;
        coefficientVolatility[key] = Math.sqrt(variance);
      }
    }

    return {
      healthy: !this.throttled && this.recentDrifts.filter(d => d.severity === 'critical').length === 0,
      throttled: this.isThrottled(),
      throttledUntil: this.throttledUntil,
      throttleReason: this.throttleReason,
      recentDrifts: this.recentDrifts.slice(-10),
      coefficientVolatility,
      weightHistory: this.weightHistory.slice(-20),
      performanceHistory: this.performanceHistory.slice(-50),
      currentAccuracy,
    };
  }

  /**
   * Reset alle historischen Daten (z.B. nach Regime-Wechsel)
   */
  reset(): void {
    this.coefficientHistory.clear();
    this.weightHistory = [];
    this.performanceHistory = [];
    this.recentDrifts = [];
    this.previousWeights = null;
    this.previousCoefficients.clear();
    this.deactivateThrottle();

    logger.info('[DRIFT] Drift Detector zurückgesetzt');
  }
}

// Singleton Instance
export const driftDetector = new DriftDetector();
