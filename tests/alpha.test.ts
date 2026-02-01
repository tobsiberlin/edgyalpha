import { describe, it, expect } from 'vitest';
import { calculateAlphaScore, calculateKellyBet } from '../src/scanner/alpha.js';
import { Market } from '../src/types/index.js';

describe('Alpha Score Calculation', () => {
  const mockMarket: Market = {
    id: 'test-market-1',
    question: 'Will Bitcoin reach $100,000 by end of 2024?',
    slug: 'bitcoin-100k-2024',
    category: 'crypto',
    volume24h: 250000,
    totalVolume: 1000000,
    liquidity: 50000,
    outcomes: [
      { id: 'yes', name: 'Yes', price: 0.35, volume24h: 150000 },
      { id: 'no', name: 'No', price: 0.65, volume24h: 100000 },
    ],
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    resolved: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('should calculate a score between 0 and 1', () => {
    const result = calculateAlphaScore(mockMarket);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('should return a direction (YES or NO)', () => {
    const result = calculateAlphaScore(mockMarket);
    expect(['YES', 'NO']).toContain(result.direction);
  });

  it('should include reasoning string', () => {
    const result = calculateAlphaScore(mockMarket);
    expect(typeof result.reasoning).toBe('string');
  });

  it('should boost score with German sources', () => {
    const withoutDE = calculateAlphaScore(mockMarket);
    const withDE = calculateAlphaScore(mockMarket, {
      germanSources: [{ relevance: 0.8, direction: 'YES' }],
    });
    expect(withDE.score).toBeGreaterThanOrEqual(withoutDE.score);
  });
});

describe('Kelly Criterion', () => {
  it('should calculate bet size based on edge', () => {
    const bet = calculateKellyBet(0.1, 2, 1000, 0.25);
    expect(bet).toBeGreaterThanOrEqual(0);
    expect(bet).toBeLessThanOrEqual(1000);
  });

  it('should return a number for any edge', () => {
    const bet = calculateKellyBet(-0.1, 2, 1000, 0.25);
    expect(typeof bet).toBe('number');
    expect(bet).toBeGreaterThanOrEqual(0);
  });

  it('should respect max bet limit', () => {
    const bet = calculateKellyBet(0.5, 2, 10000, 0.5);
    // Max bet is limited by config (default 10)
    expect(bet).toBeLessThanOrEqual(10);
  });
});
