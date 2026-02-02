/**
 * TIME_DELAY Alpha Engine
 * Generiert Signale basierend auf News-Events und deren Verzoegerung
 * Keine LLM-Calls - nur strukturiertes Matching und Feature-Berechnung
 */

import { v4 as uuidv4 } from 'uuid';
import { AlphaSignalV2, TimeDelayFeatures, SourceEvent, MarketQuality, SignalCertainty } from './types.js';
import { Market } from '../types/index.js';
import { fuzzyMatch, MatchResult, extractKeywords } from './matching.js';
import { eventExists, getEventByHash } from '../storage/repositories/events.js';
import logger from '../utils/logger.js';
import { autoTrader, AutoTradeResult } from './autoTrader.js';
import { llmMatcher, LLMMatchResult } from './llmMatcher.js';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface TimeDelayConfig {
  minSourceCount: number;        // Min. Quellen fuer Confirmation (default: 2)
  maxNewsAgeMinutes: number;     // Max. Alter der News (default: 60)
  minMatchConfidence: number;    // Min. Match-Confidence (default: 0.3)
  maxPriceMoveSinceNews: number; // Blocke wenn Markt schon > X% bewegt (default: 0.05)
  minSourceReliability: number;  // Oder hohe Reliability statt multi-source (default: 0.8)
  autoTradeEnabled: boolean;     // Auto-Trade bei breaking_confirmed (default: false)
}

export const DEFAULT_TIME_DELAY_CONFIG: TimeDelayConfig = {
  minSourceCount: 2,
  maxNewsAgeMinutes: 60,
  minMatchConfidence: 0.3,
  maxPriceMoveSinceNews: 0.05,
  minSourceReliability: 0.8,
  autoTradeEnabled: false,
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

    // 3. Matche Events gegen Markets (Fuzzy + LLM Validation)
    const marketEventMap = new Map<string, { event: SourceEvent; match: MatchResult; llmResult?: LLMMatchResult }[]>();

    for (const event of recentEvents) {
      const matches = fuzzyMatch(event, markets);

      for (const match of matches) {
        // Min. Confidence Check
        if (match.confidence < this.config.minMatchConfidence) {
          continue;
        }

        // LLM-Validation: Prüfe ob Match wirklich relevant ist
        const market = markets.find(m => m.id === match.marketId);
        if (llmMatcher.isEnabled() && market) {
          const llmResult = await llmMatcher.matchNewsToMarket(
            { title: event.title, content: event.content || undefined, source: event.sourceName },
            { id: market.id, question: market.question, currentPrice: market.outcomes?.[0]?.price }
          );

          // LLM sagt NICHT RELEVANT → Skip
          if (!llmResult.isRelevant) {
            logger.info(`[LLM_REJECT] "${event.title.substring(0, 40)}..." → "${market.question.substring(0, 30)}..." (${llmResult.reasoning})`);
            continue;
          }

          // LLM sagt RELEVANT → Speichere mit LLM-Result
          if (!marketEventMap.has(match.marketId)) {
            marketEventMap.set(match.marketId, []);
          }
          marketEventMap.get(match.marketId)!.push({ event, match, llmResult });

          logger.info(`[LLM_MATCH] "${event.title.substring(0, 40)}..." → ${llmResult.direction?.toUpperCase()} @ ${llmResult.confidence}% (${llmResult.impactStrength})`);
        } else {
          // Fallback ohne LLM
          if (!marketEventMap.has(match.marketId)) {
            marketEventMap.set(match.marketId, []);
          }
          marketEventMap.get(match.marketId)!.push({ event, match });
        }
      }
    }

    logger.info(`Matches gefunden fuer ${marketEventMap.size} Markets (LLM-validiert: ${llmMatcher.isEnabled()})`);

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

      // 4e. Direction bestimmen - LLM hat Vorrang!
      const llmResults = eventMatches.map(em => em.llmResult).filter(r => r !== undefined);
      let direction: 'yes' | 'no';
      let llmDetermined = false;

      if (llmResults.length > 0 && llmResults[0]?.direction) {
        // LLM hat die Richtung bestimmt
        direction = llmResults[0].direction;
        llmDetermined = true;
        logger.info(`[DIRECTION] LLM bestimmt: ${direction.toUpperCase()} (${llmResults[0].reasoning})`);
      } else {
        // Fallback: Heuristische Bestimmung
        direction = this.determineDirection(matchedEvents, market);
      }

      // 4f. Certainty berechnen (für Sizing)
      const certainty = this.calculateCertainty(features, matchedEvents);

      // 4g. Reasoning zusammenstellen - mit LLM-Info
      const reasoning = this.buildReasoning(matchedEvents, eventMatches, features, edge, certainty);
      if (llmDetermined && llmResults[0]) {
        reasoning.unshift(`LLM: ${llmResults[0].reasoning} (${llmResults[0].confidence}% Konfidenz)`);
      }

      // 4h. Signal erstellen
      const signal: AlphaSignalV2 = {
        signalId: uuidv4(),
        alphaType: 'timeDelay',
        marketId: market.id,
        question: market.question,
        direction,
        predictedEdge: edge,
        confidence,
        certainty,  // NEU: Für aggressives Sizing
        features,
        reasoning,
        createdAt: new Date(),
      };

      signals.push(signal);

      const certaintyEmoji = certainty === 'breaking_confirmed' ? '🚨 HALF IN!' :
                             certainty === 'high' ? '⚡ HIGH' : '';
      logger.info(
        `Signal generiert: ${market.question.substring(0, 40)}... ` +
        `| direction=${direction} | edge=${(edge * 100).toFixed(1)}% ` +
        `| confidence=${confidence.toFixed(2)} | certainty=${certainty} ${certaintyEmoji}` +
        `| sources=${matchedEvents.length}`
      );

      // ═══════════════════════════════════════════════════════════════
      // AUTO-TRADE BEI BREAKING_CONFIRMED
      // Speed ist essentiell - Zeitvorsprung nur wertvoll wenn wir schnell handeln!
      // ═══════════════════════════════════════════════════════════════
      if (certainty === 'breaking_confirmed' && this.config.autoTradeEnabled) {
        logger.warn(`[AUTO-TRADE] BREAKING_CONFIRMED detected - prüfe Auto-Trade für ${market.question.substring(0, 40)}...`);

        // MarketQuality aus Market-Daten erstellen
        const marketQuality: MarketQuality = {
          marketId: market.id,
          liquidityScore: Math.min(1, (market.liquidity || 0) / 100000), // Normalisiert auf 0-1
          spreadProxy: 0.02, // Default Spread
          volume24h: market.volume24h || 0,
          volatility: 0.1, // Default Volatility
          tradeable: true,
          reasons: [],
        };

        // Async Auto-Trade (nicht blockierend)
        this.processAutoTrade(signal, marketQuality).catch(err => {
          logger.error(`[AUTO-TRADE] Fehler: ${(err as Error).message}`);
        });
      }
    }

    // Nach Edge sortieren (beste zuerst)
    signals.sort((a, b) => b.predictedEdge - a.predictedEdge);

    logger.info(`TimeDelayEngine: ${signals.length} Signale generiert`);

    return signals;
  }

  /**
   * Verarbeitet Auto-Trade für ein Signal
   * WICHTIG: Geschwindigkeit ist kritisch!
   */
  private async processAutoTrade(signal: AlphaSignalV2, marketQuality: MarketQuality): Promise<AutoTradeResult | null> {
    try {
      const result = await autoTrader.processSignal(signal, marketQuality);

      if (result.executed) {
        logger.warn(`[AUTO-TRADE] ✅ ERFOLG: ${signal.question.substring(0, 40)}... | ${signal.direction.toUpperCase()} | Edge: ${(signal.predictedEdge * 100).toFixed(1)}%`);
      } else {
        logger.info(`[AUTO-TRADE] ❌ Nicht ausgeführt: ${result.reason}`);
      }

      return result;
    } catch (err) {
      logger.error(`[AUTO-TRADE] Exception: ${(err as Error).message}`);
      return null;
    }
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
   * ═══════════════════════════════════════════════════════════════
   * CERTAINTY BERECHNUNG - Bestimmt Sizing-Aggressivität
   * ═══════════════════════════════════════════════════════════════
   *
   * BREAKING_CONFIRMED (50% Bankroll "HALF IN!"):
   * - Breaking News Indicator vorhanden
   * - Sehr frisch (< 10 Min)
   * - Multi-Source (3+) ODER Single Tier-1 Source (0.9+ reliability)
   * - Kein signifikanter Markt-Move (< 2%)
   * - Starkes Sentiment (|score| > 0.5)
   * - Hohe Match-Confidence (> 0.6)
   *
   * Beispiele für BREAKING_CONFIRMED:
   * - "Kompany bei Bayern entlassen" (Breaking, Multi-Source, klar negativ)
   * - "Putin tot" (Tier-1 Source, Breaking, extrem impactful)
   * - "Ukraine-Waffenstillstand unterzeichnet" (Breaking, Multi-Source)
   */
  private calculateCertainty(features: TimeDelayFeatures, events: SourceEvent[]): SignalCertainty {
    const f = features.features;

    // Kriterien für BREAKING_CONFIRMED
    const isBreaking = f.impactScore >= 0.5;
    const isVeryFresh = f.newsAgeMinutes <= 10;
    const hasMultiSource = f.sourceCount >= 3;
    const hasTier1Source = f.avgSourceReliability >= 0.9;
    const noMarketMove = f.priceMoveSinceNews < 0.02;
    const strongSentiment = Math.abs(f.sentimentScore) >= 0.5;
    const highMatchConfidence = f.matchConfidence >= 0.6;

    // BREAKING_CONFIRMED: Quasi-safe, 50% Bankroll
    if (isBreaking && isVeryFresh && (hasMultiSource || hasTier1Source) &&
        noMarketMove && strongSentiment && highMatchConfidence) {
      logger.warn(
        `🚨 BREAKING_CONFIRMED detected! ` +
        `Breaking=${isBreaking}, Fresh=${f.newsAgeMinutes.toFixed(0)}min, ` +
        `Sources=${f.sourceCount}, Reliability=${f.avgSourceReliability.toFixed(2)}, ` +
        `Sentiment=${f.sentimentScore.toFixed(2)}, MatchConf=${f.matchConfidence.toFixed(2)}`
      );
      return 'breaking_confirmed';
    }

    // HIGH: Gute Bedingungen, Half-Kelly
    if ((isBreaking || isVeryFresh) && (hasMultiSource || hasTier1Source) && highMatchConfidence) {
      return 'high';
    }

    // MEDIUM: Solide Bedingungen
    if (f.sourceCount >= 2 && f.avgSourceReliability >= 0.7 && f.matchConfidence >= 0.5) {
      return 'medium';
    }

    // LOW: Default
    return 'low';
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * VERBESSERTE DIRECTION-BESTIMMUNG
   * Robuste Analyse von News-Events gegen Market-Fragen
   * ═══════════════════════════════════════════════════════════════
   *
   * Beispiele:
   * - "Kompany entlassen" + "Wird Kompany vor 2028 entlassen?" → YES
   * - "Kompany entlassen" + "Bleibt Kompany bei Bayern?" → NO
   * - "Putin tot" + "Wird Putin 2025 Präsident sein?" → NO
   * - "Ukraine Waffenstillstand" + "Wird der Krieg 2025 enden?" → YES
   */
  private determineDirection(events: SourceEvent[], market: Market): 'yes' | 'no' {
    const question = market.question.toLowerCase();

    // 1. Extrahiere Event-Keywords (was ist passiert?)
    const eventKeywords = this.extractEventAction(events);

    // 2. Analysiere Frage-Typ (was wird gefragt?)
    const questionType = this.analyzeQuestionType(question);

    // 3. Bestimme ob Event die Frage positiv oder negativ beantwortet
    const eventAnswersYes = this.doesEventAnswerYes(eventKeywords, questionType, question, events);

    logger.debug(
      `[DIRECTION] Event: "${eventKeywords.action}" | Question Type: "${questionType}" | ` +
      `Event answers YES: ${eventAnswersYes} | Sentiment: ${eventKeywords.sentiment.toFixed(2)}`
    );

    return eventAnswersYes ? 'yes' : 'no';
  }

  /**
   * Extrahiert die Haupt-Aktion aus den Events
   */
  private extractEventAction(events: SourceEvent[]): { action: string; sentiment: number; keywords: string[] } {
    const allText = events.map(e => `${e.title} ${e.content || ''}`).join(' ').toLowerCase();

    // Action-Keywords erkennen
    const actionPatterns: { pattern: RegExp; action: string; sentiment: number }[] = [
      // Entlassung / Rücktritt
      { pattern: /entlass|gefeuert|rausgeworfen|fired|sacked|dismissed/i, action: 'fired', sentiment: -1 },
      { pattern: /rücktritt|zurückgetreten|tritt zurück|resigns?|steps? down/i, action: 'resigned', sentiment: -1 },
      { pattern: /kündigt|verlässt|leaves|quits/i, action: 'leaves', sentiment: -1 },

      // Tod / Ende
      { pattern: /gestorben|tot|stirbt|died|dead|death/i, action: 'died', sentiment: -1 },
      { pattern: /ende|beendet|endet|ends?|over|finished/i, action: 'ended', sentiment: 0 },

      // Vertrag / Verlängerung
      { pattern: /verlängert|vertrag|contract.*extend|renew/i, action: 'extended', sentiment: 1 },
      { pattern: /unterschrieb|signed|signs/i, action: 'signed', sentiment: 1 },

      // Gewinn / Erfolg
      { pattern: /gewinnt|gewonnen|wins?|won|victory|sieg/i, action: 'won', sentiment: 1 },
      { pattern: /gewählt|elected|wiedergewählt|re-?elected/i, action: 'elected', sentiment: 1 },

      // Niederlage / Scheitern
      { pattern: /verliert|verloren|loses?|lost|defeat/i, action: 'lost', sentiment: -1 },
      { pattern: /scheitert|gescheitert|fails?|failed/i, action: 'failed', sentiment: -1 },

      // Ankündigung / Bestätigung
      { pattern: /bestätigt|confirmed|announces?|angekündigt/i, action: 'confirmed', sentiment: 0 },
      { pattern: /abgesagt|cancelled|canceled|postponed/i, action: 'cancelled', sentiment: -1 },

      // Waffenstillstand / Frieden
      { pattern: /waffenstillstand|ceasefire|peace.*deal|friedens/i, action: 'ceasefire', sentiment: 1 },
      { pattern: /krieg.*ende|war.*end|kriegsende/i, action: 'war_ends', sentiment: 1 },

      // Eskalation / Konflikt
      { pattern: /eskalation|escalat|angriff|attack|invasion/i, action: 'escalation', sentiment: -1 },
    ];

    let detectedAction = 'unknown';
    let detectedSentiment = 0;
    const keywords: string[] = [];

    for (const { pattern, action, sentiment } of actionPatterns) {
      const match = allText.match(pattern);
      if (match) {
        detectedAction = action;
        detectedSentiment = sentiment;
        keywords.push(match[0]);
        break;
      }
    }

    // Fallback: Generelles Sentiment
    if (detectedAction === 'unknown') {
      detectedSentiment = this.calculateSentimentScore(events);
    }

    return { action: detectedAction, sentiment: detectedSentiment, keywords };
  }

  /**
   * Analysiert den Typ der Markt-Frage
   */
  private analyzeQuestionType(question: string): 'will_happen' | 'will_stay' | 'will_end' | 'will_win' | 'will_not' | 'unknown' {
    // "Wird X entlassen/gefeuert?" -> will_happen
    if (/wird.*entlass|will.*fire|will.*sack|wird.*gefeuert/i.test(question)) {
      return 'will_happen';
    }

    // "Bleibt X?" / "Will X remain?" -> will_stay
    if (/bleibt|remain|stay|continues?|weiterhin/i.test(question)) {
      return 'will_stay';
    }

    // "Endet X?" / "Will X end?" -> will_end
    if (/endet|end|beend|over|vorbei/i.test(question)) {
      return 'will_end';
    }

    // "Gewinnt X?" / "Will X win?" -> will_win
    if (/gewinnt|win|victory|elected|gewählt/i.test(question)) {
      return 'will_win';
    }

    // Negative Fragen: "Will X NOT happen?"
    if (/not|nicht|keine|won't|will not/i.test(question)) {
      return 'will_not';
    }

    return 'unknown';
  }

  /**
   * Bestimmt ob das Event die Frage mit YES beantwortet
   */
  private doesEventAnswerYes(
    eventKeywords: { action: string; sentiment: number; keywords: string[] },
    questionType: string,
    question: string,
    events: SourceEvent[]
  ): boolean {
    const { action, sentiment } = eventKeywords;

    // Spezifische Action-zu-Frage-Mappings
    switch (action) {
      case 'fired':
      case 'resigned':
      case 'leaves':
        // Person wurde gefeuert/tritt zurück
        if (questionType === 'will_happen') return true;  // "Wird X entlassen?" -> YES
        if (questionType === 'will_stay') return false;   // "Bleibt X?" -> NO
        break;

      case 'died':
        // Person ist gestorben
        // "Wird X Präsident sein?" -> NO
        // "Stirbt X?" -> YES (aber solche Fragen gibt es kaum)
        return false;

      case 'extended':
      case 'signed':
        // Vertrag verlängert
        if (questionType === 'will_stay') return true;    // "Bleibt X?" -> YES
        if (questionType === 'will_happen') return false; // "Wird X entlassen?" -> NO
        break;

      case 'won':
      case 'elected':
        // Hat gewonnen/wurde gewählt
        if (questionType === 'will_win') return true;     // "Gewinnt X?" -> YES
        break;

      case 'lost':
      case 'failed':
        // Hat verloren/ist gescheitert
        if (questionType === 'will_win') return false;    // "Gewinnt X?" -> NO
        break;

      case 'ceasefire':
      case 'war_ends':
        // Waffenstillstand / Krieg endet
        if (questionType === 'will_end') return true;     // "Endet der Krieg?" -> YES
        break;

      case 'escalation':
        // Eskalation
        if (questionType === 'will_end') return false;    // "Endet der Krieg?" -> NO
        break;

      case 'cancelled':
        if (questionType === 'will_happen') return false; // "Wird X stattfinden?" -> NO
        break;

      case 'confirmed':
        // Bestätigt - Kontext-abhängig
        if (questionType === 'will_happen') return true;
        break;
    }

    // Fallback: Entity-Matching
    // Prüfe ob die Person/das Subjekt in News und Frage übereinstimmt
    const newsText = events.map(e => e.title).join(' ').toLowerCase();

    // Einfaches Subjekt-Matching für Personen
    const personPatterns = [
      /(\w+)\s+(?:entlass|gefeuert|fired|sacked|resigned|tritt zurück)/i,
      /(?:entlass|fire|sack)\s+(\w+)/i,
    ];

    for (const pattern of personPatterns) {
      const newsMatch = newsText.match(pattern);
      if (newsMatch && newsMatch[1]) {
        const person = newsMatch[1].toLowerCase();
        if (question.includes(person)) {
          // Person in beiden Texten gefunden - Action auf Frage anwenden
          if (action === 'fired' || action === 'resigned' || action === 'leaves') {
            // "X entlassen" + Frage enthält X
            if (question.includes('entlass') || question.includes('fire') || question.includes('sack')) {
              return true; // "Wird X entlassen?" -> YES
            }
            if (question.includes('bleib') || question.includes('remain') || question.includes('stay')) {
              return false; // "Bleibt X?" -> NO
            }
          }
        }
      }
    }

    // Ultimate Fallback: Sentiment-basiert mit verbesserter Logik
    // Aber nur wenn keine spezifische Logik greift
    if (questionType === 'will_not') {
      // Negative Fragen invertieren
      return sentiment > 0 ? false : true;
    }

    // Standard-Logik: Positives Sentiment -> YES, Negatives -> NO
    // ABER: Bei "wird X entlassen?" und negativem Sentiment (Entlassung ist negativ) -> YES
    if (questionType === 'will_happen' && sentiment < 0) {
      // Negative Events bestätigen negative Fragen
      return true;
    }

    return sentiment >= 0;
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
    edge: number,
    certainty: SignalCertainty
  ): string[] {
    const reasoning: string[] = [];
    const f = features.features;

    // 0. BREAKING_CONFIRMED Banner
    if (certainty === 'breaking_confirmed') {
      reasoning.push(`🚨 BREAKING CONFIRMED - HALF IN! 50% Bankroll`);
    } else if (certainty === 'high') {
      reasoning.push(`⚡ HIGH CERTAINTY - Aggressives Sizing`);
    }

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

    // 7. Certainty Summary
    reasoning.push(`Certainty Level: ${certainty.toUpperCase()}`);

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
