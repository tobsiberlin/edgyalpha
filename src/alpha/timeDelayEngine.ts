/**
 * TIME_DELAY Alpha Engine
 * Generiert Signale basierend auf News-Events und deren Verzoegerung
 * Keine LLM-Calls - nur strukturiertes Matching und Feature-Berechnung
 */

import { v4 as uuidv4 } from 'uuid';
import { AlphaSignalV2, TimeDelayFeatures, SourceEvent, MarketQuality } from './types.js';
import { Market } from '../types/index.js';
import { fuzzyMatch, MatchResult, extractKeywords } from './matching.js';
import { eventExists, getEventByHash } from '../storage/repositories/events.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface TimeDelayConfig {
  minSourceCount: number;        // Min. Quellen fuer Confirmation (default: 2)
  maxNewsAgeMinutes: number;     // Max. Alter der News (default: 60)
  minMatchConfidence: number;    // Min. Match-Confidence (default: 0.3)
  maxPriceMoveSinceNews: number; // Blocke wenn Markt schon > X% bewegt (default: 0.05)
  minSourceReliability: number;  // Oder hohe Reliability statt multi-source (default: 0.8)
}

export const DEFAULT_TIME_DELAY_CONFIG: TimeDelayConfig = {
  minSourceCount: 2,
  maxNewsAgeMinutes: 60,
  minMatchConfidence: 0.3,
  maxPriceMoveSinceNews: 0.05,
  minSourceReliability: 0.8,
};

// ═══════════════════════════════════════════════════════════════
// SENTIMENT KEYWORDS
// ═══════════════════════════════════════════════════════════════

const POSITIVE_KEYWORDS = new Set([
  // Deutsch
  'gewinnt', 'steigt', 'erfolg', 'sieg', 'durchbruch', 'einigung', 'fortschritt',
  'wachstum', 'rekord', 'boom', 'anstieg', 'positiv', 'optimistisch', 'besser',
  'staerkt', 'verbessert', 'erreicht', 'ueberraschend', 'unterstuetzt', 'bestaetigt',
  'fuehrt', 'vorne', 'mehrheit', 'zustimmung', 'genehmigt', 'verabschiedet',
  // Englisch
  'wins', 'rises', 'success', 'victory', 'breakthrough', 'agreement', 'progress',
  'growth', 'record', 'surge', 'positive', 'optimistic', 'better', 'stronger',
  'improves', 'achieves', 'surprising', 'supports', 'confirms', 'leads', 'ahead',
  'majority', 'approval', 'approved', 'passed', 'bullish', 'rally',
]);

const NEGATIVE_KEYWORDS = new Set([
  // Deutsch
  'verliert', 'faellt', 'scheitert', 'niederlage', 'krise', 'absturz', 'einbruch',
  'rueckgang', 'negativ', 'pessimistisch', 'schlechter', 'schwaecht', 'verschlechtert',
  'verfehlt', 'hinten', 'minderheit', 'ablehnung', 'abgelehnt', 'gescheitert',
  'warnung', 'gefahr', 'risiko', 'konflikt', 'eskalation', 'sanktionen', 'stopp',
  // Englisch
  'loses', 'falls', 'fails', 'defeat', 'crisis', 'crash', 'collapse', 'decline',
  'negative', 'pessimistic', 'worse', 'weaker', 'worsens', 'misses', 'behind',
  'minority', 'rejection', 'rejected', 'failed', 'warning', 'danger', 'risk',
  'conflict', 'escalation', 'sanctions', 'halt', 'bearish', 'selloff',
]);

const BREAKING_INDICATORS = new Set([
  'breaking', 'eilmeldung', 'just in', 'developing', 'aktuell', 'live',
  'gerade eben', 'soeben', 'dringend', 'urgent', 'alert', 'exclusive', 'exklusiv',
]);

// ═══════════════════════════════════════════════════════════════
// TIME DELAY ENGINE
// ═══════════════════════════════════════════════════════════════

export class TimeDelayEngine {
  private config: TimeDelayConfig;
  private featureVersion = '1.0.0';

  constructor(config?: Partial<TimeDelayConfig>) {
    this.config = { ...DEFAULT_TIME_DELAY_CONFIG, ...config };
    logger.info(`TimeDelayEngine initialisiert mit config:`, this.config);
  }

  /**
   * Hauptmethode: Generiere Signale aus Events + Markets
   * @param events - Source Events (News, RSS Items)
   * @param markets - Aktive Polymarket Markets
   * @param marketPricesAtNews - Preise als die News ankamen (fuer Price Move Detection)
   */
  async generateSignals(
    events: SourceEvent[],
    markets: Market[],
    marketPricesAtNews: Map<string, number>
  ): Promise<AlphaSignalV2[]> {
    const signals: AlphaSignalV2[] = [];

    logger.info(`TimeDelayEngine: Verarbeite ${events.length} Events gegen ${markets.length} Markets`);

    // 1. Dedupe: Filtere bereits verarbeitete Events
    const newEvents = events.filter(event => {
      if (eventExists(event.eventHash)) {
        logger.debug(`Event bereits verarbeitet: ${event.eventHash.substring(0, 8)}...`);
        return false;
      }
      return true;
    });

    logger.info(`Nach Dedupe: ${newEvents.length} neue Events`);

    if (newEvents.length === 0) {
      return signals;
    }

    // 2. Filtere zu alte Events
    const now = new Date();
    const maxAgeMs = this.config.maxNewsAgeMinutes * 60 * 1000;
    const recentEvents = newEvents.filter(event => {
      const eventTime = event.publishedAt || event.ingestedAt;
      const ageMs = now.getTime() - eventTime.getTime();
      return ageMs <= maxAgeMs;
    });

    logger.info(`Nach Age-Filter: ${recentEvents.length} Events (max ${this.config.maxNewsAgeMinutes} min)`);

    if (recentEvents.length === 0) {
      return signals;
    }

    // 3. Matche Events gegen Markets
    const marketEventMap = new Map<string, { event: SourceEvent; match: MatchResult }[]>();

    for (const event of recentEvents) {
      const matches = fuzzyMatch(event, markets);

      for (const match of matches) {
        // Min. Confidence Check
        if (match.confidence < this.config.minMatchConfidence) {
          continue;
        }

        if (!marketEventMap.has(match.marketId)) {
          marketEventMap.set(match.marketId, []);
        }
        marketEventMap.get(match.marketId)!.push({ event, match });
      }
    }

    logger.info(`Matches gefunden fuer ${marketEventMap.size} Markets`);

    // 4. Fuer jeden Market mit Matches: Signal generieren
    for (const [marketId, eventMatches] of marketEventMap) {
      const market = markets.find(m => m.id === marketId);
      if (!market) continue;

      const matchedEvents = eventMatches.map(em => em.event);

      // 4a. Confirmation Check
      if (!this.checkConfirmation(matchedEvents)) {
        logger.debug(`Market ${marketId}: Keine Confirmation (${matchedEvents.length} sources, max reliability: ${Math.max(...matchedEvents.map(e => e.reliabilityScore)).toFixed(2)})`);
        continue;
      }

      // 4b. Price Move Check
      const priceAtNews = marketPricesAtNews.get(marketId);
      const currentPrice = market.outcomes[0]?.price ?? 0.5;

      if (priceAtNews !== undefined) {
        if (this.isMarketAlreadyMoved(currentPrice, priceAtNews, this.config.maxPriceMoveSinceNews)) {
          logger.debug(`Market ${marketId}: Bereits bewegt (${priceAtNews.toFixed(2)} -> ${currentPrice.toFixed(2)})`);
          continue;
        }
      }

      // 4c. Features berechnen
      const features = this.calculateFeatures(
        matchedEvents,
        eventMatches.map(em => em.match),
        market,
        priceAtNews ?? currentPrice
      );

      // 4d. Edge und Confidence berechnen
      const edge = this.calculateEdge(features);
      const confidence = this.calculateConfidence(features);

      // 4e. Direction bestimmen
      const direction = this.determineDirection(matchedEvents, market);

      // 4f. Reasoning zusammenstellen
      const reasoning = this.buildReasoning(matchedEvents, eventMatches, features, edge);

      // 4g. Signal erstellen
      const signal: AlphaSignalV2 = {
        signalId: uuidv4(),
        alphaType: 'timeDelay',
        marketId: market.id,
        question: market.question,
        direction,
        predictedEdge: edge,
        confidence,
        features,
        reasoning,
        createdAt: new Date(),
      };

      signals.push(signal);

      logger.info(
        `Signal generiert: ${market.question.substring(0, 40)}... ` +
        `| direction=${direction} | edge=${(edge * 100).toFixed(1)}% ` +
        `| confidence=${confidence.toFixed(2)} | sources=${matchedEvents.length}`
      );
    }

    // Nach Edge sortieren (beste zuerst)
    signals.sort((a, b) => b.predictedEdge - a.predictedEdge);

    logger.info(`TimeDelayEngine: ${signals.length} Signale generiert`);

    return signals;
  }

  /**
   * Prueft Confirmation: Multi-Source ODER Single High-Reliability Source
   */
  private checkConfirmation(events: SourceEvent[]): boolean {
    // Multi-source confirmation
    const uniqueSources = new Set(events.map(e => e.sourceName));
    if (uniqueSources.size >= this.config.minSourceCount) {
      return true;
    }

    // Single high-reliability source
    const maxReliability = Math.max(...events.map(e => e.reliabilityScore));
    if (maxReliability >= this.config.minSourceReliability) {
      return true;
    }

    return false;
  }

  /**
   * Berechnet TimeDelayFeatures aus Events und Market
   */
  private calculateFeatures(
    events: SourceEvent[],
    matches: MatchResult[],
    market: Market,
    priceAtNews: number
  ): TimeDelayFeatures {
    const now = new Date();
    const currentPrice = market.outcomes[0]?.price ?? 0.5;

    // Source Count
    const uniqueSources = new Set(events.map(e => e.sourceName));
    const sourceCount = uniqueSources.size;

    // Average Source Reliability
    const avgSourceReliability = events.reduce((sum, e) => sum + e.reliabilityScore, 0) / events.length;

    // News Age (neueste relevante News)
    const newestEvent = events.reduce((newest, e) => {
      const eTime = e.publishedAt || e.ingestedAt;
      const nTime = newest.publishedAt || newest.ingestedAt;
      return eTime > nTime ? e : newest;
    }, events[0]);
    const newestTime = newestEvent.publishedAt || newestEvent.ingestedAt;
    const newsAgeMinutes = (now.getTime() - newestTime.getTime()) / (60 * 1000);

    // Sentiment Score
    const sentimentScore = this.calculateSentimentScore(events);

    // Impact Score (Breaking News Indicators)
    const impactScore = this.calculateImpactScore(events);

    // Price Move Since News
    const priceMoveSinceNews = Math.abs(currentPrice - priceAtNews);

    // Volume (falls verfuegbar)
    const volumeAtNews = market.volume24h || 0;
    const volumeChangeSinceNews = 0; // TODO: Historische Volume-Daten benoetigt

    // Match Confidence (Durchschnitt)
    const matchConfidence = matches.reduce((sum, m) => sum + m.confidence, 0) / matches.length;

    return {
      version: this.featureVersion,
      features: {
        sourceCount,
        avgSourceReliability,
        newsAgeMinutes,
        sentimentScore,
        impactScore,
        marketPriceAtNews: priceAtNews,
        priceMoveSinceNews,
        volumeAtNews,
        volumeChangeSinceNews,
        matchConfidence,
      },
    };
  }

  /**
   * Berechnet Sentiment Score (-1 bis +1) basierend auf Keywords
   */
  private calculateSentimentScore(events: SourceEvent[]): number {
    let positiveCount = 0;
    let negativeCount = 0;

    for (const event of events) {
      const text = `${event.title} ${event.content || ''}`.toLowerCase();
      const words = text.split(/\s+/);

      for (const word of words) {
        if (POSITIVE_KEYWORDS.has(word)) positiveCount++;
        if (NEGATIVE_KEYWORDS.has(word)) negativeCount++;
      }
    }

    const total = positiveCount + negativeCount;
    if (total === 0) return 0;

    // Normalisiert auf -1 bis +1
    return (positiveCount - negativeCount) / total;
  }

  /**
   * Berechnet Impact Score (0-1) basierend auf Breaking News Indicators
   */
  private calculateImpactScore(events: SourceEvent[]): number {
    let breakingCount = 0;

    for (const event of events) {
      const text = `${event.title} ${event.content || ''}`.toLowerCase();

      for (const indicator of BREAKING_INDICATORS) {
        if (text.includes(indicator)) {
          breakingCount++;
          break; // Ein Indicator pro Event reicht
        }
      }
    }

    // Normalisiert: 0 = keine Breaking News, 1 = alle sind Breaking
    return events.length > 0 ? breakingCount / events.length : 0;
  }

  /**
   * Berechnet Edge basierend auf Features
   * Kombiniert mehrere Faktoren zu einem erwarteten Vorteil
   */
  private calculateEdge(features: TimeDelayFeatures): number {
    const f = features.features;

    // Basis-Edge aus Match-Qualitaet
    let edge = f.matchConfidence * 0.05; // Max 5% aus Match allein

    // Bonus fuer Multi-Source Confirmation
    if (f.sourceCount >= 3) {
      edge += 0.03;
    } else if (f.sourceCount >= 2) {
      edge += 0.02;
    }

    // Bonus fuer hohe Source-Reliability
    if (f.avgSourceReliability >= 0.9) {
      edge += 0.02;
    } else if (f.avgSourceReliability >= 0.7) {
      edge += 0.01;
    }

    // Bonus fuer frische News
    if (f.newsAgeMinutes <= 10) {
      edge += 0.03;
    } else if (f.newsAgeMinutes <= 30) {
      edge += 0.01;
    }

    // Bonus fuer starkes Sentiment
    const absSentiment = Math.abs(f.sentimentScore);
    if (absSentiment >= 0.7) {
      edge += 0.02;
    } else if (absSentiment >= 0.4) {
      edge += 0.01;
    }

    // Bonus fuer Breaking News
    if (f.impactScore >= 0.5) {
      edge += 0.02;
    }

    // Penalty fuer bereits bewegten Markt
    if (f.priceMoveSinceNews > 0.02) {
      edge *= 0.7; // 30% Abzug
    } else if (f.priceMoveSinceNews > 0.01) {
      edge *= 0.85;
    }

    // Cap bei 15%
    return Math.min(edge, 0.15);
  }

  /**
   * Berechnet Confidence basierend auf Features
   */
  private calculateConfidence(features: TimeDelayFeatures): number {
    const f = features.features;

    // Basis aus Match-Confidence
    let confidence = f.matchConfidence * 0.4;

    // Source-Faktoren
    confidence += Math.min(f.sourceCount / 5, 0.2); // Max 0.2 aus Sources
    confidence += f.avgSourceReliability * 0.2;

    // Frische der News
    if (f.newsAgeMinutes <= 15) {
      confidence += 0.1;
    } else if (f.newsAgeMinutes <= 30) {
      confidence += 0.05;
    }

    // Impact
    confidence += f.impactScore * 0.1;

    // Cap bei 1.0
    return Math.min(confidence, 1.0);
  }

  /**
   * Bestimmt Direction (yes/no) basierend auf Sentiment und Market-Frage
   */
  private determineDirection(events: SourceEvent[], market: Market): 'yes' | 'no' {
    // Sentiment berechnen
    const sentimentScore = this.calculateSentimentScore(events);

    // Heuristik: Market-Frage analysieren
    const question = market.question.toLowerCase();

    // Negative Fragestellung erkennen
    const negativePatterns = [
      'fail', 'scheitern', 'verlieren', 'fall', 'drop', 'crash',
      'not', 'nicht', 'won\'t', 'will not', 'keine',
    ];

    let isNegativeQuestion = false;
    for (const pattern of negativePatterns) {
      if (question.includes(pattern)) {
        isNegativeQuestion = true;
        break;
      }
    }

    // Direction Logic:
    // Positive News + Positive Frage -> YES
    // Positive News + Negative Frage -> NO
    // Negative News + Positive Frage -> NO
    // Negative News + Negative Frage -> YES

    if (sentimentScore >= 0.1) {
      return isNegativeQuestion ? 'no' : 'yes';
    } else if (sentimentScore <= -0.1) {
      return isNegativeQuestion ? 'yes' : 'no';
    }

    // Neutral: Default zu YES (konservativ)
    return 'yes';
  }

  /**
   * Prueft ob Markt bereits signifikant bewegt hat
   */
  private isMarketAlreadyMoved(
    currentPrice: number,
    priceAtNews: number,
    threshold: number
  ): boolean {
    return Math.abs(currentPrice - priceAtNews) > threshold;
  }

  /**
   * Baut Reasoning-Array fuer das Signal
   */
  private buildReasoning(
    events: SourceEvent[],
    matches: { event: SourceEvent; match: MatchResult }[],
    features: TimeDelayFeatures,
    edge: number
  ): string[] {
    const reasoning: string[] = [];
    const f = features.features;

    // 1. Source Summary
    const uniqueSources = [...new Set(events.map(e => e.sourceName))];
    reasoning.push(`${events.length} Events von ${uniqueSources.length} Quellen: ${uniqueSources.slice(0, 3).join(', ')}${uniqueSources.length > 3 ? '...' : ''}`);

    // 2. Best Match
    const bestMatch = matches.reduce((best, m) =>
      m.match.confidence > best.match.confidence ? m : best
    );
    reasoning.push(`Bester Match: "${bestMatch.event.title.substring(0, 50)}..." (${(bestMatch.match.confidence * 100).toFixed(0)}% confidence)`);

    // 3. Timing
    if (f.newsAgeMinutes <= 10) {
      reasoning.push(`Sehr frische News (${f.newsAgeMinutes.toFixed(0)} min alt)`);
    } else {
      reasoning.push(`News-Alter: ${f.newsAgeMinutes.toFixed(0)} Minuten`);
    }

    // 4. Sentiment
    if (f.sentimentScore >= 0.4) {
      reasoning.push(`Stark positives Sentiment (${f.sentimentScore.toFixed(2)})`);
    } else if (f.sentimentScore <= -0.4) {
      reasoning.push(`Stark negatives Sentiment (${f.sentimentScore.toFixed(2)})`);
    } else if (Math.abs(f.sentimentScore) >= 0.1) {
      reasoning.push(`Moderates Sentiment (${f.sentimentScore.toFixed(2)})`);
    }

    // 5. Impact
    if (f.impactScore >= 0.5) {
      reasoning.push(`Breaking News Indicator erkannt`);
    }

    // 6. Edge Summary
    reasoning.push(`Geschaetzter Edge: ${(edge * 100).toFixed(1)}%`);

    return reasoning;
  }

  /**
   * Aktualisiert die Konfiguration
   */
  updateConfig(config: Partial<TimeDelayConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info(`TimeDelayEngine config aktualisiert:`, this.config);
  }

  /**
   * Gibt aktuelle Konfiguration zurueck
   */
  getConfig(): TimeDelayConfig {
    return { ...this.config };
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

export const timeDelayEngine = new TimeDelayEngine();

export default timeDelayEngine;
