import axios from 'axios';
import Parser from 'rss-parser';
import { config, BUNDESTAG_API_KEY } from '../utils/config.js';
import logger from '../utils/logger.js';
import { Market, GermanSource } from '../types/index.js';

const rssParser = new Parser();

// Deutsche RSS-Feeds
const RSS_FEEDS = [
  { name: 'Tagesschau', url: 'https://www.tagesschau.de/xml/rss2/' },
  { name: 'Spiegel Politik', url: 'https://www.spiegel.de/politik/index.rss' },
  { name: 'Zeit Politik', url: 'https://newsfeed.zeit.de/politik/index' },
  { name: 'FAZ Politik', url: 'https://www.faz.net/rss/aktuell/politik/' },
  { name: 'Handelsblatt', url: 'https://www.handelsblatt.com/contentexport/feed/top-themen/' },
];

// Keywords für Markt-Matching (erweitert um EU/NATO/Geopolitik)
const GERMANY_KEYWORDS = {
  politics: [
    // Deutsche Politik
    'bundestag', 'bundesregierung', 'kanzler', 'scholz', 'merz', 'habeck',
    'lindner', 'baerbock', 'weidel', 'afd', 'cdu', 'csu', 'spd', 'grüne',
    'fdp', 'linke', 'bsw', 'wahlkampf', 'koalition', 'ampel', 'opposition',
    'bundestagswahl', 'landtagswahl', 'europawahl',
    'germany', 'german', 'deutschland', 'berlin', 'chancellor',
    // EU & Europa
    'european union', 'eu ', ' eu', 'brussels', 'von der leyen', 'ursula',
    'european commission', 'european parliament', 'eurozone',
    // NATO & Geopolitik (betrifft Deutschland)
    'nato', 'ukraine', 'russia', 'putin', 'zelensky', 'ceasefire',
    'crimea', 'donbas', 'nordstream', 'sanctions',
  ],
  economics: [
    'bundesbank', 'ezb', 'ecb', 'inflation', 'rezession', 'recession',
    'wirtschaft', 'export', 'import', 'arbeitslosigkeit', 'unemployment',
    'ifo', 'zew', 'destatis', 'bip', 'gdp',
    'dax', 'volkswagen', 'siemens', 'basf', 'deutsche bank', 'allianz',
    'bmw', 'mercedes', 'porsche', 'sap',
    // Energie (wichtig für DE)
    'gas prices', 'energy crisis', 'lng', 'oil prices',
  ],
};

interface DawumPoll {
  date: string;
  institute: string;
  results: Record<string, number>;
}

interface BundestagItem {
  id: string;
  titel: string;
  datum: string;
  abstract?: string;
  vorgangstyp?: string;
}

class GermanySources {
  private cachedPolls: DawumPoll[] = [];
  private cachedNews: GermanSource[] = [];
  private cachedBundestag: BundestagItem[] = [];
  private lastUpdate: Date | null = null;

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
  }

  async fetchDawum(): Promise<void> {
    try {
      const response = await axios.get('https://api.dawum.de/');
      const data = response.data;

      if (data.Surveys) {
        this.cachedPolls = Object.entries(data.Surveys)
          .slice(0, 20)
          .map(([, survey]: [string, unknown]) => {
            const s = survey as Record<string, unknown>;
            const results: Record<string, number> = {};

            if (s.Results && typeof s.Results === 'object') {
              for (const [partyId, value] of Object.entries(s.Results as Record<string, unknown>)) {
                const partyName = this.getPartyName(partyId, data.Parties);
                if (partyName && typeof value === 'number') {
                  results[partyName] = value;
                }
              }
            }

            return {
              date: String(s.Date || ''),
              institute: this.getInstituteName(String(s.Institute_ID || ''), data.Institutes),
              results,
            };
          });
      }

      logger.debug(`Dawum: ${this.cachedPolls.length} Umfragen geladen`);
    } catch (err) {
      const error = err as Error;
      logger.error(`Dawum Fehler: ${error.message}`);
    }
  }

  private getPartyName(id: string, parties: Record<string, unknown>): string {
    const party = parties?.[id] as Record<string, unknown> | undefined;
    return party?.Shortcut as string || id;
  }

  private getInstituteName(id: string, institutes: Record<string, unknown>): string {
    const inst = institutes?.[id] as Record<string, unknown> | undefined;
    return inst?.Name as string || id;
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
    const news: GermanSource[] = [];

    for (const feed of RSS_FEEDS) {
      try {
        const parsed = await rssParser.parseURL(feed.url);

        for (const item of (parsed.items || []).slice(0, 10)) {
          news.push({
            type: 'rss',
            title: item.title || 'Kein Titel',
            url: item.link,
            data: {
              source: feed.name,
              content: item.contentSnippet || item.content || '',
            },
            relevance: 0,
            publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
          });
        }
      } catch (err) {
        const error = err as Error;
        logger.debug(`RSS Feed ${feed.name} Fehler: ${error.message}`);
      }
    }

    this.cachedNews = news;
    logger.debug(`RSS: ${news.length} Artikel geladen`);
  }

  async matchMarketsWithGermanData(
    markets: Market[]
  ): Promise<Map<string, { relevance: number; direction: 'YES' | 'NO' }[]>> {
    // Daten aktualisieren falls nötig
    if (!this.lastUpdate || Date.now() - this.lastUpdate.getTime() > 300000) {
      await this.fetchAll();
    }

    const matches = new Map<string, { relevance: number; direction: 'YES' | 'NO' }[]>();

    for (const market of markets) {
      const marketText = `${market.question} ${market.slug}`.toLowerCase();
      const sources: { relevance: number; direction: 'YES' | 'NO' }[] = [];

      // Prüfe auf Deutschland-Relevanz
      const allKeywords = [
        ...GERMANY_KEYWORDS.politics,
        ...GERMANY_KEYWORDS.economics,
      ];

      const keywordMatches = allKeywords.filter((kw) =>
        marketText.includes(kw.toLowerCase())
      );

      if (keywordMatches.length === 0) {
        continue;
      }

      // Relevanz berechnen
      const baseRelevance = Math.min(keywordMatches.length * 0.1, 0.5);

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

      if (sources.length > 0) {
        matches.set(market.id, sources);
        logger.debug(`DE-Match: "${market.question.substring(0, 50)}..." → ${keywordMatches.join(', ')}`);
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
    if (question.includes('cdu') || question.includes('merz')) {
      const cduValue = (poll.results['CDU'] || 0) + (poll.results['CSU'] || 0);
      const spdValue = poll.results['SPD'] || 0;

      if (question.includes('win') || question.includes('gewinnt')) {
        return cduValue > spdValue ? 'YES' : 'NO';
      }
    }

    if (question.includes('spd') || question.includes('scholz')) {
      const spdValue = poll.results['SPD'] || 0;
      const cduValue = (poll.results['CDU'] || 0) + (poll.results['CSU'] || 0);

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
