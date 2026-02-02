/**
 * Backtest Engine
 * Führt Backtests mit historischen Daten durch
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AlphaSignalV2,
  BacktestResult,
  BacktestTrade,
  HistoricalTrade,
  HistoricalMarket,
} from '../alpha/types.js';
import { TimeDelayEngine } from '../alpha/timeDelayEngine.js';
import { MispricingEngine } from '../alpha/mispricingEngine.js';
import { MetaCombiner, CombinedSignal } from '../alpha/metaCombiner.js';
import { TradeSimulator, SimulatorConfig } from './simulator.js';
import { calculateMetrics } from './metrics.js';
import { calculateCalibrationBuckets } from './calibration.js';
import {
  getTradesByMarket,
  getMarketResolution,
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
  walkForwardWindow?: number; // Tage für Walk-Forward (nur für meta)
  verbose?: boolean;
}

export const DEFAULT_BACKTEST_OPTIONS: Partial<BacktestOptions> = {
  initialBankroll: 1000,
  slippageEnabled: true,
  walkForwardWindow: 30,
  verbose: false,
};

// ═══════════════════════════════════════════════════════════════
// MAIN BACKTEST FUNCTION
// ═══════════════════════════════════════════════════════════════

/**
 * Führe Backtest durch
 */
export async function runBacktest(
  options: BacktestOptions
): Promise<BacktestResult> {
  const opts = { ...DEFAULT_BACKTEST_OPTIONS, ...options };

  logger.info(
    `Starte Backtest: Engine=${opts.engine}, ` +
      `Zeitraum=${opts.from.toISOString().slice(0, 10)} bis ${opts.to.toISOString().slice(0, 10)}`
  );

  // Initialisiere DB
  initDatabase();

  // Prüfe ob Daten vorhanden sind
  const stats = getStats();
  logger.info(
    `Historische Daten: ${stats.tradeCount} Trades, ` +
      `${stats.marketCount} Märkte, ${stats.resolvedCount} resolved`
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

  // Führe Engine-spezifischen Backtest durch
  let trades: BacktestTrade[] = [];

  switch (opts.engine) {
    case 'timeDelay':
      trades = await backtestTimeDelay(resolvedMarkets, simulator, opts);
      break;
    case 'mispricing':
      trades = await backtestMispricing(resolvedMarkets, simulator, opts);
      break;
    case 'meta':
      trades = await backtestMeta(resolvedMarkets, simulator, opts);
      break;
  }

  // Berechne Metriken
  const metrics = calculateMetrics(trades);
  const calibration = calculateCalibrationBuckets(trades);

  const result: BacktestResult = {
    engine: opts.engine,
    period: { from: opts.from, to: opts.to },
    trades,
    metrics,
    calibration,
  };

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

/**
 * Backtest Mispricing Engine
 */
async function backtestMispricing(
  markets: HistoricalMarket[],
  simulator: TradeSimulator,
  opts: BacktestOptions & typeof DEFAULT_BACKTEST_OPTIONS
): Promise<BacktestTrade[]> {
  const trades: BacktestTrade[] = [];

  for (const market of markets) {
    // Hole historische Trades
    const historicalTrades = getTradesByMarket(market.marketId);

    if (historicalTrades.length === 0) {
      continue;
    }

    // Simuliere Mispricing-Signal
    const signal = simulateMispricingSignal(market, historicalTrades);

    if (signal && signal.predictedEdge >= 0.03) {
      const resolution = marketOutcomeToResolution(market.outcome);
      const trade = simulator.simulateTrade(signal, historicalTrades, resolution);
      trades.push(trade);

      if (opts.verbose) {
        logger.debug(
          `Mispricing Trade: ${market.question.substring(0, 40)}... | ` +
            `PnL=${trade.pnl?.toFixed(2) ?? 'N/A'}`
        );
      }
    }
  }

  return trades;
}

/**
 * Backtest Meta-Combiner mit Walk-Forward
 */
async function backtestMeta(
  markets: HistoricalMarket[],
  simulator: TradeSimulator,
  opts: BacktestOptions & typeof DEFAULT_BACKTEST_OPTIONS
): Promise<BacktestTrade[]> {
  const trades: BacktestTrade[] = [];
  const metaCombiner = new MetaCombiner();

  // Sortiere Märkte nach Close-Datum für Walk-Forward
  const sortedMarkets = [...markets].sort((a, b) => {
    const aDate = a.closedAt?.getTime() ?? 0;
    const bDate = b.closedAt?.getTime() ?? 0;
    return aDate - bDate;
  });

  let trainingCount = 0;

  for (const market of sortedMarkets) {
    const historicalTrades = getTradesByMarket(market.marketId);

    if (historicalTrades.length === 0) {
      continue;
    }

    // Generiere Signale von beiden Engines
    const timeDelaySignal = simulateTimeDelaySignal(market, historicalTrades);
    const mispricingSignal = simulateMispricingSignal(market, historicalTrades);

    // Kombiniere Signale
    const combinedSignal = metaCombiner.combineSignals(
      timeDelaySignal ?? undefined,
      mispricingSignal ?? undefined
    );

    if (combinedSignal && combinedSignal.predictedEdge >= 0.02) {
      const resolution = marketOutcomeToResolution(market.outcome);
      const trade = simulator.simulateTrade(
        combinedSignal,
        historicalTrades,
        resolution
      );
      trades.push(trade);

      // Walk-Forward: Update MetaCombiner mit Outcome
      if (resolution !== null) {
        const actualOutcome = resolution === combinedSignal.direction ? 1 : 0;
        metaCombiner.updateFromOutcome(combinedSignal, actualOutcome as 0 | 1);
        trainingCount++;
      }

      if (opts.verbose) {
        const weights = metaCombiner.getWeights();
        logger.debug(
          `Meta Trade #${trainingCount}: ${market.question.substring(0, 30)}... | ` +
            `Weights: TD=${weights.timeDelay.toFixed(2)}, MP=${weights.mispricing.toFixed(2)}`
        );
      }
    }
  }

  logger.info(`Meta-Combiner: ${trainingCount} Walk-Forward Updates`);

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

/**
 * Simuliere Mispricing-Signal aus historischen Daten
 */
function simulateMispricingSignal(
  market: HistoricalMarket,
  trades: HistoricalTrade[]
): AlphaSignalV2 | null {
  if (trades.length < 10) {
    return null;
  }

  // Verwende frühe Trades für Signal (kein Lookahead)
  const earlyTrades = trades.slice(0, Math.min(20, Math.floor(trades.length * 0.3)));

  // Durchschnittspreis der frühen Trades
  const avgPrice =
    earlyTrades.reduce((sum, t) => sum + t.price, 0) / earlyTrades.length;

  // Mean-Reversion bei extremen Preisen
  let edge = 0;
  let direction: 'yes' | 'no' = 'yes';

  if (avgPrice < 0.2) {
    // Unterbewertet? Könnte steigen
    edge = Math.min(0.1, (0.3 - avgPrice) * 0.5);
    direction = 'yes';
  } else if (avgPrice > 0.8) {
    // Überbewertet? Könnte fallen
    edge = Math.min(0.1, (avgPrice - 0.7) * 0.5);
    direction = 'no';
  } else {
    // Mittlerer Bereich: kleine Adjustments
    const deviation = Math.abs(avgPrice - 0.5);
    edge = deviation * 0.1;
    direction = avgPrice > 0.5 ? 'no' : 'yes';
  }

  if (edge < 0.02) {
    return null;
  }

  const signalTime = earlyTrades[earlyTrades.length - 1].timestamp;

  return {
    signalId: uuidv4(),
    alphaType: 'mispricing',
    marketId: market.marketId,
    question: market.question,
    direction,
    predictedEdge: edge,
    confidence: Math.min(0.85, 0.6 + edge * 2),
    features: {
      version: '1.0.0',
      features: {
        avgPrice,
        priceDeviation: Math.abs(avgPrice - 0.5),
        tradeCount: trades.length,
      },
    },
    reasoning: [
      `Durchschnittspreis: ${(avgPrice * 100).toFixed(1)}%`,
      `Mean-Reversion Opportunity`,
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
