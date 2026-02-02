/**
 * Sizing Modul V2
 * Position-Sizing mit echtem Kelly Criterion und Adaptive Scaling
 *
 * KELLY FORMEL FÜR PREDICTION MARKETS:
 * f* = (p - (1-p)/b) / 1  oder  f* = p - q/b
 * wobei:
 *   p = geschätzte Gewinnwahrscheinlichkeit
 *   q = 1 - p (Verlustwahrscheinlichkeit)
 *   b = Odds = (1 / market_price) - 1
 *
 * ADAPTIVE SCALING:
 *   - Drawdown Scaling: Reduziert bei hohem Drawdown
 *   - Streak Scaling: Reduziert nach Verlusten
 *   - Regime Scaling: Adapts to market conditions
 *   - Time Scaling: Adjustiert nach Tageszeit
 */

import { MarketQuality, SlippageModel } from './types.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
//                         INTERFACES
// ═══════════════════════════════════════════════════════════════

export interface SizingResult {
  size: number;
  reasoning: string[];
  kellyRaw: number;
  kellyAdjusted: number;
  expectedSlippage: number;
  scalingFactors?: ScalingFactors;
}

export interface SizingConfig {
  kellyFraction: number;     // Default: 0.25 (Quarter-Kelly)
  minSize: number;           // Default: 1 USDC
  maxSize: number;           // Default: 100 USDC
  minEdge: number;           // Default: 0.02 (2%)
  minConfidence: number;     // Default: 0.5
}

export interface ScalingFactors {
  drawdownScaling: number;    // 0-1, reduziert bei hohem Drawdown
  streakScaling: number;      // 0-1, reduziert nach Verlusten
  volatilityScaling: number;  // 0-1, reduziert bei hoher Volatilität
  regimeScaling: number;      // 0-1, basierend auf Market Regime
  timeScaling: number;        // 0-1, basierend auf Tageszeit
  combinedScaling: number;    // Produkt aller Faktoren
}

export interface AdaptiveState {
  currentDrawdown: number;       // 0-1, aktueller Drawdown %
  intradayDrawdown: number;      // 0-1, Intraday Drawdown %
  consecutiveLosses: number;     // Anzahl aufeinanderfolgende Verluste
  consecutiveWins: number;       // Anzahl aufeinanderfolgende Gewinne
  recentWinRate: number;         // 0-1, Win Rate der letzten N Trades
  marketVolatility: number;      // 0-1, aktuelle Markt-Volatilität
  isHighVolatilityRegime: boolean;
}

// ═══════════════════════════════════════════════════════════════
//                         DEFAULTS
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_SLIPPAGE_MODEL: SlippageModel = {
  baseSlippage: 0.001,       // 0.1% Basis
  sizeImpact: 0.0001,        // 0.01% pro $1000
  liquidityFactor: 0.005,    // 0.5% bei niedriger Liquidity
  volatilityFactor: 0.002,   // 0.2% pro Volatility-Einheit
};

export const DEFAULT_SIZING_CONFIG: SizingConfig = {
  kellyFraction: 0.25,
  minSize: 1,
  maxSize: 100,
  minEdge: 0.02,
  minConfidence: 0.5,
};

// Adaptive Scaling Config
export interface AdaptiveScalingConfig {
  // Drawdown Scaling
  drawdownScalingEnabled: boolean;
  drawdownThreshold: number;         // Ab diesem Drawdown beginnt Skalierung (z.B. 0.1 = 10%)
  drawdownMaxReduction: number;      // Maximale Reduktion bei Max Drawdown (z.B. 0.5 = 50% der normalen Size)
  maxDrawdownForStop: number;        // Bei diesem Drawdown Size = 0 (z.B. 0.3 = 30%)

  // Streak Scaling
  streakScalingEnabled: boolean;
  consecutiveLossesThreshold: number; // Ab dieser Anzahl beginnt Skalierung
  streakReductionPerLoss: number;    // Reduktion pro weiterem Loss (z.B. 0.15 = 15%)
  maxConsecutiveLosses: number;      // Bei dieser Anzahl Size = 0

  // Win Streak Bonus (optional)
  winStreakBonusEnabled: boolean;
  winStreakBonusStart: number;       // Ab dieser Anzahl Wins
  winStreakBonusPerWin: number;      // Bonus pro weiterem Win (z.B. 0.05 = 5%)
  maxWinStreakBonus: number;         // Maximaler Bonus (z.B. 0.2 = 20% mehr)

  // Volatility Scaling
  volatilityScalingEnabled: boolean;
  highVolatilityThreshold: number;   // Ab diesem Level ist "high volatility"
  lowVolatilityBonus: number;        // Bonus bei niedriger Volatilität
  highVolatilityPenalty: number;     // Penalty bei hoher Volatilität

  // Time Scaling
  timeScalingEnabled: boolean;
  offHoursReduction: number;         // Reduktion außerhalb Haupthandelszeiten
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveScalingConfig = {
  drawdownScalingEnabled: true,
  drawdownThreshold: 0.1,
  drawdownMaxReduction: 0.5,
  maxDrawdownForStop: 0.3,

  streakScalingEnabled: true,
  consecutiveLossesThreshold: 2,
  streakReductionPerLoss: 0.2,
  maxConsecutiveLosses: 5,

  winStreakBonusEnabled: false,  // Konservativ: Kein Bonus
  winStreakBonusStart: 3,
  winStreakBonusPerWin: 0.05,
  maxWinStreakBonus: 0.15,

  volatilityScalingEnabled: true,
  highVolatilityThreshold: 0.4,
  lowVolatilityBonus: 1.0,       // Kein Bonus
  highVolatilityPenalty: 0.7,

  timeScalingEnabled: false,     // Deaktiviert - 24/7 Market
  offHoursReduction: 0.8,
};

// ═══════════════════════════════════════════════════════════════
//                      KELLY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * ECHTE KELLY-FORMEL für Prediction Markets
 *
 * Kelly Criterion: f* = (p * b - q) / b = p - q/b
 *
 * Wobei:
 *   p = Geschätzte Gewinnwahrscheinlichkeit (estimatedProb)
 *   q = 1 - p = Verlustwahrscheinlichkeit
 *   b = Odds = (1 / marketPrice) - 1 (Gewinn bei Erfolg)
 *
 * Für YES-Bets:
 *   Wenn wir bei Preis 0.40 kaufen und gewinnen: Gewinn = (1 - 0.40) / 0.40 = 1.5 (150%)
 *   b = 1.5
 *
 * Beispiel:
 *   Market Price = 0.40, Estimated Prob = 0.55
 *   b = 0.60 / 0.40 = 1.5
 *   f* = 0.55 - (0.45 / 1.5) = 0.55 - 0.30 = 0.25 (25% of bankroll)
 */
export function calculateKellyFraction(
  estimatedProb: number,
  marketPrice: number,
  direction: 'yes' | 'no'
): { kelly: number; reasoning: string[] } {
  const reasoning: string[] = [];

  // Für NO-Bets: Invertiere die Perspektive
  const effectivePrice = direction === 'yes' ? marketPrice : 1 - marketPrice;
  const effectiveProb = direction === 'yes' ? estimatedProb : 1 - estimatedProb;

  reasoning.push(`Direction: ${direction.toUpperCase()}`);
  reasoning.push(`Market Price: ${(effectivePrice * 100).toFixed(1)}%`);
  reasoning.push(`Estimated Prob: ${(effectiveProb * 100).toFixed(1)}%`);

  // Odds berechnen (Gewinn pro investiertem Dollar)
  // Bei Preis 0.40: Odds = (1 - 0.40) / 0.40 = 1.5
  if (effectivePrice <= 0 || effectivePrice >= 1) {
    reasoning.push('Ungültiger Market Price');
    return { kelly: 0, reasoning };
  }

  const odds = (1 - effectivePrice) / effectivePrice;
  reasoning.push(`Odds: ${odds.toFixed(3)} (${(odds * 100).toFixed(1)}% Return bei Gewinn)`);

  // Kelly-Formel: f* = p - q/b
  const p = effectiveProb;
  const q = 1 - p;

  // Edge Check: Wir brauchen positive Expected Value
  // EV = p * odds - q = p * odds - (1-p) = p * (odds + 1) - 1
  const ev = p * odds - q;
  reasoning.push(`Expected Value: ${(ev * 100).toFixed(2)}% pro Dollar`);

  if (ev <= 0) {
    reasoning.push('Negativer EV - Kein Trade');
    return { kelly: 0, reasoning };
  }

  // Kelly Fraction
  const kelly = p - q / odds;
  reasoning.push(`Raw Kelly: ${(kelly * 100).toFixed(2)}%`);

  // Kelly sollte zwischen 0 und 1 liegen
  const clampedKelly = Math.max(0, Math.min(1, kelly));
  if (clampedKelly !== kelly) {
    reasoning.push(`Kelly clamped: ${(clampedKelly * 100).toFixed(2)}%`);
  }

  return { kelly: clampedKelly, reasoning };
}

/**
 * Berechnet Adaptive Scaling Factors basierend auf aktuellem State
 */
export function calculateScalingFactors(
  state: AdaptiveState,
  config: AdaptiveScalingConfig = DEFAULT_ADAPTIVE_CONFIG
): ScalingFactors {
  let drawdownScaling = 1.0;
  let streakScaling = 1.0;
  let volatilityScaling = 1.0;
  let regimeScaling = 1.0;
  let timeScaling = 1.0;

  // 1. Drawdown Scaling
  if (config.drawdownScalingEnabled) {
    const maxDrawdown = Math.max(state.currentDrawdown, state.intradayDrawdown);

    if (maxDrawdown >= config.maxDrawdownForStop) {
      drawdownScaling = 0; // Stop trading
    } else if (maxDrawdown > config.drawdownThreshold) {
      // Lineare Skalierung zwischen Threshold und Max
      const drawdownRange = config.maxDrawdownForStop - config.drawdownThreshold;
      const drawdownProgress = (maxDrawdown - config.drawdownThreshold) / drawdownRange;
      // Skalierung von 1.0 auf config.drawdownMaxReduction
      drawdownScaling = 1 - drawdownProgress * (1 - config.drawdownMaxReduction);
    }
  }

  // 2. Streak Scaling (Consecutive Losses)
  if (config.streakScalingEnabled && state.consecutiveLosses > 0) {
    if (state.consecutiveLosses >= config.maxConsecutiveLosses) {
      streakScaling = 0; // Stop nach zu vielen Losses
    } else if (state.consecutiveLosses >= config.consecutiveLossesThreshold) {
      const lossesOverThreshold = state.consecutiveLosses - config.consecutiveLossesThreshold;
      streakScaling = Math.max(0.2, 1 - (lossesOverThreshold + 1) * config.streakReductionPerLoss);
    }
  }

  // 2b. Win Streak Bonus (optional)
  if (config.winStreakBonusEnabled && state.consecutiveWins >= config.winStreakBonusStart) {
    const winsOverThreshold = state.consecutiveWins - config.winStreakBonusStart;
    const bonus = Math.min(config.maxWinStreakBonus, winsOverThreshold * config.winStreakBonusPerWin);
    streakScaling = Math.min(1.2, streakScaling + bonus); // Max 20% Bonus
  }

  // 3. Volatility Scaling
  if (config.volatilityScalingEnabled) {
    if (state.marketVolatility > config.highVolatilityThreshold || state.isHighVolatilityRegime) {
      volatilityScaling = config.highVolatilityPenalty;
    } else if (state.marketVolatility < config.highVolatilityThreshold * 0.5) {
      volatilityScaling = config.lowVolatilityBonus;
    }
  }

  // 4. Regime Scaling (basierend auf Recent Win Rate)
  if (state.recentWinRate < 0.35) {
    // Schlechte Performance → reduzieren
    regimeScaling = 0.7;
  } else if (state.recentWinRate > 0.65) {
    // Gute Performance → leicht erhöhen (maximal 10%)
    regimeScaling = Math.min(1.1, 1 + (state.recentWinRate - 0.65) * 0.5);
  }

  // 5. Time Scaling (für Off-Hours)
  if (config.timeScalingEnabled) {
    const hour = new Date().getUTCHours();
    // US Market Hours: 13:30-20:00 UTC (9:30-4:00 ET)
    const isUSMarketHours = hour >= 13 && hour < 20;
    // Europe Market Hours: 7:00-15:30 UTC
    const isEuropeMarketHours = hour >= 7 && hour < 16;

    if (!isUSMarketHours && !isEuropeMarketHours) {
      timeScaling = config.offHoursReduction;
    }
  }

  // Combined Scaling (Multiplikativ)
  const combinedScaling = drawdownScaling * streakScaling * volatilityScaling * regimeScaling * timeScaling;

  return {
    drawdownScaling,
    streakScaling,
    volatilityScaling,
    regimeScaling,
    timeScaling,
    combinedScaling: Math.max(0, Math.min(1.2, combinedScaling)), // Clamp 0-120%
  };
}

// ═══════════════════════════════════════════════════════════════
//                      CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Vollständige Kelly-Berechnung mit MarketPrice und EstimatedProb
 */
export function calculateFullKellySize(
  estimatedProb: number,
  marketPrice: number,
  direction: 'yes' | 'no',
  confidence: number,
  bankroll: number,
  quality: MarketQuality,
  config: SizingConfig = DEFAULT_SIZING_CONFIG,
  adaptiveState?: AdaptiveState
): SizingResult {
  const reasoning: string[] = [];

  // 1. Echte Kelly-Fraktion berechnen
  const kellyResult = calculateKellyFraction(estimatedProb, marketPrice, direction);
  reasoning.push(...kellyResult.reasoning);

  if (kellyResult.kelly <= 0) {
    return {
      size: 0,
      reasoning,
      kellyRaw: 0,
      kellyAdjusted: 0,
      expectedSlippage: 0,
    };
  }

  const kellyRaw = kellyResult.kelly;

  // 2. Confidence Check
  if (confidence < config.minConfidence) {
    reasoning.push(`Confidence zu gering: ${(confidence * 100).toFixed(1)}%`);
    return {
      size: 0,
      reasoning,
      kellyRaw,
      kellyAdjusted: 0,
      expectedSlippage: 0,
    };
  }

  // 3. Kelly mit Fraction adjustieren (Quarter-Kelly by default)
  const kellyWithFraction = kellyRaw * config.kellyFraction;
  const kellyWithConfidence = kellyWithFraction * confidence;
  reasoning.push(`Kelly × ${(config.kellyFraction * 100).toFixed(0)}% Fraction: ${(kellyWithFraction * 100).toFixed(2)}%`);

  // 4. Adaptive Scaling
  let scalingFactors: ScalingFactors | undefined;
  let adaptiveMultiplier = 1.0;

  if (adaptiveState) {
    scalingFactors = calculateScalingFactors(adaptiveState);
    adaptiveMultiplier = scalingFactors.combinedScaling;

    if (adaptiveMultiplier < 1) {
      reasoning.push(`Adaptive Scaling: ${(adaptiveMultiplier * 100).toFixed(0)}%`);
    }
    if (adaptiveMultiplier === 0) {
      reasoning.push('ADAPTIVE STOP: Trading pausiert');
      return {
        size: 0,
        reasoning,
        kellyRaw,
        kellyAdjusted: kellyWithConfidence,
        expectedSlippage: 0,
        scalingFactors,
      };
    }
  }

  // 5. Market Quality Adjustments
  let qualityMultiplier = 1.0;
  if (quality.liquidityScore < 0.5) {
    qualityMultiplier *= quality.liquidityScore / 0.5;
  }
  if (quality.volatility > 0.3) {
    qualityMultiplier *= Math.max(0.5, 1 - (quality.volatility - 0.3));
  }
  if (qualityMultiplier < 1) {
    reasoning.push(`Quality Adjustment: ${(qualityMultiplier * 100).toFixed(0)}%`);
  }

  // 6. Finale Size
  const finalKelly = kellyWithConfidence * adaptiveMultiplier * qualityMultiplier;
  let size = bankroll * finalKelly;

  // 7. Caps
  if (size < config.minSize) {
    reasoning.push(`Size unter Minimum: ${size.toFixed(2)} USDC`);
    size = 0;
  } else if (size > config.maxSize) {
    reasoning.push(`Size gekappt auf ${config.maxSize} USDC`);
    size = config.maxSize;
  } else {
    reasoning.push(`Finale Size: $${size.toFixed(2)}`);
  }

  const expectedSlippage = estimateSlippage(size, quality);

  return {
    size: Math.round(size * 100) / 100,
    reasoning,
    kellyRaw,
    kellyAdjusted: finalKelly,
    expectedSlippage,
    scalingFactors,
  };
}

/**
 * Berechnet die optimale Position-Size mit Quarter-Kelly (Simplified)
 * Verwendet approximierte Kelly-Formel basierend auf Edge
 */
export function calculatePositionSize(
  edge: number,
  confidence: number,
  bankroll: number,
  quality: MarketQuality,
  kellyFraction: number = DEFAULT_SIZING_CONFIG.kellyFraction,
  config: SizingConfig = DEFAULT_SIZING_CONFIG
): SizingResult {
  const reasoning: string[] = [];

  // 1. Edge- und Confidence-Checks
  if (edge < config.minEdge) {
    reasoning.push(`Edge zu gering: ${(edge * 100).toFixed(2)}% < ${(config.minEdge * 100).toFixed(2)}%`);
    return {
      size: 0,
      reasoning,
      kellyRaw: 0,
      kellyAdjusted: 0,
      expectedSlippage: 0,
    };
  }

  if (confidence < config.minConfidence) {
    reasoning.push(`Confidence zu gering: ${(confidence * 100).toFixed(1)}% < ${(config.minConfidence * 100).toFixed(1)}%`);
    return {
      size: 0,
      reasoning,
      kellyRaw: 0,
      kellyAdjusted: 0,
      expectedSlippage: 0,
    };
  }

  // 2. Raw Kelly berechnen
  // Für binäre Märkte: Kelly = edge / (p * (1-p))
  // Vereinfachte Formel für PMs: Kelly = edge / odds_variance
  // Hier verwenden wir: Kelly = edge * 2 (konservative Schätzung)
  const kellyRaw = edge * 2;
  reasoning.push(`Raw Kelly: ${(kellyRaw * 100).toFixed(2)}%`);

  // 3. Kelly mit Fraction und Confidence adjustieren
  const kellyWithFraction = kellyRaw * kellyFraction;
  const kellyAdjusted = kellyWithFraction * confidence;
  reasoning.push(`Kelly nach Fraction (${(kellyFraction * 100).toFixed(0)}%): ${(kellyWithFraction * 100).toFixed(2)}%`);
  reasoning.push(`Kelly nach Confidence (${(confidence * 100).toFixed(1)}%): ${(kellyAdjusted * 100).toFixed(2)}%`);

  // 4. Liquidity Penalty
  let liquidityMultiplier = 1.0;
  if (quality.liquidityScore < 0.5) {
    liquidityMultiplier = quality.liquidityScore / 0.5;
    reasoning.push(`Liquidity Penalty: ${(liquidityMultiplier * 100).toFixed(1)}% (Score: ${(quality.liquidityScore * 100).toFixed(1)}%)`);
  }

  // 5. Volatility Penalty
  let volatilityMultiplier = 1.0;
  if (quality.volatility > 0.3) {
    volatilityMultiplier = Math.max(0.5, 1 - (quality.volatility - 0.3));
    reasoning.push(`Volatility Penalty: ${(volatilityMultiplier * 100).toFixed(1)}% (Vol: ${(quality.volatility * 100).toFixed(1)}%)`);
  }

  // 6. Finale Size berechnen
  const adjustedKelly = kellyAdjusted * liquidityMultiplier * volatilityMultiplier;
  let size = bankroll * adjustedKelly;

  // 7. Min/Max Caps
  if (size < config.minSize) {
    reasoning.push(`Size unter Minimum: ${size.toFixed(2)} < ${config.minSize} USDC`);
    size = 0; // Unter Minimum = kein Trade
  } else if (size > config.maxSize) {
    reasoning.push(`Size gekappt: ${size.toFixed(2)} -> ${config.maxSize} USDC (Max)`);
    size = config.maxSize;
  } else {
    reasoning.push(`Finale Size: ${size.toFixed(2)} USDC`);
  }

  // 8. Slippage schätzen
  const expectedSlippage = estimateSlippage(size, quality);
  reasoning.push(`Erwarteter Slippage: ${(expectedSlippage * 100).toFixed(3)}%`);

  return {
    size: Math.round(size * 100) / 100, // Auf 2 Dezimalstellen runden
    reasoning,
    kellyRaw,
    kellyAdjusted,
    expectedSlippage,
  };
}

/**
 * Schätzt den erwarteten Slippage basierend auf Size und Markt-Qualität
 */
export function estimateSlippage(
  size: number,
  quality: MarketQuality,
  model: SlippageModel = DEFAULT_SLIPPAGE_MODEL
): number {
  // Base Slippage
  let slippage = model.baseSlippage;

  // Size Impact (pro $1000)
  const sizeImpact = (size / 1000) * model.sizeImpact;
  slippage += sizeImpact;

  // Liquidity Factor (inverse - niedrige Liquidität = höherer Slippage)
  if (quality.liquidityScore < 1) {
    const liquidityPenalty = model.liquidityFactor * (1 - quality.liquidityScore);
    slippage += liquidityPenalty;
  }

  // Volatility Factor
  const volatilityImpact = quality.volatility * model.volatilityFactor;
  slippage += volatilityImpact;

  // Spread Impact (bereits eingepreist im Spread)
  slippage += quality.spreadProxy / 2; // Halber Spread als zusätzlicher Cost

  return Math.min(slippage, 0.1); // Max 10% Slippage
}

/**
 * Berechnet effektiven Edge nach Slippage und Fees
 */
export function calculateEffectiveEdge(
  rawEdge: number,
  slippage: number,
  fees: number = 0.002 // 0.2% Polymarket Fee
): number {
  const effectiveEdge = rawEdge - slippage - fees;
  return Math.max(0, effectiveEdge);
}

/**
 * Berechnet erwarteten PnL
 */
export function calculateExpectedPnL(
  size: number,
  edge: number,
  slippage: number,
  fees: number = 0.002
): { grossPnL: number; netPnL: number; costs: number } {
  const effectiveEdge = calculateEffectiveEdge(edge, slippage, fees);
  const grossPnL = size * edge;
  const costs = size * (slippage + fees);
  const netPnL = size * effectiveEdge;

  return {
    grossPnL,
    netPnL,
    costs,
  };
}

/**
 * Empfiehlt ob ein Trade trotz Slippage noch profitabel ist
 */
export function isTradeViable(
  edge: number,
  slippage: number,
  fees: number = 0.002,
  minNetEdge: number = 0.01 // Min 1% Net Edge
): { viable: boolean; reason: string } {
  const effectiveEdge = calculateEffectiveEdge(edge, slippage, fees);

  if (effectiveEdge < minNetEdge) {
    return {
      viable: false,
      reason: `Net Edge zu gering: ${(effectiveEdge * 100).toFixed(2)}% < ${(minNetEdge * 100).toFixed(2)}% (Slippage: ${(slippage * 100).toFixed(2)}%, Fees: ${(fees * 100).toFixed(2)}%)`,
    };
  }

  return {
    viable: true,
    reason: `Trade viable: Net Edge ${(effectiveEdge * 100).toFixed(2)}%`,
  };
}

/**
 * Berechnet optimale Size unter Berücksichtigung von Slippage
 * Iterative Berechnung, da Slippage von Size abhängt
 */
export function calculateOptimalSize(
  edge: number,
  confidence: number,
  bankroll: number,
  quality: MarketQuality,
  config: SizingConfig = DEFAULT_SIZING_CONFIG,
  maxIterations: number = 5
): SizingResult {
  let result = calculatePositionSize(edge, confidence, bankroll, quality, config.kellyFraction, config);

  for (let i = 0; i < maxIterations && result.size > 0; i++) {
    const slippage = estimateSlippage(result.size, quality);
    const { viable, reason } = isTradeViable(edge, slippage);

    if (!viable) {
      // Reduziere Size
      const reductionFactor = 0.7;
      const newSize = result.size * reductionFactor;

      if (newSize < config.minSize) {
        result.size = 0;
        result.reasoning.push(`Trade nicht viable nach Slippage-Adjustment: ${reason}`);
        break;
      }

      result.size = newSize;
      result.reasoning.push(`Size reduziert wegen Slippage: ${result.size.toFixed(2)} USDC`);
    } else {
      break;
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
//                      UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Formatiert Sizing-Result für Logging
 */
export function formatSizingResult(result: SizingResult): string {
  return [
    `Size: ${result.size.toFixed(2)} USDC`,
    `Kelly Raw: ${(result.kellyRaw * 100).toFixed(2)}%`,
    `Kelly Adjusted: ${(result.kellyAdjusted * 100).toFixed(2)}%`,
    `Slippage: ${(result.expectedSlippage * 100).toFixed(3)}%`,
    `---`,
    ...result.reasoning,
  ].join('\n');
}

export default {
  // Kelly Functions
  calculateKellyFraction,
  calculateFullKellySize,
  calculateScalingFactors,
  // Legacy Functions
  calculatePositionSize,
  estimateSlippage,
  calculateEffectiveEdge,
  calculateExpectedPnL,
  isTradeViable,
  calculateOptimalSize,
  formatSizingResult,
  // Configs
  DEFAULT_SLIPPAGE_MODEL,
  DEFAULT_SIZING_CONFIG,
  DEFAULT_ADAPTIVE_CONFIG,
};
