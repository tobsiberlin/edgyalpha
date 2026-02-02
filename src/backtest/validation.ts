/**
 * Backtest Validation & Overfitting Prevention
 * Out-of-Sample Testing, Monte Carlo Simulation, Overfitting Detection
 */

import {
  BacktestTrade,
  BacktestMetrics,
  ValidationResult,
  MonteCarloResult,
  OverfittingWarning,
} from '../alpha/types.js';
import { calculateMetrics } from './metrics.js';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// OUT-OF-SAMPLE VALIDATION
// ═══════════════════════════════════════════════════════════════

/**
 * Teilt Trades in Train/Test Split und berechnet separate Metriken
 * @param trades - Alle Trades (zeitlich sortiert)
 * @param splitRatio - Anteil Train-Daten (0.7 = 70% Train, 30% Test)
 */
export function performOutOfSampleValidation(
  trades: BacktestTrade[],
  splitRatio: number = 0.7
): ValidationResult {
  if (trades.length < 10) {
    logger.warn('Zu wenige Trades fuer sinnvolle Out-of-Sample Validation');
    const emptyMetrics = calculateMetrics([]);
    return {
      trainMetrics: emptyMetrics,
      testMetrics: emptyMetrics,
      trainTrades: [],
      testTrades: [],
      splitRatio,
      overfittingWarnings: [{
        type: 'low_trade_count',
        severity: 'high',
        message: `Nur ${trades.length} Trades - nicht genug fuer zuverlaessige Validation`,
        details: { tradeCount: trades.length, minRequired: 10 },
      }],
    };
  }

  // Split-Punkt berechnen
  const splitIndex = Math.floor(trades.length * splitRatio);
  const trainTrades = trades.slice(0, splitIndex);
  const testTrades = trades.slice(splitIndex);

  // Metriken berechnen
  const trainMetrics = calculateMetrics(trainTrades);
  const testMetrics = calculateMetrics(testTrades);

  // Overfitting-Warnungen generieren
  const warnings = detectOverfitting(trainMetrics, testMetrics, trainTrades.length, testTrades.length);

  logger.info(
    `Out-of-Sample Validation: ${trainTrades.length} Train / ${testTrades.length} Test Trades`
  );
  logger.info(
    `  Train PnL: $${trainMetrics.totalPnl.toFixed(2)}, Win Rate: ${(trainMetrics.winRate * 100).toFixed(1)}%`
  );
  logger.info(
    `  Test PnL: $${testMetrics.totalPnl.toFixed(2)}, Win Rate: ${(testMetrics.winRate * 100).toFixed(1)}%`
  );

  if (warnings.length > 0) {
    logger.warn(`${warnings.length} Overfitting-Warnungen erkannt!`);
    for (const w of warnings) {
      logger.warn(`  [${w.severity.toUpperCase()}] ${w.message}`);
    }
  }

  return {
    trainMetrics,
    testMetrics,
    trainTrades,
    testTrades,
    splitRatio,
    overfittingWarnings: warnings,
  };
}

// ═══════════════════════════════════════════════════════════════
// OVERFITTING DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Erkennt potentielle Overfitting-Indikatoren
 */
function detectOverfitting(
  trainMetrics: BacktestMetrics,
  testMetrics: BacktestMetrics,
  trainCount: number,
  testCount: number
): OverfittingWarning[] {
  const warnings: OverfittingWarning[] = [];

  // 1. Sharpe Ratio zu hoch (unrealistisch)
  if (trainMetrics.sharpeRatio > 3) {
    warnings.push({
      type: 'sharpe_too_high',
      severity: trainMetrics.sharpeRatio > 5 ? 'high' : 'medium',
      message: `Train Sharpe Ratio von ${trainMetrics.sharpeRatio.toFixed(2)} ist unrealistisch hoch (>3)`,
      details: {
        trainSharpe: trainMetrics.sharpeRatio,
        testSharpe: testMetrics.sharpeRatio,
      },
    });
  }

  // 2. Grosse Divergenz zwischen Train und Test Performance
  const pnlRatio = testMetrics.totalPnl / (trainMetrics.totalPnl || 1);
  const winRateDiff = Math.abs(trainMetrics.winRate - testMetrics.winRate);
  const sharpeRatio = testMetrics.sharpeRatio / (trainMetrics.sharpeRatio || 0.01);

  if (trainMetrics.totalPnl > 0 && pnlRatio < 0.3) {
    warnings.push({
      type: 'train_test_divergence',
      severity: pnlRatio < 0 ? 'high' : 'medium',
      message: `Test PnL ist nur ${(pnlRatio * 100).toFixed(1)}% der Train PnL - starke Divergenz`,
      details: {
        trainPnl: trainMetrics.totalPnl,
        testPnl: testMetrics.totalPnl,
        ratio: pnlRatio,
      },
    });
  }

  if (winRateDiff > 0.15) {
    warnings.push({
      type: 'train_test_divergence',
      severity: winRateDiff > 0.25 ? 'high' : 'medium',
      message: `Win Rate Differenz von ${(winRateDiff * 100).toFixed(1)}% zwischen Train/Test`,
      details: {
        trainWinRate: trainMetrics.winRate,
        testWinRate: testMetrics.winRate,
        difference: winRateDiff,
      },
    });
  }

  if (trainMetrics.sharpeRatio > 1 && sharpeRatio < 0.4) {
    warnings.push({
      type: 'train_test_divergence',
      severity: sharpeRatio < 0.2 ? 'high' : 'medium',
      message: `Test Sharpe ist nur ${(sharpeRatio * 100).toFixed(1)}% des Train Sharpe`,
      details: {
        trainSharpe: trainMetrics.sharpeRatio,
        testSharpe: testMetrics.sharpeRatio,
        ratio: sharpeRatio,
      },
    });
  }

  // 3. Unrealistische Returns
  // Annualisierte Return > 200% ist verdaechtig
  const annualizedReturn = trainMetrics.totalPnl / 1000 * (365 / Math.max(trainCount, 1) * 0.5); // Grobe Schaetzung
  if (annualizedReturn > 2) {
    warnings.push({
      type: 'unrealistic_returns',
      severity: annualizedReturn > 5 ? 'high' : 'medium',
      message: `Geschaetzte annualisierte Return von ${(annualizedReturn * 100).toFixed(0)}% ist unrealistisch`,
      details: {
        totalPnl: trainMetrics.totalPnl,
        estimatedAnnualReturn: annualizedReturn,
      },
    });
  }

  // 4. Zu wenige Test-Trades
  if (testCount < 20) {
    warnings.push({
      type: 'low_trade_count',
      severity: testCount < 10 ? 'high' : 'medium',
      message: `Nur ${testCount} Test-Trades - statistisch nicht signifikant`,
      details: {
        testCount,
        recommendedMin: 30,
      },
    });
  }

  return warnings;
}

// ═══════════════════════════════════════════════════════════════
// MONTE CARLO SIMULATION
// ═══════════════════════════════════════════════════════════════

/**
 * Fuehrt Monte Carlo Simulation durch
 * Shuffelt Trade-Reihenfolge und berechnet Verteilung der Ergebnisse
 * @param trades - Originale Trade-Liste
 * @param simulations - Anzahl der Simulationen (default: 1000)
 * @param initialBankroll - Start-Kapital
 */
export function runMonteCarloSimulation(
  trades: BacktestTrade[],
  simulations: number = 1000,
  initialBankroll: number = 1000
): MonteCarloResult {
  if (trades.length < 5) {
    logger.warn('Zu wenige Trades fuer Monte Carlo Simulation');
    return createEmptyMonteCarloResult();
  }

  const completedTrades = trades.filter(t => t.pnl !== null);
  if (completedTrades.length < 5) {
    logger.warn('Zu wenige abgeschlossene Trades fuer Monte Carlo');
    return createEmptyMonteCarloResult();
  }

  logger.info(`Monte Carlo Simulation: ${simulations} Durchlaeufe mit ${completedTrades.length} Trades`);

  const pnlResults: number[] = [];
  const winRateResults: number[] = [];
  const maxDrawdownResults: number[] = [];

  for (let i = 0; i < simulations; i++) {
    // Trades zufaellig shuffeln
    const shuffled = shuffleArray([...completedTrades]);

    // Metriken fuer diese Sequenz berechnen
    const simMetrics = calculateSimulationMetrics(shuffled, initialBankroll);

    pnlResults.push(simMetrics.totalPnl);
    winRateResults.push(simMetrics.winRate);
    maxDrawdownResults.push(simMetrics.maxDrawdown);
  }

  // Statistiken berechnen
  const pnlStats = calculateDistributionStats(pnlResults);
  const winRateStats = calculateDistributionStats(winRateResults);
  const drawdownStats = calculateDistributionStats(maxDrawdownResults);

  const result: MonteCarloResult = {
    simulations,
    pnlDistribution: {
      mean: pnlStats.mean,
      median: pnlStats.median,
      stdDev: pnlStats.stdDev,
      percentile5: pnlStats.percentile5,
      percentile25: pnlStats.percentile25,
      percentile75: pnlStats.percentile75,
      percentile95: pnlStats.percentile95,
    },
    winRateDistribution: {
      mean: winRateStats.mean,
      stdDev: winRateStats.stdDev,
      percentile5: winRateStats.percentile5,
      percentile95: winRateStats.percentile95,
    },
    maxDrawdownDistribution: {
      mean: drawdownStats.mean,
      worst: Math.max(...maxDrawdownResults),
      percentile5: drawdownStats.percentile5,
      percentile95: drawdownStats.percentile95,
    },
    confidenceInterval95: {
      pnlLower: pnlStats.percentile5,
      pnlUpper: pnlStats.percentile95,
    },
  };

  logger.info(
    `Monte Carlo Ergebnisse: PnL ${result.confidenceInterval95.pnlLower.toFixed(2)} - ${result.confidenceInterval95.pnlUpper.toFixed(2)} (95% CI)`
  );
  logger.info(
    `  Median PnL: $${pnlStats.median.toFixed(2)}, Worst Drawdown: $${Math.max(...maxDrawdownResults).toFixed(2)}`
  );

  return result;
}

/**
 * Fisher-Yates Shuffle
 */
function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Berechnet Metriken fuer eine Simulation (optimiert fuer Speed)
 */
function calculateSimulationMetrics(
  trades: BacktestTrade[],
  initialBankroll: number
): { totalPnl: number; winRate: number; maxDrawdown: number } {
  let equity = initialBankroll;
  let peak = initialBankroll;
  let maxDrawdown = 0;
  let wins = 0;

  for (const trade of trades) {
    if (trade.pnl !== null) {
      equity += trade.pnl;
      if (trade.pnl > 0) wins++;

      if (equity > peak) {
        peak = equity;
      }
      const drawdown = peak - equity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  return {
    totalPnl: equity - initialBankroll,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    maxDrawdown,
  };
}

/**
 * Berechnet Verteilungs-Statistiken
 */
function calculateDistributionStats(values: number[]): {
  mean: number;
  median: number;
  stdDev: number;
  percentile5: number;
  percentile25: number;
  percentile75: number;
  percentile95: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  return {
    mean,
    median,
    stdDev,
    percentile5: sorted[Math.floor(n * 0.05)],
    percentile25: sorted[Math.floor(n * 0.25)],
    percentile75: sorted[Math.floor(n * 0.75)],
    percentile95: sorted[Math.floor(n * 0.95)],
  };
}

function createEmptyMonteCarloResult(): MonteCarloResult {
  return {
    simulations: 0,
    pnlDistribution: {
      mean: 0,
      median: 0,
      stdDev: 0,
      percentile5: 0,
      percentile25: 0,
      percentile75: 0,
      percentile95: 0,
    },
    winRateDistribution: {
      mean: 0,
      stdDev: 0,
      percentile5: 0,
      percentile95: 0,
    },
    maxDrawdownDistribution: {
      mean: 0,
      worst: 0,
      percentile5: 0,
      percentile95: 0,
    },
    confidenceInterval95: {
      pnlLower: 0,
      pnlUpper: 0,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// ROBUSTNESS CHECK
// ═══════════════════════════════════════════════════════════════

/**
 * Fuehrt umfassenden Robustness-Check durch
 */
export function checkBacktestRobustness(
  validation: ValidationResult,
  monteCarlo: MonteCarloResult
): {
  isRobust: boolean;
  score: number; // 0-100
  issues: string[];
  recommendations: string[];
} {
  const issues: string[] = [];
  const recommendations: string[] = [];
  let score = 100;

  // Overfitting-Warnungen pruefen
  const highSeverityWarnings = validation.overfittingWarnings.filter(w => w.severity === 'high');
  const mediumSeverityWarnings = validation.overfittingWarnings.filter(w => w.severity === 'medium');

  if (highSeverityWarnings.length > 0) {
    score -= highSeverityWarnings.length * 20;
    issues.push(`${highSeverityWarnings.length} schwere Overfitting-Warnungen`);
    recommendations.push('Strategie-Parameter vereinfachen oder mehr Daten sammeln');
  }

  if (mediumSeverityWarnings.length > 0) {
    score -= mediumSeverityWarnings.length * 10;
    issues.push(`${mediumSeverityWarnings.length} mittlere Overfitting-Warnungen`);
  }

  // Monte Carlo Confidence Interval pruefen
  if (monteCarlo.simulations > 0) {
    // Wenn untere Grenze negativ, nicht robust
    if (monteCarlo.confidenceInterval95.pnlLower < 0) {
      score -= 25;
      issues.push('95% Confidence Interval schliesst Verluste ein');
      recommendations.push('Strategie hat zu hohe Varianz - Risiko reduzieren');
    }

    // Hohe Varianz in Ergebnissen
    const coefficientOfVariation = monteCarlo.pnlDistribution.stdDev /
      Math.abs(monteCarlo.pnlDistribution.mean || 1);
    if (coefficientOfVariation > 1.5) {
      score -= 15;
      issues.push(`Hohe Varianz (CV: ${coefficientOfVariation.toFixed(2)})`);
    }

    // Worst-Case Drawdown
    if (monteCarlo.maxDrawdownDistribution.worst > monteCarlo.pnlDistribution.mean * 0.5) {
      score -= 10;
      issues.push('Worst-Case Drawdown uebersteigt halben erwarteten Gewinn');
    }
  }

  // Train vs Test Konsistenz
  if (validation.trainMetrics.totalPnl > 0 && validation.testMetrics.totalPnl <= 0) {
    score -= 30;
    issues.push('Test-Periode zeigt Verluste trotz Train-Gewinnen');
    recommendations.push('Strategie funktioniert nicht out-of-sample - Overfitting wahrscheinlich');
  }

  score = Math.max(0, Math.min(100, score));

  return {
    isRobust: score >= 60 && highSeverityWarnings.length === 0,
    score,
    issues,
    recommendations,
  };
}

export default {
  performOutOfSampleValidation,
  runMonteCarloSimulation,
  checkBacktestRobustness,
};
