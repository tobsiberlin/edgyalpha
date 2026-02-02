#!/usr/bin/env npx tsx

/**
 * Fügt europäische Märkte zur Watchlist hinzu
 */

import axios from 'axios';
import { initDatabase } from '../src/storage/db.js';
import {
  bulkAddToWatchlist,
  getWatchlistStats,
  type AddWatchlistMarketInput,
  type WatchlistCategory,
} from '../src/storage/repositories/germanWatchlist.js';

// Europäische Event-Slugs zum Hinzufügen
const EUROPEAN_EVENT_SLUGS = [
  // UK Politik
  'uk-election-called-by',
  'starmer-out-by',

  // Frankreich
  'macron-out-by',
  'french-election-called-by',

  // Spanien
  'spain-snap-election-called-by',

  // Ungarn
  'next-prime-minister-of-hungary',

  // Portugal
  'portugal-presidential-election',

  // Polen
  'russian-strike-on-poland-by',

  // Fußball - Champions League
  'uefa-champions-league-winner',
  'champions-league-top-scorer',
  'champions-league-which-teams-advance-to-round-of-16',

  // Fußball - Premier League (UK)
  'english-premier-league-winner',
  'english-premier-league-2nd-place',
  'english-premier-league-3rd-place',
  'english-premier-league-last-place',
  'english-premier-league-top-goalscorer',
  'english-premier-league-top-4-finish',

  // Fußball - La Liga (Spanien)
  'la-liga-winner',
  'la-liga-which-clubs-get-relegated',
  'la-liga-top-goalscorer',
  'la-liga-top-4-finish',

  // Fußball - Serie A (Italien)
  'serie-a-league-winner',
  'serie-a-which-clubs-get-relegated',
  'serie-a-top-goalscorer',
  'serie-a-top-4-finish',

  // Fußball - Ligue 1 (Frankreich)
  'french-ligue-1-winner',
  'ligue-1-which-clubs-get-relegated',
  'ligue-1-top-goalscorer',
  'ligue-1-top-4-finish',
];

// Keywords für weitere Suche
const EUROPEAN_KEYWORDS = [
  // UK
  'starmer', 'sunak', 'labour', 'tory', 'tories', 'conservative', 'lib dem',
  'westminster', 'downing street', 'british', 'uk ', 'england', 'scotland', 'wales',

  // Frankreich
  'macron', 'le pen', 'bardella', 'melenchon', 'france', 'french', 'paris', 'elysee',

  // Italien
  'meloni', 'salvini', 'italy', 'italian', 'roma', 'rome',

  // Spanien
  'sanchez', 'spain', 'spanish', 'madrid', 'barcelona', 'catalonia',

  // Polen
  'tusk', 'poland', 'polish', 'warsaw',

  // Ungarn
  'orban', 'hungary', 'hungarian', 'budapest',

  // Österreich
  'austria', 'austrian', 'vienna', 'wien',

  // Andere EU
  'belgium', 'czech', 'portugal', 'greece', 'denmark', 'norway', 'sweden', 'finland',
  'romania', 'bulgaria', 'croatia', 'serbia', 'slovakia', 'slovenia',

  // Fußball
  'premier league', 'champions league', 'la liga', 'serie a', 'ligue 1',
  'arsenal', 'chelsea', 'liverpool', 'tottenham', 'man city', 'man united',
  'real madrid', 'barcelona', 'atletico',
  'juventus', 'inter', 'ac milan', 'napoli',
  'psg', 'marseille', 'lyon',
];

function categorizeMarket(question: string, eventSlug: string): WatchlistCategory {
  const q = question.toLowerCase();
  const slug = eventSlug.toLowerCase();

  // Fußball
  if (slug.includes('league') || slug.includes('liga') || slug.includes('serie') ||
      slug.includes('ligue') || slug.includes('champions') || slug.includes('goalscorer') ||
      slug.includes('relegated') || slug.includes('top-4') ||
      q.includes('premier league') || q.includes('la liga') || q.includes('serie a') ||
      q.includes('ligue 1') || q.includes('champions league')) {
    return 'bundesliga'; // Wir nutzen "bundesliga" für alle Fußball-Märkte
  }

  // EU/Geopolitik
  if (slug.includes('nato') || slug.includes('ukraine') || slug.includes('russia') ||
      q.includes('nato') || q.includes('ukraine') || q.includes('russia') ||
      q.includes('ceasefire') || q.includes('troops')) {
    return 'eu_ukraine';
  }

  // Politik
  if (slug.includes('election') || slug.includes('minister') || slug.includes('president') ||
      slug.includes('starmer') || slug.includes('macron') || slug.includes('out-by') ||
      q.includes('election') || q.includes('minister') || q.includes('president')) {
    return 'politik';
  }

  return 'sonstige';
}

interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  outcomePrices: string;
  volume: string;
  endDate: string;
  closed: boolean;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  volume: number;
  markets: GammaMarket[];
}

async function fetchAllEvents(): Promise<GammaEvent[]> {
  const response = await axios.get<GammaEvent[]>('https://gamma-api.polymarket.com/events', {
    params: { closed: false, limit: 500 },
    timeout: 30000,
  });
  return response.data;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('EUROPÄISCHE MÄRKTE HINZUFÜGEN');
  console.log('═══════════════════════════════════════════════════════════════');

  initDatabase();

  const allMarkets: AddWatchlistMarketInput[] = [];
  const seenIds = new Set<string>();

  // 1. Hole alle Events
  console.log('\nHole alle Events von Polymarket...');
  const allEvents = await fetchAllEvents();
  console.log(`${allEvents.length} Events gefunden`);

  // 2. Filtere nach europäischen Keywords
  console.log('\nFiltere nach europäischen Keywords...');

  for (const event of allEvents) {
    const eventText = `${event.title} ${event.slug}`.toLowerCase();

    // Prüfe ob Event europäisch relevant ist
    const isEuropean = EUROPEAN_KEYWORDS.some(kw => eventText.includes(kw.toLowerCase())) ||
                       EUROPEAN_EVENT_SLUGS.some(slug => event.slug.includes(slug));

    if (!isEuropean) continue;
    if (!event.markets) continue;

    // Überspringe bereits in Watchlist vorhandene deutsche Märkte
    if (eventText.includes('germany') || eventText.includes('bundesliga') ||
        eventText.includes('merz') || eventText.includes('bundestag') ||
        eventText.includes('baden') || eventText.includes('berlin state') ||
        eventText.includes('rhineland')) {
      continue;
    }

    console.log(`\n✓ ${event.title} (${event.markets.length} Märkte)`);

    for (const market of event.markets) {
      if (market.closed) continue;
      if (seenIds.has(market.id)) continue;
      seenIds.add(market.id);

      let priceYes = 0.5;
      let priceNo = 0.5;
      try {
        const prices = JSON.parse(market.outcomePrices || '[]');
        if (prices.length >= 2) {
          priceYes = parseFloat(prices[0]) || 0.5;
          priceNo = parseFloat(prices[1]) || 0.5;
        }
      } catch {
        // Ignore
      }

      const category = categorizeMarket(market.question, event.slug);

      // Keywords extrahieren
      const keywords: string[] = [];
      const text = `${market.question} ${event.title}`.toLowerCase();
      EUROPEAN_KEYWORDS.forEach(kw => {
        if (text.includes(kw.toLowerCase())) keywords.push(kw);
      });

      allMarkets.push({
        marketId: market.id,
        conditionId: market.conditionId,
        question: market.question,
        slug: market.slug,
        category,
        matchedKeywords: [...new Set(keywords)],
        relevanceScore: category === 'politik' ? 0.8 : category === 'bundesliga' ? 0.75 : 0.6,
        volumeTotal: parseFloat(market.volume) || 0,
        currentPriceYes: priceYes,
        currentPriceNo: priceNo,
        endDate: market.endDate ? new Date(market.endDate) : undefined,
      });
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`Gefunden: ${allMarkets.length} europäische Märkte`);

  // In DB speichern
  const added = bulkAddToWatchlist(allMarkets);
  console.log(`Hinzugefügt/Aktualisiert: ${added}`);

  // Statistiken
  const stats = getWatchlistStats();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('WATCHLIST STATISTIKEN (GESAMT)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Total: ${stats.total} Märkte (${stats.active} aktiv)`);
  console.log(`Volume: $${(stats.totalVolume / 1000000).toFixed(2)}M`);
  console.log('Nach Kategorie:');
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    if (count > 0) console.log(`  ${cat}: ${count}`);
  }
}

main().catch(console.error);
