/**
 * Backtest Metriken
 * Berechnet Performance-Metriken aus Trade-Liste
 */

import { BacktestTrade, BacktestMetrics } from '../alpha/types.js';

// ═══════════════════════════════════════════════════════════════
// HAUPT-FUNKTION
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne alle Metriken aus Trade-Liste
 */
export function calculateMetrics(trades: BacktestTrade[]): BacktestMetrics {
  // Nur abgeschlossene Trades mit PnL
  const completedTrades = trades.filter((t) => t.pnl !== null);

  if (completedTrades.length === 0) {
    return {
      totalPnl: 0,
      tradeCount: 0,
      winRate: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      brierScore: 0,
      avgEdgeCapture: 0,
      avgSlippage: 0,
    };
  }

  return {
    totalPnl: calculateTotalPnL(trades),
    tradeCount: completedTrades.length,
    winRate: calculateWinRate(trades),
    maxDrawdown: calculateMaxDrawdown(trades),
    sharpeRatio: calculateSharpeRatio(trades),
    brierScore: calculateBrierScore(trades),
    avgEdgeCapture: calculateEdgeCapture(trades),
    avgSlippage: calculateAvgSlippage(trades),
  };
}

// ═══════════════════════════════════════════════════════════════
// PNL-BERECHNUNGEN
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne Total PnL
 */
export function calculateTotalPnL(trades: BacktestTrade[]): number {
  return trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
}

/**
 * Berechne Win Rate (Anteil profitabler Trades)
 */
export function calculateWinRate(trades: BacktestTrade[]): number {
  const completedTrades = trades.filter((t) => t.pnl !== null);

  if (completedTrades.length === 0) {
    return 0;
  }

  const wins = completedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  return wins / completedTrades.length;
}

/**
 * Berechne Maximum Drawdown
 * Max. Rückgang vom Höchststand
 */
export function calculateMaxDrawdown(
  trades: BacktestTrade[],
  initialBankroll: number = 1000
): number {
  let peak = initialBankroll;
  let maxDrawdown = 0;
  let currentEquity = initialBankroll;

  for (const trade of trades) {
    if (trade.pnl !== null) {
      currentEquity += trade.pnl;

      if (currentEquity > peak) {
        peak = currentEquity;
      }

      const drawdown = peak - currentEquity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  return maxDrawdown;
}

// ═══════════════════════════════════════════════════════════════
// RISIKO-METRIKEN
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne Sharpe Ratio (annualisiert)
 * Annahme: Trades sind gleichmäßig verteilt
 */
export function calculateSharpeRatio(
  trades: BacktestTrade[],
  riskFreeRate: number = 0.05 // 5% jährlich
): number {
  const returns = trades
    .filter((t) => t.pnl !== null && t.size > 0)
    .map((t) => (t.pnl ?? 0) / t.size);

  if (returns.length < 2) {
    return 0;
  }

  // Durchschnittliche Rendite pro Trade
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Standardabweichung
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
    (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return avgReturn > 0 ? Infinity : 0;
  }

  // Annualisierung: Annahme ~250 Trades pro Jahr
  const tradesPerYear = 250;
  const annualizedReturn = avgReturn * tradesPerYear;
  const annualizedStdDev = stdDev * Math.sqrt(tradesPerYear);

  // Sharpe = (Return - RiskFree) / StdDev
  return (annualizedReturn - riskFreeRate) / annualizedStdDev;
}

// ═══════════════════════════════════════════════════════════════
// EDGE-ANALYSE
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne Edge-Capture Rate
 * Verhältnis: realisierter Edge / prognostizierter Edge
 */
export function calculateEdgeCapture(trades: BacktestTrade[]): number {
  const tradesWithEdge = trades.filter(
    (t) => t.actualEdge !== null && t.predictedEdge > 0
  );

  if (tradesWithEdge.length === 0) {
    return 0;
  }

  // Durchschnittlicher realisierter Edge
  const avgActualEdge =
    tradesWithEdge.reduce((sum, t) => sum + (t.actualEdge ?? 0), 0) /
    tradesWithEdge.length;

  // Durchschnittlicher prognostizierter Edge
  const avgPredictedEdge =
    tradesWithEdge.reduce((sum, t) => sum + t.predictedEdge, 0) /
    tradesWithEdge.length;

  if (avgPredictedEdge === 0) {
    return 0;
  }

  // Edge Capture Rate (kann negativ sein bei schlechter Prognose)
  return avgActualEdge / avgPredictedEdge;
}

/**
 * Berechne durchschnittlichen Slippage
 */
export function calculateAvgSlippage(trades: BacktestTrade[]): number {
  if (trades.length === 0) {
    return 0;
  }

  const totalSlippage = trades.reduce((sum, t) => sum + t.slippage, 0);
  return totalSlippage / trades.length;
}

// ═══════════════════════════════════════════════════════════════
// KALIBRIERUNG
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne Brier Score
 * Misst Kalibrierung der Wahrscheinlichkeitsvorhersagen
 * 0 = perfekt, 0.25 = zufällig, 1 = komplett falsch
 */
export function calculateBrierScore(trades: BacktestTrade[]): number {
  const tradesWithOutcome = trades.filter((t) => t.actualEdge !== null);

  if (tradesWithOutcome.length === 0) {
    return 0.25; // Default: Zufall
  }

  let sumSquaredErrors = 0;

  for (const trade of tradesWithOutcome) {
    // Predicted Probability basierend auf Edge und Entry-Preis
    // Edge = P_estimated - P_implied
    // P_estimated = Edge + Entry_Price
    const predictedProb = Math.max(0, Math.min(1, trade.predictedEdge + trade.entryPrice));

    // Actual Outcome: 1 wenn Trade profitabel, 0 sonst
    // Besser: 1 wenn unsere Richtung korrekt war
    const actualOutcome = (trade.actualEdge ?? 0) > 0 ? 1 : 0;

    // Squared Error
    const error = predictedProb - actualOutcome;
    sumSquaredErrors += error * error;
  }

  return sumSquaredErrors / tradesWithOutcome.length;
}

// ═══════════════════════════════════════════════════════════════
// ZUSÄTZLICHE METRIKEN
// ═══════════════════════════════════════════════════════════════

/**
 * Berechne Profit Factor
 * Verhältnis: Gesamtgewinne / Gesamtverluste
 */
export function calculateProfitFactor(trades: BacktestTrade[]): number {
  const completedTrades = trades.filter((t) => t.pnl !== null);

  const grossProfit = completedTrades
    .filter((t) => (t.pnl ?? 0) > 0)
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  const grossLoss = Math.abs(
    completedTrades
      .filter((t) => (t.pnl ?? 0) < 0)
      .reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  );

  if (grossLoss === 0) {
    return grossProfit > 0 ? Infinity : 0;
  }

  return grossProfit / grossLoss;
}

/**
 * Berechne durchschnittliche Trade-Größe
 */
export function calculateAvgTradeSize(trades: BacktestTrade[]): number {
  if (trades.length === 0) {
    return 0;
  }

  return trades.reduce((sum, t) => sum + t.size, 0) / trades.length;
}

/**
 * Berechne durchschnittlichen Gewinn und Verlust
 */
export function calculateAvgWinLoss(
  trades: BacktestTrade[]
): { avgWin: number; avgLoss: number } {
  const completedTrades = trades.filter((t) => t.pnl !== null);

  const wins = completedTrades.filter((t) => (t.pnl ?? 0) > 0);
  const losses = completedTrades.filter((t) => (t.pnl ?? 0) < 0);

  const avgWin =
    wins.length > 0
      ? wins.reduce((sum, t) => sum + (t.pnl ?? 0), 0) / wins.length
      : 0;

  const avgLoss =
    losses.length > 0
      ? losses.reduce((sum, t) => sum + (t.pnl ?? 0), 0) / losses.length
      : 0;

  return { avgWin, avgLoss };
}

/**
 * Berechne Calmar Ratio
 * Annualisierter Return / Max Drawdown
 */
export function calculateCalmarRatio(
  trades: BacktestTrade[],
  initialBankroll: number = 1000,
  periodDays: number = 365
): number {
  const totalPnl = calculateTotalPnL(trades);
  const maxDrawdown = calculateMaxDrawdown(trades, initialBankroll);

  if (maxDrawdown === 0) {
    return totalPnl > 0 ? Infinity : 0;
  }

  // Annualisierter Return
  const annualizedReturn = (totalPnl / initialBankroll) * (365 / periodDays);

  return annualizedReturn / (maxDrawdown / initialBankroll);
}

export default {
  calculateMetrics,
  calculateTotalPnL,
  calculateWinRate,
  calculateMaxDrawdown,
  calculateSharpeRatio,
  calculateEdgeCapture,
  calculateAvgSlippage,
  calculateBrierScore,
  calculateProfitFactor,
  calculateAvgTradeSize,
  calculateAvgWinLoss,
  calculateCalmarRatio,
};
