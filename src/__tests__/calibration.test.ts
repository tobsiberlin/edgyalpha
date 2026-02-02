/**
 * Tests fuer Kalibrierungs-Metriken
 * Prueft Brier Score und Calibration Buckets
 */

import { describe, it, expect } from 'vitest';
import {
  calculateBrierScore,
  interpretBrierScore,
  calculateCalibrationBuckets,
  analyzeCalibration,
  calculateECE,
  interpretECE,
} from '../backtest/calibration.js';
import type { BacktestTrade, CalibrationBucket } from '../alpha/types.js';

describe('Calibration', () => {
  // Helper: Create mock BacktestTrade
  const createTrade = (
    entryPrice: number,
    predictedEdge: number,
    actualEdge: number | null,
    direction: 'yes' | 'no' = 'yes'
  ): BacktestTrade => ({
    signalId: `signal-${Math.random()}`,
    marketId: 'test-market',
    direction,
    entryPrice,
    exitPrice: actualEdge !== null ? entryPrice + actualEdge : null,
    size: 10,
    pnl: actualEdge !== null ? 10 * actualEdge : null,
    predictedEdge,
    actualEdge,
    slippage: 0.01,
  });

  describe('calculateBrierScore', () => {
    it('should return 0.25 for empty trades', () => {
      const score = calculateBrierScore([]);
      expect(score).toBe(0.25);
    });

    it('should return 0.25 for trades without outcomes', () => {
      const trades = [
        createTrade(0.5, 0.1, null),
        createTrade(0.6, 0.05, null),
      ];

      const score = calculateBrierScore(trades);
      expect(score).toBe(0.25);
    });

    it('should calculate low score for perfect predictions', () => {
      // Perfekte Vorhersagen: hohe Confidence + korrekt
      const trades = [
        createTrade(0.8, 0.1, 0.15, 'yes'), // Predicted 90%, won
        createTrade(0.7, 0.15, 0.2, 'yes'), // Predicted 85%, won
        createTrade(0.2, 0.1, 0.1, 'no'),   // Predicted 70% no (30% yes), won no
      ];

      const score = calculateBrierScore(trades);

      // Gute Vorhersagen sollten niedrigen Brier Score haben
      expect(score).toBeLessThan(0.2);
    });

    it('should calculate high score for poor predictions', () => {
      // Schlechte Vorhersagen: hohe Confidence + falsch
      const trades = [
        createTrade(0.9, 0.05, -0.9, 'yes'), // Predicted 95%, lost completely
        createTrade(0.8, 0.1, -0.8, 'yes'),  // Predicted 90%, lost
      ];

      const score = calculateBrierScore(trades);

      // Schlechte Vorhersagen sollten hohen Brier Score haben
      expect(score).toBeGreaterThan(0.3);
    });

    it('should return around 0.25 for random predictions', () => {
      // 50/50 Vorhersagen mit 50/50 Outcomes
      const trades = [
        createTrade(0.5, 0.0, 0.1, 'yes'),  // 50% predicted, won
        createTrade(0.5, 0.0, -0.1, 'yes'), // 50% predicted, lost
        createTrade(0.5, 0.0, 0.1, 'yes'),  // 50% predicted, won
        createTrade(0.5, 0.0, -0.1, 'yes'), // 50% predicted, lost
      ];

      const score = calculateBrierScore(trades);

      // Random sollte um 0.25 sein
      expect(score).toBeCloseTo(0.25, 1);
    });
  });

  describe('interpretBrierScore', () => {
    it('should interpret scores correctly', () => {
      expect(interpretBrierScore(0.05)).toBe('exzellent');
      expect(interpretBrierScore(0.12)).toBe('gut');
      expect(interpretBrierScore(0.18)).toBe('akzeptabel');
      expect(interpretBrierScore(0.23)).toBe('marginal');
      expect(interpretBrierScore(0.35)).toBe('schlecht');
    });
  });

  describe('calculateCalibrationBuckets', () => {
    it('should return empty array for no trades', () => {
      const buckets = calculateCalibrationBuckets([]);
      expect(buckets).toHaveLength(0);
    });

    it('should return empty array for trades without outcomes', () => {
      const trades = [
        createTrade(0.5, 0.1, null),
      ];

      const buckets = calculateCalibrationBuckets(trades);
      expect(buckets).toHaveLength(0);
    });

    it('should create correct calibration buckets', () => {
      // Trades mit verschiedenen Predicted Probs
      const trades = [
        // 70-80% bucket (entry 0.65 + edge 0.1 = 0.75)
        createTrade(0.65, 0.1, 0.1, 'yes'),
        createTrade(0.7, 0.05, 0.05, 'yes'),
        createTrade(0.68, 0.07, -0.1, 'yes'), // Lost

        // 50-60% bucket (entry 0.5 + edge 0.05 = 0.55)
        createTrade(0.5, 0.05, 0.1, 'yes'),
        createTrade(0.52, 0.03, -0.1, 'yes'), // Lost
      ];

      const buckets = calculateCalibrationBuckets(trades);

      // Sollte mindestens 2 Buckets haben
      expect(buckets.length).toBeGreaterThanOrEqual(2);

      // Jeder Bucket sollte valide Struktur haben
      for (const bucket of buckets) {
        expect(bucket.range).toHaveLength(2);
        expect(bucket.range[0]).toBeGreaterThanOrEqual(0);
        expect(bucket.range[1]).toBeLessThanOrEqual(1);
        expect(bucket.predictedAvg).toBeGreaterThanOrEqual(0);
        expect(bucket.predictedAvg).toBeLessThanOrEqual(1);
        expect(bucket.actualAvg).toBeGreaterThanOrEqual(0);
        expect(bucket.actualAvg).toBeLessThanOrEqual(1);
        expect(bucket.count).toBeGreaterThan(0);
      }
    });

    it('should handle NO direction trades correctly', () => {
      // NO trades: probability wird invertiert
      const trades = [
        createTrade(0.3, 0.1, 0.1, 'no'), // P(no win) = 1 - 0.4 = 0.6
        createTrade(0.25, 0.05, 0.05, 'no'),
      ];

      const buckets = calculateCalibrationBuckets(trades);

      // Sollte Buckets erstellen
      expect(buckets.length).toBeGreaterThan(0);
    });
  });

  describe('analyzeCalibration', () => {
    it('should handle empty buckets', () => {
      const analysis = analyzeCalibration([]);

      expect(analysis.isOverconfident).toBe(false);
      expect(analysis.isUnderconfident).toBe(false);
      expect(analysis.avgDeviation).toBe(0);
      expect(analysis.worstBucket).toBeNull();
      expect(analysis.recommendation).toContain('Nicht genug Daten');
    });

    it('should detect overconfidence', () => {
      // Predicted > Actual = overconfident
      const buckets: CalibrationBucket[] = [
        { range: [0.7, 0.8], predictedAvg: 0.75, actualAvg: 0.50, count: 10 },
        { range: [0.8, 0.9], predictedAvg: 0.85, actualAvg: 0.60, count: 10 },
      ];

      const analysis = analyzeCalibration(buckets);

      expect(analysis.isOverconfident).toBe(true);
      expect(analysis.isUnderconfident).toBe(false);
      expect(analysis.avgDeviation).toBeGreaterThan(0);
      expect(analysis.recommendation).toContain('Overconfident');
    });

    it('should detect underconfidence', () => {
      // Predicted < Actual = underconfident
      const buckets: CalibrationBucket[] = [
        { range: [0.5, 0.6], predictedAvg: 0.55, actualAvg: 0.75, count: 10 },
        { range: [0.6, 0.7], predictedAvg: 0.65, actualAvg: 0.85, count: 10 },
      ];

      const analysis = analyzeCalibration(buckets);

      expect(analysis.isUnderconfident).toBe(true);
      expect(analysis.isOverconfident).toBe(false);
      expect(analysis.avgDeviation).toBeLessThan(0);
      expect(analysis.recommendation).toContain('Underconfident');
    });

    it('should identify good calibration', () => {
      // Predicted ~= Actual
      const buckets: CalibrationBucket[] = [
        { range: [0.6, 0.7], predictedAvg: 0.65, actualAvg: 0.64, count: 10 },
        { range: [0.7, 0.8], predictedAvg: 0.75, actualAvg: 0.76, count: 10 },
      ];

      const analysis = analyzeCalibration(buckets);

      expect(analysis.isOverconfident).toBe(false);
      expect(analysis.isUnderconfident).toBe(false);
      expect(Math.abs(analysis.avgDeviation)).toBeLessThan(0.05);
      expect(analysis.recommendation).toContain('gut');
    });

    it('should identify worst bucket', () => {
      const buckets: CalibrationBucket[] = [
        { range: [0.5, 0.6], predictedAvg: 0.55, actualAvg: 0.54, count: 10 },
        { range: [0.8, 0.9], predictedAvg: 0.85, actualAvg: 0.50, count: 10 }, // Worst
        { range: [0.6, 0.7], predictedAvg: 0.65, actualAvg: 0.63, count: 10 },
      ];

      const analysis = analyzeCalibration(buckets);

      expect(analysis.worstBucket).toBeDefined();
      expect(analysis.worstBucket!.range[0]).toBe(0.8);
    });
  });

  describe('calculateECE', () => {
    it('should return 0 for empty buckets', () => {
      const ece = calculateECE([]);
      expect(ece).toBe(0);
    });

    it('should calculate weighted calibration error', () => {
      const buckets: CalibrationBucket[] = [
        { range: [0.5, 0.6], predictedAvg: 0.55, actualAvg: 0.55, count: 10 }, // Error: 0
        { range: [0.7, 0.8], predictedAvg: 0.75, actualAvg: 0.65, count: 10 }, // Error: 0.10
      ];

      const ece = calculateECE(buckets);

      // Weighted average: (10 * 0 + 10 * 0.10) / 20 = 0.05
      expect(ece).toBeCloseTo(0.05, 2);
    });

    it('should weight by count', () => {
      const buckets: CalibrationBucket[] = [
        { range: [0.5, 0.6], predictedAvg: 0.55, actualAvg: 0.55, count: 90 }, // Error: 0
        { range: [0.7, 0.8], predictedAvg: 0.75, actualAvg: 0.65, count: 10 }, // Error: 0.10
      ];

      const ece = calculateECE(buckets);

      // Weighted average: (90 * 0 + 10 * 0.10) / 100 = 0.01
      expect(ece).toBeCloseTo(0.01, 2);
    });
  });

  describe('interpretECE', () => {
    it('should interpret ECE values correctly', () => {
      expect(interpretECE(0.01)).toBe('exzellent');
      expect(interpretECE(0.03)).toBe('gut');
      expect(interpretECE(0.07)).toBe('akzeptabel');
      expect(interpretECE(0.12)).toBe('marginal');
      expect(interpretECE(0.2)).toBe('schlecht');
    });
  });
});
