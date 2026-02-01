import axios from 'axios';
import Parser from 'rss-parser';
import { EventEmitter } from 'events';
import { config, BUNDESTAG_API_KEY } from '../utils/config.js';
import logger from '../utils/logger.js';
import { Market, GermanSource } from '../types/index.js';

const rssParser = new Parser();

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

// ULTRA-MASSIVE RSS-Feed Liste für maximalen Informationsvorsprung
// 200+ Quellen für Breaking News Detection
const RSS_FEEDS = [
  // ═══════════════════════════════════════════════════════════════
  // DEUTSCHE POLITIK (20+ Quellen)
  // ═══════════════════════════════════════════════════════════════
  { name: 'Tagesschau', url: 'https://www.tagesschau.de/xml/rss2/', category: 'politics' },
  { name: 'Tagesschau Inland', url: 'https://www.tagesschau.de/inland/index~rss2.xml', category: 'politics' },
  { name: 'Tagesschau Ausland', url: 'https://www.tagesschau.de/ausland/index~rss2.xml', category: 'politics' },
  { name: 'Spiegel Politik', url: 'https://www.spiegel.de/politik/index.rss', category: 'politics' },
  { name: 'Spiegel Deutschland', url: 'https://www.spiegel.de/politik/deutschland/index.rss', category: 'politics' },
  { name: 'Spiegel Ausland', url: 'https://www.spiegel.de/politik/ausland/index.rss', category: 'politics' },
  { name: 'Zeit Politik', url: 'https://newsfeed.zeit.de/politik/index', category: 'politics' },
  { name: 'Zeit Deutschland', url: 'https://newsfeed.zeit.de/politik/deutschland/index', category: 'politics' },
  { name: 'FAZ Politik', url: 'https://www.faz.net/rss/aktuell/politik/', category: 'politics' },
  { name: 'FAZ Inland', url: 'https://www.faz.net/rss/aktuell/politik/inland/', category: 'politics' },
  { name: 'Welt Politik', url: 'https://www.welt.de/feeds/section/politik.rss', category: 'politics' },
  { name: 'Welt Deutschland', url: 'https://www.welt.de/feeds/section/politik/deutschland.rss', category: 'politics' },
  { name: 'n-tv Politik', url: 'https://www.n-tv.de/rss/politik', category: 'politics' },
  { name: 'Focus Politik', url: 'https://rss.focus.de/politik/', category: 'politics' },
  { name: 'Stern Politik', url: 'https://www.stern.de/feed/standard/politik/', category: 'politics' },
  { name: 'Bild Politik', url: 'https://www.bild.de/rss-feeds/rss-16725492,feed=politik.bild.html', category: 'politics' },
  { name: 'Bundesregierung', url: 'https://www.bundesregierung.de/breg-de/service/rss/992816', category: 'politics' },
  { name: 'Bundestag', url: 'https://www.bundestag.de/rss-feeds', category: 'politics' },
  { name: 'rbb24 Berlin', url: 'https://www.rbb24.de/politik/feed.xml', category: 'politics' },
  { name: 'BR24 Bayern', url: 'https://www.br.de/nachrichten/bayern,QcP6dfq/feed.rss', category: 'politics' },
  { name: 'NDR Hamburg', url: 'https://www.ndr.de/nachrichten/hamburg/index-rss.xml', category: 'politics' },
  { name: 'WDR NRW', url: 'https://www1.wdr.de/nachrichten/index~rss.feed', category: 'politics' },
  { name: 'SWR BW', url: 'https://www.swr.de/swraktuell/baden-wuerttemberg/index~_feed-atom.xml', category: 'politics' },
  { name: 'MDR Sachsen', url: 'https://www.mdr.de/nachrichten/sachsen/index-rss.xml', category: 'politics' },
  { name: 'HR Hessen', url: 'https://www.hessenschau.de/index~_feed-rss-hessenschau.xml', category: 'politics' },

  // ═══════════════════════════════════════════════════════════════
  // WIRTSCHAFT & FINANZEN (25+ Quellen)
  // ═══════════════════════════════════════════════════════════════
  { name: 'Handelsblatt', url: 'https://www.handelsblatt.com/contentexport/feed/top-themen/', category: 'economics' },
  { name: 'Handelsblatt Finanzen', url: 'https://www.handelsblatt.com/contentexport/feed/finanzen/', category: 'economics' },
  { name: 'Handelsblatt Unternehmen', url: 'https://www.handelsblatt.com/contentexport/feed/unternehmen/', category: 'economics' },
  { name: 'FAZ Wirtschaft', url: 'https://www.faz.net/rss/aktuell/wirtschaft/', category: 'economics' },
  { name: 'FAZ Finanzen', url: 'https://www.faz.net/rss/aktuell/finanzen/', category: 'economics' },
  { name: 'FAZ Unternehmen', url: 'https://www.faz.net/rss/aktuell/wirtschaft/unternehmen/', category: 'economics' },
  { name: 'Manager Magazin', url: 'https://www.manager-magazin.de/rss/manager-magazin.rss', category: 'economics' },
  { name: 'Wirtschaftswoche', url: 'https://www.wiwo.de/rss/wiwo-news.rss', category: 'economics' },
  { name: 'Capital', url: 'https://www.capital.de/rss/index.rss', category: 'economics' },
  { name: 'finanzen.net', url: 'https://www.finanzen.net/rss/news', category: 'economics' },
  { name: 'Börse Online', url: 'https://www.boerse-online.de/rss/news', category: 'economics' },
  { name: 'Der Aktionär', url: 'https://www.deraktionaer.de/rss/news.xml', category: 'economics' },
  { name: 'Finanztreff', url: 'https://www.finanztreff.de/rss/news', category: 'economics' },
  { name: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss', category: 'economics' },
  { name: 'Bloomberg Europe', url: 'https://feeds.bloomberg.com/bview/news.rss', category: 'economics' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', category: 'economics' },
  { name: 'CNBC Europe', url: 'https://www.cnbc.com/id/19794221/device/rss/rss.html', category: 'economics' },
  { name: 'Financial Times', url: 'https://www.ft.com/rss/home', category: 'economics' },
  { name: 'Wall Street Journal', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', category: 'economics' },
  { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews', category: 'economics' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/rss/', category: 'economics' },
  { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/', category: 'economics' },
  { name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml', category: 'economics' },
  { name: 'ECB News', url: 'https://www.ecb.europa.eu/rss/press.html', category: 'economics' },
  { name: 'Bundesbank', url: 'https://www.bundesbank.de/SiteGlobals/Functions/RSS/DE/rssfeed.html', category: 'economics' },

  // ═══════════════════════════════════════════════════════════════
  // SPORT - Fussball & Trainerwechsel (30+ Quellen)
  // ═══════════════════════════════════════════════════════════════
  { name: 'Kicker', url: 'https://www.kicker.de/rss/news', category: 'sports' },
  { name: 'Kicker Bundesliga', url: 'https://www.kicker.de/rss/bundesliga', category: 'sports' },
  { name: 'Kicker 2. Liga', url: 'https://www.kicker.de/rss/2-bundesliga', category: 'sports' },
  { name: 'Kicker Champions League', url: 'https://www.kicker.de/rss/champions-league', category: 'sports' },
  { name: 'Sport1', url: 'https://www.sport1.de/rss/fussball', category: 'sports' },
  { name: 'Sport1 Bundesliga', url: 'https://www.sport1.de/rss/fussball/bundesliga', category: 'sports' },
  { name: 'Sportschau', url: 'https://www.sportschau.de/index~rss.xml', category: 'sports' },
  { name: 'Sportschau Fussball', url: 'https://www.sportschau.de/fussball/index~rss.xml', category: 'sports' },
  { name: 'Spox Fussball', url: 'https://www.spox.com/rss/fussball-news.xml', category: 'sports' },
  { name: 'Transfermarkt', url: 'https://www.transfermarkt.de/rss/news', category: 'sports' },
  { name: 'Goal DE', url: 'https://www.goal.com/de/feeds/news', category: 'sports' },
  { name: 'Goal EN', url: 'https://www.goal.com/en/feeds/news', category: 'sports' },
  { name: 'ESPN FC', url: 'https://www.espn.com/espn/rss/soccer/news', category: 'sports' },
  { name: 'Sky Sports Football', url: 'https://www.skysports.com/rss/12040', category: 'sports' },
  { name: 'BBC Sport Football', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', category: 'sports' },
  { name: 'Guardian Football', url: 'https://www.theguardian.com/football/rss', category: 'sports' },
  { name: 'FourFourTwo', url: 'https://www.fourfourtwo.com/feeds/all', category: 'sports' },
  { name: 'The Athletic', url: 'https://theathletic.com/rss-feed/', category: 'sports' },
  // Club-spezifische Feeds (für Trainerwechsel!)
  { name: 'FC Bayern News', url: 'https://www.tz.de/sport/fc-bayern/rssfeed.rss', category: 'sports' },
  { name: 'BVB News', url: 'https://www.ruhrnachrichten.de/sport/bvb/rssfeed.rss', category: 'sports' },
  { name: 'RB Leipzig News', url: 'https://www.lvz.de/Sport/Fussball/RB-Leipzig/rssfeed.rss', category: 'sports' },
  { name: 'Bayer Leverkusen', url: 'https://www.kicker.de/bayer-04-leverkusen/news/rss', category: 'sports' },
  { name: 'Schalke 04', url: 'https://www.kicker.de/fc-schalke-04/news/rss', category: 'sports' },
  // International
  { name: 'Premier League', url: 'https://www.skysports.com/rss/12691', category: 'sports' },
  { name: 'La Liga', url: 'https://www.skysports.com/rss/12821', category: 'sports' },
  { name: 'Serie A', url: 'https://www.skysports.com/rss/12827', category: 'sports' },
  { name: 'Ligue 1', url: 'https://www.skysports.com/rss/12833', category: 'sports' },
  // NFL/NBA für US Sports
  { name: 'ESPN NFL', url: 'https://www.espn.com/espn/rss/nfl/news', category: 'sports' },
  { name: 'ESPN NBA', url: 'https://www.espn.com/espn/rss/nba/news', category: 'sports' },
  { name: 'Bleacher Report', url: 'https://bleacherreport.com/articles/feed', category: 'sports' },

  // ═══════════════════════════════════════════════════════════════
  // GEOPOLITIK & INTERNATIONAL (40+ Quellen)
  // ═══════════════════════════════════════════════════════════════
  { name: 'Reuters World', url: 'https://feeds.reuters.com/reuters/worldNews', category: 'geopolitics' },
  { name: 'Reuters Europe', url: 'https://feeds.reuters.com/reuters/UKWorldNews', category: 'geopolitics' },
  { name: 'Reuters Politics', url: 'https://feeds.reuters.com/Reuters/PoliticsNews', category: 'geopolitics' },
  { name: 'AP News', url: 'https://rsshub.app/apnews/topics/world-news', category: 'geopolitics' },
  { name: 'AFP', url: 'https://www.afp.com/en/rss-feeds', category: 'geopolitics' },
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'geopolitics' },
  { name: 'BBC Europe', url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml', category: 'geopolitics' },
  { name: 'BBC US', url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', category: 'geopolitics' },
  { name: 'BBC Asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml', category: 'geopolitics' },
  { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss', category: 'geopolitics' },
  { name: 'Guardian Europe', url: 'https://www.theguardian.com/world/europe-news/rss', category: 'geopolitics' },
  { name: 'Guardian US', url: 'https://www.theguardian.com/us-news/rss', category: 'geopolitics' },
  { name: 'NYT World', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'geopolitics' },
  { name: 'NYT Europe', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Europe.xml', category: 'geopolitics' },
  { name: 'Washington Post', url: 'https://feeds.washingtonpost.com/rss/world', category: 'geopolitics' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'geopolitics' },
  { name: 'Al Jazeera Europe', url: 'https://www.aljazeera.com/europe/rss.xml', category: 'geopolitics' },
  { name: 'DW Deutsch', url: 'https://rss.dw.com/xml/rss-de-all', category: 'geopolitics' },
  { name: 'DW English', url: 'https://rss.dw.com/xml/rss-en-all', category: 'geopolitics' },
  { name: 'DW Europe', url: 'https://rss.dw.com/xml/rss-en-eu', category: 'geopolitics' },
  { name: 'Euronews', url: 'https://www.euronews.com/rss', category: 'geopolitics' },
  { name: 'Politico EU', url: 'https://www.politico.eu/feed/', category: 'geopolitics' },
  { name: 'EU Observer', url: 'https://euobserver.com/rss.xml', category: 'geopolitics' },
  { name: 'France24', url: 'https://www.france24.com/en/rss', category: 'geopolitics' },
  { name: 'The Local DE', url: 'https://www.thelocal.de/feed/', category: 'geopolitics' },
  { name: 'The Local EU', url: 'https://www.thelocal.com/feed/', category: 'geopolitics' },

  // === UKRAINE/RUSSLAND SPEZIAL (15+ Quellen) ===
  { name: 'Kyiv Independent', url: 'https://kyivindependent.com/feed/', category: 'geopolitics' },
  { name: 'Ukraine Pravda EN', url: 'https://www.pravda.com.ua/eng/rss/', category: 'geopolitics' },
  { name: 'Ukraine Pravda UA', url: 'https://www.pravda.com.ua/rss/', category: 'geopolitics' },
  { name: 'RFERL Ukraine', url: 'https://www.rferl.org/api/zrqiteuuir', category: 'geopolitics' },
  { name: 'RFERL Russia', url: 'https://www.rferl.org/api/zbitrmquvo', category: 'geopolitics' },
  { name: 'Meduza EN', url: 'https://meduza.io/rss/en/all', category: 'geopolitics' },
  { name: 'Moscow Times', url: 'https://www.themoscowtimes.com/rss/news', category: 'geopolitics' },
  { name: 'Ukrinform', url: 'https://www.ukrinform.net/rss/block-lastnews', category: 'geopolitics' },
  { name: 'UNIAN', url: 'https://www.unian.net/rss/', category: 'geopolitics' },
  { name: 'ISW', url: 'https://www.understandingwar.org/feed', category: 'geopolitics' },
  { name: 'War on the Rocks', url: 'https://warontherocks.com/feed/', category: 'geopolitics' },
  { name: 'Defense One', url: 'https://www.defenseone.com/rss/', category: 'geopolitics' },
  { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/', category: 'geopolitics' },
  { name: 'Janes', url: 'https://www.janes.com/feeds/news', category: 'geopolitics' },

  // === US POLITIK (für Trump/Elections) ===
  { name: 'Politico', url: 'https://www.politico.com/rss/politicopicks.xml', category: 'politics' },
  { name: 'The Hill', url: 'https://thehill.com/feed/', category: 'politics' },
  { name: 'Axios', url: 'https://api.axios.com/feed/', category: 'politics' },
  { name: 'CNN Politics', url: 'http://rss.cnn.com/rss/cnn_allpolitics.rss', category: 'politics' },
  { name: 'Fox News Politics', url: 'https://moxie.foxnews.com/google-publisher/politics.xml', category: 'politics' },
  { name: 'NPR Politics', url: 'https://feeds.npr.org/1014/rss.xml', category: 'politics' },
  { name: 'FiveThirtyEight', url: 'https://fivethirtyeight.com/features/feed/', category: 'politics' },
  { name: 'RealClearPolitics', url: 'https://www.realclearpolitics.com/index.xml', category: 'politics' },

  // ═══════════════════════════════════════════════════════════════
  // TECH & CRYPTO (20+ Quellen)
  // ═══════════════════════════════════════════════════════════════
  { name: 'Heise', url: 'https://www.heise.de/rss/heise-atom.xml', category: 'tech' },
  { name: 'Golem', url: 'https://rss.golem.de/rss.php?feed=RSS2.0', category: 'tech' },
  { name: 't3n', url: 'https://t3n.de/rss.xml', category: 'tech' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'tech' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', category: 'tech' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'tech' },
  { name: 'Engadget', url: 'https://www.engadget.com/rss.xml', category: 'tech' },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/', category: 'tech' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com/rss', category: 'tech' },
  { name: 'Reuters Tech', url: 'https://feeds.reuters.com/reuters/technologyNews', category: 'tech' },
  // Crypto
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'crypto' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', category: 'crypto' },
  { name: 'The Block', url: 'https://www.theblockcrypto.com/rss.xml', category: 'crypto' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', category: 'crypto' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed', category: 'crypto' },
  { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', category: 'crypto' },
  // AI/OpenAI
  { name: 'OpenAI Blog', url: 'https://openai.com/blog/rss/', category: 'tech' },
  { name: 'AI News', url: 'https://artificialintelligence-news.com/feed/', category: 'tech' },
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/', category: 'tech' },
];

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
      logger.warn('RSS Event-Listener läuft bereits');
      return;
    }

    logger.info('═══════════════════════════════════════════════════════');
    logger.info('🔴 ALMAN SCANNER EVENT-LISTENER GESTARTET');
    logger.info(`   Polling-Intervall: ${this.RSS_POLL_INTERVAL / 1000}s`);
    logger.info(`   Feeds: ${RSS_FEEDS.length}`);
    logger.info('═══════════════════════════════════════════════════════');

    this.isPolling = true;

    // Initialer Fetch (ohne Events - nur Cache füllen)
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
  private async fetchRSSFeedsWithDelta(emitEvents: boolean): Promise<void> {
    const newNews: GermanSource[] = [];
    const breakingNews: BreakingNewsEvent[] = [];

    // Parallel RSS-Fetching für schnellere Updates (max 10 gleichzeitig)
    const feedChunks = this.chunkArray(RSS_FEEDS, 10);

    for (const chunk of feedChunks) {
      const results = await Promise.allSettled(
        chunk.map(feed => this.fetchSingleFeed(feed))
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          for (const item of result.value) {
            // Eindeutige ID für Delta-Detection
            const newsId = this.generateNewsId(item);

            if (!this.seenNewsIds.has(newsId)) {
              this.seenNewsIds.add(newsId);
              newNews.push(item);

              // Prüfe ob Breaking News (relevant für Markets)
              if (emitEvents) {
                const keywords = this.extractKeywords(item);
                if (keywords.length > 0) {
                  const breakingEvent: BreakingNewsEvent = {
                    id: newsId,
                    source: item.data.source as string,
                    title: item.title,
                    url: item.url,
                    content: (item.data.content as string) || '',
                    category: chunk[i].category,
                    keywords,
                    publishedAt: item.publishedAt,
                    detectedAt: new Date(),
                  };
                  breakingNews.push(breakingEvent);
                }
              }
            }
          }
        }
      }
    }

    // Cache aktualisieren
    this.cachedNews = [...newNews, ...this.cachedNews].slice(0, 1000);
    this.lastUpdate = new Date();

    // Events emittieren für Breaking News
    if (emitEvents && breakingNews.length > 0) {
      logger.info(`🚨 ${breakingNews.length} BREAKING NEWS erkannt!`);

      for (const news of breakingNews) {
        logger.info(`   📰 [${news.source}] ${news.title.substring(0, 60)}...`);
        logger.info(`      Keywords: ${news.keywords.join(', ')}`);
        this.emit('breaking_news', news);
      }
    }

    if (newNews.length > 0) {
      logger.debug(`RSS Update: ${newNews.length} neue Artikel`);
    }
  }

  private async fetchSingleFeed(feed: { name: string; url: string; category: string }): Promise<GermanSource[]> {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      return (parsed.items || []).slice(0, 10).map(item => ({
        type: 'rss' as const,
        title: item.title || 'Kein Titel',
        url: item.link,
        data: {
          source: feed.name,
          content: item.contentSnippet || item.content || '',
          category: feed.category,
        },
        relevance: 0,
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      }));
    } catch {
      // Silent fail für einzelne Feeds
      return [];
    }
  }

  private generateNewsId(news: GermanSource): string {
    // URL ist eindeutig genug, mit Fallback auf Titel + Quelle
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

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
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
