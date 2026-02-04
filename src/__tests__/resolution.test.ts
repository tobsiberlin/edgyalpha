/**
 * Tests fuer Trade Resolution Service
 * Prueft Market Resolution Checks und Profit-Berechnung
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../api/polymarket.js', () => ({
  polymarketClient: {
    getMarketById: vi.fn(),
  },
}));

vi.mock('../tracking/index.js', () => ({
  performanceTracker: {
    getPendingTrades: vi.fn().mockReturnValue([]),
    getTrades: vi.fn().mockReturnValue([]),
    resolveTrade: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { TradeResolutionService } from '../tracking/resolution.js';
import { polymarketClient } from '../api/polymarket.js';
import { performanceTracker, TrackedTrade } from '../tracking/index.js';

describe('TradeResolutionService', () => {
  let service: TradeResolutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TradeResolutionService();
  });

  afterEach(() => {
    service.stop();
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize in stopped state', () => {
      expect(service.isActive()).toBe(false);
    });

    it('should have empty cache on init', () => {
      expect(service.getCachedResolutions()).toHaveLength(0);
    });
  });

  describe('Start/Stop', () => {
    it('should start and set running state', () => {
      service.start();
      expect(service.isActive()).toBe(true);
    });

    it('should stop and clear running state', () => {
      service.start();
      service.stop();
      expect(service.isActive()).toBe(false);
    });

    it('should not start twice', () => {
      service.start();
      service.start(); // Should not throw
      expect(service.isActive()).toBe(true);
    });
  });

  describe('checkPendingTrades', () => {
    it('should return empty array when no pending trades', async () => {
      (performanceTracker.getPendingTrades as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const results = await service.checkPendingTrades();

      expect(results).toHaveLength(0);
    });

    it('should check markets for pending trades', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-123',
        strategy: 'arbitrage',
        executionType: 'auto',
        marketId: 'market-abc',
        question: 'Test Market',
        direction: 'yes',
        entryPrice: 0.60,
        size: 100,
        expectedProfit: 10,
        confidence: 0.85,
        createdAt: new Date(),
        status: 'pending',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getPendingTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      // Market not resolved yet
      (polymarketClient.getMarketById as ReturnType<typeof vi.fn>).mockResolvedValue({
        closed: false,
        resolved: false,
      });

      const results = await service.checkPendingTrades();

      expect(polymarketClient.getMarketById).toHaveBeenCalledWith('market-abc');
      expect(results).toHaveLength(0);
    });

    it('should resolve trade when market is resolved with YES outcome', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-456',
        strategy: 'lateEntry',
        executionType: 'auto',
        marketId: 'market-xyz',
        question: 'BTC > 100k',
        direction: 'yes', // User bet YES
        entryPrice: 0.70,
        size: 50,
        expectedProfit: 7,
        confidence: 0.80,
        createdAt: new Date(),
        status: 'filled',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getPendingTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      // Market resolved to YES
      (polymarketClient.getMarketById as ReturnType<typeof vi.fn>).mockResolvedValue({
        closed: true,
        resolved: true,
        outcomes: [
          { name: 'Yes', price: 1.0 },
          { name: 'No', price: 0.0 },
        ],
      });

      const listener = vi.fn();
      service.on('trade_resolved', listener);

      const results = await service.checkPendingTrades();

      expect(results).toHaveLength(1);
      expect(results[0].won).toBe(true); // YES bet, YES outcome = WIN
      expect(results[0].profit).toBeCloseTo(15, 0); // (1 - 0.70) * 50 = 15
      expect(listener).toHaveBeenCalled();
    });

    it('should mark trade as lost when outcome differs from direction', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-789',
        strategy: 'timeDelay',
        executionType: 'manual',
        marketId: 'market-loss',
        question: 'ETH > 5k',
        direction: 'yes', // User bet YES
        entryPrice: 0.65,
        size: 80,
        expectedProfit: 12,
        confidence: 0.75,
        createdAt: new Date(),
        status: 'filled',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getPendingTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      // Market resolved to NO
      (polymarketClient.getMarketById as ReturnType<typeof vi.fn>).mockResolvedValue({
        closed: true,
        resolved: true,
        outcomes: [
          { name: 'Yes', price: 0.0 },
          { name: 'No', price: 1.0 },
        ],
      });

      const results = await service.checkPendingTrades();

      expect(results).toHaveLength(1);
      expect(results[0].won).toBe(false); // YES bet, NO outcome = LOSS
      expect(results[0].profit).toBeCloseTo(-52, 0); // -0.65 * 80 = -52
    });

    it('should handle multiple trades for same market', async () => {
      const trades: TrackedTrade[] = [
        {
          id: 'trade-a',
          strategy: 'arbitrage',
          executionType: 'auto',
          marketId: 'market-multi',
          question: 'Multi Test',
          direction: 'yes',
          entryPrice: 0.55,
          size: 30,
          expectedProfit: 5,
          confidence: 0.80,
          createdAt: new Date(),
          status: 'filled',
          isPaper: true,
          reasoning: [],
        },
        {
          id: 'trade-b',
          strategy: 'arbitrage',
          executionType: 'auto',
          marketId: 'market-multi', // Same market
          question: 'Multi Test',
          direction: 'no', // Different direction
          entryPrice: 0.45,
          size: 30,
          expectedProfit: 5,
          confidence: 0.80,
          createdAt: new Date(),
          status: 'filled',
          isPaper: true,
          reasoning: [],
        },
      ];

      (performanceTracker.getPendingTrades as ReturnType<typeof vi.fn>).mockReturnValue(trades);

      (polymarketClient.getMarketById as ReturnType<typeof vi.fn>).mockResolvedValue({
        closed: true,
        resolved: true,
        outcomes: [
          { name: 'Yes', price: 1.0 },
          { name: 'No', price: 0.0 },
        ],
      });

      const results = await service.checkPendingTrades();

      expect(results).toHaveLength(2);
      expect(results.find(r => r.tradeId === 'trade-a')?.won).toBe(true);
      expect(results.find(r => r.tradeId === 'trade-b')?.won).toBe(false);
    });

    it('should cache resolved markets', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-cache',
        strategy: 'arbitrage',
        executionType: 'auto',
        marketId: 'market-cached',
        question: 'Cache Test',
        direction: 'yes',
        entryPrice: 0.60,
        size: 40,
        expectedProfit: 6,
        confidence: 0.85,
        createdAt: new Date(),
        status: 'filled',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getPendingTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      (polymarketClient.getMarketById as ReturnType<typeof vi.fn>).mockResolvedValue({
        closed: true,
        resolved: true,
        outcomes: [
          { name: 'Yes', price: 1.0 },
          { name: 'No', price: 0.0 },
        ],
      });

      await service.checkPendingTrades();

      expect(service.getCachedResolutions()).toHaveLength(1);
      expect(service.getCachedResolutions()[0].marketId).toBe('market-cached');
    });

    it('should handle API errors gracefully', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-error',
        strategy: 'lateEntry',
        executionType: 'auto',
        marketId: 'market-error',
        question: 'Error Test',
        direction: 'no',
        entryPrice: 0.40,
        size: 25,
        expectedProfit: 3,
        confidence: 0.70,
        createdAt: new Date(),
        status: 'pending',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getPendingTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      (polymarketClient.getMarketById as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API Error')
      );

      // Should not throw
      const results = await service.checkPendingTrades();

      expect(results).toHaveLength(0);
    });
  });

  describe('manualResolve', () => {
    it('should manually resolve a trade as won', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-manual-win',
        strategy: 'timeDelay',
        executionType: 'manual',
        marketId: 'market-manual',
        question: 'Manual Test',
        direction: 'yes',
        entryPrice: 0.50,
        size: 100,
        expectedProfit: 10,
        confidence: 0.75,
        createdAt: new Date(),
        status: 'filled',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      const listener = vi.fn();
      service.on('trade_resolved', listener);

      const result = await service.manualResolve('trade-manual-win', true);

      expect(result).not.toBeNull();
      expect(result?.won).toBe(true);
      expect(result?.profit).toBeCloseTo(50, 0); // (1 - 0.50) * 100 = 50
      expect(performanceTracker.resolveTrade).toHaveBeenCalledWith('trade-manual-win', true, 1);
      expect(listener).toHaveBeenCalled();
    });

    it('should manually resolve a trade as lost', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-manual-loss',
        strategy: 'arbitrage',
        executionType: 'auto',
        marketId: 'market-manual-2',
        question: 'Manual Loss Test',
        direction: 'no',
        entryPrice: 0.35,
        size: 60,
        expectedProfit: 5,
        confidence: 0.65,
        createdAt: new Date(),
        status: 'filled',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      const result = await service.manualResolve('trade-manual-loss', false);

      expect(result).not.toBeNull();
      expect(result?.won).toBe(false);
      expect(result?.profit).toBeCloseTo(-21, 0); // -0.35 * 60 = -21
    });

    it('should return null for non-existent trade', async () => {
      (performanceTracker.getTrades as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = await service.manualResolve('non-existent-trade', true);

      expect(result).toBeNull();
    });
  });

  describe('simulateResolution', () => {
    it('should simulate resolution based on entry price', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-sim',
        strategy: 'lateEntry',
        executionType: 'auto',
        marketId: 'market-sim',
        question: 'Sim Test',
        direction: 'yes',
        entryPrice: 0.90, // High entry = high win probability for YES
        size: 50,
        expectedProfit: 5,
        confidence: 0.90,
        createdAt: new Date(),
        status: 'filled',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      // Mock Math.random to return predictable value
      const mockRandom = vi.spyOn(Math, 'random');
      mockRandom.mockReturnValue(0.5); // Below 0.90 = should win

      const result = await service.simulateResolution('trade-sim');

      expect(result).not.toBeNull();
      expect(result?.won).toBe(true); // 0.5 < 0.90 = win

      mockRandom.mockRestore();
    });

    it('should invert probability for NO direction', async () => {
      const mockTrade: TrackedTrade = {
        id: 'trade-sim-no',
        strategy: 'arbitrage',
        executionType: 'auto',
        marketId: 'market-sim-no',
        question: 'Sim NO Test',
        direction: 'no',
        entryPrice: 0.30, // Low entry for YES = 70% win prob for NO
        size: 40,
        expectedProfit: 4,
        confidence: 0.70,
        createdAt: new Date(),
        status: 'filled',
        isPaper: true,
        reasoning: [],
      };

      (performanceTracker.getTrades as ReturnType<typeof vi.fn>).mockReturnValue([mockTrade]);

      // Win probability for NO = 1 - 0.30 = 0.70
      const mockRandom = vi.spyOn(Math, 'random');
      mockRandom.mockReturnValue(0.5); // Below 0.70 = should win

      const result = await service.simulateResolution('trade-sim-no');

      expect(result).not.toBeNull();
      expect(result?.won).toBe(true);

      mockRandom.mockRestore();
    });

    it('should return null for non-existent trade', async () => {
      (performanceTracker.getTrades as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = await service.simulateResolution('non-existent');

      expect(result).toBeNull();
    });
  });
});
