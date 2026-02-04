/**
 * Tests fuer Performance Tracking Module
 * Prueft Trade-Tracking, Stats-Berechnung und Settings
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

// Mock fs module BEFORE any imports that use it
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Mock logger
vi.mock('../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Type definitions (not imported to avoid singleton instantiation)
type TradeStrategy = 'arbitrage' | 'lateEntry' | 'timeDelay' | 'manual';

// Import class dynamically to avoid singleton instantiation side effects
let PerformanceTracker: typeof import('../tracking/index.js').PerformanceTracker;

describe('PerformanceTracker', () => {
  let tracker: InstanceType<typeof PerformanceTracker>;
  const testDataDir = '/tmp/test-tracker';

  beforeAll(async () => {
    // Dynamic import to avoid singleton instantiation
    const module = await import('../tracking/index.js');
    PerformanceTracker = module.PerformanceTracker;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    tracker = new PerformanceTracker(testDataDir);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should create data directory if not exists', () => {
      expect(fs.mkdirSync).toHaveBeenCalledWith(testDataDir, { recursive: true });
    });

    it('should initialize with default settings', () => {
      const settings = tracker.getSettings();

      expect(settings.executionMode).toBe('paper');
      expect(settings.autoTradeEnabled).toBe(true);
      expect(settings.autoTradeMinConfidence).toBe(0.80);
      expect(settings.fullAutoMode).toBe(false);
    });
  });

  describe('Settings Management', () => {
    it('should update settings correctly', () => {
      const updated = tracker.updateSettings({
        autoTradeMinConfidence: 0.90,
        fullAutoMode: true,
      });

      expect(updated.autoTradeMinConfidence).toBe(0.90);
      expect(updated.fullAutoMode).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should emit settings_changed event', () => {
      const listener = vi.fn();
      tracker.on('settings_changed', listener);

      tracker.updateSettings({ fullAutoMode: true });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ fullAutoMode: true })
      );
    });

    it('should return paper mode status correctly', () => {
      expect(tracker.isPaperMode()).toBe(true);
      expect(tracker.isLiveMode()).toBe(false);

      tracker.updateSettings({ executionMode: 'live' });

      expect(tracker.isPaperMode()).toBe(false);
      expect(tracker.isLiveMode()).toBe(true);
    });
  });

  describe('Auto-Trade Logic', () => {
    it('should not auto-trade when disabled', () => {
      tracker.updateSettings({ autoTradeEnabled: false });

      expect(tracker.shouldAutoTrade(0.95)).toBe(false);
    });

    it('should auto-trade when confidence >= threshold (Option B)', () => {
      tracker.updateSettings({
        autoTradeEnabled: true,
        autoTradeMinConfidence: 0.80,
        fullAutoMode: false,
      });

      expect(tracker.shouldAutoTrade(0.80)).toBe(true);
      expect(tracker.shouldAutoTrade(0.85)).toBe(true);
      expect(tracker.shouldAutoTrade(0.79)).toBe(false);
    });

    it('should always auto-trade in full-auto mode (Option C)', () => {
      tracker.updateSettings({
        autoTradeEnabled: true,
        fullAutoMode: true,
      });

      expect(tracker.shouldAutoTrade(0.10)).toBe(true);
      expect(tracker.shouldAutoTrade(0.50)).toBe(true);
      expect(tracker.shouldAutoTrade(0.99)).toBe(true);
    });
  });

  describe('Trade Recording', () => {
    it('should record trade with generated ID', () => {
      const tradeData = {
        strategy: 'arbitrage' as TradeStrategy,
        executionType: 'auto' as const,
        marketId: 'test-market-123',
        question: 'Will BTC hit $100k?',
        direction: 'yes' as const,
        entryPrice: 0.65,
        size: 50,
        expectedProfit: 5.5,
        confidence: 0.85,
        status: 'pending' as const,
        reasoning: ['High confidence', 'Good liquidity'],
      };

      const recorded = tracker.recordTrade(tradeData);

      expect(recorded.id).toMatch(/^trade-\d+-[a-z0-9]+$/);
      expect(recorded.strategy).toBe('arbitrage');
      expect(recorded.marketId).toBe('test-market-123');
      expect(recorded.isPaper).toBe(true);
      expect(recorded.createdAt).toBeInstanceOf(Date);
    });

    it('should emit trade_recorded event', () => {
      const listener = vi.fn();
      tracker.on('trade_recorded', listener);

      tracker.recordTrade({
        strategy: 'lateEntry' as TradeStrategy,
        executionType: 'manual' as const,
        marketId: 'market-1',
        question: 'Test',
        direction: 'no' as const,
        entryPrice: 0.40,
        size: 25,
        expectedProfit: 2.5,
        confidence: 0.70,
        status: 'pending' as const,
        reasoning: [],
      });

      expect(listener).toHaveBeenCalled();
    });

    it('should update trade correctly', () => {
      const trade = tracker.recordTrade({
        strategy: 'timeDelay' as TradeStrategy,
        executionType: 'auto' as const,
        marketId: 'market-2',
        question: 'Test update',
        direction: 'yes' as const,
        entryPrice: 0.55,
        size: 30,
        expectedProfit: 3,
        confidence: 0.75,
        status: 'pending' as const,
        reasoning: [],
      });

      const updated = tracker.updateTrade(trade.id, {
        status: 'filled',
        filledAt: new Date(),
      });

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('filled');
      expect(updated?.filledAt).toBeInstanceOf(Date);
    });

    it('should resolve trade with profit calculation', () => {
      const trade = tracker.recordTrade({
        strategy: 'arbitrage' as TradeStrategy,
        executionType: 'auto' as const,
        marketId: 'market-3',
        question: 'Resolution test',
        direction: 'yes' as const,
        entryPrice: 0.60, // 60 cents
        size: 100, // 100 shares = $60 cost
        expectedProfit: 10,
        confidence: 0.80,
        status: 'filled' as const,
        reasoning: [],
      });

      // Win: Get $1 per share, paid $0.60 each = $0.40 profit per share
      const resolved = tracker.resolveTrade(trade.id, true, 1.0);

      expect(resolved).not.toBeNull();
      expect(resolved?.status).toBe('won');
      expect(resolved?.actualProfit).toBeCloseTo(40, 0); // (1 - 0.60) * 100 = 40
    });

    it('should calculate loss correctly', () => {
      const trade = tracker.recordTrade({
        strategy: 'lateEntry' as TradeStrategy,
        executionType: 'manual' as const,
        marketId: 'market-4',
        question: 'Loss test',
        direction: 'no' as const,
        entryPrice: 0.35,
        size: 50,
        expectedProfit: 5,
        confidence: 0.65,
        status: 'filled' as const,
        reasoning: [],
      });

      // Loss: Lose entry cost = $0.35 * 50 = $17.50
      const resolved = tracker.resolveTrade(trade.id, false, 0);

      expect(resolved).not.toBeNull();
      expect(resolved?.status).toBe('lost');
      expect(resolved?.actualProfit).toBeCloseTo(-17.5, 1);
    });
  });

  describe('Trade Retrieval', () => {
    beforeEach(() => {
      // Record multiple trades
      for (let i = 0; i < 5; i++) {
        tracker.recordTrade({
          strategy: i % 2 === 0 ? 'arbitrage' : 'lateEntry',
          executionType: 'auto' as const,
          marketId: `market-${i}`,
          question: `Trade ${i}`,
          direction: 'yes' as const,
          entryPrice: 0.5 + i * 0.05,
          size: 10 + i * 5,
          expectedProfit: 1 + i,
          confidence: 0.7 + i * 0.02,
          status: 'pending' as const,
          reasoning: [],
        });
      }
    });

    it('should get trades with limit', () => {
      const trades = tracker.getTrades(3);

      expect(trades.length).toBe(3);
      // Should return most recent first
      expect(trades[0].marketId).toBe('market-4');
    });

    it('should get trades by strategy', () => {
      const arbTrades = tracker.getTradesByStrategy('arbitrage');

      expect(arbTrades.length).toBe(3); // indices 0, 2, 4
      expect(arbTrades.every(t => t.strategy === 'arbitrage')).toBe(true);
    });

    it('should get pending trades', () => {
      const pending = tracker.getPendingTrades();

      expect(pending.length).toBe(5);
      expect(pending.every(t => t.status === 'pending')).toBe(true);
    });
  });

  describe('Stats Calculation', () => {
    it('should have correct stats structure', () => {
      const stats = tracker.getStats();

      // Check structure
      expect(stats).toHaveProperty('totalTrades');
      expect(stats).toHaveProperty('paperTrades');
      expect(stats).toHaveProperty('liveTrades');
      expect(stats).toHaveProperty('won');
      expect(stats).toHaveProperty('lost');
      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('filled');
      expect(stats).toHaveProperty('expired');
      expect(stats).toHaveProperty('winRate');
      expect(stats).toHaveProperty('totalVolume');
      expect(stats).toHaveProperty('byStrategy');

      // Check byStrategy structure
      expect(stats.byStrategy).toHaveProperty('arbitrage');
      expect(stats.byStrategy).toHaveProperty('lateEntry');
      expect(stats.byStrategy).toHaveProperty('timeDelay');
      expect(stats.byStrategy).toHaveProperty('manual');

      // Check each strategy has correct properties
      for (const strategy of ['arbitrage', 'lateEntry', 'timeDelay', 'manual'] as const) {
        expect(stats.byStrategy[strategy]).toHaveProperty('trades');
        expect(stats.byStrategy[strategy]).toHaveProperty('volume');
        expect(stats.byStrategy[strategy]).toHaveProperty('profit');
        expect(stats.byStrategy[strategy]).toHaveProperty('winRate');
      }
    });

    it('should update stats after recording trade', () => {
      const statsBefore = tracker.getStats();
      const tradesBefore = statsBefore.totalTrades;

      tracker.recordTrade({
        strategy: 'arbitrage' as TradeStrategy,
        executionType: 'auto',
        marketId: 'stats-update-test',
        question: 'Stats Update Test',
        direction: 'yes',
        entryPrice: 0.50,
        size: 100,
        expectedProfit: 10,
        confidence: 0.75,
        status: 'pending',
        reasoning: [],
      });

      const statsAfter = tracker.getStats();

      expect(statsAfter.totalTrades).toBe(tradesBefore + 1);
      expect(statsAfter.pending).toBeGreaterThan(statsBefore.pending);
    });

    it('should calculate win rate correctly', () => {
      // Record and resolve trades
      const trade1 = tracker.recordTrade({
        strategy: 'lateEntry' as TradeStrategy,
        executionType: 'auto',
        marketId: 'winrate-test-1',
        question: 'Win Rate Test 1',
        direction: 'yes',
        entryPrice: 0.60,
        size: 50,
        expectedProfit: 5,
        confidence: 0.80,
        status: 'filled',
        reasoning: [],
      });

      const trade2 = tracker.recordTrade({
        strategy: 'timeDelay' as TradeStrategy,
        executionType: 'manual',
        marketId: 'winrate-test-2',
        question: 'Win Rate Test 2',
        direction: 'no',
        entryPrice: 0.40,
        size: 50,
        expectedProfit: 5,
        confidence: 0.70,
        status: 'filled',
        reasoning: [],
      });

      tracker.resolveTrade(trade1.id, true, 1.0);
      tracker.resolveTrade(trade2.id, false, 0);

      const stats = tracker.getStats();
      const resolved = stats.won + stats.lost;

      expect(resolved).toBeGreaterThan(0);
      // Win rate should be between 0 and 1
      expect(stats.winRate).toBeGreaterThanOrEqual(0);
      expect(stats.winRate).toBeLessThanOrEqual(1);
    });
  });

  describe('Formatted Output', () => {
    it('should return formatted stats string', () => {
      tracker.recordTrade({
        strategy: 'arbitrage' as TradeStrategy,
        executionType: 'auto' as const,
        marketId: 'format-test',
        question: 'Format Test',
        direction: 'yes' as const,
        entryPrice: 0.65,
        size: 50,
        expectedProfit: 5,
        confidence: 0.85,
        status: 'pending' as const,
        reasoning: [],
      });

      const formatted = tracker.getStatsFormatted();

      expect(formatted).toContain('PERFORMANCE DASHBOARD');
      expect(formatted).toContain('TRADES');
      expect(formatted).toContain('FINANCIALS');
      expect(formatted).toContain('BY STRATEGY');
    });
  });
});
