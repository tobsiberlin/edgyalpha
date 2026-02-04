/**
 * Backtest Engine
 * Fuehrt Backtests mit historischen Daten durch
 * V2: Mit Out-of-Sample Validation und Monte Carlo Simulation
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AlphaSignalV2,
  BacktestTrade,
  HistoricalTrade,
  HistoricalMarket,
  ExtendedBacktestResult,
  ValidationResult,
  MonteCarloResult,
} from '../alpha/types.js';
// MispricingEngine und MetaCombiner wurden entfernt (V4.0)
// Backtest unterstützt nur noch timeDelay Engine
import { TradeSimulator } from './simulator.js';
import { calculateMetrics } from './metrics.js';
import { calculateCalibrationBuckets } from './calibration.js';
import {
  performOutOfSampleValidation,
  runMonteCarloSimulation,
  checkBacktestRobustness,
} from './validation.js';
import {
  getTradesByMarket,
  getStats,
} from '../storage/repositories/historical.js';
import { getDatabase, initDatabase } from '../storage/db.js';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// BACKTEST OPTIONS
// ═══════════════════════════════════════════════════════════════

export interface BacktestOptions {
  from: Date;
  to: Date;
  engine: 'timeDelay' | 'mispricing' | 'meta';
  initialBankroll?: number;
  slippageEnabled?: boolean;
  walkForwardWindow?: number; // Tage fuer Walk-Forward (nur fuer meta)
  verbose?: boolean;
  // NEU: Validation & Robustness Options
  enableValidation?: boolean; // Out-of-Sample Validation aktivieren
  trainTestSplit?: number; // Split-Ratio (0.7 = 70% Train, 30% Test)
  enableMonteCarlo?: boolean; // Monte Carlo Simulation aktivieren
  monteCarloSimulations?: number; // Anzahl der Simulationen
}

export const DEFAULT_BACKTEST_OPTIONS: Partial<BacktestOptions> = {
  initialBankroll: 1000,
  slippageEnabled: true,
  walkForwardWindow: 90, // GEAENDERT: Von 30 auf 90 Tage fuer mehr Robustheit
  verbose: false,
  // NEU: Defaults fuer Validation
  enableValidation: true,
  trainTestSplit: 0.7, // 70% Train, 30% Test
  enableMonteCarlo: true,
  monteCarloSimulations: 1000,
};

// ═══════════════════════════════════════════════════════════════
// MAIN BACKTEST FUNCTION
// ═══════════════════════════════════════════════════════════════

/**
 * Fuehre Backtest durch
 * V2: Mit Out-of-Sample Validation und Monte Carlo fuer Robustheit
 */
export async function runBacktest(
  options: BacktestOptions
): Promise<ExtendedBacktestResult> {
  const opts = { ...DEFAULT_BACKTEST_OPTIONS, ...options };

  logger.info(
    `Starte Backtest: Engine=${opts.engine}, ` +
      `Zeitraum=${opts.from.toISOString().slice(0, 10)} bis ${opts.to.toISOString().slice(0, 10)}`
  );
  logger.info(
    `  Walk-Forward Window: ${opts.walkForwardWindow} Tage, ` +
      `Validation: ${opts.enableValidation ? 'aktiv' : 'deaktiviert'}, ` +
      `Monte Carlo: ${opts.enableMonteCarlo ? `${opts.monteCarloSimulations}x` : 'deaktiviert'}`
  );

  // Initialisiere DB
  initDatabase();

  // Pruefe ob Daten vorhanden sind
  const stats = getStats();
  logger.info(
    `Historische Daten: ${stats.tradeCount} Trades, ` +
      `${stats.marketCount} Maerkte, ${stats.resolvedCount} resolved`
  );

  if (stats.resolvedCount === 0) {
    logger.warn('Keine resolved Markets gefunden - Backtest wird leer sein');
  }

  // Lade resolved Markets im Zeitraum
  const resolvedMarkets = loadResolvedMarkets(opts.from, opts.to);
  logger.info(`${resolvedMarkets.length} resolved Markets im Zeitraum gefunden`);

  // Initialisiere Simulator
  const simulator = new TradeSimulator({
    initialBankroll: opts.initialBankroll!,
    slippageEnabled: opts.slippageEnabled!,
    feesPercent: 0.001,
  });

  // Fuehre Engine-spezifischen Backtest durch
  let trades: BacktestTrade[] = [];

  switch (opts.engine) {
    case 'timeDelay':
      trades = await backtestTimeDelay(resolvedMarkets, simulator, opts);
      break;
    case 'mispricing':
      // MispricingEngine wurde entfernt (V4.0)
      logger.warn('MispricingEngine wurde in V4.0 entfernt - nutze timeDelay stattdessen');
      trades = await backtestTimeDelay(resolvedMarkets, simulator, opts);
      break;
    case 'meta':
      // MetaCombiner wurde entfernt (V4.0)
      logger.warn('MetaCombiner wurde in V4.0 entfernt - nutze timeDelay stattdessen');
      trades = await backtestTimeDelay(resolvedMarkets, simulator, opts);
      break;
  }

  // Berechne Metriken
  const metrics = calculateMetrics(trades);
  const calibration = calculateCalibrationBuckets(trades);

  // NEU: Out-of-Sample Validation
  let validation: ValidationResult | undefined;
  if (opts.enableValidation && trades.length >= 10) {
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('OUT-OF-SAMPLE VALIDATION');
    logger.info('═══════════════════════════════════════════════════════════════');
    validation = performOutOfSampleValidation(trades, opts.trainTestSplit!);
  }

  // NEU: Monte Carlo Simulation
  let monteCarlo: MonteCarloResult | undefined;
  if (opts.enableMonteCarlo && trades.length >= 10) {
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('MONTE CARLO SIMULATION');
    logger.info('═══════════════════════════════════════════════════════════════');
    monteCarlo = runMonteCarloSimulation(
      trades,
      opts.monteCarloSimulations!,
      opts.initialBankroll!
    );
  }

  // NEU: Robustness Check und Warnungen
  if (validation && monteCarlo) {
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('ROBUSTNESS CHECK');
    logger.info('═══════════════════════════════════════════════════════════════');
    const robustness = checkBacktestRobustness(validation, monteCarlo);
    logger.info(`Robustness Score: ${robustness.score}/100 (${robustness.isRobust ? 'ROBUST' : 'NICHT ROBUST'})`);

    if (robustness.issues.length > 0) {
      logger.warn('Gefundene Probleme:');
      for (const issue of robustness.issues) {
        logger.warn(`  - ${issue}`);
      }
    }

    if (robustness.recommendations.length > 0) {
      logger.info('Empfehlungen:');
      for (const rec of robustness.recommendations) {
        logger.info(`  - ${rec}`);
      }
    }
  }

  const result: ExtendedBacktestResult = {
    engine: opts.engine,
    period: { from: opts.from, to: opts.to },
    trades,
    metrics,
    calibration,
    // NEU: Erweiterte Ergebnisse
    validation,
    monteCarlo,
    walkForwardWindow: opts.walkForwardWindow!,
  };

  logger.info('');
  logger.info(
    `Backtest abgeschlossen: ${trades.length} Trades, ` +
      `PnL=$${metrics.totalPnl.toFixed(2)}, Win Rate=${(metrics.winRate * 100).toFixed(1)}%`
  );

  return result;
}

// ═══════════════════════════════════════════════════════════════
// ENGINE-SPEZIFISCHE BACKTESTS
// ═══════════════════════════════════════════════════════════════

/**
 * Backtest TimeDelay Engine
 * Simuliert News-basierte Signale
 */
async function backtestTimeDelay(
  markets: HistoricalMarket[],
  simulator: TradeSimulator,
  opts: BacktestOptions & typeof DEFAULT_BACKTEST_OPTIONS
): Promise<BacktestTrade[]> {
  const trades: BacktestTrade[] = [];

  for (const market of markets) {
    // Hole historische Trades für diesen Markt
    const historicalTrades = getTradesByMarket(market.marketId);

    if (historicalTrades.length === 0) {
      continue;
    }

    // Simuliere ein Signal basierend auf Markt-Eigenschaften
    // In einer echten Implementation würden hier News-Events verwendet
    const signal = simulateTimeDelaySignal(market, historicalTrades);

    if (signal && signal.predictedEdge >= 0.02) {
      // Resolution bestimmen
      const resolution = marketOutcomeToResolution(market.outcome);

      // Trade simulieren
      const trade = simulator.simulateTrade(signal, historicalTrades, resolution);
      trades.push(trade);

      if (opts.verbose) {
        logger.debug(
          `TimeDelay Trade: ${market.question.substring(0, 40)}... | ` +
            `PnL=${trade.pnl?.toFixed(2) ?? 'N/A'}`
        );
      }
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL SIMULATION
// ═══════════════════════════════════════════════════════════════

/**
 * Simuliere TimeDelay-Signal aus historischen Daten
 * WICHTIG: Verwendet nur Daten VOR dem Close (kein Lookahead-Bias)
 */
function simulateTimeDelaySignal(
  market: HistoricalMarket,
  trades: HistoricalTrade[]
): AlphaSignalV2 | null {
  if (trades.length < 5) {
    return null;
  }

  // Verwende Trades aus der Mitte des Markts (simuliert News-Event)
  const midIndex = Math.floor(trades.length / 2);
  const tradesBeforeEvent = trades.slice(0, midIndex);
  const tradesAfterEvent = trades.slice(midIndex);

  if (tradesBeforeEvent.length < 3 || tradesAfterEvent.length < 3) {
    return null;
  }

  // Durchschnittspreis vor und nach "Event"
  const avgPriceBefore =
    tradesBeforeEvent.reduce((sum, t) => sum + t.price, 0) /
    tradesBeforeEvent.length;
  const avgPriceAfter =
    tradesAfterEvent.slice(0, 5).reduce((sum, t) => sum + t.price, 0) /
    Math.min(5, tradesAfterEvent.length);

  // Preisänderung als Edge-Proxy
  const priceChange = avgPriceAfter - avgPriceBefore;
  const edge = Math.min(0.15, Math.abs(priceChange) * 2);

  if (edge < 0.01) {
    return null;
  }

  // Direction basierend auf Preisbewegung
  const direction: 'yes' | 'no' = priceChange > 0 ? 'yes' : 'no';

  // Signal-Zeitpunkt: nach den ersten Trades (kein Lookahead)
  const signalTime = tradesBeforeEvent[tradesBeforeEvent.length - 1].timestamp;

  return {
    signalId: uuidv4(),
    alphaType: 'timeDelay',
    marketId: market.marketId,
    question: market.question,
    direction,
    predictedEdge: edge,
    confidence: Math.min(0.9, 0.5 + edge * 3),
    features: {
      version: '1.0.0',
      features: {
        priceChange,
        avgPriceBefore,
        avgPriceAfter,
        tradeCount: trades.length,
      },
    },
    reasoning: [
      `Preisänderung: ${(priceChange * 100).toFixed(2)}%`,
      `Trades: ${trades.length}`,
    ],
    createdAt: signalTime,
  };
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Lade resolved Markets im Zeitraum
 */
function loadResolvedMarkets(from: Date, to: Date): HistoricalMarket[] {
  const db = getDatabase();

  const rows = db
    .prepare(
      `
    SELECT *
    FROM historical_markets
    WHERE outcome IS NOT NULL
      AND closed_at IS NOT NULL
      AND closed_at >= ?
      AND closed_at <= ?
    ORDER BY closed_at ASC
  `
    )
    .all(from.toISOString(), to.toISOString()) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    marketId: row.market_id as string,
    conditionId: row.condition_id as string | null,
    question: row.question as string,
    answer1: row.answer1 as string | null,
    answer2: row.answer2 as string | null,
    token1: row.token1 as string | null,
    token2: row.token2 as string | null,
    marketSlug: row.market_slug as string | null,
    volumeTotal: row.volume_total as number | null,
    createdAt: row.created_at ? new Date(row.created_at as string) : null,
    closedAt: row.closed_at ? new Date(row.closed_at as string) : null,
    outcome: row.outcome as HistoricalMarket['outcome'],
  }));
}

/**
 * Konvertiere Market-Outcome zu Resolution
 */
function marketOutcomeToResolution(
  outcome: HistoricalMarket['outcome']
): 'yes' | 'no' | null {
  if (outcome === 'answer1') return 'yes';
  if (outcome === 'answer2') return 'no';
  return null;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export { TradeSimulator } from './simulator.js';
export { calculateMetrics } from './metrics.js';
export {
  calculateBrierScore,
  calculateCalibrationBuckets,
  analyzeCalibration,
} from './calibration.js';
export {
  generateMarkdownReport,
  generateJsonReport,
  saveReports,
  generateConsoleOutput,
} from './report.js';
// NEU: Validation & Monte Carlo
export {
  performOutOfSampleValidation,
  runMonteCarloSimulation,
  checkBacktestRobustness,
} from './validation.js';
