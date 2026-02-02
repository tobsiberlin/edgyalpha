#!/usr/bin/env npx tsx

/**
 * Zeigt die komplette deutsche Markt-Watchlist (ungeclustert)
 */

import { initDatabase } from '../src/storage/db.js';
import { getActiveWatchlistMarkets, getWatchlistStats } from '../src/storage/repositories/germanWatchlist.js';

initDatabase();

const stats = getWatchlistStats();
console.log('═══════════════════════════════════════════════════════════════');
console.log('DEUTSCHE MARKT-WATCHLIST - KOMPLETTE LISTE');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`Total: ${stats.total} Märkte | Volume: $${(stats.totalVolume / 1000000).toFixed(2)}M`);
console.log();

const markets = getActiveWatchlistMarkets();

// Sortiere nach Volumen (höchstes zuerst)
markets.sort((a, b) => (b.volumeTotal || 0) - (a.volumeTotal || 0));

console.log('Nr | Kategorie    | Volume    | YES   | Frage');
console.log('---|--------------|-----------|-------|' + '-'.repeat(60));

let i = 1;
for (const m of markets) {
  const vol = m.volumeTotal ? `$${(m.volumeTotal/1000).toFixed(0)}k`.padStart(8) : '      -';
  const price = m.currentPriceYes ? `${(m.currentPriceYes*100).toFixed(0)}%`.padStart(4) : '   -';
  const cat = m.category.padEnd(12);
  const question = m.question.substring(0, 60);

  console.log(`${String(i).padStart(2)} | ${cat} | ${vol} | ${price} | ${question}`);
  i++;
}

console.log();
console.log('═══════════════════════════════════════════════════════════════');
console.log(`Gesamt: ${markets.length} Märkte`);
