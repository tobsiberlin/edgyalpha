import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { germanySources, BreakingNewsEvent } from '../germany/index.js';
import { polymarketClient } from '../api/polymarket.js';
import { Market } from '../types/index.js';
import { notificationService } from '../notifications/notificationService.js';
import { MarketInfo, SourceInfo } from '../notifications/pushGates.js';
import { fuzzyMatch, MatchResult } from '../alpha/matching.js';
import { llmMatcher } from '../alpha/llmMatcher.js';
import { SourceEvent } from '../alpha/types.js';

// ═══════════════════════════════════════════════════════════════
//              LIVE NEWS TICKER - DAUERFEUER MODUS
//        Zeigt alle News + Matching-Versuche in Echtzeit
// ═══════════════════════════════════════════════════════════════

export interface TickerEvent {
  id: string;
  timestamp: Date;
  type: 'news_in' | 'matching' | 'match_found' | 'no_match' | 'alpha_signal';
  source: string;
  title: string;
  category: string;
  keywords: string[];
  matchAttempt?: {
    marketsSearched: number;
    keywordsUsed: string[];
    timeMs: number;
  };
  matchResult?: {
    found: boolean;
    markets: Array<{
      id: string;
      question: string;
      matchScore: number;
      price: number;
    }>;
  };
}

export interface TickerStats {
  newsProcessed: number;
  matchesFound: number;
  alphaSignals: number;
  avgMatchTime: number;
  sourcesActive: number;
  lastUpdate: Date;
}

class NewsTicker extends EventEmitter {
  private stats: TickerStats = {
    newsProcessed: 0,
    matchesFound: 0,
    alphaSignals: 0,
    avgMatchTime: 0,
    sourcesActive: 0,
    lastUpdate: new Date(),
  };

  private recentTicks: TickerEvent[] = [];
  private matchTimes: number[] = [];
  private cachedMarkets: Market[] = [];
  private marketCacheTime: Date | null = null;
  private isRunning = false;

  constructor() {
    super();
  }

  // ═══════════════════════════════════════════════════════════════
  //                     START/STOP TICKER
  // ═══════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('═══════════════════════════════════════════════════════');
    logger.info('🔥 LIVE TICKER GESTARTET - DAUERFEUER MODUS');
    logger.info('═══════════════════════════════════════════════════════');

    // Auf Breaking News reagieren
    germanySources.on('breaking_news', async (news: BreakingNewsEvent) => {
      await this.processNews(news);
    });

    // Initial Markets cachen
    await this.refreshMarketCache();

    // Market Cache alle 2 Minuten refreshen
    setInterval(() => this.refreshMarketCache(), 2 * 60 * 1000);
  }

  stop(): void {
    this.isRunning = false;
    germanySources.removeAllListeners('breaking_news');
    logger.info('Live Ticker gestoppt');
  }

  // ═══════════════════════════════════════════════════════════════
  //                     PROCESS NEWS
  // ═══════════════════════════════════════════════════════════════

  private async processNews(news: BreakingNewsEvent): Promise<void> {
    const startTime = Date.now();

    // 1. NEWS EINGANG - Event emittieren
    const inEvent: TickerEvent = {
      id: `${Date.now()}-in`,
      timestamp: new Date(),
      type: 'news_in',
      source: news.source,
      title: news.title,
      category: news.category,
      keywords: news.keywords,
    };
    this.emitTick(inEvent);

    // 2. MATCHING VERSUCH - Event emittieren
    const matchingEvent: TickerEvent = {
      id: `${Date.now()}-match`,
      timestamp: new Date(),
      type: 'matching',
      source: news.source,
      title: news.title,
      category: news.category,
      keywords: news.keywords,
      matchAttempt: {
        marketsSearched: this.cachedMarkets.length,
        keywordsUsed: news.keywords.slice(0, 10),
        timeMs: 0,
      },
    };
    this.emitTick(matchingEvent);

    // 3. MATCHING DURCHFÜHREN
    const matches = await this.findMatchingMarkets(news);
    const matchTime = Date.now() - startTime;

    // Stats aktualisieren
    this.stats.newsProcessed++;
    this.matchTimes.push(matchTime);
    if (this.matchTimes.length > 100) this.matchTimes.shift();
    this.stats.avgMatchTime = this.matchTimes.reduce((a, b) => a + b, 0) / this.matchTimes.length;
    this.stats.lastUpdate = new Date();

    // 4. ERGEBNIS - Event emittieren
    if (matches.length > 0) {
      this.stats.matchesFound++;

      const matchFoundEvent: TickerEvent = {
        id: `${Date.now()}-found`,
        timestamp: new Date(),
        type: 'match_found',
        source: news.source,
        title: news.title,
        category: news.category,
        keywords: news.keywords,
        matchAttempt: {
          marketsSearched: this.cachedMarkets.length,
          keywordsUsed: news.keywords.slice(0, 10),
          timeMs: matchTime,
        },
        matchResult: {
          found: true,
          markets: matches,
        },
      };
      this.emitTick(matchFoundEvent);

      // ══════════════════════════════════════════════════════════════
      // KRITISCH: Event-basierte Verbindung mit NotificationService
      // Emittiert ticker:match_found für externe Listener
      // ══════════════════════════════════════════════════════════════
      this.emit('ticker:match_found', {
        newsId: news.id || `${news.source}:${Date.now()}`,
        newsTitle: news.title,
        newsSource: news.source,
        newsUrl: news.url,
        newsContent: news.content,
        newsKeywords: news.keywords,
        timeAdvantageSeconds: news.timeAdvantageSeconds,
        publishedAt: news.publishedAt,
        matches: matches.map(m => ({
          marketId: m.id,
          question: m.question,
          confidence: m.matchScore,
          price: m.price,
          direction: this.inferDirection(news, m),
        })),
        bestMatch: {
          marketId: matches[0].id,
          question: matches[0].question,
          confidence: matches[0].matchScore,
          price: matches[0].price,
          direction: this.inferDirection(news, matches[0]),
        },
      });

      // Legacy: NotificationService direkt informieren (Fallback)
      await this.notifyMatchToNotificationService(news, matches[0]);
    } else {
      const noMatchEvent: TickerEvent = {
        id: `${Date.now()}-nomatch`,
        timestamp: new Date(),
        type: 'no_match',
        source: news.source,
        title: news.title,
        category: news.category,
        keywords: news.keywords,
        matchAttempt: {
          marketsSearched: this.cachedMarkets.length,
          keywordsUsed: news.keywords.slice(0, 10),
          timeMs: matchTime,
        },
        matchResult: {
          found: false,
          markets: [],
        },
      };
      this.emitTick(noMatchEvent);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                     SEMANTIC MATCHING (mit LLM-Validierung)
  // ═══════════════════════════════════════════════════════════════

  private async findMatchingMarkets(news: BreakingNewsEvent): Promise<Array<{
    id: string;
    question: string;
    matchScore: number;
    price: number;
  }>> {
    // 1. STAGE 1: Fuzzy-Matching mit Subjekt-Prüfung (kostenlos, schnell)
    const sourceEvent: SourceEvent = {
      eventHash: news.id || `${news.source}:${Date.now()}`,
      sourceId: news.source,
      sourceName: news.source,
      url: news.url || null,
      title: news.title,
      content: news.content || null,
      category: news.category,
      keywords: news.keywords,
      publishedAt: news.publishedAt || new Date(),
      ingestedAt: new Date(),
      reliabilityScore: 0.7,
    };

    const fuzzyMatches = fuzzyMatch(sourceEvent, this.cachedMarkets);

    // Nur Matches mit Confidence > 50% weiterverarbeiten
    const candidates = fuzzyMatches
      .filter(m => m.confidence > 0.5)
      .slice(0, 5); // Top 5 Kandidaten

    if (candidates.length === 0) {
      logger.debug(`[TICKER] Keine Fuzzy-Matches über 50% für: ${news.title.substring(0, 40)}...`);
      return [];
    }

    logger.info(`[TICKER] ${candidates.length} Fuzzy-Kandidaten für: ${news.title.substring(0, 40)}...`);

    // 2. STAGE 2: LLM-Validierung für Top-Kandidaten (verhindert False Positives)
    const validatedMatches: Array<{
      id: string;
      question: string;
      matchScore: number;
      price: number;
    }> = [];

    // Nur LLM nutzen wenn aktiviert und Budget vorhanden
    if (llmMatcher.isEnabled()) {
      logger.info(`[TICKER] LLM-Validierung für ${Math.min(candidates.length, 3)} Kandidaten...`);

      for (const candidate of candidates.slice(0, 3)) { // Max 3 LLM-Calls pro News
        const market = this.cachedMarkets.find(m => m.id === candidate.marketId);
        if (!market) continue;

        const yesOutcome = market.outcomes.find(o => o.name.toLowerCase() === 'yes');
        const currentPrice = yesOutcome?.price || 0.5;

        try {
          const llmResult = await llmMatcher.matchNewsToMarket(
            { title: news.title, content: news.content, source: news.source },
            { id: market.id, question: market.question, currentPrice }
          );

          if (llmResult.isRelevant) {
            // LLM bestätigt: News ist relevant für den Markt
            const combinedScore = (candidate.confidence + llmResult.confidence / 100) / 2;

            validatedMatches.push({
              id: market.id,
              question: market.question,
              matchScore: combinedScore,
              price: currentPrice,
            });

            logger.info(
              `[TICKER] ✅ LLM BESTÄTIGT: "${news.title.substring(0, 30)}..." → ` +
              `"${market.question.substring(0, 30)}..." (${(combinedScore * 100).toFixed(0)}%)`
            );
          } else {
            logger.info(
              `[TICKER] ❌ LLM ABGELEHNT: "${news.title.substring(0, 30)}..." → ` +
              `"${market.question.substring(0, 30)}..." - ${llmResult.reasoning}`
            );
          }
        } catch (err) {
          logger.debug(`[TICKER] LLM-Fehler für ${market.id}: ${(err as Error).message}`);
          // Fallback: Fuzzy-Match verwenden wenn LLM fehlschlägt
          validatedMatches.push({
            id: market.id,
            question: market.question,
            matchScore: candidate.confidence,
            price: currentPrice,
          });
        }
      }
    } else {
      // Kein LLM verfügbar: Nur Fuzzy-Matches mit hoher Confidence (>70%) durchlassen
      logger.debug(`[TICKER] LLM nicht verfügbar - nutze nur Fuzzy-Matches >70%`);

      for (const candidate of candidates.filter(c => c.confidence > 0.7)) {
        const market = this.cachedMarkets.find(m => m.id === candidate.marketId);
        if (!market) continue;

        const yesOutcome = market.outcomes.find(o => o.name.toLowerCase() === 'yes');

        validatedMatches.push({
          id: market.id,
          question: market.question,
          matchScore: candidate.confidence,
          price: yesOutcome?.price || 0.5,
        });
      }
    }

    return validatedMatches.sort((a, b) => b.matchScore - a.matchScore);
  }

  // ═══════════════════════════════════════════════════════════════
  //                     MARKET CACHE
  // ═══════════════════════════════════════════════════════════════

  private async refreshMarketCache(): Promise<void> {
    try {
      // Niedrigere Schwelle (1000) um mehr Märkte zu bekommen
      const markets = await polymarketClient.getActiveMarketsWithVolume(1000);
      this.cachedMarkets = markets;
      this.marketCacheTime = new Date();
      logger.debug(`Market Cache aktualisiert: ${markets.length} Märkte`);
    } catch (err) {
      logger.error(`Market Cache Fehler: ${(err as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                     EMIT & GETTERS
  // ═══════════════════════════════════════════════════════════════

  private emitTick(event: TickerEvent): void {
    this.recentTicks.unshift(event);
    if (this.recentTicks.length > 50) this.recentTicks.pop();

    this.emit('tick', event);

    // ASCII-Log für Konsole
    this.logTickerEvent(event);
  }

  private logTickerEvent(event: TickerEvent): void {
    const timestamp = event.timestamp.toLocaleTimeString('de-DE');
    const bar = this.createProgressBar(event);

    switch (event.type) {
      case 'news_in':
        logger.info(`📰 [${timestamp}] ${event.source}: ${event.title.substring(0, 50)}...`);
        break;
      case 'matching':
        logger.info(`🔍 [${timestamp}] Matching... ${event.matchAttempt?.marketsSearched} Märkte`);
        break;
      case 'match_found':
        logger.info(`✅ [${timestamp}] ${bar} MATCH! ${event.matchResult?.markets.length} Märkte gefunden`);
        for (const m of event.matchResult?.markets || []) {
          logger.info(`   └─ ${(m.matchScore * 100).toFixed(0)}% ${m.question.substring(0, 40)}...`);
        }
        break;
      case 'no_match':
        logger.info(`❌ [${timestamp}] ${bar} Kein Match (${event.matchAttempt?.timeMs}ms)`);
        break;
    }
  }

  private createProgressBar(event: TickerEvent): string {
    if (event.type === 'match_found' && event.matchResult?.markets[0]) {
      const score = event.matchResult.markets[0].matchScore;
      const filled = Math.round(score * 10);
      return '█'.repeat(filled) + '░'.repeat(10 - filled);
    }
    return '░'.repeat(10);
  }

  getStats(): TickerStats {
    return { ...this.stats };
  }

  getRecentTicks(limit = 20): TickerEvent[] {
    return this.recentTicks.slice(0, limit);
  }

  getMarketCount(): number {
    return this.cachedMarkets.length;
  }

  // ═══════════════════════════════════════════════════════════════
  //              NOTIFICATION SERVICE INTEGRATION
  // Verbindet Ticker-Matches mit der Push-Pipeline
  // ═══════════════════════════════════════════════════════════════

  private async notifyMatchToNotificationService(
    news: BreakingNewsEvent,
    topMatch: { id: string; question: string; matchScore: number; price: number }
  ): Promise<void> {
    try {
      // 1. Prüfe ob NotificationService bereits einen Candidate für diese News hat
      // (Der Telegram Bot sollte bereits processBreakingNews aufgerufen haben)
      const { getCandidateByTitle } = await import('../storage/repositories/newsCandidates.js');
      const existingCandidate = getCandidateByTitle(news.title);

      if (!existingCandidate) {
        logger.debug(`[TICKER] Kein Candidate für News gefunden: ${news.title.substring(0, 40)}...`);
        return;
      }

      // 2. Erstelle MarketInfo für Gate-Check
      const marketInfo: MarketInfo = {
        marketId: topMatch.id,
        question: topMatch.question,
        currentPrice: topMatch.price,
        totalVolume: 50000, // Mindest-Volume für Gate-Pass
      };

      // 3. Erstelle SourceInfo
      const sourceInfo: SourceInfo = {
        sourceId: news.source,
        sourceName: news.source,
        reliabilityScore: 0.7, // Standard für kuratierte Quellen
      };

      // 4. Informiere NotificationService
      const expectedLagMinutes = news.timeAdvantageSeconds
        ? Math.ceil(news.timeAdvantageSeconds / 60)
        : 15;

      const matched = await notificationService.setMatchAndEvaluate(
        existingCandidate.id,
        marketInfo,
        sourceInfo,
        expectedLagMinutes
      );

      if (matched) {
        logger.info(`[TICKER] Match an NotificationService übergeben: ${news.title.substring(0, 40)}...`);
        this.stats.alphaSignals++;
      }
    } catch (err) {
      logger.debug(`[TICKER] NotificationService-Integration Fehler: ${(err as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                     DIRECTION INFERENCE
  // Bestimmt YES/NO Richtung basierend auf News-Sentiment
  // ═══════════════════════════════════════════════════════════════

  private inferDirection(
    news: BreakingNewsEvent,
    match: { id: string; question: string; matchScore: number; price: number }
  ): 'yes' | 'no' {
    const text = `${news.title} ${news.content || ''}`.toLowerCase();
    const question = match.question.toLowerCase();

    // Positive Indikatoren
    const positivePatterns = [
      /gewinnt|wins?|victory|sieg|erfolg|success|steigt|rises?|grows?|wächst/i,
      /bestätigt|confirmed|announced|angekündigt|approved|genehmigt/i,
      /einigung|agreement|deal|pact|vertrag/i,
    ];

    // Negative Indikatoren
    const negativePatterns = [
      /verliert|loses?|defeat|niederlage|scheitert|fails?|fällt|falls?|sinkt/i,
      /entlass|fired|sacked|dismissed|rücktritt|resigned|quits?/i,
      /abgesagt|cancelled|rejected|abgelehnt|gestoppt|blocked/i,
    ];

    let sentiment = 0;
    for (const pattern of positivePatterns) {
      if (pattern.test(text)) sentiment += 1;
    }
    for (const pattern of negativePatterns) {
      if (pattern.test(text)) sentiment -= 1;
    }

    // Bei Fragen mit "wird X entlassen?" und negativem News-Sentiment → YES
    if (/entlass|fire|sack|leave|resign/i.test(question) && sentiment < 0) {
      return 'yes';
    }

    // Bei Fragen mit "bleibt X?" und negativem News-Sentiment → NO
    if (/bleibt|remain|stay|continue/i.test(question) && sentiment < 0) {
      return 'no';
    }

    // Default: Positives Sentiment → YES, sonst NO
    return sentiment >= 0 ? 'yes' : 'no';
  }

  // ═══════════════════════════════════════════════════════════════
  //                     ASCII ART FORMATTERS
  // ═══════════════════════════════════════════════════════════════

  formatTickerLine(event: TickerEvent): string {
    const time = event.timestamp.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const emoji = this.getTypeEmoji(event.type);
    const bar = this.getMatchBar(event);

    if (event.type === 'news_in') {
      return `${emoji} ${time} │ ${event.source.padEnd(15).substring(0, 15)} │ ${event.title.substring(0, 40)}...`;
    }

    if (event.type === 'matching') {
      return `${emoji} ${time} │ SCANNING ${event.matchAttempt?.marketsSearched} MÄRKTE...`;
    }

    if (event.type === 'match_found') {
      const topMatch = event.matchResult?.markets[0];
      return `${emoji} ${time} │ ${bar} │ ${(topMatch?.matchScore || 0) * 100}% MATCH → ${topMatch?.question.substring(0, 30)}...`;
    }

    if (event.type === 'no_match') {
      return `${emoji} ${time} │ ${bar} │ KEIN MATCH (${event.matchAttempt?.timeMs}ms)`;
    }

    return `${emoji} ${time} │ ${event.title.substring(0, 50)}`;
  }

  private getTypeEmoji(type: TickerEvent['type']): string {
    const emojis: Record<TickerEvent['type'], string> = {
      'news_in': '📰',
      'matching': '🔍',
      'match_found': '✅',
      'no_match': '❌',
      'alpha_signal': '🔥',
    };
    return emojis[type] || '•';
  }

  private getMatchBar(event: TickerEvent): string {
    if (event.matchResult?.found && event.matchResult.markets[0]) {
      const score = event.matchResult.markets[0].matchScore;
      const filled = Math.round(score * 10);
      return '█'.repeat(filled) + '░'.repeat(10 - filled);
    }
    if (event.type === 'no_match') {
      return '░░░░░░░░░░';
    }
    return '▒▒▒▒▒▒▒▒▒▒';
  }

  // Telegram-formatierte Ausgabe
  formatTelegramTicker(ticks: TickerEvent[]): string {
    const lines = [
      '```',
      '╔══════════════════════════════════════╗',
      '║     🔥 LIVE TICKER - DAUERFEUER 🔥   ║',
      '╠══════════════════════════════════════╣',
    ];

    for (const tick of ticks.slice(0, 8)) {
      const time = tick.timestamp.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const emoji = this.getTypeEmoji(tick.type);

      if (tick.type === 'news_in') {
        lines.push(`║ ${emoji} ${time} ${tick.source.substring(0, 12).padEnd(12)} ║`);
        lines.push(`║   ${tick.title.substring(0, 32).padEnd(32)}║`);
      } else if (tick.type === 'match_found') {
        const bar = this.getMatchBar(tick);
        lines.push(`║ ${emoji} ${bar} MATCH!              ║`);
      } else if (tick.type === 'no_match') {
        lines.push(`║ ${emoji} ░░░░░░░░░░ kein Match        ║`);
      }
    }

    lines.push('╠══════════════════════════════════════╣');
    lines.push(`║ News: ${String(this.stats.newsProcessed).padStart(4)} │ Matches: ${String(this.stats.matchesFound).padStart(3)} │ ⏱${Math.round(this.stats.avgMatchTime)}ms ║`);
    lines.push('╚══════════════════════════════════════╝');
    lines.push('```');

    return lines.join('\n');
  }
}

export const newsTicker = new NewsTicker();
export default newsTicker;
