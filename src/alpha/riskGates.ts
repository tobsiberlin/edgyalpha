/**
 * Risk Gates Modul
 * Zentrale Risk-Management Logik für gestufte Execution
 *
 * KRITISCH: Risk State wird in SQLite persistiert und überlebt Server-Restarts.
 * Kill-Switch, Daily PnL, Positions - alles bleibt erhalten.
 */

import { RiskChecks, MarketQuality } from './types.js';
import logger from '../utils/logger.js';
import {
  loadRiskState as loadPersistedRiskState,
  saveRiskState as savePersistedRiskState,
  writeAuditLog,
} from '../storage/repositories/riskState.js';
import { isDatabaseInitialized } from '../storage/db.js';

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
  maxDailyLoss: number;         // Default: 100 USDC
  maxPositions: number;         // Default: 10
  maxPerMarket: number;         // Default: 50 USDC
  maxPerMarketPercent: number;  // Default: 0.10 (10% of bankroll)
  minLiquidity: number;         // Default: 0.3
  maxSpread: number;            // Default: 0.05
  maxSlippagePercent: number;   // Default: 0.02 (2%)
  minOrderbookDepth: number;    // Default: 2x Trade Size (Liquidität)
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
  maxPerMarketPercent: 0.10, // 10% of bankroll
  minLiquidity: 0.3,
  maxSpread: 0.05,
  maxSlippagePercent: 0.02,  // 2%
  minOrderbookDepth: 2,      // 2x Trade Size
};

// ═══════════════════════════════════════════════════════════════
//                      GLOBAL RISK STATE
// ═══════════════════════════════════════════════════════════════

// In-Memory Risk State - wird beim Start aus SQLite geladen
let riskState: RiskState = {
  dailyPnL: 0,
  openPositions: 0,
  positionsPerMarket: new Map(),
  killSwitchActive: false,
  lastReset: new Date(),
};

// Flag ob State bereits aus DB geladen wurde
let stateInitialized = false;

// Consecutive Failure Tracker für Auto-Kill-Switch
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.CONSECUTIVE_FAILURES_KILL || '3', 10);

/**
 * Lädt den Risk State aus SQLite (beim ersten Zugriff)
 * KRITISCH: Muss vor jedem Risk-Check aufgerufen werden
 */
function ensureStateInitialized(): void {
  if (stateInitialized) return;

  // Prüfe ob DB verfügbar ist
  if (!isDatabaseInitialized()) {
    logger.debug('[RISK] Datenbank noch nicht initialisiert, nutze Default-State');
    return;
  }

  try {
    const persisted = loadPersistedRiskState();

    // Konvertiere persistierten State in In-Memory Format
    riskState = {
      dailyPnL: persisted.dailyPnL,
      openPositions: Object.keys(persisted.positions).length,
      positionsPerMarket: new Map(
        Object.entries(persisted.positions).map(([marketId, pos]) => [marketId, pos.size])
      ),
      killSwitchActive: persisted.killSwitchActive,
      lastReset: persisted.updatedAt,
    };

    stateInitialized = true;

    logger.info('[RISK] Risk State aus SQLite geladen', {
      dailyPnL: riskState.dailyPnL.toFixed(2),
      openPositions: riskState.openPositions,
      killSwitchActive: riskState.killSwitchActive,
    });

    // Warnung wenn Kill-Switch aktiv war
    if (riskState.killSwitchActive) {
      logger.warn('[RISK] KILL-SWITCH WAR AKTIV beim Start!');
    }
  } catch (err) {
    logger.warn(`[RISK] Konnte Risk State nicht aus DB laden: ${(err as Error).message}`);
    // Fallback: Nutze Default-State
    stateInitialized = true;
  }
}

/**
 * Persistiert den aktuellen Risk State in SQLite
 * Wird bei JEDER Änderung aufgerufen
 */
function persistRiskState(): void {
  if (!isDatabaseInitialized()) {
    logger.debug('[RISK] Datenbank nicht initialisiert, Skip Persistierung');
    return;
  }

  try {
    // Konvertiere In-Memory State in DB-Format
    const positions: Record<string, { size: number; entryPrice: number; direction: 'yes' | 'no' }> = {};
    for (const [marketId, size] of riskState.positionsPerMarket.entries()) {
      positions[marketId] = { size, entryPrice: 0, direction: 'yes' };
    }

    savePersistedRiskState({
      dailyPnL: riskState.dailyPnL,
      killSwitchActive: riskState.killSwitchActive,
      totalExposure: Array.from(riskState.positionsPerMarket.values()).reduce((sum, size) => sum + size, 0),
      positions,
    });

    logger.debug('[RISK] Risk State in SQLite persistiert');
  } catch (err) {
    logger.error(`[RISK] Fehler beim Persistieren des Risk State: ${(err as Error).message}`);
  }
}

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
  // Stelle sicher dass State aus DB geladen ist
  ensureStateInitialized();

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
 * PERSISTIERT automatisch in SQLite
 */
export function updateRiskState(
  pnl: number,
  marketId: string,
  sizeChange: number
): void {
  // Stelle sicher dass State aus DB geladen ist
  ensureStateInitialized();

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

  // KRITISCH: In SQLite persistieren
  persistRiskState();
}

/**
 * Setzt den täglichen Risk-State zurück (z.B. um Mitternacht)
 * PERSISTIERT automatisch in SQLite
 */
export function resetDailyRisk(): void {
  ensureStateInitialized();

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

  // KRITISCH: In SQLite persistieren
  persistRiskState();

  // Audit Log
  if (isDatabaseInitialized()) {
    try {
      writeAuditLog({
        eventType: 'daily_reset',
        actor: 'system',
        action: `Daily Risk Reset: PnL ${previousPnL.toFixed(2)} → 0`,
        details: { previousPnL },
        riskStateBefore: { dailyPnL: previousPnL },
        riskStateAfter: { dailyPnL: 0 },
      });
    } catch {
      // Audit Log Fehler ignorieren
    }
  }
}

/**
 * Aktiviert den Kill-Switch (sofortiger Stopp aller Trades)
 * PERSISTIERT automatisch in SQLite - überlebt Server-Restart!
 */
export function activateKillSwitch(reason: string = 'Manuell aktiviert'): void {
  ensureStateInitialized();

  riskState.killSwitchActive = true;
  logger.warn(`KILL-SWITCH AKTIVIERT - Alle Trades gestoppt! Grund: ${reason}`);

  // KRITISCH: In SQLite persistieren
  persistRiskState();

  // Audit Log
  if (isDatabaseInitialized()) {
    try {
      writeAuditLog({
        eventType: 'kill_switch',
        actor: 'system',
        action: `KILL-SWITCH AKTIVIERT: ${reason}`,
        riskStateBefore: { killSwitchActive: false },
        riskStateAfter: { killSwitchActive: true },
      });
    } catch {
      // Audit Log Fehler ignorieren
    }
  }
}

/**
 * Deaktiviert den Kill-Switch
 * PERSISTIERT automatisch in SQLite
 */
export function deactivateKillSwitch(): void {
  ensureStateInitialized();

  riskState.killSwitchActive = false;
  logger.info('Kill-Switch deaktiviert - Trading wieder aktiv');

  // KRITISCH: In SQLite persistieren
  persistRiskState();

  // Audit Log
  if (isDatabaseInitialized()) {
    try {
      writeAuditLog({
        eventType: 'kill_switch',
        actor: 'system',
        action: 'KILL-SWITCH DEAKTIVIERT',
        riskStateBefore: { killSwitchActive: true },
        riskStateAfter: { killSwitchActive: false },
      });
    } catch {
      // Audit Log Fehler ignorieren
    }
  }
}

/**
 * Gibt den aktuellen Risk-State zurück
 * Lädt automatisch aus SQLite wenn noch nicht initialisiert
 */
export function getRiskState(): RiskState {
  ensureStateInitialized();
  return { ...riskState, positionsPerMarket: new Map(riskState.positionsPerMarket) };
}

/**
 * Setzt den kompletten Risk-State (für Tests und manuelles Override)
 * PERSISTIERT automatisch in SQLite
 */
export function setRiskState(newState: Partial<RiskState>): void {
  riskState = {
    ...riskState,
    ...newState,
    positionsPerMarket: newState.positionsPerMarket
      ? new Map(newState.positionsPerMarket)
      : riskState.positionsPerMarket,
  };

  // Markiere als initialisiert (manuelles Setzen)
  stateInitialized = true;

  // In SQLite persistieren (außer in Tests)
  if (isDatabaseInitialized()) {
    persistRiskState();
  }
}

/**
 * Prüft ob der Kill-Switch aktiv ist
 * Lädt automatisch aus SQLite wenn noch nicht initialisiert
 */
export function isKillSwitchActive(): boolean {
  ensureStateInitialized();
  return riskState.killSwitchActive;
}

/**
 * Berechnet verfügbares Risk-Budget
 */
export function getAvailableRiskBudget(config: RiskConfig = DEFAULT_RISK_CONFIG): number {
  ensureStateInitialized();
  const dailyLossRemaining = config.maxDailyLoss + riskState.dailyPnL;
  return Math.max(0, dailyLossRemaining);
}

/**
 * Initialisiert den Risk State aus SQLite
 * Wird beim Server-Start aufgerufen
 */
export function initializeRiskState(): void {
  stateInitialized = false; // Force Reload
  ensureStateInitialized();
}

/**
 * Gibt zurück ob der State bereits aus DB geladen wurde
 */
export function isRiskStateInitialized(): boolean {
  return stateInitialized;
}

// ═══════════════════════════════════════════════════════════════
//          CONSECUTIVE FAILURE TRACKING (Auto Kill-Switch)
// ═══════════════════════════════════════════════════════════════

/**
 * Registriert einen erfolgreichen Trade - setzt den Failure Counter zurück
 */
export function recordTradeSuccess(): void {
  if (consecutiveFailures > 0) {
    logger.info(`[RISK] Trade erfolgreich - Consecutive Failures zurückgesetzt (war: ${consecutiveFailures})`);
    consecutiveFailures = 0;
  }
}

/**
 * Registriert einen fehlgeschlagenen Trade
 * Aktiviert Kill-Switch automatisch nach N Fehlern in Folge
 */
export function recordTradeFailure(reason: string): void {
  consecutiveFailures++;

  logger.warn(`[RISK] Trade fehlgeschlagen (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${reason}`);

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const killReason = `${consecutiveFailures} fehlgeschlagene Trades in Folge - Letzter Fehler: ${reason}`;
    activateKillSwitch(killReason);

    logger.error(`[RISK] 🚨 AUTO-KILL-SWITCH AKTIVIERT nach ${consecutiveFailures} Fehlern!`);

    // Audit Log für Auto-Kill
    if (isDatabaseInitialized()) {
      try {
        writeAuditLog({
          eventType: 'kill_switch',
          actor: 'system',
          action: `AUTO-KILL: ${killReason}`,
          details: {
            consecutiveFailures,
            maxAllowed: MAX_CONSECUTIVE_FAILURES,
            lastError: reason,
            autoTriggered: true,
          },
        });
      } catch {
        // Audit Log Fehler ignorieren
      }
    }
  }
}

/**
 * Gibt die aktuelle Anzahl aufeinanderfolgender Fehler zurück
 */
export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

/**
 * Setzt den Failure Counter manuell zurück (z.B. nach manuellem Review)
 */
export function resetConsecutiveFailures(): void {
  const previous = consecutiveFailures;
  consecutiveFailures = 0;
  logger.info(`[RISK] Consecutive Failures manuell zurückgesetzt (war: ${previous})`);
}

/**
 * Prüft ob FORCE_PAPER_MODE aktiv ist (Hardware Kill-Switch via ENV)
 */
export function isForcePaperModeActive(): boolean {
  return process.env.FORCE_PAPER_MODE === 'true';
}

// ═══════════════════════════════════════════════════════════════
//          SLIPPAGE & ORDERBOOK DEPTH CHECK
// ═══════════════════════════════════════════════════════════════

export interface OrderbookDepthCheck {
  passed: boolean;
  reason?: string;
  availableLiquidity: number;
  requiredLiquidity: number;
  estimatedSlippage: number;
  maxSlippage: number;
}

/**
 * Prüft Orderbook-Tiefe und schätzt Slippage
 * @param orderbook - Bid/Ask Arrays
 * @param tradeSize - Trade-Größe in USDC
 * @param side - BUY oder SELL
 * @param config - Risk Config
 */
export function checkOrderbookDepth(
  orderbook: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> },
  tradeSize: number,
  side: 'BUY' | 'SELL',
  config: RiskConfig = DEFAULT_RISK_CONFIG
): OrderbookDepthCheck {
  const relevantOrders = side === 'BUY' ? orderbook.asks : orderbook.bids;

  if (!relevantOrders || relevantOrders.length === 0) {
    return {
      passed: false,
      reason: 'Keine Orders im Orderbook',
      availableLiquidity: 0,
      requiredLiquidity: tradeSize * config.minOrderbookDepth,
      estimatedSlippage: 1, // 100%
      maxSlippage: config.maxSlippagePercent,
    };
  }

  // Berechne verfügbare Liquidität und durchschnittlichen Preis
  let cumulativeSize = 0;
  let weightedPriceSum = 0;
  const bestPrice = relevantOrders[0].price;

  for (const order of relevantOrders) {
    const orderValue = order.price * order.size;
    cumulativeSize += orderValue;
    weightedPriceSum += order.price * orderValue;

    if (cumulativeSize >= tradeSize * config.minOrderbookDepth) {
      break;
    }
  }

  const availableLiquidity = cumulativeSize;
  const requiredLiquidity = tradeSize * config.minOrderbookDepth;

  // Durchschnittlicher Fill-Preis
  const avgFillPrice = cumulativeSize > 0 ? weightedPriceSum / cumulativeSize : bestPrice;
  const estimatedSlippage = Math.abs(avgFillPrice - bestPrice) / bestPrice;

  const passed = availableLiquidity >= requiredLiquidity && estimatedSlippage <= config.maxSlippagePercent;

  let reason: string | undefined;
  if (!passed) {
    if (availableLiquidity < requiredLiquidity) {
      reason = `Unzureichende Liquidität: $${availableLiquidity.toFixed(2)} < $${requiredLiquidity.toFixed(2)} (${config.minOrderbookDepth}x Trade)`;
    } else {
      reason = `Slippage zu hoch: ${(estimatedSlippage * 100).toFixed(2)}% > ${(config.maxSlippagePercent * 100).toFixed(2)}%`;
    }
  }

  return {
    passed,
    reason,
    availableLiquidity,
    requiredLiquidity,
    estimatedSlippage,
    maxSlippage: config.maxSlippagePercent,
  };
}

/**
 * Erweiterte Risk-Check mit Bankroll-Prozent und Slippage
 */
export function checkExtendedRiskGates(
  sizeUsdc: number,
  marketId: string,
  quality: MarketQuality,
  bankroll: number,
  orderbook?: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> },
  side?: 'BUY' | 'SELL',
  config: RiskConfig = DEFAULT_RISK_CONFIG
): RiskCheckResult & { orderbookCheck?: OrderbookDepthCheck } {
  // Standard Risk Gates
  const baseResult = checkRiskGates(sizeUsdc, marketId, quality, config);

  // Zusätzlich: Bankroll-Prozent Check
  const maxByPercent = bankroll * config.maxPerMarketPercent;
  const perMarketPercentOk = sizeUsdc <= maxByPercent;

  if (!perMarketPercentOk) {
    baseResult.passed = false;
    baseResult.failedReasons.push(
      `Überschreitet ${(config.maxPerMarketPercent * 100).toFixed(0)}% Bankroll: $${sizeUsdc.toFixed(2)} > $${maxByPercent.toFixed(2)}`
    );
  }

  // Optional: Orderbook Depth Check
  let orderbookCheck: OrderbookDepthCheck | undefined;
  if (orderbook && side) {
    orderbookCheck = checkOrderbookDepth(orderbook, sizeUsdc, side, config);

    if (!orderbookCheck.passed) {
      baseResult.passed = false;
      baseResult.failedReasons.push(orderbookCheck.reason || 'Orderbook Check fehlgeschlagen');
    }
  }

  return {
    ...baseResult,
    orderbookCheck,
  };
}

export default {
  checkRiskGates,
  checkExtendedRiskGates,
  checkOrderbookDepth,
  updateRiskState,
  resetDailyRisk,
  activateKillSwitch,
  deactivateKillSwitch,
  getRiskState,
  setRiskState,
  isKillSwitchActive,
  getAvailableRiskBudget,
  initializeRiskState,
  isRiskStateInitialized,
  DEFAULT_RISK_CONFIG,
  // Consecutive Failure Tracking
  recordTradeSuccess,
  recordTradeFailure,
  getConsecutiveFailures,
  resetConsecutiveFailures,
  isForcePaperModeActive,
};
