/**
 * Tests fuer Risk-Gates
 * Prueft das zentrale Risk-Management System
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkRiskGates,
  updateRiskState,
  resetDailyRisk,
  activateKillSwitch,
  deactivateKillSwitch,
  getRiskState,
  setRiskState,
  isKillSwitchActive,
  getAvailableRiskBudget,
  DEFAULT_RISK_CONFIG,
} from '../alpha/riskGates.js';
import type { MarketQuality } from '../alpha/types.js';

describe('Risk Gates', () => {
  // Vor jedem Test: Reset auf sauberen Zustand
  beforeEach(() => {
    resetDailyRisk();
    deactivateKillSwitch();
    setRiskState({
      dailyPnL: 0,
      openPositions: 0,
      positionsPerMarket: new Map(),
    });
  });

  // Mock MarketQuality fuer Tests
  const goodQuality: MarketQuality = {
    marketId: 'test-market-1',
    liquidityScore: 0.8,
    spreadProxy: 0.02,
    volume24h: 50000,
    volatility: 0.1,
    tradeable: true,
    reasons: [],
  };

  const lowLiquidityQuality: MarketQuality = {
    marketId: 'test-market-2',
    liquidityScore: 0.2, // Unter minLiquidity (0.3)
    spreadProxy: 0.02,
    volume24h: 5000,
    volatility: 0.1,
    tradeable: true,
    reasons: [],
  };

  const highSpreadQuality: MarketQuality = {
    marketId: 'test-market-3',
    liquidityScore: 0.8,
    spreadProxy: 0.08, // Ueber maxSpread (0.05)
    volume24h: 50000,
    volatility: 0.1,
    tradeable: true,
    reasons: [],
  };

  describe('checkRiskGates', () => {
    it('should pass all gates when within limits', () => {
      const result = checkRiskGates(10, 'test-market', goodQuality);

      expect(result.passed).toBe(true);
      expect(result.failedReasons).toHaveLength(0);
      expect(result.checks.dailyLossOk).toBe(true);
      expect(result.checks.maxPositionsOk).toBe(true);
      expect(result.checks.perMarketCapOk).toBe(true);
      expect(result.checks.liquidityOk).toBe(true);
      expect(result.checks.spreadOk).toBe(true);
      expect(result.checks.killSwitchOk).toBe(true);
    });

    it('should fail daily loss gate when exceeded', () => {
      // Die Logik prueft: (dailyPnL + sizeUsdc) >= -maxDailyLoss
      // Bei dailyPnL = -95 und sizeUsdc = 10:
      // (-95 + 10) = -85 >= -100 = true (bestanden)
      //
      // Um zu failen, muss die Bedingung false sein:
      // (dailyPnL + sizeUsdc) < -maxDailyLoss
      // z.B. dailyPnL = -95 und sizeUsdc = 10 ergibt -85 >= -100 = true
      //
      // Nach Code-Analyse: Die Pruefung ist (riskState.dailyPnL + sizeUsdc) >= -config.maxDailyLoss
      // Das bedeutet wenn dailyPnL bereits -101 ist, dann -101 + 10 = -91 >= -100 = true
      // Um zu failen: -101 + 0 = -101 >= -100 = false, oder -150 + 10 = -140 >= -100 = false
      setRiskState({ dailyPnL: -150 });

      const result = checkRiskGates(10, 'test-market', goodQuality);

      expect(result.passed).toBe(false);
      expect(result.checks.dailyLossOk).toBe(false);
      expect(result.failedReasons.some(r => r.includes('Verlust-Limit'))).toBe(true);
    });

    it('should fail max positions gate when at limit', () => {
      // Setze Positionen auf Max (10)
      setRiskState({ openPositions: 10 });

      const result = checkRiskGates(10, 'test-market', goodQuality);

      expect(result.passed).toBe(false);
      expect(result.checks.maxPositionsOk).toBe(false);
      expect(result.failedReasons.some(r => r.includes('Maximale Positionen'))).toBe(true);
    });

    it('should fail per-market cap when exceeded', () => {
      // Setze bestehende Position auf 45 USDC (Max ist 50)
      const positionsMap = new Map([['test-market', 45]]);
      setRiskState({ positionsPerMarket: positionsMap });

      // Trade mit 10 USDC wuerde 55 USDC ergeben > 50 Max
      const result = checkRiskGates(10, 'test-market', goodQuality);

      expect(result.passed).toBe(false);
      expect(result.checks.perMarketCapOk).toBe(false);
      expect(result.failedReasons.some(r => r.includes('Markt-Cap'))).toBe(true);
    });

    it('should fail when kill switch active', () => {
      activateKillSwitch();

      const result = checkRiskGates(10, 'test-market', goodQuality);

      expect(result.passed).toBe(false);
      expect(result.checks.killSwitchOk).toBe(false);
      expect(result.failedReasons.some(r => r.includes('Kill-Switch'))).toBe(true);
    });

    it('should fail liquidity gate when below minimum', () => {
      const result = checkRiskGates(10, 'test-market', lowLiquidityQuality);

      expect(result.passed).toBe(false);
      expect(result.checks.liquidityOk).toBe(false);
      expect(result.failedReasons.some(r => r.includes('Liquidität'))).toBe(true);
    });

    it('should fail spread gate when above maximum', () => {
      const result = checkRiskGates(10, 'test-market', highSpreadQuality);

      expect(result.passed).toBe(false);
      expect(result.checks.spreadOk).toBe(false);
      expect(result.failedReasons.some(r => r.includes('Spread'))).toBe(true);
    });

    it('should collect multiple failure reasons', () => {
      activateKillSwitch();
      setRiskState({ openPositions: 10, dailyPnL: -150 });

      const result = checkRiskGates(10, 'test-market', lowLiquidityQuality);

      expect(result.passed).toBe(false);
      expect(result.failedReasons.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('updateRiskState', () => {
    it('should update daily PnL correctly', () => {
      updateRiskState(15, 'market-1', 10);

      const state = getRiskState();
      expect(state.dailyPnL).toBe(15);
    });

    it('should increment open positions on new trade', () => {
      updateRiskState(0, 'market-1', 10);

      const state = getRiskState();
      expect(state.openPositions).toBe(1);
      expect(state.positionsPerMarket.get('market-1')).toBe(10);
    });

    it('should track multiple market positions', () => {
      updateRiskState(0, 'market-1', 10);
      updateRiskState(0, 'market-2', 20);

      const state = getRiskState();
      expect(state.openPositions).toBe(2);
      expect(state.positionsPerMarket.get('market-1')).toBe(10);
      expect(state.positionsPerMarket.get('market-2')).toBe(20);
    });

    it('should reduce position size correctly', () => {
      updateRiskState(0, 'market-1', 20);
      updateRiskState(5, 'market-1', -10); // Teilweise schliessen

      const state = getRiskState();
      expect(state.positionsPerMarket.get('market-1')).toBe(10);
      expect(state.dailyPnL).toBe(5);
    });

    it('should remove position when fully closed', () => {
      updateRiskState(0, 'market-1', 20);
      updateRiskState(10, 'market-1', -20); // Komplett schliessen

      const state = getRiskState();
      expect(state.positionsPerMarket.has('market-1')).toBe(false);
      expect(state.openPositions).toBe(0);
    });
  });

  describe('resetDailyRisk', () => {
    it('should reset daily PnL to zero', () => {
      setRiskState({ dailyPnL: -50 });
      resetDailyRisk();

      const state = getRiskState();
      expect(state.dailyPnL).toBe(0);
    });

    it('should preserve open positions', () => {
      const positionsMap = new Map([['market-1', 25]]);
      setRiskState({ openPositions: 1, positionsPerMarket: positionsMap });

      resetDailyRisk();

      const state = getRiskState();
      expect(state.openPositions).toBe(1);
      expect(state.positionsPerMarket.get('market-1')).toBe(25);
    });

    it('should deactivate kill switch', () => {
      activateKillSwitch();
      resetDailyRisk();

      expect(isKillSwitchActive()).toBe(false);
    });
  });

  describe('Kill Switch', () => {
    it('should activate kill switch', () => {
      activateKillSwitch();

      expect(isKillSwitchActive()).toBe(true);
    });

    it('should deactivate kill switch', () => {
      activateKillSwitch();
      deactivateKillSwitch();

      expect(isKillSwitchActive()).toBe(false);
    });

    it('should block all trades when active', () => {
      activateKillSwitch();

      const result = checkRiskGates(1, 'any-market', goodQuality);

      expect(result.passed).toBe(false);
      expect(result.checks.killSwitchOk).toBe(false);
    });
  });

  describe('getAvailableRiskBudget', () => {
    it('should return full budget when no losses', () => {
      const budget = getAvailableRiskBudget();

      expect(budget).toBe(DEFAULT_RISK_CONFIG.maxDailyLoss);
    });

    it('should reduce budget by losses', () => {
      setRiskState({ dailyPnL: -30 });

      const budget = getAvailableRiskBudget();

      expect(budget).toBe(70); // 100 - 30
    });

    it('should return zero when limit reached', () => {
      setRiskState({ dailyPnL: -100 });

      const budget = getAvailableRiskBudget();

      expect(budget).toBe(0);
    });

    it('should not go negative', () => {
      setRiskState({ dailyPnL: -150 });

      const budget = getAvailableRiskBudget();

      expect(budget).toBe(0);
    });
  });
});
