// ═══════════════════════════════════════════════════════════════
//                    RSS FEED MODULE
// Robuste, modulare RSS-Logik mit Health-Tracking
// ═══════════════════════════════════════════════════════════════

import Parser from 'rss-parser';
import { createHash } from 'crypto';
import logger from '../utils/logger.js';
import { GermanSource } from '../types/index.js';

const rssParser = new Parser({
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; PolymarketScanner/1.0)',
  },
});

// ═══════════════════════════════════════════════════════════════
// FEED DEFINITIONS
// ═══════════════════════════════════════════════════════════════

export interface RSSFeed {
  url: string;
  name: string;
  category: 'politics' | 'economics' | 'sports' | 'geopolitics' | 'tech';
}

// ═══════════════════════════════════════════════════════════════
// DEUTSCHE FEEDS - NUR ECHTE DEUTSCHE QUELLEN!
// Diese werden im "Deutsche News" Bereich angezeigt
// ═══════════════════════════════════════════════════════════════
export const WORKING_RSS_FEEDS: RSSFeed[] = [
  // ═══════════════════════════════════════════════════════════════
  // DEUTSCHE POLITIK (12 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.tagesschau.de/xml/rss2/', name: 'Tagesschau', category: 'politics' },
  { url: 'https://www.tagesschau.de/inland/index~rss2.xml', name: 'Tagesschau Inland', category: 'politics' },
  { url: 'https://www.spiegel.de/politik/index.rss', name: 'Spiegel Politik', category: 'politics' },
  { url: 'https://www.spiegel.de/politik/deutschland/index.rss', name: 'Spiegel Deutschland', category: 'politics' },
  { url: 'https://newsfeed.zeit.de/politik/index', name: 'Zeit Politik', category: 'politics' },
  { url: 'https://www.faz.net/rss/aktuell/politik/', name: 'FAZ Politik', category: 'politics' },
  { url: 'https://www.welt.de/feeds/section/politik.rss', name: 'Welt Politik', category: 'politics' },
  { url: 'https://www.n-tv.de/rss', name: 'n-tv', category: 'politics' },
  { url: 'https://rss.dw.com/xml/rss-de-all', name: 'DW Deutsch', category: 'politics' },
  { url: 'https://www.bundesregierung.de/breg-de/service/rss/992816', name: 'Bundesregierung', category: 'politics' },
  { url: 'https://www.zeit.de/news/index', name: 'Zeit News', category: 'politics' },
  { url: 'https://www.welt.de/feeds/latest.rss', name: 'Welt Aktuell', category: 'politics' },

  // ═══════════════════════════════════════════════════════════════
  // DEUTSCHE WIRTSCHAFT & FINANZEN (8 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.handelsblatt.com/contentexport/feed/top-themen/', name: 'Handelsblatt', category: 'economics' },
  { url: 'https://www.faz.net/rss/aktuell/wirtschaft/', name: 'FAZ Wirtschaft', category: 'economics' },
  { url: 'https://www.faz.net/rss/aktuell/finanzen/', name: 'FAZ Finanzen', category: 'economics' },
  { url: 'https://www.manager-magazin.de/rss/manager-magazin.rss', name: 'Manager Magazin', category: 'economics' },
  { url: 'https://www.wiwo.de/rss/wiwo-news.rss', name: 'Wirtschaftswoche', category: 'economics' },
  { url: 'https://www.capital.de/rss/index.rss', name: 'Capital', category: 'economics' },
  { url: 'https://www.spiegel.de/wirtschaft/index.rss', name: 'Spiegel Wirtschaft', category: 'economics' },
  { url: 'https://www.welt.de/feeds/section/wirtschaft.rss', name: 'Welt Wirtschaft', category: 'economics' },

  // ═══════════════════════════════════════════════════════════════
  // DEUTSCHER SPORT (6 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.kicker.de/rss/news', name: 'Kicker', category: 'sports' },
  { url: 'https://www.sportschau.de/index~rss.xml', name: 'Sportschau', category: 'sports' },
  { url: 'https://www.sport1.de/rss/fussball', name: 'Sport1', category: 'sports' },
  { url: 'https://www.spox.com/rss/fussball-news.xml', name: 'Spox', category: 'sports' },
  { url: 'https://www.kicker.de/rss/bundesliga', name: 'Kicker Bundesliga', category: 'sports' },
  { url: 'https://www.transfermarkt.de/rss/news', name: 'Transfermarkt', category: 'sports' },

  // ═══════════════════════════════════════════════════════════════
  // DEUTSCHE TECH (4 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.heise.de/rss/heise-atom.xml', name: 'Heise', category: 'tech' },
  { url: 'https://rss.golem.de/rss.php?feed=RSS2.0', name: 'Golem', category: 'tech' },
  { url: 'https://t3n.de/rss.xml', name: 't3n', category: 'tech' },
  { url: 'https://www.chip.de/rss/rss_topnews.xml', name: 'Chip', category: 'tech' },

  // ═══════════════════════════════════════════════════════════════
  // DEUTSCHE AUSLANDSNACHRICHTEN / GEOPOLITIK (4 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.tagesschau.de/ausland/index~rss2.xml', name: 'Tagesschau Ausland', category: 'geopolitics' },
  { url: 'https://www.spiegel.de/ausland/index.rss', name: 'Spiegel Ausland', category: 'geopolitics' },
  { url: 'https://www.faz.net/rss/aktuell/politik/ausland/', name: 'FAZ Ausland', category: 'geopolitics' },
  { url: 'https://www.zeit.de/politik/ausland/index', name: 'Zeit Ausland', category: 'geopolitics' },
];

// ═══════════════════════════════════════════════════════════════
// INTERNATIONALE/EUROPÄISCHE FEEDS - Für EUSSR-Tracker Matching
// Werden NICHT im "Deutsche News" Bereich angezeigt!
// ═══════════════════════════════════════════════════════════════
export const INTERNATIONAL_RSS_FEEDS: RSSFeed[] = [
  // ═══════════════════════════════════════════════════════════════
  // UK POLITIK & NEWS
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://feeds.bbci.co.uk/news/uk/politics/rss.xml', name: 'BBC UK Politics', category: 'politics' },
  { url: 'https://www.theguardian.com/politics/rss', name: 'Guardian Politics', category: 'politics' },
  { url: 'https://www.telegraph.co.uk/politics/rss.xml', name: 'Telegraph Politics', category: 'politics' },
  { url: 'https://www.independent.co.uk/news/uk/politics/rss', name: 'Independent Politics', category: 'politics' },

  // ═══════════════════════════════════════════════════════════════
  // FRANKREICH
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.france24.com/en/rss', name: 'France24 EN', category: 'geopolitics' },
  { url: 'https://www.rfi.fr/en/rss', name: 'RFI English', category: 'geopolitics' },
  { url: 'https://www.lemonde.fr/en/rss/une.xml', name: 'Le Monde EN', category: 'politics' },

  // ═══════════════════════════════════════════════════════════════
  // ITALIEN
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.ansa.it/sito/notizie/politica/politica_rss.xml', name: 'ANSA Politics', category: 'politics' },
  { url: 'https://www.reuters.com/news/archive/italyNews?view=rss', name: 'Reuters Italy', category: 'geopolitics' },

  // ═══════════════════════════════════════════════════════════════
  // SPANIEN
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/english.elpais.com/portada', name: 'El Pais EN', category: 'politics' },

  // ═══════════════════════════════════════════════════════════════
  // WIRTSCHAFT INTERNATIONAL
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://feeds.reuters.com/reuters/businessNews', name: 'Reuters Business', category: 'economics' },
  { url: 'https://feeds.bloomberg.com/markets/news.rss', name: 'Bloomberg', category: 'economics' },
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', name: 'MarketWatch', category: 'economics' },
  { url: 'https://www.ecb.europa.eu/rss/press.html', name: 'ECB News', category: 'economics' },
  { url: 'https://www.ft.com/rss/home/uk', name: 'Financial Times', category: 'economics' },

  // ═══════════════════════════════════════════════════════════════
  // EUROPÄISCHER FUSSBALL
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', name: 'BBC Sport Football', category: 'sports' },
  { url: 'https://www.theguardian.com/football/rss', name: 'Guardian Football', category: 'sports' },
  { url: 'https://www.skysports.com/rss/12040', name: 'Sky Sports Football', category: 'sports' },
  { url: 'https://www.espn.com/espn/rss/soccer/news', name: 'ESPN FC', category: 'sports' },
  { url: 'https://www.marca.com/en/rss/football.xml', name: 'Marca Football', category: 'sports' },
  { url: 'https://www.gazzetta.it/rss/calcio.xml', name: 'Gazzetta Calcio', category: 'sports' },
  { url: 'https://www.lequipe.fr/rss/actu_rss.xml', name: 'L Equipe', category: 'sports' },

  // ═══════════════════════════════════════════════════════════════
  // GEOPOLITIK INTERNATIONAL
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://feeds.reuters.com/reuters/worldNews', name: 'Reuters World', category: 'geopolitics' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World', category: 'geopolitics' },
  { url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml', name: 'BBC Europe', category: 'geopolitics' },
  { url: 'https://www.theguardian.com/world/rss', name: 'Guardian World', category: 'geopolitics' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'NYT World', category: 'geopolitics' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera', category: 'geopolitics' },
  { url: 'https://rss.dw.com/xml/rss-en-all', name: 'DW English', category: 'geopolitics' },
  { url: 'https://www.politico.eu/feed/', name: 'Politico EU', category: 'geopolitics' },
  { url: 'https://kyivindependent.com/feed/', name: 'Kyiv Independent', category: 'geopolitics' },
  { url: 'https://meduza.io/rss/en/all', name: 'Meduza EN', category: 'geopolitics' },
  { url: 'https://www.euronews.com/rss', name: 'Euronews', category: 'geopolitics' },

  // ═══════════════════════════════════════════════════════════════
  // TECH INTERNATIONAL (kein Crypto)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://techcrunch.com/feed/', name: 'TechCrunch', category: 'tech' },
];

// Experimentelle Feeds - weniger zuverlässig, optional aktivierbar
export const EXPERIMENTAL_RSS_FEEDS: RSSFeed[] = [
  // ═══════════════════════════════════════════════════════════════
  // DEUTSCHE POLITIK - ERWEITERT (15 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.tagesschau.de/ausland/index~rss2.xml', name: 'Tagesschau Ausland', category: 'politics' },
  { url: 'https://www.spiegel.de/politik/ausland/index.rss', name: 'Spiegel Ausland', category: 'politics' },
  { url: 'https://newsfeed.zeit.de/politik/deutschland/index', name: 'Zeit Deutschland', category: 'politics' },
  { url: 'https://www.faz.net/rss/aktuell/politik/inland/', name: 'FAZ Inland', category: 'politics' },
  { url: 'https://www.welt.de/feeds/section/politik/deutschland.rss', name: 'Welt Deutschland', category: 'politics' },
  { url: 'https://rss.focus.de/politik/', name: 'Focus Politik', category: 'politics' },
  { url: 'https://www.stern.de/feed/standard/politik/', name: 'Stern Politik', category: 'politics' },
  { url: 'https://www.bild.de/rss-feeds/rss-16725492,feed=politik.bild.html', name: 'Bild Politik', category: 'politics' },
  { url: 'https://www.bundestag.de/rss-feeds', name: 'Bundestag', category: 'politics' },
  { url: 'https://www.rbb24.de/politik/feed.xml', name: 'rbb24 Berlin', category: 'politics' },
  { url: 'https://www.br.de/nachrichten/bayern,QcP6dfq/feed.rss', name: 'BR24 Bayern', category: 'politics' },
  { url: 'https://www.ndr.de/nachrichten/hamburg/index-rss.xml', name: 'NDR Hamburg', category: 'politics' },
  { url: 'https://www1.wdr.de/nachrichten/index~rss.feed', name: 'WDR NRW', category: 'politics' },
  { url: 'https://www.swr.de/swraktuell/baden-wuerttemberg/index~_feed-atom.xml', name: 'SWR BW', category: 'politics' },
  { url: 'https://www.mdr.de/nachrichten/sachsen/index-rss.xml', name: 'MDR Sachsen', category: 'politics' },
  { url: 'https://www.hessenschau.de/index~_feed-rss-hessenschau.xml', name: 'HR Hessen', category: 'politics' },

  // ═══════════════════════════════════════════════════════════════
  // WIRTSCHAFT & FINANZEN - ERWEITERT (16 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.handelsblatt.com/contentexport/feed/finanzen/', name: 'Handelsblatt Finanzen', category: 'economics' },
  { url: 'https://www.handelsblatt.com/contentexport/feed/unternehmen/', name: 'Handelsblatt Unternehmen', category: 'economics' },
  { url: 'https://www.faz.net/rss/aktuell/wirtschaft/unternehmen/', name: 'FAZ Unternehmen', category: 'economics' },
  { url: 'https://www.wiwo.de/rss/wiwo-news.rss', name: 'Wirtschaftswoche', category: 'economics' },
  { url: 'https://www.capital.de/rss/index.rss', name: 'Capital', category: 'economics' },
  { url: 'https://www.finanzen.net/rss/news', name: 'finanzen.net', category: 'economics' },
  { url: 'https://www.boerse-online.de/rss/news', name: 'Börse Online', category: 'economics' },
  { url: 'https://www.deraktionaer.de/rss/news.xml', name: 'Der Aktionär', category: 'economics' },
  { url: 'https://www.finanztreff.de/rss/news', name: 'Finanztreff', category: 'economics' },
  { url: 'https://feeds.bloomberg.com/bview/news.rss', name: 'Bloomberg Europe', category: 'economics' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', name: 'CNBC', category: 'economics' },
  { url: 'https://www.cnbc.com/id/19794221/device/rss/rss.html', name: 'CNBC Europe', category: 'economics' },
  { url: 'https://www.ft.com/rss/home', name: 'Financial Times', category: 'economics' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', name: 'Wall Street Journal', category: 'economics' },
  { url: 'https://finance.yahoo.com/rss/', name: 'Yahoo Finance', category: 'economics' },
  { url: 'https://seekingalpha.com/market_currents.xml', name: 'Seeking Alpha', category: 'economics' },
  { url: 'https://www.bundesbank.de/SiteGlobals/Functions/RSS/DE/rssfeed.html', name: 'Bundesbank', category: 'economics' },

  // ═══════════════════════════════════════════════════════════════
  // SPORT - MASSIVE ERWEITERUNG (30 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.kicker.de/rss/bundesliga', name: 'Kicker Bundesliga', category: 'sports' },
  { url: 'https://www.kicker.de/rss/2-bundesliga', name: 'Kicker 2. Liga', category: 'sports' },
  { url: 'https://www.kicker.de/rss/champions-league', name: 'Kicker Champions League', category: 'sports' },
  { url: 'https://www.sport1.de/rss/fussball', name: 'Sport1', category: 'sports' },
  { url: 'https://www.sport1.de/rss/fussball/bundesliga', name: 'Sport1 Bundesliga', category: 'sports' },
  { url: 'https://www.sportschau.de/fussball/index~rss.xml', name: 'Sportschau Fussball', category: 'sports' },
  { url: 'https://www.spox.com/rss/fussball-news.xml', name: 'Spox Fussball', category: 'sports' },
  { url: 'https://www.transfermarkt.de/rss/news', name: 'Transfermarkt', category: 'sports' },
  { url: 'https://www.goal.com/de/feeds/news', name: 'Goal DE', category: 'sports' },
  { url: 'https://www.goal.com/en/feeds/news', name: 'Goal EN', category: 'sports' },
  { url: 'https://www.fourfourtwo.com/feeds/all', name: 'FourFourTwo', category: 'sports' },
  { url: 'https://theathletic.com/rss-feed/', name: 'The Athletic', category: 'sports' },
  { url: 'https://www.tz.de/sport/fc-bayern/rssfeed.rss', name: 'FC Bayern News', category: 'sports' },
  { url: 'https://www.ruhrnachrichten.de/sport/bvb/rssfeed.rss', name: 'BVB News', category: 'sports' },
  { url: 'https://www.lvz.de/Sport/Fussball/RB-Leipzig/rssfeed.rss', name: 'RB Leipzig News', category: 'sports' },
  { url: 'https://www.kicker.de/bayer-04-leverkusen/news/rss', name: 'Bayer Leverkusen', category: 'sports' },
  { url: 'https://www.kicker.de/fc-schalke-04/news/rss', name: 'Schalke 04', category: 'sports' },
  { url: 'https://www.skysports.com/rss/12691', name: 'Premier League', category: 'sports' },
  { url: 'https://www.skysports.com/rss/12821', name: 'La Liga', category: 'sports' },
  { url: 'https://www.skysports.com/rss/12827', name: 'Serie A', category: 'sports' },
  { url: 'https://www.skysports.com/rss/12833', name: 'Ligue 1', category: 'sports' },
  { url: 'https://www.espn.com/espn/rss/nfl/news', name: 'ESPN NFL', category: 'sports' },
  { url: 'https://www.espn.com/espn/rss/nba/news', name: 'ESPN NBA', category: 'sports' },
  { url: 'https://bleacherreport.com/articles/feed', name: 'Bleacher Report', category: 'sports' },

  // ═══════════════════════════════════════════════════════════════
  // GEOPOLITIK - MASSIVE ERWEITERUNG (35 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://feeds.reuters.com/reuters/UKWorldNews', name: 'Reuters Europe', category: 'geopolitics' },
  { url: 'https://feeds.reuters.com/Reuters/PoliticsNews', name: 'Reuters Politics', category: 'geopolitics' },
  { url: 'https://rsshub.app/apnews/topics/world-news', name: 'AP News', category: 'geopolitics' },
  { url: 'https://www.afp.com/en/rss-feeds', name: 'AFP', category: 'geopolitics' },
  { url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', name: 'BBC US', category: 'geopolitics' },
  { url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml', name: 'BBC Asia', category: 'geopolitics' },
  { url: 'https://www.theguardian.com/world/europe-news/rss', name: 'Guardian Europe', category: 'geopolitics' },
  { url: 'https://www.theguardian.com/us-news/rss', name: 'Guardian US', category: 'geopolitics' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Europe.xml', name: 'NYT Europe', category: 'geopolitics' },
  { url: 'https://feeds.washingtonpost.com/rss/world', name: 'Washington Post', category: 'geopolitics' },
  { url: 'https://www.aljazeera.com/europe/rss.xml', name: 'Al Jazeera Europe', category: 'geopolitics' },
  { url: 'https://rss.dw.com/xml/rss-en-eu', name: 'DW Europe', category: 'geopolitics' },
  { url: 'https://www.euronews.com/rss', name: 'Euronews', category: 'geopolitics' },
  { url: 'https://euobserver.com/rss.xml', name: 'EU Observer', category: 'geopolitics' },
  { url: 'https://www.france24.com/en/rss', name: 'France24', category: 'geopolitics' },
  { url: 'https://www.thelocal.de/feed/', name: 'The Local DE', category: 'geopolitics' },
  { url: 'https://www.thelocal.com/feed/', name: 'The Local EU', category: 'geopolitics' },
  { url: 'https://www.pravda.com.ua/eng/rss/', name: 'Ukraine Pravda EN', category: 'geopolitics' },
  { url: 'https://www.pravda.com.ua/rss/', name: 'Ukraine Pravda UA', category: 'geopolitics' },
  { url: 'https://www.rferl.org/api/zrqiteuuir', name: 'RFERL Ukraine', category: 'geopolitics' },
  { url: 'https://www.rferl.org/api/zbitrmquvo', name: 'RFERL Russia', category: 'geopolitics' },
  { url: 'https://www.themoscowtimes.com/rss/news', name: 'Moscow Times', category: 'geopolitics' },
  { url: 'https://www.ukrinform.net/rss/block-lastnews', name: 'Ukrinform', category: 'geopolitics' },
  { url: 'https://www.unian.net/rss/', name: 'UNIAN', category: 'geopolitics' },
  { url: 'https://www.understandingwar.org/feed', name: 'ISW', category: 'geopolitics' },
  { url: 'https://warontherocks.com/feed/', name: 'War on the Rocks', category: 'geopolitics' },
  { url: 'https://www.defenseone.com/rss/', name: 'Defense One', category: 'geopolitics' },
  { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/', name: 'Defense News', category: 'geopolitics' },
  { url: 'https://www.janes.com/feeds/news', name: 'Janes', category: 'geopolitics' },

  // ═══════════════════════════════════════════════════════════════
  // US POLITIK (10 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://www.politico.com/rss/politicopicks.xml', name: 'Politico', category: 'politics' },
  { url: 'https://thehill.com/feed/', name: 'The Hill', category: 'politics' },
  { url: 'https://api.axios.com/feed/', name: 'Axios', category: 'politics' },
  { url: 'http://rss.cnn.com/rss/cnn_allpolitics.rss', name: 'CNN Politics', category: 'politics' },
  { url: 'https://moxie.foxnews.com/google-publisher/politics.xml', name: 'Fox News Politics', category: 'politics' },
  { url: 'https://feeds.npr.org/1014/rss.xml', name: 'NPR Politics', category: 'politics' },
  { url: 'https://fivethirtyeight.com/features/feed/', name: 'FiveThirtyEight', category: 'politics' },
  { url: 'https://www.realclearpolitics.com/index.xml', name: 'RealClearPolitics', category: 'politics' },

  // ═══════════════════════════════════════════════════════════════
  // TECH - ERWEITERT (12 Quellen)
  // ═══════════════════════════════════════════════════════════════
  { url: 'https://t3n.de/rss.xml', name: 't3n', category: 'tech' },
  { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge', category: 'tech' },
  { url: 'https://www.wired.com/feed/rss', name: 'Wired', category: 'tech' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica', category: 'tech' },
  { url: 'https://www.engadget.com/rss.xml', name: 'Engadget', category: 'tech' },
  { url: 'https://www.technologyreview.com/feed/', name: 'MIT Tech Review', category: 'tech' },
  { url: 'https://news.ycombinator.com/rss', name: 'Hacker News', category: 'tech' },
  { url: 'https://feeds.reuters.com/reuters/technologyNews', name: 'Reuters Tech', category: 'tech' },
  { url: 'https://openai.com/blog/rss/', name: 'OpenAI Blog', category: 'tech' },
  { url: 'https://artificialintelligence-news.com/feed/', name: 'AI News', category: 'tech' },
  { url: 'https://venturebeat.com/category/ai/feed/', name: 'VentureBeat AI', category: 'tech' },
];

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface NewsItem {
  hash: string;
  source: string;
  title: string;
  url?: string;
  content: string;
  category: string;
  publishedAt: Date;
  fetchedAt: Date;
}

export interface RSSFetchResult {
  feed: string;
  feedUrl: string;
  items: NewsItem[];
  success: boolean;
  error?: string;
  fetchTimeMs: number;
}

export interface FeedHealth {
  name: string;
  url: string;
  lastFetch: Date | null;
  lastItemCount: number;
  status: 'ok' | 'error' | 'timeout' | 'unknown';
  errorMessage?: string;
  avgFetchTimeMs: number;
  successRate: number;
  totalFetches: number;
}

export interface BatchFetchResult {
  items: NewsItem[];
  health: FeedHealth[];
  totalFeeds: number;
  successfulFeeds: number;
  failedFeeds: number;
  totalItems: number;
  uniqueItems: number;
  fetchDurationMs: number;
}

// ═══════════════════════════════════════════════════════════════
// HEALTH TRACKING (In-Memory)
// ═══════════════════════════════════════════════════════════════

const feedHealthMap = new Map<string, {
  lastFetch: Date | null;
  lastItemCount: number;
  status: 'ok' | 'error' | 'timeout' | 'unknown';
  errorMessage?: string;
  fetchTimes: number[];
  successes: number;
  failures: number;
}>();

function initFeedHealth(url: string): void {
  if (!feedHealthMap.has(url)) {
    feedHealthMap.set(url, {
      lastFetch: null,
      lastItemCount: 0,
      status: 'unknown',
      fetchTimes: [],
      successes: 0,
      failures: 0,
    });
  }
}

function updateFeedHealth(
  url: string,
  success: boolean,
  itemCount: number,
  fetchTimeMs: number,
  error?: string
): void {
  initFeedHealth(url);
  const health = feedHealthMap.get(url)!;

  health.lastFetch = new Date();
  health.lastItemCount = itemCount;
  health.status = success ? 'ok' : (error?.includes('timeout') ? 'timeout' : 'error');
  health.errorMessage = error;

  // Rolling average (letzte 10 Fetches)
  health.fetchTimes.push(fetchTimeMs);
  if (health.fetchTimes.length > 10) {
    health.fetchTimes.shift();
  }

  if (success) {
    health.successes++;
  } else {
    health.failures++;
  }
}

// ═══════════════════════════════════════════════════════════════
// HASH FUNCTION (SHA256)
// ═══════════════════════════════════════════════════════════════

export function computeNewsHash(item: { source: string; url?: string; title: string }): string {
  const content = `${item.source}|${item.url || ''}|${item.title}`;
  return createHash('sha256').update(content).digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// SINGLE FEED FETCH
// ═══════════════════════════════════════════════════════════════

export async function fetchRSSFeed(
  feedUrl: string,
  feedName: string,
  category: string,
  timeout: number = 8000
): Promise<RSSFetchResult> {
  const startTime = Date.now();

  try {
    // Timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const parsed = await rssParser.parseURL(feedUrl);
    clearTimeout(timeoutId);

    const fetchTimeMs = Date.now() - startTime;

    const items: NewsItem[] = (parsed.items || []).slice(0, 15).map(item => {
      const newsItem: NewsItem = {
        hash: '', // wird unten gesetzt
        source: feedName,
        title: item.title || 'Kein Titel',
        url: item.link,
        content: item.contentSnippet || item.content || '',
        category,
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        fetchedAt: new Date(),
      };
      newsItem.hash = computeNewsHash(newsItem);
      return newsItem;
    });

    updateFeedHealth(feedUrl, true, items.length, fetchTimeMs);

    return {
      feed: feedName,
      feedUrl,
      items,
      success: true,
      fetchTimeMs,
    };
  } catch (err) {
    const fetchTimeMs = Date.now() - startTime;
    const error = err as Error;
    const errorMessage = error.name === 'AbortError'
      ? `timeout after ${timeout}ms`
      : error.message;

    updateFeedHealth(feedUrl, false, 0, fetchTimeMs, errorMessage);

    return {
      feed: feedName,
      feedUrl,
      items: [],
      success: false,
      error: errorMessage,
      fetchTimeMs,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// BATCH FETCH MIT PROMISE.ALLSETTLED
// ═══════════════════════════════════════════════════════════════

export interface FetchAllOptions {
  includeExperimental?: boolean;
  includeInternational?: boolean;  // NEU: Internationale Feeds einbeziehen
  germanOnly?: boolean;            // NEU: NUR deutsche Feeds (für "Deutsche News")
  maxConcurrent?: number;
  timeout?: number;
  categories?: string[];
}

export async function fetchAllRSSFeeds(options: FetchAllOptions = {}): Promise<BatchFetchResult> {
  const {
    includeExperimental = false,
    includeInternational = false,
    germanOnly = false,
    maxConcurrent = 10,
    timeout = 8000,
    categories,
  } = options;

  const startTime = Date.now();

  // Feeds zusammenstellen
  let feeds: RSSFeed[] = [];

  if (germanOnly) {
    // NUR deutsche Quellen - für "Deutsche News" Bereich
    feeds = [...WORKING_RSS_FEEDS];
  } else {
    // Standard: Deutsche + optionale Erweiterungen
    feeds = [...WORKING_RSS_FEEDS];
    if (includeInternational) {
      feeds = [...feeds, ...INTERNATIONAL_RSS_FEEDS];
    }
    if (includeExperimental) {
      feeds = [...feeds, ...EXPERIMENTAL_RSS_FEEDS];
    }
  }

  // Optional: Nach Kategorie filtern
  if (categories && categories.length > 0) {
    feeds = feeds.filter(f => categories.includes(f.category));
  }

  logger.debug(`RSS Batch-Fetch: ${feeds.length} Feeds (experimental: ${includeExperimental})`);

  // In Chunks aufteilen für kontrollierte Parallelität
  const chunks: RSSFeed[][] = [];
  for (let i = 0; i < feeds.length; i += maxConcurrent) {
    chunks.push(feeds.slice(i, i + maxConcurrent));
  }

  const allResults: RSSFetchResult[] = [];

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(feed => fetchRSSFeed(feed.url, feed.name, feed.category, timeout))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allResults.push(result.value);
      }
    }
  }

  // Dedupe via Hash
  const seenHashes = new Set<string>();
  const uniqueItems: NewsItem[] = [];

  for (const result of allResults) {
    for (const item of result.items) {
      if (!seenHashes.has(item.hash)) {
        seenHashes.add(item.hash);
        uniqueItems.push(item);
      }
    }
  }

  // Nach Datum sortieren (neueste zuerst)
  uniqueItems.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  const fetchDurationMs = Date.now() - startTime;
  const successfulFeeds = allResults.filter(r => r.success).length;
  const failedFeeds = allResults.filter(r => !r.success).length;
  const totalItems = allResults.reduce((sum, r) => sum + r.items.length, 0);

  logger.info(
    `RSS Fetch abgeschlossen: ${successfulFeeds}/${feeds.length} Feeds OK, ` +
    `${uniqueItems.length} unique Items (${totalItems} total), ${fetchDurationMs}ms`
  );

  return {
    items: uniqueItems,
    health: getFeedHealth(),
    totalFeeds: feeds.length,
    successfulFeeds,
    failedFeeds,
    totalItems,
    uniqueItems: uniqueItems.length,
    fetchDurationMs,
  };
}

// ═══════════════════════════════════════════════════════════════
// HEALTH REPORTING
// ═══════════════════════════════════════════════════════════════

export function getFeedHealth(): FeedHealth[] {
  const allFeeds = [...WORKING_RSS_FEEDS, ...INTERNATIONAL_RSS_FEEDS, ...EXPERIMENTAL_RSS_FEEDS];

  return allFeeds.map(feed => {
    const health = feedHealthMap.get(feed.url);

    if (!health) {
      return {
        name: feed.name,
        url: feed.url,
        lastFetch: null,
        lastItemCount: 0,
        status: 'unknown' as const,
        avgFetchTimeMs: 0,
        successRate: 0,
        totalFetches: 0,
      };
    }

    const totalFetches = health.successes + health.failures;
    const avgFetchTimeMs = health.fetchTimes.length > 0
      ? Math.round(health.fetchTimes.reduce((a, b) => a + b, 0) / health.fetchTimes.length)
      : 0;

    return {
      name: feed.name,
      url: feed.url,
      lastFetch: health.lastFetch,
      lastItemCount: health.lastItemCount,
      status: health.status,
      errorMessage: health.errorMessage,
      avgFetchTimeMs,
      successRate: totalFetches > 0 ? Math.round((health.successes / totalFetches) * 100) : 0,
      totalFetches,
    };
  });
}

export function getHealthSummary(): {
  total: number;
  ok: number;
  error: number;
  timeout: number;
  unknown: number;
  avgSuccessRate: number;
} {
  const health = getFeedHealth();
  const known = health.filter(h => h.totalFetches > 0);

  return {
    total: health.length,
    ok: health.filter(h => h.status === 'ok').length,
    error: health.filter(h => h.status === 'error').length,
    timeout: health.filter(h => h.status === 'timeout').length,
    unknown: health.filter(h => h.status === 'unknown').length,
    avgSuccessRate: known.length > 0
      ? Math.round(known.reduce((sum, h) => sum + h.successRate, 0) / known.length)
      : 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// CONVERSION TO GERMAN SOURCE FORMAT
// ═══════════════════════════════════════════════════════════════

export function newsItemToGermanSource(item: NewsItem): GermanSource {
  return {
    type: 'rss',
    title: item.title,
    url: item.url,
    data: {
      source: item.source,
      content: item.content,
      category: item.category,
      hash: item.hash,
    },
    relevance: 0,
    publishedAt: item.publishedAt,
  };
}

export function newsItemsToGermanSources(items: NewsItem[]): GermanSource[] {
  return items.map(newsItemToGermanSource);
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export default {
  WORKING_RSS_FEEDS,
  INTERNATIONAL_RSS_FEEDS,
  EXPERIMENTAL_RSS_FEEDS,
  fetchRSSFeed,
  fetchAllRSSFeeds,
  computeNewsHash,
  getFeedHealth,
  getHealthSummary,
  newsItemToGermanSource,
  newsItemsToGermanSources,
};
