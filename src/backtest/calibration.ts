/**
 * Kalibrierungs-Analyse
 * Prüft wie gut die Wahrscheinlichkeitsvorhersagen sind
 */

import { BacktestTrade, CalibrationBucket } from '../alpha/types.js';

// ═══════════════════════════════════════════════════════════════
// BRIER SCORE
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne Brier Score
 * Misst die Genauigkeit von Wahrscheinlichkeitsvorhersagen
 *
 * Score-Interpretation:
 * - 0.00 = Perfekt
 * - 0.15 = Gut
 * - 0.20 = Akzeptabel
 * - 0.25 = Zufällig (kein Skill)
 * - > 0.25 = Schlechter als Zufall
 */
export function calculateBrierScore(trades: BacktestTrade[]): number {
  const tradesWithOutcome = trades.filter((t) => t.actualEdge !== null);

  if (tradesWithOutcome.length === 0) {
    return 0.25; // Default: Zufall
  }

  let sumSquaredErrors = 0;

  for (const trade of tradesWithOutcome) {
    // Predicted Probability
    // Bei "yes" Trade: wir erwarten P(yes) = entryPrice + predictedEdge
    // Bei "no" Trade: wir erwarten P(no) = (1 - entryPrice) + predictedEdge
    const predictedProb = Math.max(
      0.01,
      Math.min(0.99, trade.entryPrice + trade.predictedEdge)
    );

    // Actual Outcome: 1 wenn unsere Vorhersage korrekt war
    const actualOutcome = (trade.actualEdge ?? 0) > 0 ? 1 : 0;

    // Für Direction-Adjusted Brier Score
    const adjustedPrediction =
      trade.direction === 'yes' ? predictedProb : 1 - predictedProb;

    const error = adjustedPrediction - actualOutcome;
    sumSquaredErrors += error * error;
  }

  return sumSquaredErrors / tradesWithOutcome.length;
}

/**
 * Interpretiere Brier Score
 */
export function interpretBrierScore(score: number): string {
  if (score <= 0.1) return 'exzellent';
  if (score <= 0.15) return 'gut';
  if (score <= 0.2) return 'akzeptabel';
  if (score <= 0.25) return 'marginal';
  return 'schlecht';
}

// ═══════════════════════════════════════════════════════════════
// CALIBRATION BUCKETS
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne Reliability/Calibration Buckets
 * Teilt Vorhersagen in 10 Buckets (0-10%, 10-20%, ..., 90-100%)
 * Vergleicht vorhergesagte vs. tatsächliche Wahrscheinlichkeiten
 */
export function calculateCalibrationBuckets(
  trades: BacktestTrade[]
): CalibrationBucket[] {
  const tradesWithOutcome = trades.filter((t) => t.actualEdge !== null);

  if (tradesWithOutcome.length === 0) {
    return [];
  }

  const buckets: CalibrationBucket[] = [];

  // 10 Buckets: 0-10%, 10-20%, ..., 90-100%
  for (let i = 0; i < 10; i++) {
    const lower = i * 0.1;
    const upper = (i + 1) * 0.1;

    // Finde Trades in diesem Bucket
    const bucketTrades = tradesWithOutcome.filter((trade) => {
      // Predicted Probability
      const predictedProb = Math.max(
        0.01,
        Math.min(0.99, trade.entryPrice + trade.predictedEdge)
      );

      // Direction-adjusted: YES-Trades bleiben, NO-Trades werden invertiert
      const adjustedProb =
        trade.direction === 'yes' ? predictedProb : 1 - predictedProb;

      return adjustedProb >= lower && adjustedProb < upper;
    });

    if (bucketTrades.length > 0) {
      // Durchschnittliche vorhergesagte Wahrscheinlichkeit
      const predictedAvg =
        bucketTrades.reduce((sum, t) => {
          const prob = Math.max(0.01, Math.min(0.99, t.entryPrice + t.predictedEdge));
          return sum + (t.direction === 'yes' ? prob : 1 - prob);
        }, 0) / bucketTrades.length;

      // Tatsächliche Erfolgsrate
      const actualAvg =
        bucketTrades.filter((t) => (t.actualEdge ?? 0) > 0).length /
        bucketTrades.length;

      buckets.push({
        range: [lower, upper],
        predictedAvg,
        actualAvg,
        count: bucketTrades.length,
      });
    }
  }

  return buckets;
}

// ═══════════════════════════════════════════════════════════════
// CALIBRATION ANALYSIS
// ═══════════════════════════════════════════════════════════════

export interface CalibrationAnalysis {
  isOverconfident: boolean;
  isUnderconfident: boolean;
  avgDeviation: number;
  worstBucket: CalibrationBucket | null;
  recommendation: string;
}

/**
 * Analysiere Kalibrierung: Over-/Underconfident?
 */
export function analyzeCalibration(
  buckets: CalibrationBucket[]
): CalibrationAnalysis {
  if (buckets.length === 0) {
    return {
      isOverconfident: false,
      isUnderconfident: false,
      avgDeviation: 0,
      worstBucket: null,
      recommendation: 'Nicht genug Daten für Kalibrierungsanalyse',
    };
  }

  // Gewichtete Abweichung berechnen
  let totalDeviation = 0;
  let totalCount = 0;
  let worstDeviation = 0;
  let worstBucket: CalibrationBucket | null = null;

  for (const bucket of buckets) {
    // Deviation = predicted - actual
    // Positiv = overconfident (wir sagen höhere Wahrscheinlichkeit voraus als tatsächlich)
    // Negativ = underconfident (wir sagen niedrigere Wahrscheinlichkeit voraus)
    const deviation = bucket.predictedAvg - bucket.actualAvg;
    const absDeviation = Math.abs(deviation);

    totalDeviation += deviation * bucket.count;
    totalCount += bucket.count;

    if (absDeviation > Math.abs(worstDeviation) && bucket.count >= 3) {
      worstDeviation = deviation;
      worstBucket = bucket;
    }
  }

  const avgDeviation = totalCount > 0 ? totalDeviation / totalCount : 0;

  // Threshold für Over/Underconfidence: 5%
  const threshold = 0.05;
  const isOverconfident = avgDeviation > threshold;
  const isUnderconfident = avgDeviation < -threshold;

  // Empfehlung generieren
  let recommendation: string;

  if (Math.abs(avgDeviation) <= 0.02) {
    recommendation = 'Kalibrierung ist gut. Keine Anpassung nötig.';
  } else if (isOverconfident) {
    recommendation = `Overconfident um ${(avgDeviation * 100).toFixed(1)}%. ` +
      `Edge-Schätzungen sollten konservativer sein. ` +
      `Erwäge Kelly-Fraction zu reduzieren.`;
  } else if (isUnderconfident) {
    recommendation = `Underconfident um ${(Math.abs(avgDeviation) * 100).toFixed(1)}%. ` +
      `Edge-Schätzungen könnten aggressiver sein, aber Vorsicht vor Overfitting.`;
  } else {
    recommendation = 'Marginale Abweichungen. Weiter beobachten.';
  }

  // Worst Bucket Warnung
  if (worstBucket && Math.abs(worstDeviation) > 0.1) {
    const bucketRange = `${(worstBucket.range[0] * 100).toFixed(0)}-${(worstBucket.range[1] * 100).toFixed(0)}%`;
    recommendation += ` Achtung: Bucket ${bucketRange} hat ${(Math.abs(worstDeviation) * 100).toFixed(1)}% Abweichung.`;
  }

  return {
    isOverconfident,
    isUnderconfident,
    avgDeviation,
    worstBucket,
    recommendation,
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPECTED CALIBRATION ERROR (ECE)
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne Expected Calibration Error (ECE)
 * Gewichtete absolute Abweichung pro Bucket
 */
export function calculateECE(buckets: CalibrationBucket[]): number {
  if (buckets.length === 0) {
    return 0;
  }

  let weightedSum = 0;
  let totalCount = 0;

  for (const bucket of buckets) {
    const absDeviation = Math.abs(bucket.predictedAvg - bucket.actualAvg);
    weightedSum += absDeviation * bucket.count;
    totalCount += bucket.count;
  }

  return totalCount > 0 ? weightedSum / totalCount : 0;
}

/**
 * Interpretiere ECE
 */
export function interpretECE(ece: number): string {
  if (ece <= 0.02) return 'exzellent';
  if (ece <= 0.05) return 'gut';
  if (ece <= 0.1) return 'akzeptabel';
  if (ece <= 0.15) return 'marginal';
  return 'schlecht';
}

// ═══════════════════════════════════════════════════════════════
// RELIABILITY DIAGRAM DATA
// ═══════════════════════════════════════════════════════════════

/**
 * Generiere Daten für Reliability Diagram
 */
export function getReliabilityDiagramData(
  buckets: CalibrationBucket[]
): { x: number[]; y: number[]; counts: number[] } {
  const x: number[] = []; // Predicted (Mitte des Buckets)
  const y: number[] = []; // Actual
  const counts: number[] = [];

  for (const bucket of buckets) {
    const midpoint = (bucket.range[0] + bucket.range[1]) / 2;
    x.push(midpoint);
    y.push(bucket.actualAvg);
    counts.push(bucket.count);
  }

  return { x, y, counts };
}

/**
 * Formatiere Calibration-Bucket für Anzeige
 */
export function formatBucket(bucket: CalibrationBucket): string {
  const range = `${(bucket.range[0] * 100).toFixed(0)}-${(bucket.range[1] * 100).toFixed(0)}%`;
  const predicted = `${(bucket.predictedAvg * 100).toFixed(1)}%`;
  const actual = `${(bucket.actualAvg * 100).toFixed(1)}%`;
  const deviation = bucket.predictedAvg - bucket.actualAvg;
  const deviationStr =
    deviation > 0
      ? `+${(deviation * 100).toFixed(1)}%`
      : `${(deviation * 100).toFixed(1)}%`;

  return `${range.padEnd(8)} | ${predicted.padStart(6)} | ${actual.padStart(6)} | ${deviationStr.padStart(7)} | n=${bucket.count}`;
}

export default {
  calculateBrierScore,
  interpretBrierScore,
  calculateCalibrationBuckets,
  analyzeCalibration,
  calculateECE,
  interpretECE,
  getReliabilityDiagramData,
  formatBucket,
};
