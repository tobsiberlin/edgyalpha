/**
 * Risk Gates Modul
 * Zentrale Risk-Management Logik für gestufte Execution
 */

import { RiskChecks, MarketQuality } from './types.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
//                         INTERFACES
// ═══════════════════════════════════════════════════════════════

export interface RiskState {
  dailyPnL: number;
  openPositions: number;
  positionsPerMarket: Map<string, number>;
  killSwitchActive: boolean;
  lastReset: Date;
}

export interface RiskConfig {
  maxDailyLoss: number;    // Default: 100 USDC
  maxPositions: number;    // Default: 10
  maxPerMarket: number;    // Default: 50 USDC
  minLiquidity: number;    // Default: 0.3
  maxSpread: number;       // Default: 0.05
}

export interface RiskCheckResult {
  checks: RiskChecks;
  passed: boolean;
  failedReasons: string[];
}

// ═══════════════════════════════════════════════════════════════
//                         DEFAULTS
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxDailyLoss: 100,
  maxPositions: 10,
  maxPerMarket: 50,
  minLiquidity: 0.3,
  maxSpread: 0.05,
};

// ═══════════════════════════════════════════════════════════════
//                      GLOBAL RISK STATE
// ═══════════════════════════════════════════════════════════════

// In-Memory Risk State (später DB-backed)
let riskState: RiskState = {
  dailyPnL: 0,
  openPositions: 0,
  positionsPerMarket: new Map(),
  killSwitchActive: false,
  lastReset: new Date(),
};

// ═══════════════════════════════════════════════════════════════
//                      CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Prüft alle Risk-Gates für einen potenziellen Trade
 */
export function checkRiskGates(
  sizeUsdc: number,
  marketId: string,
  quality: MarketQuality,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): RiskCheckResult {
  const failedReasons: string[] = [];

  // 1. Kill Switch Check
  const killSwitchOk = !riskState.killSwitchActive;
  if (!killSwitchOk) {
    failedReasons.push('Kill-Switch ist aktiv');
  }

  // 2. Daily Loss Check
  const dailyLossOk = (riskState.dailyPnL + sizeUsdc) >= -config.maxDailyLoss;
  if (!dailyLossOk) {
    failedReasons.push(
      `Tägliches Verlust-Limit erreicht: ${riskState.dailyPnL.toFixed(2)} USDC (Max: -${config.maxDailyLoss} USDC)`
    );
  }

  // 3. Max Positions Check
  const maxPositionsOk = riskState.openPositions < config.maxPositions;
  if (!maxPositionsOk) {
    failedReasons.push(
      `Maximale Positionen erreicht: ${riskState.openPositions}/${config.maxPositions}`
    );
  }

  // 4. Per-Market Cap Check
  const currentMarketExposure = riskState.positionsPerMarket.get(marketId) || 0;
  const perMarketCapOk = (currentMarketExposure + sizeUsdc) <= config.maxPerMarket;
  if (!perMarketCapOk) {
    failedReasons.push(
      `Markt-Cap erreicht: ${currentMarketExposure.toFixed(2)} + ${sizeUsdc.toFixed(2)} > ${config.maxPerMarket} USDC`
    );
  }

  // 5. Liquidity Check
  const liquidityOk = quality.liquidityScore >= config.minLiquidity;
  if (!liquidityOk) {
    failedReasons.push(
      `Zu geringe Liquidität: ${(quality.liquidityScore * 100).toFixed(1)}% (Min: ${(config.minLiquidity * 100).toFixed(1)}%)`
    );
  }

  // 6. Spread Check
  const spreadOk = quality.spreadProxy <= config.maxSpread;
  if (!spreadOk) {
    failedReasons.push(
      `Spread zu hoch: ${(quality.spreadProxy * 100).toFixed(2)}% (Max: ${(config.maxSpread * 100).toFixed(2)}%)`
    );
  }

  const checks: RiskChecks = {
    dailyLossOk,
    maxPositionsOk,
    perMarketCapOk,
    liquidityOk,
    spreadOk,
    killSwitchOk,
  };

  const passed = Object.values(checks).every(Boolean);

  // Logging
  if (!passed) {
    logger.warn(`Risk-Gates fehlgeschlagen für Markt ${marketId}:`, {
      failedReasons,
      checks,
      sizeUsdc,
    });
  } else {
    logger.debug(`Risk-Gates bestanden für Markt ${marketId}`, { sizeUsdc, checks });
  }

  return {
    checks,
    passed,
    failedReasons,
  };
}

/**
 * Aktualisiert den Risk-State nach einem Trade
 */
export function updateRiskState(
  pnl: number,
  marketId: string,
  sizeChange: number
): void {
  // PnL aktualisieren
  riskState.dailyPnL += pnl;

  // Positions-Tracking
  if (sizeChange > 0) {
    // Position eröffnet
    riskState.openPositions += 1;
    const current = riskState.positionsPerMarket.get(marketId) || 0;
    riskState.positionsPerMarket.set(marketId, current + sizeChange);
  } else if (sizeChange < 0) {
    // Position geschlossen/reduziert
    const current = riskState.positionsPerMarket.get(marketId) || 0;
    const newValue = Math.max(0, current + sizeChange);

    if (newValue <= 0) {
      riskState.positionsPerMarket.delete(marketId);
      riskState.openPositions = Math.max(0, riskState.openPositions - 1);
    } else {
      riskState.positionsPerMarket.set(marketId, newValue);
    }
  }

  logger.info(`Risk-State aktualisiert:`, {
    dailyPnL: riskState.dailyPnL.toFixed(2),
    openPositions: riskState.openPositions,
    marketExposure: marketId ? riskState.positionsPerMarket.get(marketId) : undefined,
  });
}

/**
 * Setzt den täglichen Risk-State zurück (z.B. um Mitternacht)
 */
export function resetDailyRisk(): void {
  const previousPnL = riskState.dailyPnL;

  riskState = {
    dailyPnL: 0,
    openPositions: riskState.openPositions, // Positions bleiben
    positionsPerMarket: riskState.positionsPerMarket, // Positions bleiben
    killSwitchActive: false, // Kill-Switch wird zurückgesetzt
    lastReset: new Date(),
  };

  logger.info(`Täglicher Risk-Reset durchgeführt`, {
    previousPnL: previousPnL.toFixed(2),
    newPnL: 0,
  });
}

/**
 * Aktiviert den Kill-Switch (sofortiger Stopp aller Trades)
 */
export function activateKillSwitch(): void {
  riskState.killSwitchActive = true;
  logger.warn('KILL-SWITCH AKTIVIERT - Alle Trades gestoppt!');
}

/**
 * Deaktiviert den Kill-Switch
 */
export function deactivateKillSwitch(): void {
  riskState.killSwitchActive = false;
  logger.info('Kill-Switch deaktiviert - Trading wieder aktiv');
}

/**
 * Gibt den aktuellen Risk-State zurück
 */
export function getRiskState(): RiskState {
  return { ...riskState, positionsPerMarket: new Map(riskState.positionsPerMarket) };
}

/**
 * Setzt den kompletten Risk-State (für Tests)
 */
export function setRiskState(newState: Partial<RiskState>): void {
  riskState = {
    ...riskState,
    ...newState,
    positionsPerMarket: newState.positionsPerMarket
      ? new Map(newState.positionsPerMarket)
      : riskState.positionsPerMarket,
  };
}

/**
 * Prüft ob der Kill-Switch aktiv ist
 */
export function isKillSwitchActive(): boolean {
  return riskState.killSwitchActive;
}

/**
 * Berechnet verfügbares Risk-Budget
 */
export function getAvailableRiskBudget(config: RiskConfig = DEFAULT_RISK_CONFIG): number {
  const dailyLossRemaining = config.maxDailyLoss + riskState.dailyPnL;
  return Math.max(0, dailyLossRemaining);
}

export default {
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
};
