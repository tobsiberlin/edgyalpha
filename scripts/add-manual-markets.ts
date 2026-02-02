#!/usr/bin/env npx tsx

/**
 * Fügt manuell spezifizierte Märkte zur Watchlist hinzu
 */

import axios from 'axios';
import { initDatabase } from '../src/storage/db.js';
import {
  bulkAddToWatchlist,
  getWatchlistStats,
  type AddWatchlistMarketInput,
  type WatchlistCategory,
} from '../src/storage/repositories/germanWatchlist.js';

// Events, die wir manuell hinzufügen wollen
const MANUAL_EVENT_SLUGS = [
  // Fußball
  'next-manchester-united-manager',
  'bundesliga-which-clubs-get-relegated',

  // Deutsche Politik
  'will-cducsuspd-german-federal-coalition-break-before-2027',
  'friedrich-merz-out-as-chancellor-of-germany-before-2027',

  // Landtagswahlen
  'who-will-win-the-most-seats-in-the-2026-baden-wrttemberg-parliamentary-elections',
  'berlin-state-election-winner',
  'rhineland-palatinate-parliamentary-election-winner',

  // Wirtschaft
  'which-banks-will-fail-by-june-30',
];

function categorizeMarket(question: string, eventSlug: string): WatchlistCategory {
  const q = question.toLowerCase();
  const slug = eventSlug.toLowerCase();

  if (slug.includes('bundesliga') || slug.includes('manchester-united') ||
      q.includes('bundesliga') || q.includes('manager') || q.includes('coach')) {
    return 'bundesliga';
  }

  if (slug.includes('baden') || slug.includes('berlin') || slug.includes('rhineland') ||
      slug.includes('coalition') || slug.includes('merz') || slug.includes('chancellor') ||
      q.includes('cdu') || q.includes('spd') || q.includes('afd') || q.includes('grüne') ||
      q.includes('fdp') || q.includes('linke') || q.includes('bsw')) {
    return 'politik';
  }

  if (slug.includes('bank') || q.includes('bank') || q.includes('deutsche')) {
    return 'wirtschaft';
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
  markets: GammaMarket[];
}

async function fetchEventBySlug(slug: string): Promise<GammaEvent | null> {
  try {
    const response = await axios.get<GammaEvent[]>(`https://gamma-api.polymarket.com/events`, {
      params: { slug },
      timeout: 15000,
    });
    return response.data[0] || null;
  } catch (err) {
    console.error(`Fehler bei ${slug}:`, (err as Error).message);
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('MANUELLE MÄRKTE HINZUFÜGEN');
  console.log('═══════════════════════════════════════════════════════════════');

  initDatabase();

  const allMarkets: AddWatchlistMarketInput[] = [];

  for (const slug of MANUAL_EVENT_SLUGS) {
    console.log(`\nHole Event: ${slug}`);
    const event = await fetchEventBySlug(slug);

    if (!event) {
      console.log(`  ❌ Nicht gefunden`);
      continue;
    }

    console.log(`  ✅ ${event.title} (${event.markets?.length || 0} Märkte)`);

    if (!event.markets) continue;

    for (const market of event.markets) {
      if (market.closed) continue;

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

      // Keywords aus Frage und Event extrahieren
      const keywords: string[] = [];
      const text = `${market.question} ${event.title}`.toLowerCase();

      // Politik Keywords
      ['cdu', 'spd', 'afd', 'grüne', 'fdp', 'linke', 'bsw', 'merz', 'scholz', 'koalition', 'kanzler',
       'bundestag', 'landtag', 'wahl', 'election', 'baden', 'württemberg', 'berlin', 'rheinland', 'pfalz']
        .forEach(kw => { if (text.includes(kw)) keywords.push(kw); });

      // Sport Keywords
      ['bundesliga', 'manchester', 'united', 'manager', 'coach', 'trainer', 'relegated', 'abstieg',
       'bayern', 'dortmund', 'hamburg', 'köln', 'pauli', 'heidenheim', 'augsburg']
        .forEach(kw => { if (text.includes(kw)) keywords.push(kw); });

      // Wirtschaft Keywords
      ['bank', 'deutsche bank', 'commerzbank', 'fail', 'pleite', 'insolvenz']
        .forEach(kw => { if (text.includes(kw)) keywords.push(kw); });

      allMarkets.push({
        marketId: market.id,
        conditionId: market.conditionId,
        question: market.question,
        slug: market.slug,
        category,
        matchedKeywords: [...new Set(keywords)],
        relevanceScore: category === 'politik' ? 0.9 : category === 'bundesliga' ? 0.85 : 0.7,
        volumeTotal: parseFloat(market.volume) || 0,
        currentPriceYes: priceYes,
        currentPriceNo: priceNo,
        endDate: market.endDate ? new Date(market.endDate) : undefined,
      });

      console.log(`    - ${market.question.substring(0, 60)}...`);
    }

    // Kurze Pause
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`Gefunden: ${allMarkets.length} Märkte`);

  // In DB speichern
  const added = bulkAddToWatchlist(allMarkets);
  console.log(`Hinzugefügt/Aktualisiert: ${added}`);

  // Statistiken
  const stats = getWatchlistStats();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('WATCHLIST STATISTIKEN');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Total: ${stats.total} Märkte (${stats.active} aktiv)`);
  console.log(`Volume: $${(stats.totalVolume / 1000000).toFixed(2)}M`);
  console.log('Nach Kategorie:');
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    if (count > 0) console.log(`  ${cat}: ${count}`);
  }
}

main().catch(console.error);
