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

// News Candidates Repository
export {
  createCandidate,
  setMatchResult,
  setGateResults,
  markAsPushed,
  rejectCandidate,
  queueForPush,
  getCandidatesForPush,
  getCandidatesForMatching,
  getCandidateById,
  getCandidateByHash,
  getCandidateByTitle,
  getRecentCandidates,
  getCandidateStats,
  expireOldCandidates,
  cleanupOldCandidates,
} from './newsCandidates.js';
export type {
  NewsCandidate,
  CandidateStatus,
  CandidateStats,
  GateResult,
  GateResults,
  CreateCandidateInput,
} from './newsCandidates.js';

// Pipeline Health Repository
export {
  recordPipelineSuccess,
  recordPipelineError,
  getAllPipelineStatus,
  getPipelineStatus,
  isPipelineStale,
  recordDataFreshness,
  getDataFreshness,
  isDataStale,
  getSystemHealthDashboard,
} from './pipelineHealth.js';
export type {
  PipelineStatus,
  DataFreshness,
  SystemHealthDashboard,
} from './pipelineHealth.js';

// Risk State Repository
export {
  loadRiskState,
  saveRiskState,
  resetDailyInDb,
  writeAuditLog,
  getAuditLog,
} from './riskState.js';
export type { PersistedRiskState, AuditLogEntry } from './riskState.js';
