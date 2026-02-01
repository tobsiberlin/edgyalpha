/**
 * Meta-Combiner für Alpha Engines
 * Kombiniert TIME_DELAY und MISPRICING Signale mit Online Logistic Regression
 *
 * ML-Ansatz:
 * 1. Features aus beiden Signalen extrahieren
 * 2. Logistic Regression für kombinierte Prediction
 * 3. Online-Update bei bekanntem Outcome (Walk-Forward)
 * 4. Regularisierung gegen Overfitting
 */

import { v4 as uuidv4 } from 'uuid';
import { AlphaSignalV2, Decision, RiskChecks, Rationale } from './types.js';
import { getDatabase, isDatabaseInitialized } from '../storage/db.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// Konfiguration
// ============================================================================

export interface CombinerConfig {
  // Initiale Gewichte (werden durch ML angepasst)
  initialWeights: {
    timeDelay: number;
    mispricing: number;
  };
  // Minimum-Signale für Kombination
  minSignalsForCombine: number;
  // Learning Rate für Online-Updates
  learningRate: number;
  // Regularisierung (verhindert Overfitting)
  regularization: number;
}

export const DEFAULT_COMBINER_CONFIG: CombinerConfig = {
  initialWeights: {
    timeDelay: 0.5,
    mispricing: 0.5,
  },
  minSignalsForCombine: 1,
  learningRate: 0.01,
  regularization: 0.001,
};

// ============================================================================
// Types
// ============================================================================

export interface CombinedSignal extends AlphaSignalV2 {
  sourceSignals: {
    timeDelay?: AlphaSignalV2;
    mispricing?: AlphaSignalV2;
  };
  weights: {
    timeDelay: number;
    mispricing: number;
  };
}

interface StoredCoefficients {
  weights: { timeDelay: number; mispricing: number };
  coefficients: Record<string, number>;
  trainingCount: number;
  lastUpdated: string;
}

// ============================================================================
// Feature-Namen (für Erklärbarkeit)
// ============================================================================

const FEATURE_NAMES: Record<string, string> = {
  bias: 'Basis-Wahrscheinlichkeit',
  td_edge: 'TimeDelay Edge',
  td_conf: 'TimeDelay Confidence',
  mp_edge: 'Mispricing Edge',
  mp_conf: 'Mispricing Confidence',
  agreement: 'Signal-Übereinstimmung',
  edge_diff: 'Edge-Differenz',
  avg_edge: 'Durchschnittliche Edge',
  avg_conf: 'Durchschnittliche Confidence',
  td_only: 'Nur TimeDelay Signal',
  mp_only: 'Nur Mispricing Signal',
  both_signals: 'Beide Signale vorhanden',
  edge_product: 'Edge-Produkt (Interaktion)',
  conf_product: 'Confidence-Produkt',
};

// ============================================================================
// MetaCombiner Klasse
// ============================================================================

export class MetaCombiner {
  private config: CombinerConfig;

  // Aktuelle Gewichte (werden online gelernt)
  private weights: { timeDelay: number; mispricing: number };

  // Feature-Koeffizienten für Logistic Regression
  private coefficients: Map<string, number> = new Map();

  // Trainingsdaten (Ring-Buffer für Analyse)
  private trainingBuffer: Array<{
    features: Record<string, number>;
    outcome: 0 | 1;
    timestamp: Date;
  }> = [];
  private maxBufferSize = 1000;

  // Tracking
  private trainingCount = 0;
  private lastSaveTime: Date | null = null;

  constructor(config?: Partial<CombinerConfig>) {
    this.config = { ...DEFAULT_COMBINER_CONFIG, ...config };
    this.weights = { ...this.config.initialWeights };

    // Initialisiere Koeffizienten mit kleinen Werten
    this.initializeCoefficients();
  }

  /**
   * Initialisiert Koeffizienten mit kleinen Zufallswerten
   */
  private initializeCoefficients(): void {
    const featureKeys = [
      'bias',
      'td_edge',
      'td_conf',
      'mp_edge',
      'mp_conf',
      'agreement',
      'edge_diff',
      'avg_edge',
      'avg_conf',
      'td_only',
      'mp_only',
      'both_signals',
      'edge_product',
      'conf_product',
    ];

    for (const key of featureKeys) {
      // Kleine Initialisierung, bias etwas höher
      this.coefficients.set(key, key === 'bias' ? 0.0 : 0.01);
    }
  }

  /**
   * Lade gespeicherte Weights aus DB
   */
  async loadWeights(): Promise<void> {
    if (!isDatabaseInitialized()) {
      logger.warn('MetaCombiner: DB nicht initialisiert, verwende Defaults');
      return;
    }

    try {
      const db = getDatabase();

      // Prüfe ob Tabelle existiert
      const tableExists = db
        .prepare(
          `
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='meta_combiner_state'
      `
        )
        .get();

      if (!tableExists) {
        logger.info('MetaCombiner: Keine gespeicherten Weights gefunden, verwende Defaults');
        return;
      }

      const row = db
        .prepare(
          `
        SELECT weights, coefficients, training_count, updated_at
        FROM meta_combiner_state
        ORDER BY updated_at DESC
        LIMIT 1
      `
        )
        .get() as { weights: string; coefficients: string; training_count: number; updated_at: string } | undefined;

      if (row) {
        const storedWeights = JSON.parse(row.weights);
        const storedCoefficients = JSON.parse(row.coefficients);

        this.weights = storedWeights;
        this.coefficients = new Map(Object.entries(storedCoefficients));
        this.trainingCount = row.training_count;

        logger.info(
          `MetaCombiner: Weights geladen (${this.trainingCount} Trainings, ` +
            `TD=${this.weights.timeDelay.toFixed(3)}, MP=${this.weights.mispricing.toFixed(3)})`
        );
      }
    } catch (error) {
      logger.error('MetaCombiner: Fehler beim Laden der Weights', error);
    }
  }

  /**
   * Speichere Weights in DB
   */
  async saveWeights(): Promise<void> {
    if (!isDatabaseInitialized()) {
      logger.warn('MetaCombiner: DB nicht initialisiert, kann Weights nicht speichern');
      return;
    }

    try {
      const db = getDatabase();

      // Erstelle Tabelle falls nicht existiert
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta_combiner_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          weights TEXT NOT NULL,
          coefficients TEXT NOT NULL,
          training_count INTEGER NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const weightsJson = JSON.stringify(this.weights);
      const coefficientsJson = JSON.stringify(Object.fromEntries(this.coefficients));

      db.prepare(
        `
        INSERT INTO meta_combiner_state (weights, coefficients, training_count, updated_at)
        VALUES (?, ?, ?, datetime('now'))
      `
      ).run(weightsJson, coefficientsJson, this.trainingCount);

      this.lastSaveTime = new Date();

      logger.debug(
        `MetaCombiner: Weights gespeichert (${this.trainingCount} Trainings)`
      );
    } catch (error) {
      logger.error('MetaCombiner: Fehler beim Speichern der Weights', error);
    }
  }

  /**
   * Kombiniere Signale von beiden Engines
   */
  combineSignals(
    timeDelaySignal?: AlphaSignalV2,
    mispricingSignal?: AlphaSignalV2
  ): CombinedSignal | null {
    // Mindestens ein Signal benötigt
    const signalCount = (timeDelaySignal ? 1 : 0) + (mispricingSignal ? 1 : 0);

    if (signalCount < this.config.minSignalsForCombine) {
      return null;
    }

    // Prüfe Richtungs-Konflikt wenn beide vorhanden
    if (timeDelaySignal && mispricingSignal) {
      if (timeDelaySignal.direction !== mispricingSignal.direction) {
        // Bei Konflikt: Nimm das Signal mit höherer Confidence
        if (timeDelaySignal.confidence > mispricingSignal.confidence) {
          mispricingSignal = undefined;
        } else {
          timeDelaySignal = undefined;
        }
        logger.debug('MetaCombiner: Richtungs-Konflikt, verwende stärkeres Signal');
      }
    }

    // Berechne kombinierte Metriken
    const { edge, confidence } = this.calculateCombinedMetrics(
      timeDelaySignal,
      mispricingSignal
    );

    // Bestimme Richtung (von verfügbarem Signal)
    const direction = timeDelaySignal?.direction ?? mispricingSignal?.direction ?? 'yes';
    const marketId = timeDelaySignal?.marketId ?? mispricingSignal?.marketId ?? '';
    const question = timeDelaySignal?.question ?? mispricingSignal?.question ?? '';

    // Kombiniere Features
    const combinedFeatures = this.mergeFeatures(timeDelaySignal, mispricingSignal);

    // Generiere Reasoning
    const reasoning = this.generateReasoning(timeDelaySignal, mispricingSignal, edge, confidence);

    const combinedSignal: CombinedSignal = {
      signalId: uuidv4(),
      alphaType: 'mispricing', // Meta-Typ, aber wir nutzen "mispricing" als Fallback
      marketId,
      question,
      direction,
      predictedEdge: edge,
      confidence,
      features: combinedFeatures,
      reasoning,
      createdAt: new Date(),
      sourceSignals: {
        timeDelay: timeDelaySignal,
        mispricing: mispricingSignal,
      },
      weights: { ...this.weights },
    };

    return combinedSignal;
  }

  /**
   * Online Logistic Regression Update
   * Wird aufgerufen wenn ein Outcome bekannt ist
   */
  updateFromOutcome(signal: CombinedSignal, actualOutcome: 0 | 1): void {
    // Extrahiere Features aus dem Signal
    const features = this.extractMLFeatures(
      signal.sourceSignals.timeDelay,
      signal.sourceSignals.mispricing
    );

    // Berechne aktuelle Vorhersage
    const prediction = this.predict(features);

    // Gradient Descent Step
    this.gradientStep(features, prediction, actualOutcome);

    // Update Engine-Weights basierend auf individueller Performance
    this.updateEngineWeights(signal, actualOutcome);

    // Speichere im Buffer für Analyse
    this.trainingBuffer.push({
      features,
      outcome: actualOutcome,
      timestamp: new Date(),
    });

    // Ring-Buffer: Älteste Einträge entfernen
    if (this.trainingBuffer.length > this.maxBufferSize) {
      this.trainingBuffer.shift();
    }

    this.trainingCount++;

    // Auto-Save alle 50 Updates
    if (this.trainingCount % 50 === 0) {
      this.saveWeights();
    }

    logger.debug(
      `MetaCombiner: Update #${this.trainingCount}, ` +
        `Prediction=${prediction.toFixed(3)}, Actual=${actualOutcome}`
    );
  }

  /**
   * Berechne kombinierte Edge und Confidence
   */
  private calculateCombinedMetrics(
    timeDelay?: AlphaSignalV2,
    mispricing?: AlphaSignalV2
  ): { edge: number; confidence: number } {
    // Wenn nur ein Signal: verwende dessen Werte
    if (!timeDelay && mispricing) {
      return {
        edge: mispricing.predictedEdge,
        confidence: mispricing.confidence * 0.9, // Leicht reduziert ohne Bestätigung
      };
    }

    if (timeDelay && !mispricing) {
      return {
        edge: timeDelay.predictedEdge,
        confidence: timeDelay.confidence * 0.9,
      };
    }

    // Beide Signale: Gewichtete Kombination mit ML-Boost
    if (timeDelay && mispricing) {
      const features = this.extractMLFeatures(timeDelay, mispricing);
      const mlPrediction = this.predict(features);

      // Gewichtete Edge
      const totalWeight = this.weights.timeDelay + this.weights.mispricing;
      const weightedEdge =
        (this.weights.timeDelay * timeDelay.predictedEdge +
          this.weights.mispricing * mispricing.predictedEdge) /
        totalWeight;

      // Confidence: Basis + Boost wenn Signale übereinstimmen
      const baseConfidence =
        (this.weights.timeDelay * timeDelay.confidence +
          this.weights.mispricing * mispricing.confidence) /
        totalWeight;

      // ML-basierter Boost (bis zu 20% bei starker Übereinstimmung)
      const agreementBoost = timeDelay.direction === mispricing.direction ? 0.15 : 0;
      const mlBoost = mlPrediction > 0.6 ? 0.05 : 0;

      const confidence = Math.min(0.95, baseConfidence + agreementBoost + mlBoost);

      return { edge: weightedEdge, confidence };
    }

    // Fallback
    return { edge: 0, confidence: 0 };
  }

  /**
   * Sigmoid-Funktion für Logistic Regression
   */
  private sigmoid(x: number): number {
    // Numerisch stabil
    if (x >= 0) {
      return 1 / (1 + Math.exp(-x));
    } else {
      const expX = Math.exp(x);
      return expX / (1 + expX);
    }
  }

  /**
   * Vorhersage mit aktuellen Koeffizienten
   */
  private predict(features: Record<string, number>): number {
    let logit = 0;

    for (const [key, value] of Object.entries(features)) {
      const coef = this.coefficients.get(key) ?? 0;
      logit += coef * value;
    }

    return this.sigmoid(logit);
  }

  /**
   * Gradient Descent Step mit L2-Regularisierung
   */
  private gradientStep(
    features: Record<string, number>,
    prediction: number,
    actual: number
  ): void {
    const error = prediction - actual;

    for (const [key, value] of Object.entries(features)) {
      const currentCoef = this.coefficients.get(key) ?? 0;

      // Gradient: (prediction - actual) * feature_value
      const gradient = error * value;

      // L2 Regularisierung: lambda * coefficient
      const regularization = this.config.regularization * currentCoef;

      // Update: coef -= learning_rate * (gradient + regularization)
      const newCoef = currentCoef - this.config.learningRate * (gradient + regularization);

      // Clipping für Stabilität
      this.coefficients.set(key, Math.max(-10, Math.min(10, newCoef)));
    }
  }

  /**
   * Update Engine-Weights basierend auf individueller Performance
   */
  private updateEngineWeights(signal: CombinedSignal, actualOutcome: 0 | 1): void {
    const td = signal.sourceSignals.timeDelay;
    const mp = signal.sourceSignals.mispricing;

    if (!td && !mp) return;

    // Berechne individuelle Fehler
    let tdError = 0;
    let mpError = 0;

    if (td) {
      const tdPrediction = td.direction === 'yes' ? td.confidence : 1 - td.confidence;
      tdError = Math.abs(tdPrediction - actualOutcome);
    }

    if (mp) {
      const mpPrediction = mp.direction === 'yes' ? mp.confidence : 1 - mp.confidence;
      mpError = Math.abs(mpPrediction - actualOutcome);
    }

    // Update Weights: Weniger Fehler = höheres Gewicht
    const lr = this.config.learningRate * 0.5; // Langsameres Weight-Update

    if (td && mp) {
      // Relative Performance
      const totalError = tdError + mpError + 0.001; // Epsilon für Division
      const tdPerf = 1 - tdError / totalError;
      const mpPerf = 1 - mpError / totalError;

      // Exponential Moving Average
      this.weights.timeDelay = (1 - lr) * this.weights.timeDelay + lr * tdPerf;
      this.weights.mispricing = (1 - lr) * this.weights.mispricing + lr * mpPerf;

      // Normalisierung
      const sum = this.weights.timeDelay + this.weights.mispricing;
      this.weights.timeDelay /= sum;
      this.weights.mispricing /= sum;

      // Minimum-Gewicht (verhindert komplettes Ausschalten)
      const minWeight = 0.2;
      this.weights.timeDelay = Math.max(minWeight, this.weights.timeDelay);
      this.weights.mispricing = Math.max(minWeight, this.weights.mispricing);

      // Re-Normalisierung
      const newSum = this.weights.timeDelay + this.weights.mispricing;
      this.weights.timeDelay /= newSum;
      this.weights.mispricing /= newSum;
    }
  }

  /**
   * Extract Features für ML
   */
  private extractMLFeatures(
    timeDelay?: AlphaSignalV2,
    mispricing?: AlphaSignalV2
  ): Record<string, number> {
    const features: Record<string, number> = {
      // Bias-Term (immer 1)
      bias: 1,

      // TimeDelay Features
      td_edge: timeDelay?.predictedEdge ?? 0,
      td_conf: timeDelay?.confidence ?? 0,

      // Mispricing Features
      mp_edge: mispricing?.predictedEdge ?? 0,
      mp_conf: mispricing?.confidence ?? 0,

      // Kombinierte Features
      agreement:
        timeDelay && mispricing
          ? timeDelay.direction === mispricing.direction
            ? 1
            : -1
          : 0,

      edge_diff:
        timeDelay && mispricing
          ? Math.abs(timeDelay.predictedEdge - mispricing.predictedEdge)
          : 0,

      avg_edge: this.average(timeDelay?.predictedEdge, mispricing?.predictedEdge),
      avg_conf: this.average(timeDelay?.confidence, mispricing?.confidence),

      // Signal-Präsenz (One-Hot-ähnlich)
      td_only: timeDelay && !mispricing ? 1 : 0,
      mp_only: !timeDelay && mispricing ? 1 : 0,
      both_signals: timeDelay && mispricing ? 1 : 0,

      // Interaktions-Features
      edge_product: (timeDelay?.predictedEdge ?? 0) * (mispricing?.predictedEdge ?? 0),
      conf_product: (timeDelay?.confidence ?? 0) * (mispricing?.confidence ?? 0),
    };

    return features;
  }

  /**
   * Hilfsfunktion: Durchschnitt von optionalen Werten
   */
  private average(...values: (number | undefined)[]): number {
    const defined = values.filter((v): v is number => v !== undefined);
    if (defined.length === 0) return 0;
    return defined.reduce((a, b) => a + b, 0) / defined.length;
  }

  /**
   * Merge Features von beiden Signalen
   */
  private mergeFeatures(
    timeDelay?: AlphaSignalV2,
    mispricing?: AlphaSignalV2
  ): AlphaSignalV2['features'] {
    const mergedFeatures: Record<string, number | string | boolean | null> = {};

    // TimeDelay Features mit Prefix
    if (timeDelay) {
      for (const [key, value] of Object.entries(timeDelay.features.features)) {
        mergedFeatures[`td_${key}`] = value;
      }
    }

    // Mispricing Features mit Prefix
    if (mispricing) {
      for (const [key, value] of Object.entries(mispricing.features.features)) {
        mergedFeatures[`mp_${key}`] = value;
      }
    }

    // Meta-Features
    mergedFeatures['meta_agreement'] =
      timeDelay && mispricing ? timeDelay.direction === mispricing.direction : null;
    mergedFeatures['meta_source_count'] = (timeDelay ? 1 : 0) + (mispricing ? 1 : 0);
    mergedFeatures['meta_weight_td'] = this.weights.timeDelay;
    mergedFeatures['meta_weight_mp'] = this.weights.mispricing;

    return {
      version: '1.0.0',
      features: mergedFeatures,
    };
  }

  /**
   * Generiere menschenlesbares Reasoning
   */
  private generateReasoning(
    timeDelay?: AlphaSignalV2,
    mispricing?: AlphaSignalV2,
    combinedEdge?: number,
    combinedConfidence?: number
  ): string[] {
    const reasons: string[] = [];

    // Signal-Quellen
    if (timeDelay && mispricing) {
      if (timeDelay.direction === mispricing.direction) {
        reasons.push(
          `Beide Engines (TimeDelay + Mispricing) empfehlen ${timeDelay.direction.toUpperCase()}`
        );
      } else {
        reasons.push('Signal-Konflikt zwischen Engines aufgeloest');
      }
    } else if (timeDelay) {
      reasons.push('Basierend auf TimeDelay-Engine (News-Reaktion)');
    } else if (mispricing) {
      reasons.push('Basierend auf Mispricing-Engine (Marktbewertung)');
    }

    // Edge-Details
    if (timeDelay) {
      reasons.push(
        `TimeDelay: Edge=${(timeDelay.predictedEdge * 100).toFixed(1)}%, ` +
          `Conf=${(timeDelay.confidence * 100).toFixed(0)}%`
      );
    }
    if (mispricing) {
      reasons.push(
        `Mispricing: Edge=${(mispricing.predictedEdge * 100).toFixed(1)}%, ` +
          `Conf=${(mispricing.confidence * 100).toFixed(0)}%`
      );
    }

    // Gewichte
    reasons.push(
      `Engine-Gewichte: TD=${(this.weights.timeDelay * 100).toFixed(0)}%, ` +
        `MP=${(this.weights.mispricing * 100).toFixed(0)}%`
    );

    // Kombinierte Werte
    if (combinedEdge !== undefined && combinedConfidence !== undefined) {
      reasons.push(
        `Kombiniert: Edge=${(combinedEdge * 100).toFixed(1)}%, ` +
          `Conf=${(combinedConfidence * 100).toFixed(0)}%`
      );
    }

    // ML-Training Status
    if (this.trainingCount > 0) {
      reasons.push(`ML-Modell: ${this.trainingCount} Trainingsbeispiele`);
    }

    return reasons;
  }

  /**
   * Bestimme Top-Features die Entscheidung treiben
   */
  getTopFeatures(signal: CombinedSignal, n: number = 3): string[] {
    const features = this.extractMLFeatures(
      signal.sourceSignals.timeDelay,
      signal.sourceSignals.mispricing
    );

    // Berechne Feature-Beiträge (Koeffizient * Wert)
    const contributions: Array<{ key: string; contribution: number; name: string }> = [];

    for (const [key, value] of Object.entries(features)) {
      if (key === 'bias') continue; // Bias ignorieren

      const coef = this.coefficients.get(key) ?? 0;
      const contribution = Math.abs(coef * value);

      if (contribution > 0.001) {
        contributions.push({
          key,
          contribution,
          name: FEATURE_NAMES[key] ?? key,
        });
      }
    }

    // Sortiere nach Beitrag
    contributions.sort((a, b) => b.contribution - a.contribution);

    // Top N zurückgeben
    return contributions.slice(0, n).map((c) => {
      const direction = (this.coefficients.get(c.key) ?? 0) > 0 ? '+' : '-';
      return `${c.name} (${direction}${c.contribution.toFixed(3)})`;
    });
  }

  /**
   * Diagnostik: Aktuelle Koeffizienten
   */
  getCoefficients(): Record<string, number> {
    return Object.fromEntries(this.coefficients);
  }

  /**
   * Diagnostik: Aktuelle Weights
   */
  getWeights(): { timeDelay: number; mispricing: number } {
    return { ...this.weights };
  }

  /**
   * Diagnostik: Training-Statistiken
   */
  getStats(): {
    trainingCount: number;
    bufferSize: number;
    weights: { timeDelay: number; mispricing: number };
    topCoefficients: Array<{ name: string; value: number }>;
  } {
    const sortedCoefs = Array.from(this.coefficients.entries())
      .map(([key, value]) => ({
        name: FEATURE_NAMES[key] ?? key,
        value,
      }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    return {
      trainingCount: this.trainingCount,
      bufferSize: this.trainingBuffer.length,
      weights: { ...this.weights },
      topCoefficients: sortedCoefs.slice(0, 5),
    };
  }

  /**
   * Reset auf Defaults (für Tests)
   */
  reset(): void {
    this.weights = { ...this.config.initialWeights };
    this.initializeCoefficients();
    this.trainingBuffer = [];
    this.trainingCount = 0;
    logger.info('MetaCombiner: Reset auf Defaults');
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const metaCombiner = new MetaCombiner();
