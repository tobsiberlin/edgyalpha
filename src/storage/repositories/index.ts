/**
 * Barrel Export für alle Repository-Module
 */

// Events Repository
export {
  insertEvent,
  getEventByHash,
  getRecentEvents,
  updateReliability,
  eventExists,
} from './events.js';

// Markets Repository
export {
  insertSnapshot,
  getLatestSnapshot,
  getSnapshotHistory,
  getActiveMarkets,
} from './markets.js';

// Signals Repository
export {
  insertSignal,
  getSignalById,
  getSignalsByMarket,
  getSignalsByType,
  getRecentSignals,
} from './signals.js';

// Decisions Repository
export {
  insertDecision,
  getDecisionById,
  getDecisionsBySignal,
  getPendingDecisions,
} from './decisions.js';

// Executions Repository
export {
  insertExecution,
  updateExecution,
  getExecutionById,
  getPendingExecutions,
  getExecutionsByMode,
} from './executions.js';

// Outcomes Repository
export {
  insertOutcome,
  getOutcomeByExecution,
  getOutcomesByMarket,
  getCalibrationData,
} from './outcomes.js';
export type { CalibrationDataPoint } from './outcomes.js';

// Historical Repository
export {
  insertTrade,
  insertMarket,
  bulkInsertTrades,
  bulkInsertMarkets,
  getTradesByMarket,
  getMarketResolution,
  getStats,
} from './historical.js';
export type { HistoricalStats } from './historical.js';
