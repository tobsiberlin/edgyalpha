import axios from 'axios';
import { EventEmitter } from 'events';
import { config, BUNDESTAG_API_KEY } from '../utils/config.js';
import logger from '../utils/logger.js';
import { Market, GermanSource } from '../types/index.js';
import { fetchDawumPolls, type DawumPoll } from './dawum.js';
import {
  fetchAllRSSFeeds,
  newsItemsToGermanSources,
  getHealthSummary,
  computeNewsHash,
  type NewsItem,
  WORKING_RSS_FEEDS,
} from './rss.js';

// ═══════════════════════════════════════════════════════════════
// EVENT-DRIVEN ALMAN SCANNER
// Statt 5-Min-Polling: Kontinuierliches RSS-Monitoring mit Events
// ═══════════════════════════════════════════════════════════════

export interface BreakingNewsEvent {
  id: string;
  source: string;
  title: string;
  url?: string;
  content: string;
  category: string;
  keywords: string[];
  publishedAt: Date;
  detectedAt: Date;
}

// RSS Feeds sind jetzt in ./rss.ts definiert (WORKING_RSS_FEEDS + EXPERIMENTAL_RSS_FEEDS)
// Import: WORKING_RSS_FEEDS aus ./rss.js

// Keywords für Markt-Matching (erweitert um EU/NATO/Geopolitik)
// Basierend auf Spezifikation: 15-60 Min Informationsvorsprung nutzen
const GERMANY_KEYWORDS = {
  politics: [
    // Deutsche Politik
    'bundestag', 'bundesregierung', 'kanzler', 'scholz', 'merz', 'habeck',
    'lindner', 'baerbock', 'weidel', 'afd', 'cdu', 'csu', 'spd', 'grüne',
    'fdp', 'linke', 'bsw', 'wahlkampf', 'koalition', 'ampel', 'opposition',
    'bundestagswahl', 'landtagswahl', 'europawahl', 'regierungskrise',
    'germany', 'german', 'deutschland', 'berlin', 'chancellor',
    'kai wegner', 'giffey', 'abgeordnetenhaus', 'groko',
    // Misstrauensvotum & Koalitionsbruch
    'misstrauensvotum', 'rücktritt', 'neuwahl', 'vertrauensfrage',
    // EU & Europa
    'european union', 'eu ', ' eu', 'brussels', 'von der leyen', 'ursula',
    'european commission', 'european parliament', 'eurozone', 'lagarde',
    // NATO & Geopolitik (betrifft Deutschland)
    'nato', 'ukraine', 'russia', 'putin', 'zelensky', 'ceasefire',
    'crimea', 'donbas', 'nordstream', 'sanctions', 'selenskyj',
    'waffenstillstand', 'friedensverhandlungen', 'invasion',
  ],
  economics: [
    // Zentralbanken
    'bundesbank', 'ezb', 'ecb', 'inflation', 'rezession', 'recession',
    'zinsen', 'interest rate', 'rate hike', 'rate cut',
    // Wirtschaftsdaten (Destatis)
    'wirtschaft', 'export', 'import', 'arbeitslosigkeit', 'unemployment',
    'ifo', 'zew', 'destatis', 'bip', 'gdp', 'vpi', 'verbraucherpreis',
    // DAX Unternehmen
    'dax', 'volkswagen', 'siemens', 'basf', 'deutsche bank', 'allianz',
    'bmw', 'mercedes', 'porsche', 'sap', 'adidas', 'bayer',
    // Energie (sehr wichtig für DE/EU)
    'gas prices', 'energy crisis', 'lng', 'oil prices', 'natural gas',
    'pipeline', 'energy', 'strompreis',
  ],
  // NEU: Spezifische Markt-Keywords für direktes Matching
  markets: [
    // Koalition/Regierung
    'coalition break', 'coalition collapse', 'government fall',
    'chancellor out', 'prime minister resign',
    // EZB Zinsen
    'ecb rate', 'ecb interest', 'european central bank',
    // Geopolitik Events
    'peace deal', 'peace agreement', 'troops withdraw', 'military',
    'war end', 'conflict resolution',
  ],
  // Bundesliga/Sport (Trainerwechsel = Alpha!)
  sports: [
    'bundesliga', 'bayern', 'dortmund', 'bvb', 'leipzig', 'leverkusen',
    'bayern munich', 'bayern münchen', 'fc bayern',
    // Trainer
    'trainer', 'coach', 'manager sacked', 'manager fired',
    'trainerwechsel', 'entlassen', 'freigestellt',
    'kompany', 'terzic', 'xabi alonso', 'rose',
    // Champions League (relevant für DE-Clubs)
    'champions league',
  ],
};

// DawumPoll Interface jetzt aus ./dawum.ts importiert
// Hier nutzen wir das importierte DawumPoll Interface

interface BundestagItem {
  id: string;
  titel: string;
  datum: string;
  abstract?: string;
  vorgangstyp?: string;
}

// ═══════════════════════════════════════════════════════════════
// EVENT-DRIVEN GERMAN SOURCES SCANNER
// Events: 'breaking_news', 'poll_update', 'bundestag_update'
// ═══════════════════════════════════════════════════════════════
class GermanySources extends EventEmitter {
  private cachedPolls: DawumPoll[] = [];
  private cachedNews: GermanSource[] = [];
  private cachedBundestag: BundestagItem[] = [];
  private lastUpdate: Date | null = null;

  // Event-driven: Track gesehene News-IDs für Delta-Detection
  private seenNewsIds: Set<string> = new Set();
  private rssPollingInterval: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;

  // RSS-Polling Intervall (60 Sekunden für schnelle Erkennung)
  private readonly RSS_POLL_INTERVAL = 60 * 1000;

  constructor() {
    super();
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT-DRIVEN RSS MONITORING
  // Startet kontinuierliches Polling für Breaking News Detection
  // ═══════════════════════════════════════════════════════════════

  startEventListener(): void {
    if (this.isPolling) {
      logger.warn('RSS Event-Listener laeuft bereits');
      return;
    }

    const healthSummary = getHealthSummary();
    logger.info('═══════════════════════════════════════════════════════');
    logger.info('ALMAN SCANNER EVENT-LISTENER GESTARTET');
    logger.info(`   Polling-Intervall: ${this.RSS_POLL_INTERVAL / 1000}s`);
    logger.info(`   Feeds: ${WORKING_RSS_FEEDS.length} (kuratiert)`);
    logger.info(`   Health: ${healthSummary.ok} OK, ${healthSummary.error} Fehler`);
    logger.info('═══════════════════════════════════════════════════════');

    this.isPolling = true;

    // Initialer Fetch (ohne Events - nur Cache fuellen)
    this.fetchRSSFeedsWithDelta(false).catch(err =>
      logger.error(`Initial RSS-Fetch Fehler: ${err.message}`)
    );

    // Kontinuierliches Polling mit Delta-Detection
    this.rssPollingInterval = setInterval(async () => {
      try {
        await this.fetchRSSFeedsWithDelta(true);
      } catch (err) {
        logger.error(`RSS-Polling Fehler: ${(err as Error).message}`);
      }
    }, this.RSS_POLL_INTERVAL);
  }

  stopEventListener(): void {
    if (this.rssPollingInterval) {
      clearInterval(this.rssPollingInterval);
      this.rssPollingInterval = null;
    }
    this.isPolling = false;
    logger.info('RSS Event-Listener gestoppt');
  }

  // Delta-Detection: Nur NEUE News erkennen und Events emittieren
  // Nutzt jetzt die robuste fetchAllRSSFeeds aus ./rss.ts
  private async fetchRSSFeedsWithDelta(emitEvents: boolean): Promise<void> {
    const breakingNews: BreakingNewsEvent[] = [];

    // Nutze die neue robuste RSS-Fetch-Logik mit Health-Tracking
    const result = await fetchAllRSSFeeds({
      includeExperimental: false, // Nur stabile Feeds fuer Event-Listener
      maxConcurrent: 10,
      timeout: 8000,
    });

    // Konvertiere NewsItems zu GermanSource
    const allNews = newsItemsToGermanSources(result.items);
    const newNews: GermanSource[] = [];

    for (const item of allNews) {
      // Nutze SHA256-Hash fuer eindeutige ID
      const newsId = (item.data.hash as string) || computeNewsHash({
        source: item.data.source as string,
        url: item.url,
        title: item.title,
      });

      if (!this.seenNewsIds.has(newsId)) {
        this.seenNewsIds.add(newsId);
        newNews.push(item);

        // Pruefe ob Breaking News (relevant fuer Markets)
        if (emitEvents) {
          const keywords = this.extractKeywords(item);
          if (keywords.length > 0) {
            const breakingEvent: BreakingNewsEvent = {
              id: newsId,
              source: item.data.source as string,
              title: item.title,
              url: item.url,
              content: (item.data.content as string) || '',
              category: (item.data.category as string) || 'unknown',
              keywords,
              publishedAt: item.publishedAt,
              detectedAt: new Date(),
            };
            breakingNews.push(breakingEvent);
          }
        }
      }
    }

    // Cache aktualisieren
    this.cachedNews = [...newNews, ...this.cachedNews].slice(0, 1000);
    this.lastUpdate = new Date();

    // Events emittieren fuer Breaking News
    if (emitEvents && breakingNews.length > 0) {
      logger.info(`${breakingNews.length} BREAKING NEWS erkannt!`);

      for (const news of breakingNews) {
        logger.info(`   [${news.source}] ${news.title.substring(0, 60)}...`);
        logger.info(`      Keywords: ${news.keywords.join(', ')}`);
        this.emit('breaking_news', news);
      }
    }

    if (newNews.length > 0) {
      logger.debug(`RSS Update: ${newNews.length} neue Artikel (${result.successfulFeeds}/${result.totalFeeds} Feeds OK)`);
    }
  }

  private generateNewsId(news: GermanSource): string {
    // Nutze SHA256-Hash wenn vorhanden, sonst Fallback
    if (news.data.hash) return news.data.hash as string;
    if (news.url) return news.url;
    return `${news.data.source}:${news.title}`.substring(0, 200);
  }

  private extractKeywords(news: GermanSource): string[] {
    const text = `${news.title} ${(news.data.content as string) || ''}`.toLowerCase();
    const allKeywords = [
      ...GERMANY_KEYWORDS.politics,
      ...GERMANY_KEYWORDS.economics,
      ...GERMANY_KEYWORDS.markets,
      ...GERMANY_KEYWORDS.sports,
    ];

    return allKeywords.filter(kw => text.includes(kw.toLowerCase()));
  }

  // Original fetchAll - jetzt auch Event-Listener starten
  async fetchAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (config.germany.sources.dawum) {
      promises.push(this.fetchDawum());
    }
    if (config.germany.sources.bundestag && BUNDESTAG_API_KEY) {
      promises.push(this.fetchBundestag());
    }
    if (config.germany.sources.rss) {
      promises.push(this.fetchRSSFeeds());
    }

    await Promise.allSettled(promises);
    this.lastUpdate = new Date();

    logger.info(
      `DE-Quellen aktualisiert: ${this.cachedPolls.length} Umfragen, ${this.cachedNews.length} News, ${this.cachedBundestag.length} Bundestag-Items`
    );

    // Event-Listener automatisch starten
    if (config.germany.sources.rss && !this.isPolling) {
      this.startEventListener();
    }
  }

  async fetchDawum(): Promise<void> {
    try {
      // Nutze die neue dawum.ts Implementierung
      const polls = await fetchDawumPolls();
      this.cachedPolls = polls.slice(0, 20);
      logger.debug(`Dawum: ${this.cachedPolls.length} Bundestag-Umfragen geladen`);
    } catch (err) {
      const error = err as Error;
      logger.error(`Dawum Fehler: ${error.message}`);
    }
  }

  async fetchBundestag(): Promise<void> {
    if (!BUNDESTAG_API_KEY) {
      logger.debug('Bundestag API Key nicht konfiguriert');
      return;
    }

    try {
      const response = await axios.get(
        'https://search.dip.bundestag.de/api/v1/vorgang',
        {
          params: {
            apikey: BUNDESTAG_API_KEY,
            f: {
              datum: {
                start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
                  .toISOString()
                  .split('T')[0],
              },
            },
            format: 'json',
          },
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (response.data.documents) {
        this.cachedBundestag = response.data.documents.slice(0, 50).map(
          (doc: Record<string, unknown>) => ({
            id: String(doc.id || ''),
            titel: String(doc.titel || ''),
            datum: String(doc.datum || ''),
            abstract: String(doc.abstract || ''),
            vorgangstyp: String(doc.vorgangstyp || ''),
          })
        );
      }

      logger.debug(`Bundestag: ${this.cachedBundestag.length} Vorgänge geladen`);
    } catch (err) {
      const error = err as Error;
      logger.error(`Bundestag API Fehler: ${error.message}`);
    }
  }

  async fetchRSSFeeds(): Promise<void> {
    // Nutze die neue robuste RSS-Fetch-Logik
    const result = await fetchAllRSSFeeds({
      includeExperimental: false, // Nur stabile, kuratierte Feeds
      maxConcurrent: 10,
      timeout: 8000,
    });

    // Konvertiere NewsItems zu GermanSource Format
    this.cachedNews = newsItemsToGermanSources(result.items);

    const healthSummary = getHealthSummary();
    logger.debug(
      `RSS: ${result.uniqueItems} Artikel geladen ` +
      `(${result.successfulFeeds}/${result.totalFeeds} Feeds OK, ` +
      `${healthSummary.avgSuccessRate}% Erfolgsrate)`
    );
  }

  async matchMarketsWithGermanData(
    markets: Market[]
  ): Promise<Map<string, { relevance: number; direction: 'YES' | 'NO' }[]>> {
    // Daten aktualisieren falls nötig
    if (!this.lastUpdate || Date.now() - this.lastUpdate.getTime() > 300000) {
      await this.fetchAll();
    }

    const matches = new Map<string, { relevance: number; direction: 'YES' | 'NO' }[]>();

    // Alle Keywords sammeln (inkl. Markt-spezifische + Sport)
    const allKeywords = [
      ...GERMANY_KEYWORDS.politics,
      ...GERMANY_KEYWORDS.economics,
      ...GERMANY_KEYWORDS.markets,
      ...GERMANY_KEYWORDS.sports,
    ];

    logger.debug(`Prüfe ${markets.length} Märkte gegen ${allKeywords.length} Keywords`);

    for (const market of markets) {
      const marketText = `${market.question} ${market.slug}`.toLowerCase();
      const sources: { relevance: number; direction: 'YES' | 'NO' }[] = [];

      // Prüfe auf Deutschland/EU-Relevanz
      const keywordMatches = allKeywords.filter((kw) =>
        marketText.includes(kw.toLowerCase())
      );

      if (keywordMatches.length === 0) {
        continue;
      }

      logger.info(`DE/EU-Match: "${market.question.substring(0, 50)}..." → ${keywordMatches.join(', ')}`);

      // Relevanz berechnen - höhere Basis für mehr Alpha!
      const baseRelevance = Math.min(0.2 + keywordMatches.length * 0.1, 0.6);

      // Mit Umfragedaten abgleichen
      if (this.isElectionMarket(marketText)) {
        const latestPoll = this.cachedPolls[0];
        if (latestPoll) {
          const pollSignal = this.analyzePollForMarket(market, latestPoll);
          if (pollSignal) {
            sources.push({
              relevance: baseRelevance + 0.3,
              direction: pollSignal,
            });
          }
        }
      }

      // Mit News abgleichen
      const relevantNews = this.cachedNews.filter((n) =>
        this.isNewsRelevantToMarket(n, market)
      );

      if (relevantNews.length > 0) {
        sources.push({
          relevance: baseRelevance + Math.min(relevantNews.length * 0.05, 0.2),
          direction: 'YES', // Vereinfacht - könnte Sentiment-Analyse nutzen
        });
      }

      // Mit Bundestag-Vorgängen abgleichen
      const relevantBundestag = this.cachedBundestag.filter((b) =>
        this.isBundestagRelevantToMarket(b, market)
      );

      if (relevantBundestag.length > 0) {
        sources.push({
          relevance: baseRelevance + 0.25,
          direction: 'YES',
        });
      }

      // WICHTIG: Wenn Keywords matchen aber keine spezifischen Quellen gefunden wurden,
      // trotzdem als relevant markieren mit Basis-Relevanz
      if (sources.length === 0 && keywordMatches.length > 0) {
        // Geopolitik-Märkte (Ukraine, Russland, etc.) sind immer relevant für DE/EU
        const isGeopolitical = ['ukraine', 'russia', 'ceasefire', 'nato', 'putin', 'zelensky', 'crimea', 'donbas'].some(
          kw => keywordMatches.includes(kw)
        );

        if (isGeopolitical) {
          sources.push({
            relevance: baseRelevance + 0.25, // Geopolitik-Bonus erhöht
            direction: 'YES', // Basis-Annahme: EU/NATO unterstützt Ukraine
          });
          logger.info(`🌍 Geopolitik-Alpha: ${market.question.substring(0, 40)}... (Relevanz: ${(baseRelevance + 0.25).toFixed(2)})`);
        } else {
          // Allgemeine DE/EU-Relevanz (auch ohne Geopolitik)
          sources.push({
            relevance: baseRelevance + 0.15,
            direction: 'YES',
          });
          logger.info(`🇩🇪 DE/EU-Alpha: ${market.question.substring(0, 40)}... (Relevanz: ${(baseRelevance + 0.15).toFixed(2)})`);
        }
      }

      if (sources.length > 0) {
        matches.set(market.id, sources);
      }
    }

    if (matches.size === 0) {
      logger.debug('Keine Deutschland/EU-relevanten Märkte gefunden. Deutsche Wahlen sind vorbei.');
    } else {
      logger.info(`${matches.size} Märkte mit DE/EU-Relevanz gefunden`);
    }

    return matches;
  }

  private isElectionMarket(text: string): boolean {
    const electionKeywords = [
      // Wahlen
      'wahl', 'election', 'vote', 'voting', 'ballot',
      // Politik-Positionen
      'kanzler', 'chancellor', 'president', 'prime minister',
      'bundestag', 'parliament', 'government', 'coalition',
      // Ergebnisse
      'win', 'gewinnt', 'siegt', 'führt', 'regierung',
      'majority', 'victory', 'defeat',
      // Geopolitik (für Ukraine/Russland Märkte)
      'ceasefire', 'peace', 'war', 'invasion', 'troops',
    ];
    return electionKeywords.some((kw) => text.includes(kw));
  }

  private analyzePollForMarket(
    market: Market,
    poll: DawumPoll
  ): 'YES' | 'NO' | null {
    const question = market.question.toLowerCase();

    // CDU/CSU vs SPD Analyse
    // Neue Struktur: CDU/CSU ist jetzt zusammengefasst, oder CDU/CSU einzeln
    const cduValue =
      (poll.results['CDU/CSU'] || 0) +
      (poll.results['CDU'] || 0) +
      (poll.results['CSU'] || 0);
    const spdValue = poll.results['SPD'] || 0;

    if (question.includes('cdu') || question.includes('merz')) {
      if (question.includes('win') || question.includes('gewinnt')) {
        return cduValue > spdValue ? 'YES' : 'NO';
      }
    }

    if (question.includes('spd') || question.includes('scholz')) {
      if (question.includes('win') || question.includes('gewinnt')) {
        return spdValue > cduValue ? 'YES' : 'NO';
      }
    }

    // AfD Analyse
    if (question.includes('afd')) {
      const afdValue = poll.results['AfD'] || 0;

      if (question.includes('20%') || question.includes('twenty')) {
        return afdValue >= 20 ? 'YES' : 'NO';
      }
    }

    return null;
  }

  private isNewsRelevantToMarket(news: GermanSource, market: Market): boolean {
    const marketText = market.question.toLowerCase();
    const newsText = `${news.title} ${(news.data.content as string) || ''}`.toLowerCase();

    // Einfache Keyword-Überlappung
    const marketWords = marketText.split(/\s+/).filter((w) => w.length > 4);
    const matchCount = marketWords.filter((w) => newsText.includes(w)).length;

    return matchCount >= 2;
  }

  private isBundestagRelevantToMarket(
    item: BundestagItem,
    market: Market
  ): boolean {
    const marketText = market.question.toLowerCase();
    const itemText = `${item.titel} ${item.abstract || ''}`.toLowerCase();

    const marketWords = marketText.split(/\s+/).filter((w) => w.length > 4);
    const matchCount = marketWords.filter((w) => itemText.includes(w)).length;

    return matchCount >= 2;
  }

  getLatestPolls(): DawumPoll[] {
    return this.cachedPolls;
  }

  getLatestNews(): GermanSource[] {
    return this.cachedNews;
  }

  getBundestagItems(): BundestagItem[] {
    return this.cachedBundestag;
  }
}

export const germanySources = new GermanySources();
export default germanySources;
