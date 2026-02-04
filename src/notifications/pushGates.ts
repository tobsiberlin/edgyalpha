/**
 * Push Gates - Quality Gates für TIME_DELAY Notifications
 *
 * Ein TIME_DELAY Push darf nur raus, wenn ALLE Gates grün sind.
 * Gates prüfen: Match Quality, Market Quality, Source Quality, System Health
 */

import { logger } from '../utils/logger.js';
import { runtimeState } from '../runtime/state.js';
import { getSystemHealthDashboard } from '../storage/repositories/pipelineHealth.js';
import { GateResult, GateResults, NewsCandidate } from '../storage/repositories/newsCandidates.js';
import { getNotificationSettings, isCategoryEnabled } from './rateLimiter.js';

// ═══════════════════════════════════════════════════════════════
// GATE THRESHOLDS (Defaults)
// ═══════════════════════════════════════════════════════════════

export interface PushGateConfig {
  // Match Quality
  minMatchConfidence: number;     // Min confidence dass News zu Markt passt (0.75)

  // Lag Check
  maxPremove: number;             // Max Preisbewegung letzte N Minuten (0.015 = 1.5%)
  minExpectedLag: number;         // Min erwartete Reaktionszeit in Minuten (8)

  // Market Quality
  minTotalVolume: number;         // Min Total Volume ($50k)
  maxSpreadProxy: number;         // Max Spread (0.05 = 5%)
  minLiquidityScore: number;      // Min Liquidity Score (0.3)

  // Source Quality
  minSourceReliability: number;   // Min Source Reliability (0.6)
  requireMultipleSources: boolean; // Braucht 2+ unabhängige Quellen?
}

const DEFAULT_GATE_CONFIG: PushGateConfig = {
  minMatchConfidence: 0.75,
  maxPremove: 0.015,
  minExpectedLag: 8,
  minTotalVolume: 50000,
  maxSpreadProxy: 0.05,
  minLiquidityScore: 0.3,
  minSourceReliability: 0.6,
  requireMultipleSources: false,
};

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface MarketInfo {
  marketId: string;
  question: string;
  currentPrice: number;
  priceChange5min?: number;
  priceChange15min?: number;
  totalVolume: number;
  volume24h?: number;
  spreadProxy?: number;
  liquidityScore?: number;
  categories?: string[];
  endDate?: Date;
}

export interface SourceInfo {
  sourceId: string;
  sourceName: string;
  reliabilityScore: number;
  additionalSources?: Array<{
    sourceId: string;
    sourceName: string;
    reliabilityScore: number;
  }>;
}

export interface GateEvaluationInput {
  candidate: NewsCandidate;
  market: MarketInfo;
  source: SourceInfo;
  expectedLagMinutes?: number;
}

export interface GateEvaluationResult {
  allPassed: boolean;
  gateResults: GateResults;
  failedGates: string[];
  passedGates: string[];
  summary: string;
}

// ═══════════════════════════════════════════════════════════════
// GATE EVALUATION
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluiert alle Gates für einen News-Kandidaten
 */
export function evaluateGates(
  input: GateEvaluationInput,
  chatId: string,
  config: Partial<PushGateConfig> = {}
): GateEvaluationResult {
  const settings = getNotificationSettings(chatId);
  const cfg = { ...DEFAULT_GATE_CONFIG, ...config };

  // Override thresholds from user settings
  cfg.minMatchConfidence = settings.minMatchConfidence;
  cfg.minTotalVolume = settings.minVolume;

  const gateResults: GateResults = {};
  const failedGates: string[] = [];
  const passedGates: string[] = [];

  // 1. Match Confidence Gate
  gateResults.match_confidence = evaluateMatchConfidenceGate(
    input.candidate.matchConfidence,
    cfg.minMatchConfidence
  );
  if (gateResults.match_confidence.passed) {
    passedGates.push('match_confidence');
  } else {
    failedGates.push('match_confidence');
  }

  // 2. Price Premove Gate
  gateResults.price_premove = evaluatePremoveGate(
    input.market.priceChange5min,
    cfg.maxPremove
  );
  if (gateResults.price_premove.passed) {
    passedGates.push('price_premove');
  } else {
    failedGates.push('price_premove');
  }

  // 3. Expected Lag Gate
  gateResults.expected_lag = evaluateExpectedLagGate(
    input.expectedLagMinutes,
    cfg.minExpectedLag
  );
  if (gateResults.expected_lag.passed) {
    passedGates.push('expected_lag');
  } else {
    failedGates.push('expected_lag');
  }

  // 4. Total Volume Gate
  gateResults.total_volume = evaluateTotalVolumeGate(
    input.market.totalVolume,
    cfg.minTotalVolume
  );
  if (gateResults.total_volume.passed) {
    passedGates.push('total_volume');
  } else {
    failedGates.push('total_volume');
  }

  // 5. Spread Gate
  gateResults.spread_proxy = evaluateSpreadGate(
    input.market.spreadProxy,
    cfg.maxSpreadProxy
  );
  if (gateResults.spread_proxy.passed) {
    passedGates.push('spread_proxy');
  } else {
    failedGates.push('spread_proxy');
  }

  // 6. Liquidity Score Gate
  gateResults.liquidity_score = evaluateLiquidityGate(
    input.market.liquidityScore,
    cfg.minLiquidityScore
  );
  if (gateResults.liquidity_score.passed) {
    passedGates.push('liquidity_score');
  } else {
    failedGates.push('liquidity_score');
  }

  // 7. Source Reliability Gate
  gateResults.source_reliability = evaluateSourceReliabilityGate(
    input.source,
    cfg.minSourceReliability,
    cfg.requireMultipleSources
  );
  if (gateResults.source_reliability.passed) {
    passedGates.push('source_reliability');
  } else {
    failedGates.push('source_reliability');
  }

  // 8. System Health Gate
  gateResults.system_health = evaluateSystemHealthGate();
  if (gateResults.system_health.passed) {
    passedGates.push('system_health');
  } else {
    failedGates.push('system_health');
  }

  // 9. Category Gate (User Settings)
  const categoryPassed = checkCategoryEnabled(input.candidate.categories, chatId);
  if (!categoryPassed) {
    failedGates.push('category_disabled');
  }

  const allPassed = failedGates.length === 0;

  const summary = allPassed
    ? `Alle ${passedGates.length} Gates bestanden`
    : `${failedGates.length} Gate(s) fehlgeschlagen: ${failedGates.join(', ')}`;

  logger.debug(`[PUSH_GATES] ${summary}`);

  return {
    allPassed,
    gateResults,
    failedGates,
    passedGates,
    summary,
  };
}

// ═══════════════════════════════════════════════════════════════
// INDIVIDUAL GATE EVALUATIONS
// ═══════════════════════════════════════════════════════════════

function evaluateMatchConfidenceGate(
  confidence: number | null,
  threshold: number
): GateResult {
  const value = confidence ?? 0;
  const passed = value >= threshold;

  return {
    passed,
    value,
    threshold,
    reason: passed
      ? `Match Confidence ${(value * 100).toFixed(0)}% >= ${(threshold * 100).toFixed(0)}%`
      : `Match Confidence zu niedrig: ${(value * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%`,
  };
}

function evaluatePremoveGate(
  priceChange: number | undefined,
  threshold: number
): GateResult {
  // Wenn keine Preisänderung bekannt, Gate passieren lassen
  if (priceChange === undefined) {
    return {
      passed: true,
      value: 'unknown',
      threshold,
      reason: 'Keine Preisdaten - Gate übersprungen',
    };
  }

  const absChange = Math.abs(priceChange);
  const passed = absChange <= threshold;

  return {
    passed,
    value: absChange,
    threshold,
    reason: passed
      ? `Preisbewegung ${(absChange * 100).toFixed(2)}% <= ${(threshold * 100).toFixed(1)}%`
      : `Preis hat sich bereits bewegt: ${(absChange * 100).toFixed(2)}% > ${(threshold * 100).toFixed(1)}%`,
  };
}

function evaluateExpectedLagGate(
  expectedLag: number | undefined,
  threshold: number
): GateResult {
  // Wenn kein erwarteter Lag bekannt, annehmen dass ausreichend
  if (expectedLag === undefined) {
    return {
      passed: true,
      value: 'unknown',
      threshold,
      reason: 'Kein Lag-Schätzung - Gate übersprungen',
    };
  }

  const passed = expectedLag >= threshold;

  return {
    passed,
    value: expectedLag,
    threshold,
    reason: passed
      ? `Erwarteter Lag ${expectedLag}min >= ${threshold}min`
      : `Erwartete Reaktion zu schnell: ${expectedLag}min < ${threshold}min`,
  };
}

function evaluateTotalVolumeGate(
  volume: number,
  threshold: number
): GateResult {
  const passed = volume >= threshold;

  return {
    passed,
    value: volume,
    threshold,
    reason: passed
      ? `Volume $${(volume / 1000).toFixed(0)}k >= $${(threshold / 1000).toFixed(0)}k`
      : `Volume zu niedrig: $${(volume / 1000).toFixed(0)}k < $${(threshold / 1000).toFixed(0)}k`,
  };
}

function evaluateSpreadGate(
  spread: number | undefined,
  threshold: number
): GateResult {
  if (spread === undefined) {
    return {
      passed: true,
      value: 'unknown',
      threshold,
      reason: 'Kein Spread bekannt - Gate übersprungen',
    };
  }

  const passed = spread <= threshold;

  return {
    passed,
    value: spread,
    threshold,
    reason: passed
      ? `Spread ${(spread * 100).toFixed(1)}% <= ${(threshold * 100).toFixed(0)}%`
      : `Spread zu hoch: ${(spread * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}%`,
  };
}

function evaluateLiquidityGate(
  liquidity: number | undefined,
  threshold: number
): GateResult {
  if (liquidity === undefined) {
    return {
      passed: true,
      value: 'unknown',
      threshold,
      reason: 'Keine Liquidity bekannt - Gate übersprungen',
    };
  }

  const passed = liquidity >= threshold;

  return {
    passed,
    value: liquidity,
    threshold,
    reason: passed
      ? `Liquidity Score ${liquidity.toFixed(2)} >= ${threshold}`
      : `Liquidity zu niedrig: ${liquidity.toFixed(2)} < ${threshold}`,
  };
}

function evaluateSourceReliabilityGate(
  source: SourceInfo,
  threshold: number,
  requireMultiple: boolean
): GateResult {
  // Check primary source reliability
  if (source.reliabilityScore >= threshold) {
    return {
      passed: true,
      value: source.reliabilityScore,
      threshold,
      reason: `High-Reliability Quelle: ${source.sourceName} (${(source.reliabilityScore * 100).toFixed(0)}%)`,
    };
  }

  // If multiple sources required, check additional sources
  if (requireMultiple && source.additionalSources && source.additionalSources.length > 0) {
    const totalSources = 1 + source.additionalSources.length;
    if (totalSources >= 2) {
      return {
        passed: true,
        value: totalSources,
        threshold: 2,
        reason: `${totalSources} unabhängige Quellen bestätigen`,
      };
    }
  }

  // Single source with insufficient reliability
  const passed = source.reliabilityScore >= threshold;

  return {
    passed,
    value: source.reliabilityScore,
    threshold,
    reason: passed
      ? `Source Reliability ${(source.reliabilityScore * 100).toFixed(0)}%`
      : `Quelle nicht zuverlässig genug: ${source.sourceName} (${(source.reliabilityScore * 100).toFixed(0)}%)`,
  };
}

function evaluateSystemHealthGate(): GateResult {
  try {
    const health = getSystemHealthDashboard();
    const state = runtimeState.getState();

    // Critical: Kill Switch
    if (state.killSwitchActive) {
      return {
        passed: false,
        value: 'kill_switch_active',
        threshold: 'kill_switch_off',
        reason: 'Kill-Switch ist aktiv',
      };
    }

    // Critical: System health
    if (health.overall === 'critical') {
      return {
        passed: false,
        value: health.overall,
        threshold: 'healthy|degraded',
        reason: `System Health: ${health.staleAlerts.slice(0, 2).join(', ')}`,
      };
    }

    return {
      passed: true,
      value: health.overall,
      threshold: 'healthy|degraded',
      reason: `System OK (${health.overall})`,
    };
  } catch {
    return {
      passed: true, // Fail open - don't block pushes on health check errors
      value: 'error',
      threshold: 'healthy|degraded',
      reason: 'Health Check Fehler - Gate übersprungen',
    };
  }
}

function checkCategoryEnabled(categories: string[], chatId: string): boolean {
  if (!categories || categories.length === 0) return true;

  // Check if at least one category is enabled
  for (const cat of categories) {
    if (isCategoryEnabled(chatId, cat)) {
      return true;
    }
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════
// WHY NOW? GENERATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Generiert "Why now?" Begründung für den Push
 */
export function generateWhyNow(
  candidate: NewsCandidate,
  market: MarketInfo,
  gateResults: GateResults
): string[] {
  const reasons: string[] = [];

  // 1. Time Advantage
  if (candidate.timeAdvantageSeconds && candidate.timeAdvantageSeconds > 60) {
    const mins = Math.floor(candidate.timeAdvantageSeconds / 60);
    reasons.push(`News ${mins} Min vor US-Medien`);
  }

  // 2. Match Quality
  if (candidate.matchConfidence && candidate.matchConfidence >= 0.85) {
    reasons.push(`Hohe Match-Konfidenz (${(candidate.matchConfidence * 100).toFixed(0)}%)`);
  }

  // 3. Market hasn't moved yet
  if (gateResults.price_premove?.passed && typeof gateResults.price_premove.value === 'number') {
    const move = gateResults.price_premove.value;
    if (move < 0.005) {
      reasons.push('Markt hat noch nicht reagiert');
    }
  }

  // 4. High Volume/Liquidity
  if (market.totalVolume >= 100000) {
    reasons.push(`Hohes Volume ($${(market.totalVolume / 1000).toFixed(0)}k)`);
  }

  // 5. Source Quality
  if (gateResults.source_reliability?.passed) {
    const reason = gateResults.source_reliability.reason;
    if (reason?.includes('High-Reliability')) {
      reasons.push('Verifizierte Quelle');
    } else if (reason?.includes('unabhängige')) {
      reasons.push('Mehrere Quellen bestätigen');
    }
  }

  // Fallback if no strong reasons
  if (reasons.length === 0) {
    reasons.push('TIME_DELAY Signal erkannt');
    reasons.push('Alle Quality Gates bestanden');
  }

  return reasons.slice(0, 3);
}
