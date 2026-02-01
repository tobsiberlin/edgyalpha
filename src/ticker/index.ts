import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { germanySources, BreakingNewsEvent } from '../germany/index.js';
import { polymarketClient } from '../api/polymarket.js';
import { Market } from '../types/index.js';

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
  //                     SEMANTIC MATCHING
  // ═══════════════════════════════════════════════════════════════

  private async findMatchingMarkets(news: BreakingNewsEvent): Promise<Array<{
    id: string;
    question: string;
    matchScore: number;
    price: number;
  }>> {
    const matches: Array<{
      id: string;
      question: string;
      matchScore: number;
      price: number;
    }> = [];

    const newsText = `${news.title} ${news.content}`.toLowerCase();
    const newsWords = this.extractSignificantWords(newsText);

    for (const market of this.cachedMarkets) {
      const marketText = `${market.question} ${market.slug}`.toLowerCase();
      const marketWords = this.extractSignificantWords(marketText);

      // Berechne Match-Score
      const score = this.calculateMatchScore(newsWords, marketWords, news.keywords);

      if (score > 0.3) {
        const yesOutcome = market.outcomes.find(o => o.name.toLowerCase() === 'yes');
        matches.push({
          id: market.id,
          question: market.question,
          matchScore: score,
          price: yesOutcome?.price || 0.5,
        });
      }
    }

    // Top 5 Matches zurückgeben
    return matches
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 5);
  }

  private extractSignificantWords(text: string): string[] {
    // Stopwords entfernen, nur signifikante Wörter behalten
    const stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
      'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
      'from', 'up', 'about', 'into', 'over', 'after', 'der', 'die', 'das',
      'und', 'oder', 'aber', 'wenn', 'weil', 'dass', 'wird', 'werden',
      'hat', 'haben', 'ist', 'sind', 'war', 'waren', 'sein', 'seine',
      'einer', 'eine', 'einem', 'einen', 'vor', 'nach', 'bei', 'mit',
    ]);

    return text
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-ZäöüßÄÖÜ]/g, '').toLowerCase())
      .filter(w => w.length > 3 && !stopwords.has(w));
  }

  private calculateMatchScore(newsWords: string[], marketWords: string[], keywords: string[]): number {
    let score = 0;

    // 1. Direkte Keyword-Matches (höchste Gewichtung)
    for (const keyword of keywords) {
      const kwLower = keyword.toLowerCase();
      if (marketWords.some(w => w.includes(kwLower) || kwLower.includes(w))) {
        score += 0.3;
      }
    }

    // 2. Word Overlap
    const commonWords = newsWords.filter(w =>
      marketWords.some(mw =>
        mw.includes(w) || w.includes(mw) || this.levenshteinSimilar(w, mw)
      )
    );
    score += (commonWords.length / Math.max(newsWords.length, 1)) * 0.4;

    // 3. Fuzzy Name Matching (z.B. "Kompany" -> "Vincent Kompany")
    for (const newsWord of newsWords) {
      if (newsWord.length > 4) {
        for (const marketWord of marketWords) {
          if (marketWord.includes(newsWord) || newsWord.includes(marketWord)) {
            score += 0.15;
          }
        }
      }
    }

    return Math.min(score, 1);
  }

  private levenshteinSimilar(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 2) return false;

    let diff = 0;
    const minLen = Math.min(a.length, b.length);

    for (let i = 0; i < minLen; i++) {
      if (a[i] !== b[i]) diff++;
    }

    diff += Math.abs(a.length - b.length);
    return diff <= 2;
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
