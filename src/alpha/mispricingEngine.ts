/**
 * MISPRICING Alpha Engine
 * Transparente P_true Schaetzung ohne Blackbox
 *
 * Prinzipien:
 * 1. Alle Schaetzungen sind erklaerbar
 * 2. Unsicherheit wird explizit modelliert
 * 3. Features sind versioniert fuer Reproduzierbarkeit
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AlphaSignalV2,
  MispricingFeatures,
  MarketQuality,
  CalibrationBucket,
} from './types.js';
import { Market } from '../types/index.js';
import { NormalizedPoll } from '../germany/dawum.js';
import { getCalibrationData } from '../storage/repositories/outcomes.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface MispricingConfig {
  minEdge: number; // Min. Edge fuer Trade (default: 0.03)
  maxUncertainty: number; // Max. Unsicherheit (default: 0.15)
  minLiquidity: number; // Min. Liquidity-Score (default: 0.3)
  maxSpread: number; // Max. Spread (default: 0.05)
  meanReversionStrength: number; // Staerke der Mean-Reversion bei Extremen (default: 0.1)
}

export const DEFAULT_MISPRICING_CONFIG: MispricingConfig = {
  minEdge: 0.03,
  maxUncertainty: 0.15,
  minLiquidity: 0.3,
  maxSpread: 0.05,
  meanReversionStrength: 0.1,
};

// ═══════════════════════════════════════════════════════════════
// PROBABILITY ESTIMATION RESULT
// ═══════════════════════════════════════════════════════════════

interface ProbEstimation {
  estimate: number;
  uncertainty: number;
  reasoning: string[];
}

// ═══════════════════════════════════════════════════════════════
// MISPRICING ENGINE
// ═══════════════════════════════════════════════════════════════

export class MispricingEngine {
  private config: MispricingConfig;
  private featureVersion = '1.0.0';

  // Historische Kalibrierungsdaten (aus DB geladen)
  private historicalBias: Map<string, number> = new Map();

  constructor(config?: Partial<MispricingConfig>) {
    this.config = { ...DEFAULT_MISPRICING_CONFIG, ...config };
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTORISCHE KALIBRIERUNG
  // ═══════════════════════════════════════════════════════════════

  /**
   * Lade historische Kalibrierungsdaten aus der Outcomes-Tabelle
   * Berechnet durchschnittlichen Bias pro Wahrscheinlichkeits-Bucket
   */
  async loadHistoricalCalibration(): Promise<void> {
    try {
      const calibrationData = getCalibrationData('mispricing');

      if (calibrationData.length === 0) {
        logger.debug('MispricingEngine: Keine historischen Kalibrierungsdaten vorhanden');
        return;
      }

      // Buckets: 0-10%, 10-20%, ..., 90-100%
      const buckets: CalibrationBucket[] = [];
      for (let i = 0; i < 10; i++) {
        const lower = i * 0.1;
        const upper = (i + 1) * 0.1;

        const bucketData = calibrationData.filter(
          (d) => d.predictedProb >= lower && d.predictedProb < upper
        );

        if (bucketData.length > 0) {
          const predictedAvg =
            bucketData.reduce((sum, d) => sum + d.predictedProb, 0) / bucketData.length;
          const actualAvg =
            bucketData.reduce((sum, d) => sum + d.actualOutcome, 0) / bucketData.length;

          buckets.push({
            range: [lower, upper],
            predictedAvg,
            actualAvg,
            count: bucketData.length,
          });

          // Bias = actual - predicted (positiv = unterschaetzt, negativ = ueberschaetzt)
          const bias = actualAvg - predictedAvg;
          const bucketKey = `${lower.toFixed(1)}-${upper.toFixed(1)}`;
          this.historicalBias.set(bucketKey, bias);
        }
      }

      logger.info(
        `MispricingEngine: Kalibrierungsdaten geladen (${calibrationData.length} Outcomes, ${buckets.length} Buckets)`
      );
    } catch (error) {
      logger.error(`MispricingEngine: Fehler beim Laden der Kalibrierung: ${error}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SIGNAL GENERATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Hauptmethode: Generiere Signal fuer einen Markt
   */
  async generateSignal(
    market: Market,
    polls?: NormalizedPoll[],
    marketQuality?: MarketQuality
  ): Promise<AlphaSignalV2 | null> {
    // Market-Quality berechnen falls nicht uebergeben
    const quality = marketQuality ?? this.calculateMarketQuality(market);

    // P_true schaetzen
    const estimation = this.estimateTrueProb(market, polls);

    // Implied Probability aus Marktpreis (YES-Outcome)
    const yesOutcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === 'yes' || o.name.toLowerCase() === 'ja'
    );
    const impliedProb = yesOutcome?.price ?? 0.5;

    // Edge berechnen
    const edge = this.calculateEdge(impliedProb, estimation.estimate);

    // Tradeable?
    const tradeableCheck = this.isTradeable(edge, estimation.uncertainty, quality);

    // Wenn nicht tradeable oder kein signifikanter Edge, kein Signal
    if (!tradeableCheck.tradeable || Math.abs(edge) < this.config.minEdge) {
      return null;
    }

    // Features berechnen
    const features = this.calculateFeatures(market, estimation.estimate, estimation.uncertainty, polls);

    // Direction bestimmen
    const direction: 'yes' | 'no' = edge > 0 ? 'yes' : 'no';

    // Signal erstellen
    const signal: AlphaSignalV2 = {
      signalId: uuidv4(),
      alphaType: 'mispricing',
      marketId: market.id,
      question: market.question,
      direction,
      predictedEdge: Math.abs(edge),
      confidence: this.calculateConfidence(estimation.uncertainty, quality),
      features,
      reasoning: [...estimation.reasoning, ...tradeableCheck.reasons],
      createdAt: new Date(),
    };

    logger.debug(
      `MispricingEngine: Signal generiert fuer "${market.question.substring(0, 50)}..." - Edge: ${(edge * 100).toFixed(1)}%`
    );

    return signal;
  }

  // ═══════════════════════════════════════════════════════════════
  // P_TRUE SCHAETZUNG (TRANSPARENT)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Schaetze P_true mit Unsicherheit
   *
   * Komponenten:
   * 1. Basis: Implied Probability aus Marktpreis
   * 2. Poll-Delta: Bei Politik-Maerkten
   * 3. Mean-Reversion: Bei extremen Preisen
   * 4. Historischer Bias: Aus Outcomes-Tabelle
   */
  private estimateTrueProb(market: Market, polls?: NormalizedPoll[]): ProbEstimation {
    const reasoning: string[] = [];

    // 1. Basis: Implied Probability
    const yesOutcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === 'yes' || o.name.toLowerCase() === 'ja'
    );
    let estimate = yesOutcome?.price ?? 0.5;
    reasoning.push(`Basis: Marktpreis ${(estimate * 100).toFixed(1)}%`);

    // 2. Poll-Delta (nur bei Politik-Maerkten mit Umfragen)
    const pollDelta = this.calculatePollDelta(market, polls ?? []);
    if (pollDelta !== null) {
      const pollAdjustment = pollDelta * 0.5; // Nur 50% des Deltas anwenden (konservativ)
      estimate += pollAdjustment;
      reasoning.push(
        `Poll-Adjustment: ${pollDelta > 0 ? '+' : ''}${(pollDelta * 100).toFixed(1)}% (angewandt: ${(pollAdjustment * 100).toFixed(1)}%)`
      );
    }

    // 3. Mean-Reversion bei extremen Preisen
    const originalEstimate = estimate;
    estimate = this.applyMeanReversion(estimate);
    if (estimate !== originalEstimate) {
      reasoning.push(
        `Mean-Reversion: ${(originalEstimate * 100).toFixed(1)}% -> ${(estimate * 100).toFixed(1)}%`
      );
    }

    // 4. Historischer Bias
    const bucketKey = this.getBucketKey(estimate);
    const historicalBias = this.historicalBias.get(bucketKey) ?? 0;
    if (historicalBias !== 0) {
      const biasAdjustment = historicalBias * 0.3; // 30% des Bias anwenden
      estimate += biasAdjustment;
      reasoning.push(
        `Historischer Bias (${bucketKey}): ${historicalBias > 0 ? '+' : ''}${(historicalBias * 100).toFixed(1)}% (angewandt: ${(biasAdjustment * 100).toFixed(1)}%)`
      );
    }

    // Estimate auf [0.01, 0.99] begrenzen
    estimate = Math.max(0.01, Math.min(0.99, estimate));

    // 5. Unsicherheit berechnen
    const uncertainty = this.calculateUncertainty(market, polls ?? [], pollDelta !== null);
    reasoning.push(`Unsicherheit: +/- ${(uncertainty * 100).toFixed(1)}%`);

    return { estimate, uncertainty, reasoning };
  }

  /**
   * Berechne Unsicherheit basierend auf verfuegbaren Daten
   */
  private calculateUncertainty(
    market: Market,
    polls: NormalizedPoll[],
    hasPollData: boolean
  ): number {
    let uncertainty = 0.1; // Basis-Unsicherheit 10%

    // Spread erhoeht Unsicherheit
    const spreadProxy = this.calculateSpreadProxy(market);
    uncertainty += spreadProxy * 0.5;

    // Niedrige Liquiditaet erhoeht Unsicherheit
    const liquidityScore = this.calculateLiquidityScore(market);
    uncertainty += (1 - liquidityScore) * 0.1;

    // Zeit bis Expiry: Mehr Zeit = mehr Unsicherheit
    const daysToExpiry = this.calculateDaysToExpiry(market);
    if (daysToExpiry > 30) {
      uncertainty += 0.05;
    }
    if (daysToExpiry > 90) {
      uncertainty += 0.05;
    }

    // Umfragen reduzieren Unsicherheit bei Politik-Maerkten
    if (hasPollData && polls.length >= 3) {
      uncertainty *= 0.8; // 20% Reduktion
    }

    // Max 25% Unsicherheit
    return Math.min(0.25, uncertainty);
  }

  // ═══════════════════════════════════════════════════════════════
  // EDGE CALCULATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Berechne Edge = P_estimated - P_implied
   * Positiv = YES kaufen, Negativ = NO kaufen
   */
  private calculateEdge(impliedProb: number, estimatedProb: number): number {
    return estimatedProb - impliedProb;
  }

  // ═══════════════════════════════════════════════════════════════
  // TRADEABLE CHECK
  // ═══════════════════════════════════════════════════════════════

  /**
   * Pruefe ob der Markt tradeable ist
   */
  private isTradeable(
    edge: number,
    uncertainty: number,
    quality: MarketQuality
  ): { tradeable: boolean; reasons: string[] } {
    const reasons: string[] = [];
    let tradeable = true;

    // Edge muss groesser als Unsicherheit sein
    if (Math.abs(edge) < uncertainty) {
      reasons.push(`Edge (${(Math.abs(edge) * 100).toFixed(1)}%) < Unsicherheit (${(uncertainty * 100).toFixed(1)}%)`);
      tradeable = false;
    }

    // Mindest-Edge
    if (Math.abs(edge) < this.config.minEdge) {
      reasons.push(`Edge (${(Math.abs(edge) * 100).toFixed(1)}%) < Min-Edge (${(this.config.minEdge * 100).toFixed(1)}%)`);
      tradeable = false;
    }

    // Unsicherheit darf nicht zu hoch sein
    if (uncertainty > this.config.maxUncertainty) {
      reasons.push(
        `Unsicherheit (${(uncertainty * 100).toFixed(1)}%) > Max (${(this.config.maxUncertainty * 100).toFixed(1)}%)`
      );
      tradeable = false;
    }

    // Liquiditaet
    if (quality.liquidityScore < this.config.minLiquidity) {
      reasons.push(
        `Liquiditaet (${quality.liquidityScore.toFixed(2)}) < Min (${this.config.minLiquidity})`
      );
      tradeable = false;
    }

    // Spread
    if (quality.spreadProxy > this.config.maxSpread) {
      reasons.push(
        `Spread (${(quality.spreadProxy * 100).toFixed(1)}%) > Max (${(this.config.maxSpread * 100).toFixed(1)}%)`
      );
      tradeable = false;
    }

    if (tradeable) {
      reasons.push('Alle Tradeable-Checks bestanden');
    }

    return { tradeable, reasons };
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE CALCULATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Berechne alle Features fuer das Signal
   */
  private calculateFeatures(
    market: Market,
    estimate: number,
    uncertainty: number,
    polls?: NormalizedPoll[]
  ): MispricingFeatures {
    const yesOutcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === 'yes' || o.name.toLowerCase() === 'ja'
    );
    const impliedProb = yesOutcome?.price ?? 0.5;

    const pollDelta = this.calculatePollDelta(market, polls ?? []);
    const bucketKey = this.getBucketKey(impliedProb);
    const historicalBias = this.historicalBias.get(bucketKey) ?? 0;

    return {
      version: this.featureVersion,
      features: {
        impliedProb,
        estimatedProb: estimate,
        probUncertainty: uncertainty,
        pollDelta,
        historicalBias,
        liquidityScore: this.calculateLiquidityScore(market),
        spreadProxy: this.calculateSpreadProxy(market),
        volatility30d: 0, // Placeholder - TODO: Aus historischen Daten berechnen
        daysToExpiry: this.calculateDaysToExpiry(market),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // MEAN REVERSION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Wende Mean-Reversion bei extremen Preisen an
   * Maerkte mit <10% oder >90% tendieren zur Mitte zurueck
   */
  private applyMeanReversion(price: number): number {
    const strength = this.config.meanReversionStrength;

    if (price < 0.1) {
      // Unter 10%: Leichte Aufwaertskorrektur
      const adjustment = (0.1 - price) * strength;
      return price + adjustment;
    }

    if (price > 0.9) {
      // Ueber 90%: Leichte Abwaertskorrektur
      const adjustment = (price - 0.9) * strength;
      return price - adjustment;
    }

    return price;
  }

  // ═══════════════════════════════════════════════════════════════
  // POLL DELTA
  // ═══════════════════════════════════════════════════════════════

  /**
   * Berechne Differenz zwischen Umfragen und Marktpreis
   * Nur fuer Politik-Maerkte relevant
   */
  private calculatePollDelta(market: Market, polls: NormalizedPoll[]): number | null {
    // Nur fuer Politik-Maerkte
    if (market.category !== 'politics') {
      return null;
    }

    if (!polls || polls.length === 0) {
      return null;
    }

    // Versuche Partei aus Markt-Frage zu extrahieren
    const question = market.question.toLowerCase();

    // Partei-Mapping
    const partyMatches: { party: keyof NormalizedPoll; patterns: string[] }[] = [
      { party: 'cduCsu', patterns: ['cdu', 'csu', 'union', 'merz'] },
      { party: 'spd', patterns: ['spd', 'scholz', 'sozialdemokrat'] },
      { party: 'gruene', patterns: ['gruene', 'grüne', 'green', 'habeck', 'baerbock'] },
      { party: 'afd', patterns: ['afd', 'weidel', 'alternative für deutschland'] },
      { party: 'fdp', patterns: ['fdp', 'lindner', 'liberal'] },
      { party: 'linke', patterns: ['linke', 'left party'] },
      { party: 'bsw', patterns: ['bsw', 'wagenknecht', 'bündnis sahra'] },
    ];

    // Finde passende Partei
    for (const { party, patterns } of partyMatches) {
      if (patterns.some((p) => question.includes(p))) {
        // Durchschnitt der letzten 3 Umfragen
        const recentPolls = polls.slice(0, 3);
        const avgPollValue =
          recentPolls.reduce((sum, poll) => sum + (poll[party] as number), 0) / recentPolls.length;

        // Poll-Wert ist in % (0-100), Marktpreis ist 0-1
        const pollProbability = avgPollValue / 100;

        // Delta = Poll - Markt
        const yesOutcome = market.outcomes.find(
          (o) => o.name.toLowerCase() === 'yes' || o.name.toLowerCase() === 'ja'
        );
        const marketPrice = yesOutcome?.price ?? 0.5;

        return pollProbability - marketPrice;
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // MARKET QUALITY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Berechne Market-Quality Metriken
   */
  calculateMarketQuality(market: Market): MarketQuality {
    const liquidityScore = this.calculateLiquidityScore(market);
    const spreadProxy = this.calculateSpreadProxy(market);
    const volume24h = market.volume24h;
    const volatility = 0; // Placeholder

    const reasons: string[] = [];
    let tradeable = true;

    if (liquidityScore < this.config.minLiquidity) {
      reasons.push(`Niedrige Liquiditaet: ${liquidityScore.toFixed(2)}`);
      tradeable = false;
    }

    if (spreadProxy > this.config.maxSpread) {
      reasons.push(`Hoher Spread: ${(spreadProxy * 100).toFixed(1)}%`);
      tradeable = false;
    }

    if (volume24h < 100) {
      reasons.push(`Niedriges Volume: $${volume24h.toFixed(0)}`);
      tradeable = false;
    }

    if (tradeable) {
      reasons.push('Market-Quality OK');
    }

    return {
      marketId: market.id,
      liquidityScore,
      spreadProxy,
      volume24h,
      volatility,
      tradeable,
      reasons,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Berechne Liquidity-Score (0-1)
   */
  private calculateLiquidityScore(market: Market): number {
    // Normalisiere Liquiditaet auf 0-1 Skala
    // $100k+ = 1.0, $10k = 0.5, $1k = 0.1
    const liquidity = market.liquidity;
    const score = Math.min(1, Math.log10(Math.max(1, liquidity)) / 5);
    return score;
  }

  /**
   * Berechne Spread-Proxy: |yes_price + no_price - 1|
   */
  private calculateSpreadProxy(market: Market): number {
    const yesPriceOutcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === 'yes' || o.name.toLowerCase() === 'ja'
    );
    const noPriceOutcome = market.outcomes.find(
      (o) => o.name.toLowerCase() === 'no' || o.name.toLowerCase() === 'nein'
    );

    const yesPrice = yesPriceOutcome?.price ?? 0.5;
    const noPrice = noPriceOutcome?.price ?? 0.5;

    return Math.abs(yesPrice + noPrice - 1);
  }

  /**
   * Berechne Tage bis Expiry
   */
  private calculateDaysToExpiry(market: Market): number {
    if (!market.endDate) {
      return 365; // Default: 1 Jahr
    }

    const endDate = new Date(market.endDate);
    const now = new Date();
    const diffMs = endDate.getTime() - now.getTime();
    const diffDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

    return diffDays;
  }

  /**
   * Berechne Confidence (0-1) basierend auf Unsicherheit und Qualitaet
   */
  private calculateConfidence(uncertainty: number, quality: MarketQuality): number {
    // Basis-Confidence aus Unsicherheit
    let confidence = 1 - uncertainty / 0.25; // 0% Unsicherheit = 1.0, 25% = 0

    // Qualitaet einbeziehen
    confidence *= (quality.liquidityScore + 1) / 2; // Liquiditaet hat halbes Gewicht

    // Spread-Penalty
    confidence *= 1 - quality.spreadProxy;

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Hole Bucket-Key fuer historischen Bias
   */
  private getBucketKey(prob: number): string {
    const bucket = Math.floor(prob * 10) / 10;
    const lower = Math.max(0, bucket).toFixed(1);
    const upper = Math.min(1, bucket + 0.1).toFixed(1);
    return `${lower}-${upper}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════

export const mispricingEngine = new MispricingEngine();
