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
//                    ALPHA SCORE BERECHNUNG
// ═══════════════════════════════════════════════════════════════

export function calculateAlphaScore(
  market: Market,
  externalData?: {
    germanSources?: Array<{ relevance: number; direction: 'YES' | 'NO' }>;
    aiAnalysis?: { confidence: number; direction: 'YES' | 'NO' };
    newsAlpha?: NewsAlphaData;
  }
): { score: number; edge: number; direction: 'YES' | 'NO'; reasoning: string } {
  let score = 0;
  let direction: 'YES' | 'NO' = 'YES';
  const reasons: string[] = [];

  const yesOutcome = market.outcomes.find(
    (o) => o.name.toLowerCase() === 'yes'
  );
  const noOutcome = market.outcomes.find((o) => o.name.toLowerCase() === 'no');

  // ═══════════════════════════════════════════════════════════════
  // 1. MARKT-BASIERTE ANALYSE (Grundlage)
  // ═══════════════════════════════════════════════════════════════

  // Volume Analysis
  const volumeScore = Math.min(market.volume24h / 500000, 1) * 0.1;
  score += volumeScore;
  if (volumeScore > 0.05) {
    reasons.push(`Vol: $${(market.volume24h / 1000).toFixed(0)}k`);
  }

  // Mispricing Detection
  if (yesOutcome && noOutcome) {
    const yesPrice = yesOutcome.price;
    const noPrice = noOutcome.price;
    const totalPrice = yesPrice + noPrice;

    if (Math.abs(totalPrice - 1) > 0.02) {
      const mispricingScore = Math.abs(totalPrice - 1) * 2;
      score += Math.min(mispricingScore, 0.15);
      reasons.push(`Mispricing: ${((totalPrice - 1) * 100).toFixed(1)}%`);
    }

    // Extreme Preise
    if (yesPrice < 0.1 || yesPrice > 0.9) {
      score += 0.08;
      direction = yesPrice < 0.1 ? 'NO' : 'YES';
      reasons.push(`Extrem: ${(yesPrice * 100).toFixed(0)}%`);
    }
  }

  // Zeitfaktor
  const endDate = new Date(market.endDate);
  const now = new Date();
  const daysUntilEnd = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (daysUntilEnd > 0 && daysUntilEnd < 7) {
    score += 0.1;
    reasons.push(`${daysUntilEnd.toFixed(0)}d left`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. NEWS-BASIERTE ALPHA (POWER BOOST!)
  // ═══════════════════════════════════════════════════════════════

  if (externalData?.newsAlpha) {
    const na = externalData.newsAlpha;

    if (na.matchCount > 0) {
      // Basis News-Score
      const newsBaseScore = Math.min(na.matchCount * 0.08, 0.25);
      score += newsBaseScore;

      // Impact-Boost (Breaking News etc.)
      const impactBoost = na.impactScore * 0.2;
      score += impactBoost;

      // Aktuelle News Boost (< 30 Min = GOLD!)
      if (na.recentNews.length > 0) {
        const recencyBoost = Math.min(na.recentNews.length * 0.1, 0.25);
        score += recencyBoost;
        reasons.push(`🔥 ${na.recentNews.length} FRESH NEWS!`);
      }

      // Sentiment beeinflusst Direction
      if (na.sentimentScore > 0.2) {
        direction = 'YES';
        score += 0.05;
      } else if (na.sentimentScore < -0.2) {
        direction = 'NO';
        score += 0.05;
      }

      // Best Match Info
      if (na.bestMatch) {
        const matchStr = `${na.bestMatch.source}: ${(na.bestMatch.relevance * 100).toFixed(0)}%`;
        reasons.push(matchStr);

        if (na.bestMatch.isBreaking) {
          score += 0.15;
          reasons.push('⚡BREAKING');
        }
      }

      logger.debug(
        `News-Alpha: ${na.matchCount} matches, sentiment=${na.sentimentScore.toFixed(2)}, impact=${na.impactScore.toFixed(2)}`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. DEUTSCHE QUELLEN (ALMAN EDGE)
  // ═══════════════════════════════════════════════════════════════

  if (externalData?.germanSources && externalData.germanSources.length > 0) {
    const avgRelevance =
      externalData.germanSources.reduce((sum, s) => sum + s.relevance, 0) /
      externalData.germanSources.length;

    const deScore = avgRelevance * 0.4;
    score += deScore;
    reasons.push(`🇩🇪 ${externalData.germanSources.length}x DE`);

    // Direction von DE-Quellen
    const yesVotes = externalData.germanSources.filter(
      (s) => s.direction === 'YES'
    ).length;
    const noVotes = externalData.germanSources.filter(
      (s) => s.direction === 'NO'
    ).length;
    if (yesVotes !== noVotes) {
      direction = yesVotes > noVotes ? 'YES' : 'NO';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. KI-ANALYSE (Falls vorhanden)
  // ═══════════════════════════════════════════════════════════════

  if (externalData?.aiAnalysis) {
    score += externalData.aiAnalysis.confidence * 0.2;
    direction = externalData.aiAnalysis.direction;
    reasons.push(`AI: ${(externalData.aiAnalysis.confidence * 100).toFixed(0)}%`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. EDGE BERECHNUNG
  // ═══════════════════════════════════════════════════════════════

  const currentPrice =
    direction === 'YES' ? yesOutcome?.price || 0.5 : noOutcome?.price || 0.5;
  const impliedProb = currentPrice;

  // Score → Probability Boost
  const probabilityBoost = score * 0.25;
  const estimatedProb = Math.min(Math.max(impliedProb + probabilityBoost, 0.05), 0.95);

  let edge = (estimatedProb - impliedProb) / Math.max(impliedProb, 0.1);
  edge = Math.min(Math.max(edge, 0), 0.30); // Max 30% Edge

  // Score normalisieren
  const normalizedScore = Math.min(Math.max(score, 0), 1);

  return {
    score: normalizedScore,
    edge: Math.max(edge, 0),
    direction,
    reasoning: reasons.join(' | '),
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
  const { score, edge, direction, reasoning } = calculateAlphaScore(
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
