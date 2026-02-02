import { Market, AlphaSignal, TradeRecommendation, GermanSource } from '../types/index.js';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';
import { v4 as uuid } from 'uuid';

// ═══════════════════════════════════════════════════════════════
//                    ALPHA GENERATOR v2.0
//          ALLE QUELLEN NUTZEN - MAXIMALE POWER
// ═══════════════════════════════════════════════════════════════

// Sentiment Keywords für verschiedene Richtungen
const BULLISH_KEYWORDS = [
  'wins', 'victory', 'success', 'approved', 'passed', 'confirmed', 'deal',
  'agreement', 'breakthrough', 'surge', 'rally', 'boost', 'growth',
  'gewinnt', 'sieg', 'erfolg', 'genehmigt', 'durchbruch', 'einigung',
  'yes', 'will', 'expected to', 'likely', 'probably', 'on track',
  'peace', 'ceasefire', 'withdrawal', 'ends', 'resolves',
];

const BEARISH_KEYWORDS = [
  'loses', 'defeat', 'failure', 'rejected', 'blocked', 'collapse',
  'crisis', 'crash', 'plunge', 'scandal', 'investigation', 'charged',
  'verliert', 'niederlage', 'scheitert', 'abgelehnt', 'krise',
  'no', 'won\'t', 'unlikely', 'doubt', 'fails', 'impossible',
  'war', 'invasion', 'escalation', 'attack', 'sanctions',
];

const HIGH_IMPACT_KEYWORDS = [
  // Breaking News Indikatoren
  'breaking', 'just in', 'eilmeldung', 'soeben', 'aktuell',
  'confirmed', 'official', 'announces', 'bestätigt', 'offiziell',
  // Hoher Impact
  'resign', 'fired', 'sacked', 'dead', 'dies', 'killed',
  'rücktritt', 'entlassen', 'tot', 'stirbt', 'getötet',
  'war', 'invasion', 'nuclear', 'emergency', 'crisis',
  'krieg', 'angriff', 'notstand', 'krise',
];

// Interface für erweiterte Alpha-Analyse
export interface NewsAlphaData {
  news: GermanSource[];
  recentNews: GermanSource[]; // News der letzten 30 Min
  sentimentScore: number; // -1 bis +1
  impactScore: number; // 0 bis 1
  matchCount: number;
  bestMatch?: {
    title: string;
    source: string;
    relevance: number;
    sentiment: 'bullish' | 'bearish' | 'neutral';
    isBreaking: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════
//                    NEWS-BASIERTE ALPHA ANALYSE
// ═══════════════════════════════════════════════════════════════

export function analyzeNewsForMarket(
  market: Market,
  allNews: GermanSource[]
): NewsAlphaData {
  const marketText = `${market.question} ${market.slug}`.toLowerCase();
  const marketWords = extractSignificantWords(marketText);

  const now = Date.now();
  const thirtyMinAgo = now - 30 * 60 * 1000;

  const matchingNews: GermanSource[] = [];
  const recentMatchingNews: GermanSource[] = [];
  let totalSentiment = 0;
  let totalImpact = 0;
  let bestMatch: NewsAlphaData['bestMatch'] | undefined;
  let bestRelevance = 0;

  for (const news of allNews) {
    const newsText = `${news.title} ${(news.data.content as string) || ''}`.toLowerCase();
    const newsWords = extractSignificantWords(newsText);

    // Match-Score berechnen
    const relevance = calculateMatchRelevance(marketWords, newsWords, marketText, newsText);

    if (relevance > 0.2) {
      matchingNews.push({ ...news, relevance });

      // Ist die News aktuell (< 30 Min)?
      const newsTime = news.publishedAt.getTime();
      const isRecent = newsTime > thirtyMinAgo;
      if (isRecent) {
        recentMatchingNews.push({ ...news, relevance });
      }

      // Sentiment analysieren
      const sentiment = analyzeSentiment(newsText);
      totalSentiment += sentiment;

      // Impact analysieren
      const impact = analyzeImpact(newsText);
      totalImpact += impact;

      // Bestes Match tracken
      if (relevance > bestRelevance) {
        bestRelevance = relevance;
        bestMatch = {
          title: news.title,
          source: (news.data.source as string) || 'Unknown',
          relevance,
          sentiment: sentiment > 0.2 ? 'bullish' : sentiment < -0.2 ? 'bearish' : 'neutral',
          isBreaking: isBreakingNews(newsText),
        };
      }
    }
  }

  const matchCount = matchingNews.length;
  const avgSentiment = matchCount > 0 ? totalSentiment / matchCount : 0;
  const avgImpact = matchCount > 0 ? totalImpact / matchCount : 0;

  // Boost für aktuelle News
  const recencyBoost = recentMatchingNews.length > 0 ? 0.2 : 0;
  const finalImpact = Math.min(avgImpact + recencyBoost, 1);

  return {
    news: matchingNews,
    recentNews: recentMatchingNews,
    sentimentScore: avgSentiment,
    impactScore: finalImpact,
    matchCount,
    bestMatch,
  };
}

function extractSignificantWords(text: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'to', 'of', 'in', 'for', 'on',
    'with', 'at', 'by', 'from', 'up', 'about', 'into', 'over', 'after',
    'der', 'die', 'das', 'und', 'oder', 'aber', 'wenn', 'weil', 'dass',
    'wird', 'werden', 'hat', 'haben', 'ist', 'sind', 'war', 'waren',
    'sein', 'seine', 'einer', 'eine', 'einem', 'einen', 'vor', 'nach',
    'bei', 'mit', 'will', 'yes', 'no',
  ]);

  return text
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-ZäöüßÄÖÜ0-9]/g, '').toLowerCase())
    .filter(w => w.length > 2 && !stopwords.has(w));
}

function calculateMatchRelevance(
  marketWords: string[],
  newsWords: string[],
  marketText: string,
  newsText: string
): number {
  let score = 0;

  // 1. Direkte Wort-Überlappung
  for (const mw of marketWords) {
    if (mw.length > 3) {
      for (const nw of newsWords) {
        if (nw === mw) {
          score += 0.15;
        } else if (nw.includes(mw) || mw.includes(nw)) {
          score += 0.1;
        } else if (levenshteinDistance(mw, nw) <= 2) {
          score += 0.05;
        }
      }
    }
  }

  // 2. Named Entity Matching (Namen, Orte, etc.)
  const namedEntities = extractNamedEntities(marketText);
  for (const entity of namedEntities) {
    if (newsText.includes(entity.toLowerCase())) {
      score += 0.25;
    }
  }

  // 3. Phrase Matching
  const marketPhrases = extractPhrases(marketText);
  for (const phrase of marketPhrases) {
    if (newsText.includes(phrase.toLowerCase())) {
      score += 0.3;
    }
  }

  return Math.min(score, 1);
}

function extractNamedEntities(text: string): string[] {
  // Einfache Named Entity Extraction (Wörter mit Großbuchstaben)
  const matches = text.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g) || [];
  return matches.filter(m => m.length > 3);
}

function extractPhrases(text: string): string[] {
  // 2-3 Wort Phrasen extrahieren
  const words = text.split(/\s+/).filter(w => w.length > 2);
  const phrases: string[] = [];

  for (let i = 0; i < words.length - 1; i++) {
    phrases.push(`${words[i]} ${words[i + 1]}`);
    if (i < words.length - 2) {
      phrases.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
  }

  return phrases;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function analyzeSentiment(text: string): number {
  const lowerText = text.toLowerCase();
  let score = 0;

  for (const kw of BULLISH_KEYWORDS) {
    if (lowerText.includes(kw)) score += 0.15;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (lowerText.includes(kw)) score -= 0.15;
  }

  return Math.max(-1, Math.min(1, score));
}

function analyzeImpact(text: string): number {
  const lowerText = text.toLowerCase();
  let impact = 0.3; // Basis-Impact

  for (const kw of HIGH_IMPACT_KEYWORDS) {
    if (lowerText.includes(kw)) impact += 0.15;
  }

  return Math.min(impact, 1);
}

function isBreakingNews(text: string): boolean {
  const lowerText = text.toLowerCase();
  const breakingIndicators = ['breaking', 'just in', 'eilmeldung', 'soeben', '+++ '];
  return breakingIndicators.some(ind => lowerText.includes(ind));
}

// ═══════════════════════════════════════════════════════════════
//                    ALPHA SCORE BERECHNUNG V2
//          Echte, variierende Werte mit nachvollziehbarem Reasoning
// ═══════════════════════════════════════════════════════════════

// Gewichtungen fuer die verschiedenen Faktoren
const WEIGHTS = {
  // Match-Qualitaet (wie gut passt News zu Markt)
  matchRelevance: 0.25,
  // Quellen-Faktoren
  sourceCount: 0.15,
  sourceQuality: 0.10,
  // Timing-Faktoren
  newsFreshness: 0.20,
  timeAdvantage: 0.10,
  // Inhalt-Faktoren
  sentimentStrength: 0.10,
  impactScore: 0.10,
};

export interface AlphaCalculationResult {
  score: number;       // 0-1 Gesamtscore
  edge: number;        // 0-0.25 erwarteter Vorteil
  confidence: number;  // 0-1 Wie sicher sind wir?
  direction: 'YES' | 'NO';
  reasoning: string;
  breakdown: {
    matchScore: number;
    sourceScore: number;
    timingScore: number;
    contentScore: number;
  };
}

export function calculateAlphaScore(
  market: Market,
  externalData?: {
    germanSources?: Array<{ relevance: number; direction: 'YES' | 'NO' }>;
    aiAnalysis?: { confidence: number; direction: 'YES' | 'NO' };
    newsAlpha?: NewsAlphaData;
  }
): AlphaCalculationResult {
  const reasons: string[] = [];
  let direction: 'YES' | 'NO' = 'YES';

  const yesOutcome = market.outcomes.find(
    (o) => o.name.toLowerCase() === 'yes'
  );
  const noOutcome = market.outcomes.find((o) => o.name.toLowerCase() === 'no');
  const yesPrice = yesOutcome?.price ?? 0.5;
  const noPrice = noOutcome?.price ?? 0.5;

  // ═══════════════════════════════════════════════════════════════
  // 1. MATCH-QUALITAET (Wie gut passt News zum Markt?)
  // ═══════════════════════════════════════════════════════════════
  let matchScore = 0;
  let bestMatchRelevance = 0;

  if (externalData?.newsAlpha?.bestMatch) {
    bestMatchRelevance = externalData.newsAlpha.bestMatch.relevance;
    matchScore = bestMatchRelevance;

    const matchPct = (bestMatchRelevance * 100).toFixed(0);
    reasons.push(`Match: ${matchPct}%`);

    if (bestMatchRelevance < 0.4) {
      reasons.push('(schwaches Matching)');
    } else if (bestMatchRelevance >= 0.7) {
      reasons.push('(starkes Matching)');
    }
  } else if (externalData?.germanSources && externalData.germanSources.length > 0) {
    // DE-Quellen als Fallback
    const avgRelevance = externalData.germanSources.reduce((sum, s) => sum + s.relevance, 0) /
                         externalData.germanSources.length;
    matchScore = avgRelevance;
    bestMatchRelevance = avgRelevance;
    reasons.push(`DE-Match: ${(avgRelevance * 100).toFixed(0)}%`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. QUELLEN-QUALITAET (Anzahl und Glaubwuerdigkeit)
  // ═══════════════════════════════════════════════════════════════
  let sourceScore = 0;
  let sourceCountFactor = 0;
  let sourceQualityFactor = 0;

  if (externalData?.newsAlpha) {
    const na = externalData.newsAlpha;

    // Anzahl der Quellen (mehr = besser, aber mit abnehmendem Ertrag)
    // 1 Quelle = 0.3, 2 = 0.5, 3 = 0.7, 4+ = 0.85+
    sourceCountFactor = Math.min(1, Math.log2(na.matchCount + 1) / 2.5);

    // Qualitaet basierend auf Best Match Source
    if (na.bestMatch) {
      // Breaking News von bekannter Quelle = hohe Qualitaet
      sourceQualityFactor = na.bestMatch.isBreaking ? 0.9 : 0.6;
    }

    sourceScore = (sourceCountFactor * WEIGHTS.sourceCount +
                   sourceQualityFactor * WEIGHTS.sourceQuality) /
                  (WEIGHTS.sourceCount + WEIGHTS.sourceQuality);

    if (na.matchCount >= 3) {
      reasons.push(`${na.matchCount} Quellen bestaetigen`);
    } else if (na.matchCount === 2) {
      reasons.push(`2 Quellen`);
    } else if (na.matchCount === 1) {
      reasons.push(`1 Quelle`);
    }
  }

  if (externalData?.germanSources && externalData.germanSources.length > 0) {
    const deCount = externalData.germanSources.length;
    // Deutsche Quellen haben Bonus wegen Heimvorteil
    const deFactor = Math.min(1, Math.log2(deCount + 1) / 2) * 1.2;
    sourceScore = Math.max(sourceScore, Math.min(1, deFactor));
    reasons.push(`DE: ${deCount}x`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. TIMING (Frische der News + Zeitvorsprung)
  // ═══════════════════════════════════════════════════════════════
  let timingScore = 0;
  let freshnessFactor = 0;
  let timeAdvantageFactor = 0;

  if (externalData?.newsAlpha) {
    const na = externalData.newsAlpha;

    // Frische: News < 10 Min = 1.0, < 30 Min = 0.7, < 60 Min = 0.4, > 60 Min = 0.2
    if (na.recentNews.length > 0) {
      freshnessFactor = 1.0;
      const freshCount = na.recentNews.length;
      reasons.push(`${freshCount} News < 30 Min`);
    } else if (na.news.length > 0) {
      // Berechne durchschnittliches Alter
      const now = Date.now();
      const ages = na.news.map(n => (now - n.publishedAt.getTime()) / (60 * 1000));
      const avgAgeMinutes = ages.reduce((a, b) => a + b, 0) / ages.length;

      if (avgAgeMinutes <= 30) {
        freshnessFactor = 0.7;
      } else if (avgAgeMinutes <= 60) {
        freshnessFactor = 0.4;
        reasons.push(`News ~${avgAgeMinutes.toFixed(0)} Min alt`);
      } else {
        freshnessFactor = 0.2;
        reasons.push(`News ${avgAgeMinutes.toFixed(0)} Min alt (veraltet)`);
      }
    }

    // Zeitvorsprung gegenueber Marktreaktion
    // Wenn Markt noch nicht reagiert hat, haben wir Vorsprung
    const priceStillNeutral = Math.abs(yesPrice - 0.5) < 0.1;
    if (freshnessFactor > 0.5 && priceStillNeutral) {
      timeAdvantageFactor = 0.8;
      reasons.push('Markt noch nicht reagiert');
    } else if (freshnessFactor > 0.5) {
      timeAdvantageFactor = 0.4;
    }

    timingScore = (freshnessFactor * WEIGHTS.newsFreshness +
                   timeAdvantageFactor * WEIGHTS.timeAdvantage) /
                  (WEIGHTS.newsFreshness + WEIGHTS.timeAdvantage);
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. INHALT (Sentiment + Impact)
  // ═══════════════════════════════════════════════════════════════
  let contentScore = 0;
  let sentimentFactor = 0;
  let impactFactor = 0;

  if (externalData?.newsAlpha) {
    const na = externalData.newsAlpha;

    // Sentiment-Staerke (absoluter Wert)
    const absSentiment = Math.abs(na.sentimentScore);
    sentimentFactor = absSentiment; // 0-1 direkt verwendbar

    // Direction aus Sentiment ableiten
    if (na.sentimentScore > 0.15) {
      direction = 'YES';
      if (absSentiment >= 0.5) {
        reasons.push('stark positiv');
      } else if (absSentiment >= 0.3) {
        reasons.push('positiv');
      }
    } else if (na.sentimentScore < -0.15) {
      direction = 'NO';
      if (absSentiment >= 0.5) {
        reasons.push('stark negativ');
      } else if (absSentiment >= 0.3) {
        reasons.push('negativ');
      }
    } else {
      reasons.push('neutral');
    }

    // Impact-Score (Breaking News, etc.)
    impactFactor = na.impactScore;

    if (na.bestMatch?.isBreaking) {
      impactFactor = Math.max(impactFactor, 0.9);
      reasons.push('BREAKING');
    } else if (impactFactor >= 0.5) {
      reasons.push('hoher Impact');
    }

    contentScore = (sentimentFactor * WEIGHTS.sentimentStrength +
                    impactFactor * WEIGHTS.impactScore) /
                   (WEIGHTS.sentimentStrength + WEIGHTS.impactScore);
  }

  // Deutsche Quellen Direction
  if (externalData?.germanSources && externalData.germanSources.length > 0) {
    const yesVotes = externalData.germanSources.filter(s => s.direction === 'YES').length;
    const noVotes = externalData.germanSources.filter(s => s.direction === 'NO').length;
    if (yesVotes > noVotes) {
      direction = 'YES';
    } else if (noVotes > yesVotes) {
      direction = 'NO';
    }
  }

  // AI-Analyse ueberschreibt alles
  if (externalData?.aiAnalysis) {
    direction = externalData.aiAnalysis.direction;
    const aiConf = externalData.aiAnalysis.confidence;
    reasons.push(`AI: ${(aiConf * 100).toFixed(0)}%`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. MARKT-FAKTOREN (Mispricing, Volumen, Zeit)
  // ═══════════════════════════════════════════════════════════════
  let marketBonus = 0;

  // Mispricing Detection
  const totalPrice = yesPrice + noPrice;
  if (Math.abs(totalPrice - 1) > 0.02) {
    const mispricing = Math.abs(totalPrice - 1);
    marketBonus += mispricing * 0.5;
    reasons.push(`Mispricing: ${(mispricing * 100).toFixed(1)}%`);
  }

  // Volumen (mehr Volumen = mehr Vertrauen in Preise, aber auch mehr Liquiditaet)
  const volumeNormalized = Math.min(market.volume24h / 100000, 1);
  if (volumeNormalized >= 0.5) {
    reasons.push(`Vol: $${(market.volume24h / 1000).toFixed(0)}k`);
  }

  // Zeit bis Ende (nahe Deadline = hoeherer Druck)
  const endDate = new Date(market.endDate);
  const now = new Date();
  const daysUntilEnd = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (daysUntilEnd > 0 && daysUntilEnd < 7) {
    marketBonus += 0.1;
    reasons.push(`${daysUntilEnd.toFixed(0)}d verbleibend`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. FINALE BERECHNUNG
  // ═══════════════════════════════════════════════════════════════

  // Gewichteter Gesamtscore
  const rawScore = (
    matchScore * WEIGHTS.matchRelevance +
    sourceScore * (WEIGHTS.sourceCount + WEIGHTS.sourceQuality) +
    timingScore * (WEIGHTS.newsFreshness + WEIGHTS.timeAdvantage) +
    contentScore * (WEIGHTS.sentimentStrength + WEIGHTS.impactScore)
  );

  // Score normalisieren und Markt-Bonus hinzufuegen
  let score = Math.min(1, rawScore + marketBonus);

  // Edge-Berechnung: Basierend auf Score und Match-Qualitaet
  // Edge = wie viel besser wir den wahren Preis schaetzen
  // Formel: Edge = BaseEdge * MatchQualitaet * TimingFaktor
  const baseEdge = score * 0.15; // Max 15% Base Edge aus Score
  const matchMultiplier = 0.5 + bestMatchRelevance * 0.5; // 0.5-1.0
  const timingMultiplier = 0.6 + timingScore * 0.4; // 0.6-1.0

  let edge = baseEdge * matchMultiplier * timingMultiplier;

  // Minimum-Edge wenn wir gute Daten haben
  if (matchScore >= 0.5 && sourceScore >= 0.3) {
    edge = Math.max(edge, 0.02); // Mindestens 2%
  }

  // Maximum-Edge begrenzen (25% ist realistisches Maximum)
  edge = Math.min(edge, 0.25);

  // Confidence-Berechnung: Wie sicher sind wir in unserer Schaetzung?
  // Hohe Confidence bei: Multi-Source + Starkes Match + Frische News
  let confidence = (
    sourceCountFactor * 0.35 +      // Mehrere Quellen = sicherer
    bestMatchRelevance * 0.30 +     // Besseres Match = sicherer
    freshnessFactor * 0.20 +        // Frische News = sicherer
    Math.abs(externalData?.newsAlpha?.sentimentScore ?? 0) * 0.15  // Klares Sentiment = sicherer
  );

  // Confidence-Adjustments
  if (externalData?.newsAlpha?.matchCount === 1) {
    confidence *= 0.7; // Single-Source Penalty
  }
  if (freshnessFactor < 0.3) {
    confidence *= 0.8; // Alte News Penalty
  }
  if (externalData?.aiAnalysis) {
    confidence = Math.max(confidence, externalData.aiAnalysis.confidence * 0.9);
  }

  confidence = Math.min(Math.max(confidence, 0.1), 0.95); // 10-95% Range

  // Falls kein sinnvoller Input, minimale Werte
  if (!externalData?.newsAlpha && !externalData?.germanSources && !externalData?.aiAnalysis) {
    score = Math.max(score, 0.1);
    edge = 0;
    confidence = 0.1;
  }

  // Logging fuer Debugging
  logger.debug(
    `AlphaScore: match=${matchScore.toFixed(2)}, src=${sourceScore.toFixed(2)}, ` +
    `time=${timingScore.toFixed(2)}, content=${contentScore.toFixed(2)} -> ` +
    `score=${score.toFixed(2)}, edge=${(edge * 100).toFixed(1)}%, conf=${(confidence * 100).toFixed(0)}%`
  );

  return {
    score: Math.max(0, Math.min(1, score)),
    edge: Math.max(0, edge),
    confidence,
    direction,
    reasoning: reasons.join(' | '),
    breakdown: {
      matchScore,
      sourceScore,
      timingScore,
      contentScore,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
//                    KELLY CRITERION
// ═══════════════════════════════════════════════════════════════

export function calculateKellyBet(
  edge: number,
  odds: number,
  bankroll: number,
  kellyFraction: number = 0.25
): number {
  const p = 0.5 + edge / 2;
  const q = 1 - p;
  const b = odds;

  const kelly = (p * b - q) / b;
  const fractionalKelly = kelly * kellyFraction;

  const maxBet = config.trading.maxBetUsdc;
  const riskBased = bankroll * (config.trading.riskPerTradePercent / 100);

  const bet = Math.min(
    Math.max(fractionalKelly * bankroll, 0),
    maxBet,
    riskBased
  );

  return Math.round(bet * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════
//                    TRADE RECOMMENDATION
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
//                    ALPHA SIGNAL ERSTELLEN
// ═══════════════════════════════════════════════════════════════

export function createAlphaSignal(
  market: Market,
  externalData?: {
    germanSources?: Array<{ relevance: number; direction: 'YES' | 'NO' }>;
    aiAnalysis?: { confidence: number; direction: 'YES' | 'NO' };
    newsAlpha?: NewsAlphaData;
  }
): AlphaSignal | null {
  const { score, edge, confidence, direction, reasoning, breakdown } = calculateAlphaScore(
    market,
    externalData
  );

  // Score-Schwelle prüfen
  if (score < config.trading.minAlphaForTrade) {
    return null;
  }

  // Edge-Prüfung für DE-Modus
  if (externalData?.germanSources && externalData.germanSources.length > 0) {
    if (edge < config.germany.minEdge) {
      return null;
    }
  }

  // Erweitertes Reasoning mit Breakdown
  const detailedReasoning = reasoning + (breakdown
    ? ` [M:${(breakdown.matchScore * 100).toFixed(0)}% S:${(breakdown.sourceScore * 100).toFixed(0)}% T:${(breakdown.timingScore * 100).toFixed(0)}% C:${(breakdown.contentScore * 100).toFixed(0)}%]`
    : '');

  const signal: AlphaSignal = {
    id: uuid(),
    market,
    score,
    edge,
    confidence, // Jetzt echte berechnete Confidence statt score
    direction,
    reasoning: detailedReasoning,
    sources: [],
    timestamp: new Date(),
    germanSource: externalData?.germanSources?.[0]
      ? {
          type: 'rss',
          title: externalData.newsAlpha?.bestMatch?.title || 'News Match',
          data: { source: externalData.newsAlpha?.bestMatch?.source || 'Multiple' },
          relevance: externalData.germanSources[0].relevance,
          publishedAt: new Date(),
        }
      : undefined,
  };

  const newsInfo = externalData?.newsAlpha
    ? ` | ${externalData.newsAlpha.matchCount} News`
    : '';

  logger.info(
    `⚡ ALPHA: ${market.question.substring(0, 45)}... | ${score.toFixed(2)} | ${(edge * 100).toFixed(1)}% Edge | ${direction}${newsInfo}`
  );

  return signal;
}

export default {
  calculateAlphaScore,
  calculateKellyBet,
  createTradeRecommendation,
  createAlphaSignal,
  analyzeNewsForMarket,
};
