/**
 * Telemetry Modul - Observability fuer Alpha Signale
 * Formatierung fuer Logging, Telegram und Debugging
 */

import { AlphaSignalV2, Decision, Execution, RiskChecks } from './types.js';
import { logger } from '../utils/logger.js';

// CombinedSignal Interface (früher aus metaCombiner.js, jetzt inline definiert)
// MetaCombiner wurde entfernt (V4.0)
export interface CombinedSignal extends AlphaSignalV2 {
  sourceSignals: {
    timeDelay?: AlphaSignalV2;
    mispricing?: AlphaSignalV2;
  };
  weights: {
    timeDelay: number;
    mispricing: number;
  };
}

// ============================================================================
// Telemetry Event Types
// ============================================================================

export interface TelemetryEvent {
  type: 'signal' | 'decision' | 'execution' | 'outcome';
  timestamp: Date;
  data: Record<string, unknown>;
}

// ============================================================================
// Polymarket URL Generierung
// ============================================================================

/**
 * Generiere Polymarket URL fuer einen Markt
 */
export function getPolymarketUrl(marketId: string, slug?: string): string {
  // Wenn slug vorhanden, bevorzugen
  if (slug) {
    return `https://polymarket.com/event/${slug}`;
  }
  // Fallback auf Markt-ID
  return `https://polymarket.com/market/${marketId}`;
}

// ============================================================================
// Signal Formatierung
// ============================================================================

/**
 * Formatiere AlphaSignalV2 fuer Display (Logging/Telegram)
 */
export function formatSignalForDisplay(signal: AlphaSignalV2): string {
  const lines: string[] = [
    `Signal: ${signal.signalId.slice(0, 8)}...`,
    `Type: ${signal.alphaType.toUpperCase()}`,
    `Market: ${signal.question.substring(0, 50)}${signal.question.length > 50 ? '...' : ''}`,
    `Direction: ${signal.direction.toUpperCase()} @ Edge ${(signal.predictedEdge * 100).toFixed(1)}%`,
    `Confidence: ${(signal.confidence * 100).toFixed(0)}%`,
    `Created: ${signal.createdAt.toISOString()}`,
  ];

  if (signal.reasoning && signal.reasoning.length > 0) {
    lines.push(`Reasoning: ${signal.reasoning[0]}`);
  }

  return lines.join('\n');
}

/**
 * Formatiere CombinedSignal fuer Display
 */
export function formatCombinedSignalForDisplay(signal: CombinedSignal): string {
  const lines: string[] = [
    `Combined Signal: ${signal.signalId.slice(0, 8)}...`,
    `Market: ${signal.question.substring(0, 50)}${signal.question.length > 50 ? '...' : ''}`,
    `Direction: ${signal.direction.toUpperCase()} @ Edge ${(signal.predictedEdge * 100).toFixed(1)}%`,
    `Confidence: ${(signal.confidence * 100).toFixed(0)}%`,
    `Weights: TD=${(signal.weights.timeDelay * 100).toFixed(0)}%, MP=${(signal.weights.mispricing * 100).toFixed(0)}%`,
  ];

  // Source signals
  if (signal.sourceSignals.timeDelay) {
    lines.push(`  TimeDelay: Edge=${(signal.sourceSignals.timeDelay.predictedEdge * 100).toFixed(1)}%`);
  }
  if (signal.sourceSignals.mispricing) {
    lines.push(`  Mispricing: Edge=${(signal.sourceSignals.mispricing.predictedEdge * 100).toFixed(1)}%`);
  }

  return lines.join('\n');
}

// ============================================================================
// Decision Formatierung
// ============================================================================

/**
 * Formatiere Decision mit Risk-Checks fuer Display
 */
export function formatDecisionForDisplay(decision: Decision): string {
  const actionEmoji: Record<string, string> = {
    show: '👁️',
    watch: '👀',
    trade: '💰',
    high_conviction: '🔥',
    reject: '❌',
  };

  const lines: string[] = [
    `${actionEmoji[decision.action] || '📊'} Decision: ${decision.action.toUpperCase()}`,
    `Signal: ${decision.signalId.slice(0, 8)}...`,
  ];

  if (decision.sizeUsdc !== null) {
    lines.push(`Size: $${decision.sizeUsdc.toFixed(2)} USDC`);
  }

  // Rationale
  lines.push(`Alpha-Type: ${decision.rationale.alphaType}`);
  lines.push(`Edge: ${(decision.rationale.edge * 100).toFixed(1)}%`);
  lines.push(`Confidence: ${(decision.rationale.confidence * 100).toFixed(0)}%`);

  // Risk Checks Summary
  const riskSummary = formatRiskGates(decision.riskChecks);
  lines.push(`Risk-Gates: ${riskSummary}`);

  // Rejection Reasons
  if (decision.rationale.rejectionReasons && decision.rationale.rejectionReasons.length > 0) {
    lines.push(`Rejections: ${decision.rationale.rejectionReasons.join(', ')}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Execution Formatierung
// ============================================================================

/**
 * Formatiere Execution-Ergebnis fuer Display
 */
export function formatExecutionForDisplay(execution: Execution): string {
  const modeEmoji: Record<string, string> = {
    paper: '📝',
    shadow: '👻',
    live: '🚀',
  };

  const statusEmoji: Record<string, string> = {
    pending: '⏳',
    filled: '✅',
    cancelled: '🚫',
    failed: '❌',
  };

  const lines: string[] = [
    `${modeEmoji[execution.mode] || '📊'} [${execution.mode.toUpperCase()}] Execution`,
    `Status: ${statusEmoji[execution.status] || '❓'} ${execution.status.toUpperCase()}`,
    `Decision: ${execution.decisionId.slice(0, 8)}...`,
  ];

  if (execution.fillPrice !== null) {
    lines.push(`Fill Price: ${(execution.fillPrice * 100).toFixed(1)}c`);
  }

  if (execution.fillSize !== null) {
    lines.push(`Fill Size: $${execution.fillSize.toFixed(2)}`);
  }

  if (execution.slippage !== null) {
    const slippagePercent = (execution.slippage * 100).toFixed(2);
    lines.push(`Slippage: ${slippagePercent}%`);
  }

  if (execution.fees !== null) {
    lines.push(`Fees: $${execution.fees.toFixed(4)}`);
  }

  if (execution.txHash) {
    lines.push(`TX: ${execution.txHash.slice(0, 10)}...`);
  }

  if (execution.filledAt) {
    lines.push(`Filled: ${execution.filledAt.toISOString()}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Feature-Treiber Formatierung
// ============================================================================

/**
 * Extrahiere Top-3 Feature-Treiber als lesbare Strings
 */
export function formatTopFeatures(signal: AlphaSignalV2 | CombinedSignal): string[] {
  const features = signal.features.features;
  const topFeatures: string[] = [];

  // Feature-Namen Mapping (deutsch)
  const featureLabels: Record<string, string> = {
    // TimeDelay Features
    sourceCount: 'Quellen-Anzahl',
    avgSourceReliability: 'Quellen-Zuverlaessigkeit',
    newsAgeMinutes: 'News-Alter (Min)',
    sentimentScore: 'Sentiment',
    impactScore: 'Impact-Score',
    marketPriceAtNews: 'Preis bei News',
    priceMoveSinceNews: 'Preisbewegung seit News',
    volumeAtNews: 'Volumen bei News',
    volumeChangeSinceNews: 'Volumen-Aenderung',
    matchConfidence: 'Match-Konfidenz',
    // Mispricing Features
    impliedProb: 'Implizierte Wahrscheinlichkeit',
    estimatedProb: 'Geschaetzte Wahrscheinlichkeit',
    probUncertainty: 'Unsicherheit',
    pollDelta: 'Umfrage-Delta',
    historicalBias: 'Historischer Bias',
    liquidityScore: 'Liquiditaet',
    spreadProxy: 'Spread',
    volatility30d: 'Volatilitaet 30d',
    daysToExpiry: 'Tage bis Ablauf',
    // Meta Features
    meta_agreement: 'Engine-Uebereinstimmung',
    meta_source_count: 'Anzahl Signal-Quellen',
    meta_weight_td: 'TimeDelay Gewicht',
    meta_weight_mp: 'Mispricing Gewicht',
    // Prefixed Features
    td_edge: 'TimeDelay Edge',
    td_conf: 'TimeDelay Confidence',
    mp_edge: 'Mispricing Edge',
    mp_conf: 'Mispricing Confidence',
  };

  // Sammle Feature-Werte mit Bedeutung
  const featureValues: Array<{ key: string; label: string; value: number | string | boolean | null; importance: number }> = [];

  for (const [key, value] of Object.entries(features)) {
    if (value === null || value === undefined) continue;

    // Berechne "Wichtigkeit" basierend auf Wert
    let importance = 0;
    if (typeof value === 'number') {
      // Hoehere Werte = wichtiger (vereinfacht)
      importance = Math.abs(value);

      // Skalierung fuer verschiedene Feature-Typen
      if (key.includes('edge') || key.includes('Edge')) {
        importance *= 100; // Edge ist wichtig
      } else if (key.includes('conf') || key.includes('Confidence')) {
        importance *= 50;
      } else if (key.includes('sentiment') || key.includes('Sentiment')) {
        importance *= 30;
      }
    } else if (typeof value === 'boolean' && value === true) {
      importance = 10;
    }

    const label = featureLabels[key] || key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
    featureValues.push({ key, label, value, importance });
  }

  // Sortiere nach Wichtigkeit
  featureValues.sort((a, b) => b.importance - a.importance);

  // Top 3 formatieren
  for (const feature of featureValues.slice(0, 3)) {
    let formattedValue: string;

    if (typeof feature.value === 'number') {
      if (feature.key.includes('edge') || feature.key.includes('prob') || feature.key.includes('conf')) {
        formattedValue = `${(feature.value * 100).toFixed(1)}%`;
      } else if (feature.key.includes('Minutes') || feature.key.includes('days')) {
        formattedValue = `${feature.value.toFixed(0)}`;
      } else if (feature.value < 1) {
        formattedValue = `${(feature.value * 100).toFixed(1)}%`;
      } else {
        formattedValue = `${feature.value.toFixed(2)}`;
      }
    } else if (typeof feature.value === 'boolean') {
      formattedValue = feature.value ? 'Ja' : 'Nein';
    } else {
      formattedValue = String(feature.value);
    }

    topFeatures.push(`${feature.label}: ${formattedValue}`);
  }

  return topFeatures;
}

// ============================================================================
// Risk-Gates Formatierung
// ============================================================================

/**
 * Formatiere Risk-Gates als Summary String
 */
export function formatRiskGates(riskChecks: RiskChecks): string {
  const gates = [
    { key: 'dailyLossOk', label: 'Daily', ok: riskChecks.dailyLossOk },
    { key: 'maxPositionsOk', label: 'Pos', ok: riskChecks.maxPositionsOk },
    { key: 'perMarketCapOk', label: 'Cap', ok: riskChecks.perMarketCapOk },
    { key: 'liquidityOk', label: 'Liq', ok: riskChecks.liquidityOk },
    { key: 'spreadOk', label: 'Sprd', ok: riskChecks.spreadOk },
    { key: 'killSwitchOk', label: 'Kill', ok: riskChecks.killSwitchOk },
  ];

  const passed = gates.filter((g) => g.ok).length;
  const total = gates.length;

  const gateIcons = gates.map((g) => (g.ok ? '✅' : '❌')).join('');

  return `${passed}/${total} ${gateIcons}`;
}

/**
 * Formatiere Risk-Gates ausfuehrlich
 */
export function formatRiskGatesDetailed(riskChecks: RiskChecks): string[] {
  const gates = [
    { key: 'dailyLossOk', label: 'Daily Loss Limit', ok: riskChecks.dailyLossOk },
    { key: 'maxPositionsOk', label: 'Max Positions', ok: riskChecks.maxPositionsOk },
    { key: 'perMarketCapOk', label: 'Per Market Cap', ok: riskChecks.perMarketCapOk },
    { key: 'liquidityOk', label: 'Liquiditaet', ok: riskChecks.liquidityOk },
    { key: 'spreadOk', label: 'Spread', ok: riskChecks.spreadOk },
    { key: 'killSwitchOk', label: 'Kill Switch', ok: riskChecks.killSwitchOk },
  ];

  return gates.map((g) => `${g.ok ? '✅' : '❌'} ${g.label}`);
}

// ============================================================================
// Telegram Alert Builder
// ============================================================================

export interface TelegramAlertConfig {
  mode: 'paper' | 'shadow' | 'live';
  showPolymarketLink: boolean;
}

/**
 * Baue kompletten Telegram Alert fuer V2 Signal + Decision
 */
export function buildTelegramAlert(
  signal: AlphaSignalV2 | CombinedSignal,
  decision: Decision,
  config: TelegramAlertConfig
): string {
  const isCombined = 'sourceSignals' in signal;
  const modeLabel = `[${config.mode.toUpperCase()}]`;
  const modeEmoji = config.mode === 'live' ? '🚀' : config.mode === 'shadow' ? '👻' : '📝';

  // Header
  const header = `${modeEmoji} ${modeLabel} SIGNAL: ${signal.question.substring(0, 50)}${signal.question.length > 50 ? '...' : ''}`;

  // Divider
  const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

  // Alpha-Type anzeigen
  let alphaTypeDisplay: string;
  if (isCombined) {
    const combined = signal as CombinedSignal;
    const sources: string[] = [];
    if (combined.sourceSignals.timeDelay) sources.push('TimeDelay');
    if (combined.sourceSignals.mispricing) sources.push('Mispricing');
    alphaTypeDisplay = `Meta (${sources.join(' + ')})`;
  } else {
    alphaTypeDisplay = signal.alphaType === 'timeDelay' ? 'TimeDelay' : 'Mispricing';
  }

  // Preis fuer Direction (vereinfacht, da wir keinen aktuellen Preis haben)
  const directionDisplay = signal.direction.toUpperCase();

  // Size
  const sizeDisplay = decision.sizeUsdc !== null ? `$${decision.sizeUsdc.toFixed(2)} USDC` : 'N/A';

  // Top Features
  const topFeatures = formatTopFeatures(signal);

  // Risk Gates
  const riskGatesSummary = formatRiskGates(decision.riskChecks);
  const riskGatesDetailed = formatRiskGatesDetailed(decision.riskChecks);

  // Polymarket URL
  const polymarketUrl = getPolymarketUrl(signal.marketId);

  // Zusammenbau
  const lines: string[] = [
    `🔔 ${header}`,
    divider,
    '',
    `📊 Alpha-Type: ${alphaTypeDisplay}`,
    `📈 Direction: ${directionDisplay}`,
    `💰 Size: ${sizeDisplay}`,
    `📐 Edge: ${(signal.predictedEdge * 100).toFixed(1)}% | Conf: ${(signal.confidence * 100).toFixed(0)}%`,
    '',
    divider,
    '',
    '🔍 Treiber:',
    ...topFeatures.map((f, i) => `  ${i + 1}. ${f}`),
    '',
    divider,
    '',
    `✅ Risk-Gates: ${riskGatesSummary}`,
    ...riskGatesDetailed,
  ];

  // Rejection Reasons falls vorhanden
  if (decision.rationale.rejectionReasons && decision.rationale.rejectionReasons.length > 0) {
    lines.push('');
    lines.push('⚠️ Einschraenkungen:');
    for (const reason of decision.rationale.rejectionReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  // Polymarket Link
  if (config.showPolymarketLink) {
    lines.push('');
    lines.push(`🔗 ${polymarketUrl}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Logging Helpers
// ============================================================================

/**
 * Logge TelemetryEvent
 */
export function logTelemetryEvent(event: TelemetryEvent): void {
  const logData = {
    type: event.type,
    timestamp: event.timestamp.toISOString(),
    ...event.data,
  };

  logger.info(`[TELEMETRY] ${event.type.toUpperCase()}`, logData);
}

/**
 * Erstelle Signal TelemetryEvent
 */
export function createSignalEvent(signal: AlphaSignalV2 | CombinedSignal): TelemetryEvent {
  return {
    type: 'signal',
    timestamp: new Date(),
    data: {
      signalId: signal.signalId,
      alphaType: signal.alphaType,
      marketId: signal.marketId,
      direction: signal.direction,
      predictedEdge: signal.predictedEdge,
      confidence: signal.confidence,
      isCombined: 'sourceSignals' in signal,
    },
  };
}

/**
 * Erstelle Decision TelemetryEvent
 */
export function createDecisionEvent(decision: Decision): TelemetryEvent {
  const passedGates = Object.values(decision.riskChecks).filter(Boolean).length;
  const totalGates = Object.keys(decision.riskChecks).length;

  return {
    type: 'decision',
    timestamp: new Date(),
    data: {
      decisionId: decision.decisionId,
      signalId: decision.signalId,
      action: decision.action,
      sizeUsdc: decision.sizeUsdc,
      passedGates: `${passedGates}/${totalGates}`,
      alphaType: decision.rationale.alphaType,
      edge: decision.rationale.edge,
      confidence: decision.rationale.confidence,
    },
  };
}

/**
 * Erstelle Execution TelemetryEvent
 */
export function createExecutionEvent(execution: Execution): TelemetryEvent {
  return {
    type: 'execution',
    timestamp: new Date(),
    data: {
      executionId: execution.executionId,
      decisionId: execution.decisionId,
      mode: execution.mode,
      status: execution.status,
      fillPrice: execution.fillPrice,
      fillSize: execution.fillSize,
      slippage: execution.slippage,
      fees: execution.fees,
    },
  };
}
