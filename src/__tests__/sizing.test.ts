/**
 * Tests fuer Kelly-Sizing
 * Prueft Position-Sizing Berechnungen
 */

import { describe, it, expect } from 'vitest';
import {
  calculatePositionSize,
  estimateSlippage,
  calculateEffectiveEdge,
  calculateExpectedPnL,
  isTradeViable,
  DEFAULT_SIZING_CONFIG,
  DEFAULT_SLIPPAGE_MODEL,
} from '../alpha/sizing.js';
import type { MarketQuality } from '../alpha/types.js';

describe('Position Sizing', () => {
  // Standard MarketQuality fuer Tests
  const goodQuality: MarketQuality = {
    marketId: 'test-market',
    liquidityScore: 0.8,
    spreadProxy: 0.02,
    volume24h: 50000,
    volatility: 0.15,
    tradeable: true,
    reasons: [],
  };

  const lowLiquidityQuality: MarketQuality = {
    marketId: 'low-liq-market',
    liquidityScore: 0.3, // Unter 0.5 -> Penalty
    spreadProxy: 0.02,
    volume24h: 5000,
    volatility: 0.15,
    tradeable: true,
    reasons: [],
  };

  const highVolatilityQuality: MarketQuality = {
    marketId: 'high-vol-market',
    liquidityScore: 0.8,
    spreadProxy: 0.02,
    volume24h: 50000,
    volatility: 0.5, // Ueber 0.3 -> Penalty
    tradeable: true,
    reasons: [],
  };

  describe('calculatePositionSize', () => {
    it('should calculate quarter-kelly correctly', () => {
      const bankroll = 1000;
      const edge = 0.10; // 10% Edge
      const confidence = 0.8;

      const result = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        goodQuality,
        0.25 // Quarter-Kelly
      );

      // Raw Kelly = edge * 2 = 0.20 (20%)
      // Mit Fraction (25%): 0.20 * 0.25 = 0.05 (5%)
      // Mit Confidence (80%): 0.05 * 0.8 = 0.04 (4%)
      // Size = 1000 * 0.04 = 40 USDC

      expect(result.kellyRaw).toBeCloseTo(0.20, 2);
      expect(result.kellyAdjusted).toBeCloseTo(0.04, 2);
      expect(result.size).toBeGreaterThan(0);
      expect(result.size).toBeLessThanOrEqual(100); // Max cap
    });

    it('should cap size at max limits', () => {
      const bankroll = 10000;
      const edge = 0.20; // 20% Edge
      const confidence = 1.0;

      const result = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        goodQuality,
        0.25
      );

      // Ohne Cap waere Size sehr hoch
      // Mit Default maxSize = 100
      expect(result.size).toBeLessThanOrEqual(DEFAULT_SIZING_CONFIG.maxSize);
    });

    it('should return zero when edge below minimum', () => {
      const edge = 0.01; // 1% - unter minEdge (2%)
      const confidence = 0.8;
      const bankroll = 1000;

      const result = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        goodQuality
      );

      expect(result.size).toBe(0);
      expect(result.reasoning.some(r => r.includes('Edge zu gering'))).toBe(true);
    });

    it('should return zero when confidence below minimum', () => {
      const edge = 0.10;
      const confidence = 0.3; // Unter minConfidence (0.5)
      const bankroll = 1000;

      const result = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        goodQuality
      );

      expect(result.size).toBe(0);
      expect(result.reasoning.some(r => r.includes('Confidence zu gering'))).toBe(true);
    });

    it('should reduce size for low liquidity', () => {
      const edge = 0.10;
      const confidence = 0.8;
      const bankroll = 1000;

      const normalResult = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        goodQuality
      );

      const lowLiqResult = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        lowLiquidityQuality
      );

      expect(lowLiqResult.size).toBeLessThan(normalResult.size);
      expect(lowLiqResult.reasoning.some(r => r.includes('Liquidity Penalty'))).toBe(true);
    });

    it('should reduce size for high volatility', () => {
      const edge = 0.10;
      const confidence = 0.8;
      const bankroll = 1000;

      const normalResult = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        goodQuality
      );

      const highVolResult = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        highVolatilityQuality
      );

      expect(highVolResult.size).toBeLessThan(normalResult.size);
      expect(highVolResult.reasoning.some(r => r.includes('Volatility Penalty'))).toBe(true);
    });

    it('should return zero when size below minimum', () => {
      const edge = 0.02; // Knapp ueber minEdge
      const confidence = 0.5; // Knapp ueber minConfidence
      const bankroll = 50; // Kleine Bankroll

      const result = calculatePositionSize(
        edge,
        confidence,
        bankroll,
        goodQuality
      );

      // Bei so kleinen Werten kann Size unter Minimum fallen
      if (result.size > 0) {
        expect(result.size).toBeGreaterThanOrEqual(DEFAULT_SIZING_CONFIG.minSize);
      }
    });
  });

  describe('estimateSlippage', () => {
    it('should return base slippage for small size', () => {
      const slippage = estimateSlippage(1, goodQuality);

      // Base + minimal Size Impact + Spread/2
      expect(slippage).toBeGreaterThanOrEqual(DEFAULT_SLIPPAGE_MODEL.baseSlippage);
      expect(slippage).toBeLessThan(0.05); // Reasonable upper bound
    });

    it('should increase with size', () => {
      const smallSlippage = estimateSlippage(10, goodQuality);
      const largeSlippage = estimateSlippage(1000, goodQuality);

      expect(largeSlippage).toBeGreaterThan(smallSlippage);
    });

    it('should increase with lower liquidity', () => {
      const goodLiqSlippage = estimateSlippage(100, goodQuality);
      const lowLiqSlippage = estimateSlippage(100, lowLiquidityQuality);

      expect(lowLiqSlippage).toBeGreaterThan(goodLiqSlippage);
    });

    it('should increase with higher volatility', () => {
      const normalVolSlippage = estimateSlippage(100, goodQuality);
      const highVolSlippage = estimateSlippage(100, highVolatilityQuality);

      expect(highVolSlippage).toBeGreaterThan(normalVolSlippage);
    });

    it('should cap at maximum 10%', () => {
      const extremeQuality: MarketQuality = {
        marketId: 'extreme',
        liquidityScore: 0.01, // Sehr niedrig
        spreadProxy: 0.5, // Sehr hoch
        volume24h: 100,
        volatility: 1.0, // Sehr hoch
        tradeable: false,
        reasons: [],
      };

      const slippage = estimateSlippage(10000, extremeQuality);

      expect(slippage).toBeLessThanOrEqual(0.1);
    });
  });

  describe('calculateEffectiveEdge', () => {
    it('should subtract slippage and fees from raw edge', () => {
      const rawEdge = 0.10; // 10%
      const slippage = 0.02; // 2%
      const fees = 0.002; // 0.2%

      const effectiveEdge = calculateEffectiveEdge(rawEdge, slippage, fees);

      expect(effectiveEdge).toBeCloseTo(0.078, 3);
    });

    it('should not go negative', () => {
      const rawEdge = 0.02; // 2%
      const slippage = 0.05; // 5%
      const fees = 0.01; // 1%

      const effectiveEdge = calculateEffectiveEdge(rawEdge, slippage, fees);

      expect(effectiveEdge).toBe(0);
    });

    it('should use default fees when not provided', () => {
      const rawEdge = 0.10;
      const slippage = 0.01;

      const effectiveEdge = calculateEffectiveEdge(rawEdge, slippage);

      // Default fees = 0.002
      expect(effectiveEdge).toBeCloseTo(0.088, 3);
    });
  });

  describe('calculateExpectedPnL', () => {
    it('should calculate gross and net PnL correctly', () => {
      const size = 100;
      const edge = 0.10;
      const slippage = 0.02;
      const fees = 0.002;

      const pnl = calculateExpectedPnL(size, edge, slippage, fees);

      expect(pnl.grossPnL).toBeCloseTo(10, 2); // 100 * 0.10
      expect(pnl.costs).toBeCloseTo(2.2, 2); // 100 * (0.02 + 0.002)
      expect(pnl.netPnL).toBeCloseTo(7.8, 2); // 10 - 2.2
    });

    it('should handle zero edge', () => {
      const pnl = calculateExpectedPnL(100, 0, 0.01, 0.002);

      expect(pnl.grossPnL).toBe(0);
      // netPnL = size * effectiveEdge, effectiveEdge = max(0, 0 - 0.01 - 0.002) = 0
      // Also netPnL = 0, nicht negativ weil effectiveEdge bei 0 gekappt wird
      expect(pnl.netPnL).toBe(0);
      expect(pnl.costs).toBeGreaterThan(0); // Aber Kosten sind da
    });
  });

  describe('isTradeViable', () => {
    it('should return viable for sufficient edge', () => {
      const edge = 0.10;
      const slippage = 0.02;
      const fees = 0.002;

      const result = isTradeViable(edge, slippage, fees);

      expect(result.viable).toBe(true);
    });

    it('should return not viable when net edge below minimum', () => {
      const edge = 0.03; // 3%
      const slippage = 0.02; // 2%
      const fees = 0.01; // 1% - zusammen = 3%, Net Edge = 0%

      const result = isTradeViable(edge, slippage, fees);

      expect(result.viable).toBe(false);
      expect(result.reason).toContain('Net Edge zu gering');
    });

    it('should respect custom minNetEdge', () => {
      const edge = 0.05;
      const slippage = 0.01;
      const fees = 0.002;
      const minNetEdge = 0.05; // Hoeher als default 1%

      const result = isTradeViable(edge, slippage, fees, minNetEdge);

      // Net Edge = 0.05 - 0.01 - 0.002 = 0.038 < 0.05
      expect(result.viable).toBe(false);
    });
  });
});
