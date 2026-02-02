#!/usr/bin/env npx tsx

/**
 * Synchronisiert die deutsche Markt-Watchlist mit Polymarket
 * Sucht nach allen deutschen/EU-relevanten Märkten und speichert sie
 *
 * Usage: npx tsx scripts/sync-german-watchlist.ts
 */

import axios from 'axios';
import { initDatabase } from '../src/storage/db.js';
import {
  bulkAddToWatchlist,
  getWatchlistStats,
  type AddWatchlistMarketInput,
  type WatchlistCategory,
} from '../src/storage/repositories/germanWatchlist.js';

// Deutsche/EU-relevante Keywords für die Suche
const GERMAN_SEARCH_KEYWORDS = [
  // === POLITIK ===
  // Politiker
  'merz', 'scholz', 'habeck', 'lindner', 'baerbock', 'weidel', 'wagenknecht',
  'söder', 'pistorius', 'faeser', 'steinmeier',
  // Parteien
  'cdu', 'spd', 'grüne', 'fdp', 'afd', 'bsw', 'linke',
  // Institutionen
  'bundestag', 'bundesregierung', 'kanzler',
  // Allgemein
  'germany', 'german', 'deutschland', 'berlin',

  // === WIRTSCHAFT ===
  // DAX-Unternehmen
  'volkswagen', 'siemens', 'basf', 'deutsche bank', 'allianz',
  'bmw', 'mercedes', 'daimler', 'porsche', 'sap', 'adidas', 'bayer',
  'telekom', 'lufthansa', 'continental', 'infineon',
  // Wirtschaftsindikatoren
  'dax', 'bundesbank', 'ifo',

  // === FUSSBALL/BUNDESLIGA ===
  'bundesliga', 'bayern munich', 'bayern münchen', 'borussia dortmund', 'bvb',
  'rb leipzig', 'bayer leverkusen', 'eintracht frankfurt',
  'dfb', 'dfb-pokal',
  // Trainer
  'nagelsmann', 'tuchel', 'klopp', 'xabi alonso', 'kompany', 'terzic',
  // Spieler
  'musiala', 'wirtz', 'havertz', 'sane', 'gundogan', 'kroos', 'muller', 'neuer',

  // === EU/GEOPOLITIK ===
  'european union', 'eu ', 'brussels', 'von der leyen',
  'ukraine', 'zelensky', 'selenskyj', 'ceasefire', 'nato',
  'russia', 'putin', 'crimea', 'donbas',
  // Nachbarländer
  'netherlands', 'wilders', 'france', 'macron', 'poland', 'austria',
];

// Kategorisierung basierend auf Keywords
function categorizeMarket(question: string, matchedKeywords: string[]): WatchlistCategory {
  const q = question.toLowerCase();
  const kws = matchedKeywords.map(k => k.toLowerCase());

  // Bundesliga/Fußball
  const footballKeywords = ['bundesliga', 'bayern', 'dortmund', 'bvb', 'leipzig', 'leverkusen',
    'frankfurt', 'dfb', 'nagelsmann', 'tuchel', 'klopp', 'xabi alonso', 'kompany', 'musiala', 'wirtz'];
  if (footballKeywords.some(k => kws.includes(k) || q.includes(k))) {
    return 'bundesliga';
  }

  // Deutsche Politik
  const politikKeywords = ['merz', 'scholz', 'habeck', 'lindner', 'baerbock', 'weidel',
    'wagenknecht', 'bundestag', 'bundesregierung', 'kanzler', 'cdu', 'spd', 'grüne', 'fdp', 'afd', 'bsw'];
  if (politikKeywords.some(k => kws.includes(k) || q.includes(k))) {
    // Prüfe ob es wirklich um deutsche Politik geht
    if (q.includes('germany') || q.includes('german') || q.includes('chancellor') ||
        q.includes('bundestag') || q.includes('bundesregierung')) {
      return 'politik';
    }
  }

  // EU/Ukraine
  const euKeywords = ['ukraine', 'zelensky', 'selenskyj', 'ceasefire', 'nato', 'russia', 'putin',
    'crimea', 'donbas', 'european union', 'eu ', 'brussels', 'von der leyen'];
  if (euKeywords.some(k => kws.includes(k) || q.includes(k))) {
    return 'eu_ukraine';
  }

  // Wirtschaft
  const wirtschaftKeywords = ['dax', 'bundesbank', 'volkswagen', 'siemens', 'basf', 'deutsche bank',
    'bmw', 'mercedes', 'porsche', 'sap', 'adidas', 'bayer', 'lufthansa'];
  if (wirtschaftKeywords.some(k => kws.includes(k) || q.includes(k))) {
    return 'wirtschaft';
  }

  return 'sonstige';
}

// Berechne Relevanz-Score
function calculateRelevance(matchedKeywords: string[], category: WatchlistCategory): number {
  let score = 0.3; // Basis

  // Mehr Keywords = höhere Relevanz
  score += Math.min(matchedKeywords.length * 0.1, 0.3);

  // Kategorie-Bonus
  if (category === 'politik') score += 0.2;
  if (category === 'bundesliga') score += 0.15;
  if (category === 'eu_ukraine') score += 0.1;

  return Math.min(score, 1.0);
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  markets: Array<{
    id: string;
    conditionId: string;
    question: string;
    slug: string;
    outcomePrices: string;
    volume: string;
    endDate: string;
    closed: boolean;
  }>;
}

async function fetchMarketsForKeyword(keyword: string): Promise<Map<string, AddWatchlistMarketInput>> {
  const results = new Map<string, AddWatchlistMarketInput>();

  try {
    const response = await axios.get<GammaEvent[]>('https://gamma-api.polymarket.com/events', {
      params: {
        closed: false,
        limit: 100,
        _t: Date.now(),
      },
      headers: {
        'User-Agent': 'EdgyAlpha/1.0',
      },
      timeout: 10000,
    });

    for (const event of response.data) {
      const eventText = `${event.title} ${event.slug}`.toLowerCase();

      // Prüfe ob Event zum Keyword passt
      if (!eventText.includes(keyword.toLowerCase())) continue;

      for (const market of event.markets) {
        if (market.closed) continue;

        const marketText = `${market.question} ${market.slug}`.toLowerCase();
        const allMatchedKeywords: string[] = [];

        // Sammle alle matchenden Keywords
        for (const kw of GERMAN_SEARCH_KEYWORDS) {
          if (marketText.includes(kw.toLowerCase()) || eventText.includes(kw.toLowerCase())) {
            allMatchedKeywords.push(kw);
          }
        }

        if (allMatchedKeywords.length === 0) continue;

        // Parse Preise
        let priceYes = 0.5;
        let priceNo = 0.5;
        try {
          const prices = JSON.parse(market.outcomePrices || '[]');
          if (prices.length >= 2) {
            priceYes = parseFloat(prices[0]) || 0.5;
            priceNo = parseFloat(prices[1]) || 0.5;
          }
        } catch {
          // Ignore parse errors
        }

        const category = categorizeMarket(market.question, allMatchedKeywords);
        const relevance = calculateRelevance(allMatchedKeywords, category);

        results.set(market.id, {
          marketId: market.id,
          conditionId: market.conditionId,
          question: market.question,
          slug: market.slug,
          category,
          matchedKeywords: [...new Set(allMatchedKeywords)],
          relevanceScore: relevance,
          volumeTotal: parseFloat(market.volume) || 0,
          currentPriceYes: priceYes,
          currentPriceNo: priceNo,
          endDate: market.endDate ? new Date(market.endDate) : undefined,
        });
      }
    }
  } catch (err) {
    console.error(`Fehler bei Keyword "${keyword}":`, (err as Error).message);
  }

  return results;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('DEUTSCHE MARKT-WATCHLIST SYNCHRONISATION');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Keywords: ${GERMAN_SEARCH_KEYWORDS.length}`);
  console.log('');

  // Datenbank initialisieren
  initDatabase();

  // Sammle alle Märkte
  const allMarkets = new Map<string, AddWatchlistMarketInput>();

  // Batch-weise Keywords durchgehen (um Rate Limits zu vermeiden)
  const batchSize = 5;
  for (let i = 0; i < GERMAN_SEARCH_KEYWORDS.length; i += batchSize) {
    const batch = GERMAN_SEARCH_KEYWORDS.slice(i, i + batchSize);
    console.log(`Suche: ${batch.join(', ')}...`);

    const promises = batch.map(kw => fetchMarketsForKeyword(kw));
    const results = await Promise.all(promises);

    for (const result of results) {
      for (const [id, market] of result) {
        // Merge Keywords wenn Markt schon existiert
        if (allMarkets.has(id)) {
          const existing = allMarkets.get(id)!;
          const mergedKeywords = [...new Set([...(existing.matchedKeywords || []), ...(market.matchedKeywords || [])])];
          existing.matchedKeywords = mergedKeywords;
          existing.relevanceScore = calculateRelevance(mergedKeywords, existing.category);
        } else {
          allMarkets.set(id, market);
        }
      }
    }

    // Kurze Pause zwischen Batches
    if (i + batchSize < GERMAN_SEARCH_KEYWORDS.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log('');
  console.log(`Gefunden: ${allMarkets.size} einzigartige Märkte`);
  console.log('');

  // Kategorien zählen
  const byCategory = new Map<WatchlistCategory, number>();
  let totalVolume = 0;
  for (const market of allMarkets.values()) {
    byCategory.set(market.category, (byCategory.get(market.category) || 0) + 1);
    totalVolume += market.volumeTotal || 0;
  }

  console.log('Nach Kategorie:');
  for (const [cat, count] of byCategory) {
    console.log(`  ${cat}: ${count} Märkte`);
  }
  console.log(`  TOTAL: ${allMarkets.size} Märkte, $${(totalVolume / 1000).toFixed(0)}k Volume`);
  console.log('');

  // In Datenbank speichern
  console.log('Speichere in Datenbank...');
  const added = bulkAddToWatchlist(Array.from(allMarkets.values()));
  console.log(`${added} Märkte hinzugefügt/aktualisiert`);

  // Statistiken anzeigen
  const stats = getWatchlistStats();
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('WATCHLIST STATISTIKEN');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Total: ${stats.total} Märkte (${stats.active} aktiv)`);
  console.log(`Volume: $${(stats.totalVolume / 1000000).toFixed(2)}M`);
  console.log(`Avg Relevance: ${(stats.avgRelevance * 100).toFixed(1)}%`);
  console.log('');
  console.log('Nach Kategorie:');
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log('');
  console.log('Fertig!');
}

main().catch(console.error);
