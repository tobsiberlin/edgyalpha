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
import { getDatabase, initDatabase, isDatabaseInitialized } from '../storage/db.js';
import { runtimeState } from '../runtime/state.js';

// ═══════════════════════════════════════════════════════════════
// PERSISTENT SEEN NEWS HASHES (verhindert Push-Storm nach Restart)
// ═══════════════════════════════════════════════════════════════

function ensureDatabase(): ReturnType<typeof getDatabase> {
  if (!isDatabaseInitialized()) {
    initDatabase();
  }
  return getDatabase();
}

function loadSeenHashes(): Set<string> {
  try {
    const db = ensureDatabase();
    const rows = db.prepare('SELECT hash FROM seen_news_hashes').all() as Array<{hash: string}>;
    logger.info(`[SEEN_HASHES] ${rows.length} Hashes aus DB geladen`);
    return new Set(rows.map(r => r.hash));
  } catch (err) {
    logger.warn(`[SEEN_HASHES] DB nicht verfügbar, nutze leeres Set: ${(err as Error).message}`);
    return new Set();
  }
}

function saveSeenHash(hash: string, source: string, title: string): void {
  try {
    const db = ensureDatabase();
    db.prepare(`
      INSERT OR IGNORE INTO seen_news_hashes (hash, source, title)
      VALUES (?, ?, ?)
    `).run(hash, source, title.substring(0, 200));
  } catch (err) {
    logger.debug(`[SEEN_HASHES] Konnte Hash nicht speichern: ${(err as Error).message}`);
  }
}

function cleanupOldHashes(maxAgeDays = 7): void {
  try {
    const db = ensureDatabase();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const result = db.prepare(`
      DELETE FROM seen_news_hashes
      WHERE seen_at < ?
    `).run(cutoff.toISOString());
    if (result.changes > 0) {
      logger.info(`[SEEN_HASHES] ${result.changes} alte Hashes gelöscht`);
    }
  } catch (err) {
    logger.debug(`[SEEN_HASHES] Cleanup Fehler: ${(err as Error).message}`);
  }
}

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
  timeAdvantageSeconds?: number;  // Zeitvorsprung in Sekunden
}

// RSS Feeds sind jetzt in ./rss.ts definiert (WORKING_RSS_FEEDS + EXPERIMENTAL_RSS_FEEDS)
// Import: WORKING_RSS_FEEDS aus ./rss.js

// ═══════════════════════════════════════════════════════════════
// MEGA-KEYWORDS FÜR MARKT-MATCHING
// Massiv erweitert für maximale Alpha-Erkennung
// ═══════════════════════════════════════════════════════════════
const GERMANY_KEYWORDS = {
  politics: [
    // ═══════════════════════════════════════════════════════════
    // DEUTSCHE POLITIK
    // ═══════════════════════════════════════════════════════════
    'bundestag', 'bundesregierung', 'kanzler', 'kanzlerin', 'kanzleramt',
    'scholz', 'merz', 'habeck', 'lindner', 'baerbock', 'weidel', 'chrupalla',
    'wagenknecht', 'söder', 'laschet', 'merkel', 'steinmeier', 'faeser',
    'afd', 'cdu', 'csu', 'spd', 'grüne', 'fdp', 'linke', 'bsw',
    'wahlkampf', 'koalition', 'ampel', 'opposition', 'große koalition',
    'bundestagswahl', 'landtagswahl', 'europawahl', 'regierungskrise',
    'germany', 'german', 'deutschland', 'berlin', 'chancellor',
    'kai wegner', 'giffey', 'abgeordnetenhaus', 'groko', 'jamaika',
    // Misstrauensvotum & Koalitionsbruch
    'misstrauensvotum', 'rücktritt', 'neuwahl', 'vertrauensfrage',
    'koalitionsbruch', 'regierungskrise', 'kabinett', 'minister entlassen',

    // ═══════════════════════════════════════════════════════════
    // US POLITIK (Polymarket Hauptmarkt!)
    // ═══════════════════════════════════════════════════════════
    'trump', 'biden', 'harris', 'desantis', 'vivek', 'ramaswamy', 'haley',
    'pence', 'pompeo', 'bannon', 'musk', 'rfk', 'kennedy', 'newsom',
    'whitehouse', 'white house', 'oval office', 'congress', 'senate',
    'house of representatives', 'supreme court', 'scotus',
    'republican', 'democrat', 'gop', 'dnc', 'rnc', 'primary', 'caucus',
    'electoral college', 'swing state', 'battleground',
    'impeachment', 'indictment', 'arraignment', 'trial', 'verdict',
    'classified documents', 'mar-a-lago', 'january 6', 'jan 6',

    // ═══════════════════════════════════════════════════════════
    // UK POLITIK
    // ═══════════════════════════════════════════════════════════
    'sunak', 'starmer', 'truss', 'boris johnson', 'rishi', 'keir',
    'tory', 'tories', 'labour', 'lib dem', 'snp', 'westminster',
    'parliament', 'downing street', 'prime minister', 'pm ',
    'general election uk', 'by-election', 'brexit',

    // ═══════════════════════════════════════════════════════════
    // FRANKREICH
    // ═══════════════════════════════════════════════════════════
    'macron', 'le pen', 'marine le pen', 'melenchon', 'bardella',
    'elysee', 'élysée', 'assemblée nationale', 'france election',
    'french president', 'paris', 'rassemblement national',

    // ═══════════════════════════════════════════════════════════
    // NIEDERLANDE (Polymarket-Markt!)
    // ═══════════════════════════════════════════════════════════
    'netherlands', 'dutch', 'holland', 'amsterdam', 'den haag', 'the hague',
    'wilders', 'geert wilders', 'pvv', 'schoof', 'dick schoof',
    'timmermans', 'frans timmermans', 'yesilgöz', 'dilan yesilgöz',
    'van der plas', 'bbb', 'vvd', 'dutch election', 'dutch government',

    // ═══════════════════════════════════════════════════════════
    // ITALIEN
    // ═══════════════════════════════════════════════════════════
    'italy', 'italian', 'meloni', 'giorgia meloni', 'salvini',
    'berlusconi', 'rome', 'roma', 'fratelli d\'italia',

    // ═══════════════════════════════════════════════════════════
    // SPANIEN
    // ═══════════════════════════════════════════════════════════
    'spain', 'spanish', 'sanchez', 'pedro sanchez', 'vox party',
    'pp spain', 'psoe', 'catalonia', 'madrid',

    // ═══════════════════════════════════════════════════════════
    // EU & EUROPA
    // ═══════════════════════════════════════════════════════════
    'european union', 'eu ', ' eu', 'brussels', 'brüssel',
    'von der leyen', 'ursula', 'charles michel', 'roberta metsola',
    'european commission', 'european parliament', 'eurozone', 'lagarde',
    'eu summit', 'eu council', 'article 50', 'schengen',

    // ═══════════════════════════════════════════════════════════
    // NATO & GEOPOLITIK
    // ═══════════════════════════════════════════════════════════
    'nato', 'ukraine', 'russia', 'putin', 'zelensky', 'zelenskyy', 'selenskyj',
    'ceasefire', 'waffenstillstand', 'friedensverhandlungen',
    'crimea', 'krim', 'donbas', 'donezk', 'luhansk', 'kherson', 'bakhmut',
    'nordstream', 'nord stream', 'sanctions', 'sanktionen',
    'invasion', 'offensive', 'counteroffensive', 'gegenoffensive',
    'wagner', 'prigozhin', 'shoigu', 'gerasimov', 'medvedev',
    'nuclear', 'nuklear', 'atomic', 'tactical nuke',

    // ═══════════════════════════════════════════════════════════
    // CHINA & ASIEN
    // ═══════════════════════════════════════════════════════════
    'xi jinping', 'china', 'beijing', 'peking', 'taiwan', 'taipei',
    'ccp', 'communist party', 'south china sea', 'one china',
    'kim jong un', 'north korea', 'pyongyang', 'icbm', 'missile test',

    // ═══════════════════════════════════════════════════════════
    // NAHER OSTEN
    // ═══════════════════════════════════════════════════════════
    'israel', 'gaza', 'hamas', 'hezbollah', 'netanyahu', 'bibi',
    'iran', 'tehran', 'khamenei', 'raisi', 'saudi', 'mbs',
    'abraham accords', 'two state', 'west bank', 'idf',
  ],

  economics: [
    // ═══════════════════════════════════════════════════════════
    // ZENTRALBANKEN
    // ═══════════════════════════════════════════════════════════
    'bundesbank', 'ezb', 'ecb', 'fed', 'federal reserve', 'fomc',
    'powell', 'lagarde', 'yellen', 'bailey', 'bank of england', 'boe',
    'bank of japan', 'boj', 'ueda', 'kuroda',
    'inflation', 'deflation', 'rezession', 'recession', 'stagflation',
    'zinsen', 'interest rate', 'rate hike', 'rate cut', 'pivot',
    'quantitative easing', 'qe', 'qt', 'tightening', 'dovish', 'hawkish',
    'basis points', 'bps', 'dot plot',

    // ═══════════════════════════════════════════════════════════
    // WIRTSCHAFTSDATEN
    // ═══════════════════════════════════════════════════════════
    'wirtschaft', 'economy', 'export', 'import', 'trade balance',
    'arbeitslosigkeit', 'unemployment', 'jobs report', 'nonfarm payrolls',
    'ifo', 'zew', 'destatis', 'bip', 'gdp', 'vpi', 'verbraucherpreis',
    'cpi', 'ppi', 'pce', 'core inflation', 'consumer price',
    'retail sales', 'industrial production', 'pmi', 'ism',
    'housing starts', 'building permits', 'consumer confidence',

    // ═══════════════════════════════════════════════════════════
    // BÖRSEN & INDIZES
    // ═══════════════════════════════════════════════════════════
    'dax', 'mdax', 'sdax', 'eurostoxx', 'stoxx',
    's&p 500', 'sp500', 'nasdaq', 'dow jones', 'djia', 'russell',
    'ftse', 'nikkei', 'hang seng', 'shanghai',
    'bull market', 'bear market', 'correction', 'crash', 'rally',
    'all-time high', 'ath', 'circuit breaker', 'volatility', 'vix',

    // ═══════════════════════════════════════════════════════════
    // DAX & GROSSE UNTERNEHMEN
    // ═══════════════════════════════════════════════════════════
    'volkswagen', 'vw', 'siemens', 'basf', 'deutsche bank', 'allianz',
    'bmw', 'mercedes', 'daimler', 'porsche', 'sap', 'adidas', 'bayer',
    'telekom', 'deutsche post', 'dhl', 'lufthansa', 'henkel', 'continental',
    'infineon', 'deutsche börse', 'munich re', 'rwe', 'eon',

    // ═══════════════════════════════════════════════════════════
    // US TECH GIANTS (Markt-Mover)
    // ═══════════════════════════════════════════════════════════
    'apple', 'aapl', 'microsoft', 'msft', 'google', 'alphabet', 'googl',
    'amazon', 'amzn', 'meta', 'facebook', 'nvidia', 'nvda', 'tesla', 'tsla',
    'netflix', 'nflx', 'magnificent seven', 'mag7', 'faang',
    'openai', 'chatgpt', 'gpt-4', 'gpt-5', 'anthropic', 'claude',
    'earnings', 'quarterly results', 'guidance', 'revenue', 'eps',

    // ═══════════════════════════════════════════════════════════
    // ENERGIE & ROHSTOFFE
    // ═══════════════════════════════════════════════════════════
    'gas prices', 'energy crisis', 'lng', 'oil prices', 'natural gas',
    'pipeline', 'energy', 'strompreis', 'opec', 'opec+',
    'crude oil', 'brent', 'wti', 'barrel', 'oil production',
    'gold', 'silver', 'copper', 'lithium', 'rare earth',
    'solar', 'wind', 'renewable', 'nuclear power', 'hydrogen',

    // ═══════════════════════════════════════════════════════════
    // CRYPTO
    // ═══════════════════════════════════════════════════════════
    'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency',
    'binance', 'coinbase', 'ftx', 'sbf', 'sec crypto', 'etf bitcoin',
    'spot etf', 'blackrock bitcoin', 'halving', 'altcoin',
  ],

  markets: [
    // ═══════════════════════════════════════════════════════════
    // REGIERUNGSKRISEN & WAHLEN
    // ═══════════════════════════════════════════════════════════
    'coalition break', 'coalition collapse', 'government fall',
    'chancellor out', 'prime minister resign', 'pm resign',
    'snap election', 'early election', 'vote of no confidence',
    'cabinet reshuffle', 'minister fired', 'minister resign',
    'landslide victory', 'upset victory', 'polling', 'poll shows',

    // ═══════════════════════════════════════════════════════════
    // ZENTRALBANK EVENTS
    // ═══════════════════════════════════════════════════════════
    'ecb rate', 'ecb interest', 'european central bank',
    'fed rate', 'fed decision', 'fomc meeting', 'fomc minutes',
    'emergency rate', 'surprise cut', 'surprise hike',

    // ═══════════════════════════════════════════════════════════
    // GEOPOLITIK EVENTS
    // ═══════════════════════════════════════════════════════════
    'peace deal', 'peace agreement', 'peace talks', 'peace treaty',
    'troops withdraw', 'military', 'war end', 'conflict resolution',
    'ceasefire announced', 'hostage deal', 'prisoner exchange',
    'territory captured', 'major offensive', 'breakthrough',
    'assassination', 'coup', 'martial law', 'state of emergency',

    // ═══════════════════════════════════════════════════════════
    // BREAKING NEWS KEYWORDS
    // ═══════════════════════════════════════════════════════════
    'breaking', 'just in', 'developing', 'urgent', 'exclusive',
    'confirmed', 'official', 'announces', 'announced',
    'steps down', 'resigns', 'fired', 'sacked', 'ousted',
    'dead', 'dies', 'killed', 'hospitalized', 'health concerns',
  ],

  sports: [
    // ═══════════════════════════════════════════════════════════
    // BUNDESLIGA CLUBS
    // ═══════════════════════════════════════════════════════════
    'bundesliga', 'bayern', 'dortmund', 'bvb', 'leipzig', 'leverkusen',
    'bayern munich', 'bayern münchen', 'fc bayern', 'fcb',
    'borussia dortmund', 'rb leipzig', 'bayer leverkusen', 'bayer 04',
    'frankfurt', 'eintracht', 'wolfsburg', 'gladbach', 'mönchengladbach',
    'stuttgart', 'vfb', 'union berlin', 'freiburg', 'hoffenheim',
    'mainz', 'augsburg', 'werder bremen', 'köln', 'fc köln', 'bochum',
    'heidenheim', 'darmstadt', 'schalke', 's04', 'hamburg', 'hsv',

    // ═══════════════════════════════════════════════════════════
    // PREMIER LEAGUE CLUBS
    // ═══════════════════════════════════════════════════════════
    'premier league', 'epl', 'english football',
    'manchester united', 'man utd', 'man united', 'mufc', 'old trafford',
    'manchester city', 'man city', 'mcfc', 'etihad',
    'liverpool', 'lfc', 'anfield', 'arsenal', 'gunners', 'emirates',
    'chelsea', 'cfc', 'stamford bridge', 'tottenham', 'spurs', 'thfc',
    'newcastle', 'nufc', 'aston villa', 'avfc', 'west ham', 'whufc',
    'brighton', 'brentford', 'fulham', 'crystal palace', 'wolves',
    'everton', 'nottingham forest', 'bournemouth', 'burnley', 'luton',
    'sheffield united',

    // ═══════════════════════════════════════════════════════════
    // LA LIGA CLUBS
    // ═══════════════════════════════════════════════════════════
    'la liga', 'spanish football', 'liga española',
    'real madrid', 'madrid', 'bernabeu', 'barcelona', 'barca', 'barça',
    'camp nou', 'atletico madrid', 'atleti', 'sevilla', 'real sociedad',
    'villarreal', 'athletic bilbao', 'betis', 'valencia',

    // ═══════════════════════════════════════════════════════════
    // SERIE A CLUBS
    // ═══════════════════════════════════════════════════════════
    'serie a', 'italian football', 'calcio',
    'juventus', 'juve', 'inter milan', 'inter', 'ac milan', 'milan',
    'napoli', 'roma', 'as roma', 'lazio', 'atalanta', 'fiorentina',

    // ═══════════════════════════════════════════════════════════
    // LIGUE 1 CLUBS
    // ═══════════════════════════════════════════════════════════
    'ligue 1', 'french football',
    'psg', 'paris saint-germain', 'paris sg', 'marseille', 'om',
    'lyon', 'monaco', 'lille',

    // ═══════════════════════════════════════════════════════════
    // TRAINER (MEGA-LISTE!)
    // ═══════════════════════════════════════════════════════════
    // Deutsche Trainer
    'nagelsmann', 'julian nagelsmann', 'flick', 'hansi flick',
    'tuchel', 'thomas tuchel', 'klopp', 'jürgen klopp', 'jurgen klopp',
    'rangnick', 'ralf rangnick', 'rose', 'marco rose', 'tedesco',
    'streich', 'christian streich', 'hütter', 'adi hütter',
    'glasner', 'oliver glasner', 'kovac', 'niko kovac',

    // Internationale Top-Trainer
    'guardiola', 'pep guardiola', 'ancelotti', 'carlo ancelotti',
    'mourinho', 'jose mourinho', 'conte', 'antonio conte',
    'allegri', 'max allegri', 'inzaghi', 'simone inzaghi',
    'simeone', 'diego simeone', 'xavi', 'xavi hernandez',
    'arteta', 'mikel arteta', 'slot', 'arne slot',
    'postecoglou', 'ange postecoglou', 'emery', 'unai emery',
    'ten hag', 'erik ten hag', 'de zerbi', 'roberto de zerbi',
    'pochettino', 'mauricio pochettino', 'enrique', 'luis enrique',
    'kompany', 'vincent kompany', 'terzic', 'edin terzic',
    'xabi alonso', 'alonso',
    'zidane', 'zinedine zidane', 'deschamps', 'didier deschamps',
    'southgate', 'gareth southgate',

    // ═══════════════════════════════════════════════════════════
    // TRAINER-WECHSEL KEYWORDS (CRITICAL!)
    // ═══════════════════════════════════════════════════════════
    'trainer', 'coach', 'manager', 'head coach', 'cheftrainer',
    'sacked', 'fired', 'dismissed', 'axed', 'let go', 'parted ways',
    'entlassen', 'freigestellt', 'beurlaubt', 'trennung', 'rauswurf',
    'trainerwechsel', 'coaching change', 'new manager', 'new coach',
    'appoints', 'appointed', 'names', 'named', 'hires', 'hired',
    'signs', 'signed', 'contract extension', 'verlängert',
    'interim', 'caretaker', 'interimstrainer',
    'leaves', 'leaving', 'departure', 'exit', 'quits', 'resigns',
    'under pressure', 'job in danger', 'future uncertain',
    'hot seat', 'next manager', 'replacement', 'successor',

    // ═══════════════════════════════════════════════════════════
    // STAR-SPIELER (Transfer-Alpha!)
    // ═══════════════════════════════════════════════════════════
    'mbappe', 'mbappé', 'kylian', 'haaland', 'erling haaland',
    'bellingham', 'jude bellingham', 'vinicius', 'vini jr',
    'musiala', 'jamal musiala', 'saka', 'bukayo saka',
    'salah', 'mohamed salah', 'kane', 'harry kane',
    'lewandowski', 'robert lewandowski', 'de bruyne', 'kevin de bruyne',
    'bruno fernandes', 'rashford', 'foden', 'phil foden',
    'palmer', 'cole palmer', 'rice', 'declan rice',
    'wirtz', 'florian wirtz', 'xhaka', 'granit xhaka',
    'gündogan', 'ilkay gündogan', 'kroos', 'toni kroos',
    'müller', 'thomas müller', 'neuer', 'manuel neuer',
    'ter stegen', 'rüdiger', 'antonio rüdiger',

    // ═══════════════════════════════════════════════════════════
    // WETTBEWERBE
    // ═══════════════════════════════════════════════════════════
    'champions league', 'ucl', 'europa league', 'uel',
    'conference league', 'uecl', 'dfb pokal', 'dfb-pokal',
    'fa cup', 'efl cup', 'carabao cup', 'copa del rey',
    'coppa italia', 'coupe de france', 'supercup',
    'world cup', 'wm', 'weltmeisterschaft', 'euro', 'em', 'europameisterschaft',
    'nations league', 'friendly', 'länderspiel', 'qualifying', 'qualification',
    'group stage', 'knockout', 'quarter-final', 'semi-final', 'final',

    // ═══════════════════════════════════════════════════════════
    // FIFA WORLD CUP 2026 (Polymarket-Märkte!)
    // ═══════════════════════════════════════════════════════════
    'world cup 2026', 'wm 2026', 'fifa 2026', 'usa mexico canada',
    'world cup winner', 'world cup qualify', 'world cup qualification',
    // Nationalmannschaften (Polymarket-Märkte)
    'germany national', 'dfb team', 'die mannschaft', 'german team',
    'france national', 'les bleus', 'french team', 'équipe de france',
    'spain national', 'la roja', 'spanish team',
    'italy national', 'azzurri', 'italian team', 'italia',
    'england national', 'three lions', 'english team',
    'netherlands national', 'oranje', 'dutch team',
    'argentina national', 'albiceleste', 'argentine team',
    'brazil national', 'seleção', 'selecao', 'brazilian team',
    'portugal national', 'portuguese team',
    'belgium national', 'red devils belgium', 'belgian team',
    'ukraine national', 'ukrainian team',
    'poland national', 'polish team', 'polska',
    'sweden national', 'swedish team',
    // National Team Coaches (WM-relevant)
    'bundestrainer', 'nationaltrainer', 'national team coach',

    // ═══════════════════════════════════════════════════════════
    // US SPORTS (Polymarket-relevant!)
    // ═══════════════════════════════════════════════════════════
    'nfl', 'super bowl', 'superbowl', 'super bowl 2026', 'touchdown', 'quarterback',
    'chiefs', 'eagles', 'cowboys', '49ers', 'ravens', 'lions', 'bills',
    'patriots', 'seahawks', 'packers', 'steelers', 'broncos', 'raiders',
    'dolphins', 'jets', 'giants', 'commanders', 'bears', 'vikings', 'saints',
    'falcons', 'buccaneers', 'panthers', 'cardinals', 'rams', 'chargers',
    'texans', 'colts', 'titans', 'jaguars', 'bengals', 'browns',
    'mahomes', 'patrick mahomes', 'travis kelce', 'taylor swift',
    'allen', 'josh allen', 'burrow', 'joe burrow', 'lamar jackson',
    'hurts', 'jalen hurts', 'herbert', 'justin herbert',
    // NFL Awards (Polymarket-Märkte!)
    'nfl mvp', 'offensive player', 'defensive player', 'rookie of the year',
    'coach of the year', 'comeback player',

    // ═══════════════════════════════════════════════════════════
    // NBA (Polymarket-Märkte!)
    // ═══════════════════════════════════════════════════════════
    'nba', 'nba finals', 'nba playoffs', 'nba mvp', 'all-star',
    'lakers', 'celtics', 'warriors', 'bucks', 'nuggets', 'heat', 'suns',
    'thunder', 'cavaliers', 'knicks', 'timberwolves', 'rockets', 'pacers',
    'mavericks', 'clippers', 'spurs', 'nets', 'sixers', 'hawks', 'bulls',
    'lebron', 'lebron james', 'curry', 'steph curry', 'giannis', 'jokic',
    'tatum', 'jayson tatum', 'luka', 'luka doncic', 'embiid', 'joel embiid',
    'gilgeous-alexander', 'sga', 'anthony edwards', 'ant-man',
    // NBA Awards (Polymarket!)
    'nba rookie', 'defensive player of the year', 'sixth man',

    // ═══════════════════════════════════════════════════════════
    // NHL (Polymarket Stanley Cup!)
    // ═══════════════════════════════════════════════════════════
    'nhl', 'stanley cup', 'stanley cup 2026', 'hockey',
    'hurricanes', 'panthers', 'oilers', 'stars', 'avalanche', 'golden knights',
    'lightning', 'kings', 'devils', 'jets', 'maple leafs', 'capitals',
    'rangers', 'senators', 'wild', 'blues', 'canucks', 'islanders',
    'flyers', 'blue jackets', 'flames', 'predators', 'red wings',
    'ducks', 'canadiens', 'bruins', 'sabres', 'penguins', 'kraken', 'blackhawks',

    // ═══════════════════════════════════════════════════════════
    // MLB
    // ═══════════════════════════════════════════════════════════
    'mlb', 'world series', 'home run', 'yankees', 'dodgers', 'astros',
    'mets', 'braves', 'phillies', 'padres', 'cubs', 'red sox',

    // ═══════════════════════════════════════════════════════════
    // WEITERE SPORT-EVENTS
    // ═══════════════════════════════════════════════════════════
    'olympics', 'olympia', 'olympic games', 'ioc', 'paris 2024',
    'tennis', 'wimbledon', 'us open', 'australian open', 'french open',
    'djokovic', 'alcaraz', 'sinner', 'medvedev', 'zverev',
    'formula 1', 'f1', 'verstappen', 'hamilton', 'leclerc', 'norris',
    'grand prix', 'qualifying', 'pole position', 'podium',
    'boxing', 'ufc', 'mma', 'fury', 'usyk', 'joshua',
    'golf', 'masters', 'pga', 'ryder cup',
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
  // JETZT PERSISTENT! Verhindert Push-Storm nach Restart
  private seenNewsIds: Set<string>;
  private rssPollingInterval: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;
  private hashCleanupInterval: NodeJS.Timeout | null = null;

  // RSS-Polling Intervall (60 Sekunden für schnelle Erkennung)
  private readonly RSS_POLL_INTERVAL = 60 * 1000;

  constructor() {
    super();
    // Lade persistente Hashes aus DB
    this.seenNewsIds = loadSeenHashes();
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

    // Refresh seenNewsIds aus DB (für Multi-Instance-Support)
    this.seenNewsIds = loadSeenHashes();

    const healthSummary = getHealthSummary();
    logger.info('═══════════════════════════════════════════════════════');
    logger.info('ALMAN SCANNER EVENT-LISTENER GESTARTET');
    logger.info(`   Polling-Intervall: ${this.RSS_POLL_INTERVAL / 1000}s`);
    logger.info(`   Feeds: ${WORKING_RSS_FEEDS.length} (kuratiert)`);
    logger.info(`   Health: ${healthSummary.ok} OK, ${healthSummary.error} Fehler`);
    logger.info(`   Seen Hashes: ${this.seenNewsIds.size} (persistent)`);
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

    // Cleanup alte Hashes einmal täglich (12 Stunden)
    this.hashCleanupInterval = setInterval(() => {
      cleanupOldHashes(7);
    }, 12 * 60 * 60 * 1000);
  }

  stopEventListener(): void {
    if (this.rssPollingInterval) {
      clearInterval(this.rssPollingInterval);
      this.rssPollingInterval = null;
    }
    if (this.hashCleanupInterval) {
      clearInterval(this.hashCleanupInterval);
      this.hashCleanupInterval = null;
    }
    this.isPolling = false;
    logger.info('RSS Event-Listener gestoppt');
  }

  // Delta-Detection: Nur NEUE News erkennen und Events emittieren
  // Nutzt jetzt die robuste fetchAllRSSFeeds aus ./rss.ts
  // NUR DEUTSCHE QUELLEN für Breaking News Detection!
  private async fetchRSSFeedsWithDelta(emitEvents: boolean): Promise<void> {
    const breakingNews: BreakingNewsEvent[] = [];

    let result;
    try {
      // NUR DEUTSCHE QUELLEN für Breaking News Detection!
      result = await fetchAllRSSFeeds({
        germanOnly: true,  // NUR deutsche Quellen!
        maxConcurrent: 10,
        timeout: 8000,
      });

      // Pipeline Success tracken wenn mindestens ein Feed erfolgreich
      if (result.successfulFeeds > 0) {
        runtimeState.recordPipelineSuccess('rss');
      } else if (result.totalFeeds > 0) {
        runtimeState.recordPipelineError('rss', `0/${result.totalFeeds} Feeds erfolgreich`);
      }
    } catch (err) {
      const error = err as Error;
      logger.error(`RSS Delta-Fetch Fehler: ${error.message}`);
      runtimeState.recordPipelineError('rss', error.message);
      return;
    }

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
        // PERSISTENT: Hash in DB speichern um Push-Storm nach Restart zu verhindern
        saveSeenHash(newsId, item.data.source as string, item.title);
        newNews.push(item);

        // Pruefe ob Breaking News (relevant fuer Markets)
        if (emitEvents) {
          const keywords = this.extractKeywords(item);
          if (keywords.length > 0) {
            const detectedAt = new Date();
            const timeAdvantageSeconds = Math.max(0, Math.floor((detectedAt.getTime() - item.publishedAt.getTime()) / 1000));
            const breakingEvent: BreakingNewsEvent = {
              id: newsId,
              source: item.data.source as string,
              title: item.title,
              url: item.url,
              content: (item.data.content as string) || '',
              category: (item.data.category as string) || 'unknown',
              keywords,
              publishedAt: item.publishedAt,
              detectedAt,
              timeAdvantageSeconds,
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

      // Pipeline Success tracken
      if (this.cachedPolls.length > 0) {
        runtimeState.recordPipelineSuccess('dawum');
      }
    } catch (err) {
      const error = err as Error;
      logger.error(`Dawum Fehler: ${error.message}`);
      runtimeState.recordPipelineError('dawum', error.message);
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
    try {
      // NUR DEUTSCHE QUELLEN für den Cache - keine internationalen!
      const result = await fetchAllRSSFeeds({
        germanOnly: true,  // NUR deutsche Quellen für "Deutsche News"!
        maxConcurrent: 10,
        timeout: 8000,
      });

      // Konvertiere NewsItems zu GermanSource Format
      this.cachedNews = newsItemsToGermanSources(result.items);

      const healthSummary = getHealthSummary();
      logger.debug(
        `RSS (NUR DEUTSCH): ${result.uniqueItems} Artikel geladen ` +
        `(${result.successfulFeeds}/${result.totalFeeds} Feeds OK, ` +
        `${healthSummary.avgSuccessRate}% Erfolgsrate)`
      );

      // Pipeline Success tracken wenn mindestens ein Feed erfolgreich
      if (result.successfulFeeds > 0) {
        runtimeState.recordPipelineSuccess('rss');
      } else if (result.totalFeeds > 0) {
        runtimeState.recordPipelineError('rss', `0/${result.totalFeeds} Feeds erfolgreich`);
      }
    } catch (err) {
      const error = err as Error;
      logger.error(`RSS Fehler: ${error.message}`);
      runtimeState.recordPipelineError('rss', error.message);
    }
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
