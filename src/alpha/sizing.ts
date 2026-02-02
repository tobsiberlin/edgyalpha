/**
 * Sizing Modul
 * Position-Sizing mit Quarter-Kelly und Slippage-Modellierung
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
}

export interface SizingConfig {
  kellyFraction: number;     // Default: 0.25 (Quarter-Kelly)
  minSize: number;           // Default: 1 USDC
  maxSize: number;           // Default: 100 USDC
  minEdge: number;           // Default: 0.02 (2%)
  minConfidence: number;     // Default: 0.5
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

// ═══════════════════════════════════════════════════════════════
//                      CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Berechnet die optimale Position-Size mit Quarter-Kelly
 *
 * Kelly-Formel: f* = (b*p - q) / b
 * wobei: b = odds (gewinn/einsatz), p = win probability, q = 1-p
 *
 * Für Prediction Markets: f* = edge / (price * (1 - price))
 * Mit Confidence-Adjustment: f* = f* * confidence
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
  calculatePositionSize,
  estimateSlippage,
  calculateEffectiveEdge,
  calculateExpectedPnL,
  isTradeViable,
  calculateOptimalSize,
  formatSizingResult,
  DEFAULT_SLIPPAGE_MODEL,
  DEFAULT_SIZING_CONFIG,
};
