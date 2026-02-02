#!/usr/bin/env npx tsx

/**
 * Zeigt die deutsche Markt-Watchlist an
 */

import { initDatabase } from '../src/storage/db.js';
import { getActiveWatchlistMarkets, getWatchlistStats } from '../src/storage/repositories/germanWatchlist.js';

initDatabase();

const stats = getWatchlistStats();
console.log('═══════════════════════════════════════════════════════════════');
console.log('DEUTSCHE MARKT-WATCHLIST');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`Total: ${stats.total} Märkte | Volume: $${(stats.totalVolume / 1000000).toFixed(2)}M`);
console.log(`Avg Relevanz: ${(stats.avgRelevance * 100).toFixed(0)}%`);
console.log();

const markets = getActiveWatchlistMarkets();

// Gruppiere nach Kategorie
const byCategory = new Map<string, typeof markets>();
for (const m of markets) {
  if (!byCategory.has(m.category)) byCategory.set(m.category, []);
  byCategory.get(m.category)!.push(m);
}

for (const [cat, catMarkets] of byCategory) {
  const catVolume = catMarkets.reduce((sum, m) => sum + (m.volumeTotal || 0), 0);
  console.log(`\n═══ ${cat.toUpperCase()} (${catMarkets.length} Märkte, $${(catVolume/1000000).toFixed(2)}M) ═══`);

  // Sortiere nach Volumen
  catMarkets.sort((a, b) => (b.volumeTotal || 0) - (a.volumeTotal || 0));

  for (const m of catMarkets.slice(0, 20)) {
    const vol = m.volumeTotal ? `$${(m.volumeTotal/1000).toFixed(0)}k` : '-';
    const price = m.currentPriceYes ? `${(m.currentPriceYes*100).toFixed(0)}%` : '-';
    const kws = m.matchedKeywords.slice(0, 4).join(', ');
    console.log(`  • ${m.question.substring(0, 65)}${m.question.length > 65 ? '...' : ''}`);
    console.log(`    Vol: ${vol} | YES: ${price} | Keywords: ${kws}`);
  }
  if (catMarkets.length > 20) {
    console.log(`  ... und ${catMarkets.length - 20} weitere`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('Diese Liste wird täglich durch sync-german-watchlist.ts aktualisiert');
console.log('═══════════════════════════════════════════════════════════════');
