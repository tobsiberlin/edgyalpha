import { Market, AlphaSignal, TradeRecommendation } from '../types/index.js';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';
import { v4 as uuid } from 'uuid';

// Alpha Score berechnen basierend auf verschiedenen Faktoren
export function calculateAlphaScore(
  market: Market,
  externalData?: {
    germanSources?: Array<{ relevance: number; direction: 'YES' | 'NO' }>;
    aiAnalysis?: { confidence: number; direction: 'YES' | 'NO' };
  }
): { score: number; edge: number; direction: 'YES' | 'NO'; reasoning: string } {
  let score = 0;
  let direction: 'YES' | 'NO' = 'YES';
  const reasons: string[] = [];

  // 1. Volume Analysis (höheres Volume = zuverlässigere Preise)
  const volumeScore = Math.min(market.volume24h / 500000, 1) * 0.15;
  score += volumeScore;
  if (volumeScore > 0.1) {
    reasons.push(`Hohes Volumen: $${market.volume24h.toLocaleString()}`);
  }

  // 2. Preis-Analyse (Extreme Preise = potentielle Mispricing)
  const yesOutcome = market.outcomes.find(
    (o) => o.name.toLowerCase() === 'yes'
  );
  const noOutcome = market.outcomes.find((o) => o.name.toLowerCase() === 'no');

  if (yesOutcome && noOutcome) {
    const yesPrice = yesOutcome.price;
    const noPrice = noOutcome.price;

    // Suche nach Mispricing (Preise die nicht 1.0 ergeben)
    const totalPrice = yesPrice + noPrice;
    if (Math.abs(totalPrice - 1) > 0.02) {
      const mispricingScore = Math.abs(totalPrice - 1) * 2;
      score += Math.min(mispricingScore, 0.2);
      reasons.push(`Mispricing erkannt: ${((totalPrice - 1) * 100).toFixed(1)}%`);
    }

    // Extreme Preise (nahe 0 oder 1) können Opportunities sein
    if (yesPrice < 0.15 || yesPrice > 0.85) {
      score += 0.1;
      direction = yesPrice < 0.15 ? 'NO' : 'YES';
      reasons.push(`Extremer Preis: ${(yesPrice * 100).toFixed(0)}% YES`);
    }
  }

  // 3. Liquidität (geringe Liquidität = mögliche Ineffizienz)
  if (market.liquidity > 0 && market.liquidity < 50000) {
    score += 0.1;
    reasons.push('Niedrige Liquidität - potentielle Ineffizienz');
  }

  // 4. Zeitfaktor (Märkte kurz vor Ende haben oft Mispricing)
  const endDate = new Date(market.endDate);
  const now = new Date();
  const daysUntilEnd = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (daysUntilEnd > 0 && daysUntilEnd < 7) {
    score += 0.15;
    reasons.push(`Endet in ${daysUntilEnd.toFixed(1)} Tagen`);
  }

  // 5. Deutsche Quellen (falls vorhanden)
  if (externalData?.germanSources && externalData.germanSources.length > 0) {
    const avgRelevance =
      externalData.germanSources.reduce((sum, s) => sum + s.relevance, 0) /
      externalData.germanSources.length;

    score += avgRelevance * 0.3;
    reasons.push(`Deutschland-Info: ${externalData.germanSources.length} Quellen`);

    // Direction von deutschen Quellen übernehmen
    const yesVotes = externalData.germanSources.filter(
      (s) => s.direction === 'YES'
    ).length;
    const noVotes = externalData.germanSources.filter(
      (s) => s.direction === 'NO'
    ).length;
    direction = yesVotes > noVotes ? 'YES' : 'NO';
  }

  // 6. KI-Analyse (falls vorhanden)
  if (externalData?.aiAnalysis) {
    score += externalData.aiAnalysis.confidence * 0.25;
    direction = externalData.aiAnalysis.direction;
    reasons.push(`KI-Analyse: ${(externalData.aiAnalysis.confidence * 100).toFixed(0)}% Konfidenz`);
  }

  // Edge berechnen (basierend auf Score und aktuellen Preisen)
  const currentPrice =
    direction === 'YES' ? yesOutcome?.price || 0.5 : noOutcome?.price || 0.5;
  const impliedProb = currentPrice;
  const estimatedProb = Math.min(impliedProb + score * 0.3, 0.95);
  const edge = (estimatedProb - impliedProb) / impliedProb;

  // Score normalisieren auf 0-1
  const normalizedScore = Math.min(Math.max(score, 0), 1);

  return {
    score: normalizedScore,
    edge: Math.max(edge, 0),
    direction,
    reasoning: reasons.join(' | '),
  };
}

// Kelly Criterion für Positionsgröße
export function calculateKellyBet(
  edge: number,
  odds: number,
  bankroll: number,
  kellyFraction: number = 0.25
): number {
  // Kelly: f* = (p*b - q) / b
  // p = Gewinnwahrscheinlichkeit, q = 1-p, b = Gewinnquote
  // Bei Prediction Markets: odds = 1/price - 1

  const p = 0.5 + edge / 2; // Geschätzte Gewinnwahrscheinlichkeit
  const q = 1 - p;
  const b = odds;

  const kelly = (p * b - q) / b;
  const fractionalKelly = kelly * kellyFraction;

  // Begrenzen auf max Einsatz
  const maxBet = config.trading.maxBetUsdc;
  const riskBased = bankroll * (config.trading.riskPerTradePercent / 100);

  const bet = Math.min(
    Math.max(fractionalKelly * bankroll, 0),
    maxBet,
    riskBased
  );

  return Math.round(bet * 100) / 100;
}

// Trade Recommendation erstellen
export function createTradeRecommendation(
  signal: AlphaSignal,
  bankroll: number
): TradeRecommendation {
  const outcome = signal.market.outcomes.find(
    (o) => o.name.toUpperCase() === signal.direction
  );
  const price = outcome?.price || 0.5;
  const odds = 1 / price - 1;

  const positionSize = calculateKellyBet(
    signal.edge,
    odds,
    bankroll,
    config.trading.kellyFraction
  );

  const expectedValue = positionSize * signal.edge;
  const maxLoss = positionSize;
  const potentialWin = positionSize * odds;
  const riskRewardRatio = potentialWin / maxLoss;

  return {
    signal,
    positionSize,
    kellyFraction: config.trading.kellyFraction,
    expectedValue,
    maxLoss,
    riskRewardRatio,
  };
}

// Alpha Signal aus Markt erstellen
export function createAlphaSignal(
  market: Market,
  externalData?: {
    germanSources?: Array<{ relevance: number; direction: 'YES' | 'NO' }>;
    aiAnalysis?: { confidence: number; direction: 'YES' | 'NO' };
  }
): AlphaSignal | null {
  const { score, edge, direction, reasoning } = calculateAlphaScore(
    market,
    externalData
  );

  // Nur Signale mit ausreichendem Score
  if (score < config.trading.minAlphaForTrade) {
    return null;
  }

  // Edge-Prüfung für Deutschland-Modus
  if (externalData?.germanSources && externalData.germanSources.length > 0) {
    if (edge < config.germany.minEdge) {
      logger.debug(
        `DE-Signal verworfen: Edge ${(edge * 100).toFixed(1)}% < ${config.germany.minEdge * 100}%`
      );
      return null;
    }
  }

  const signal: AlphaSignal = {
    id: uuid(),
    market,
    score,
    edge,
    confidence: score,
    direction,
    reasoning,
    sources: [],
    timestamp: new Date(),
    germanSource: externalData?.germanSources?.[0]
      ? {
          type: 'rss',
          title: 'Deutsche Quelle',
          data: {},
          relevance: externalData.germanSources[0].relevance,
          publishedAt: new Date(),
        }
      : undefined,
  };

  logger.info(
    `Alpha Signal: ${market.question.substring(0, 50)}... | Score: ${score.toFixed(2)} | Edge: ${(edge * 100).toFixed(1)}% | ${direction}`
  );

  return signal;
}

export default {
  calculateAlphaScore,
  calculateKellyBet,
  createTradeRecommendation,
  createAlphaSignal,
};
