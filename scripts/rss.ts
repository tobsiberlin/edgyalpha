#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════════
//                    RSS CLI TOOL
// Nutzung: npm run rss -- --health | --fetch | --test <url>
// ═══════════════════════════════════════════════════════════════

import {
  fetchAllRSSFeeds,
  fetchRSSFeed,
  getFeedHealth,
  getHealthSummary,
  WORKING_RSS_FEEDS,
  EXPERIMENTAL_RSS_FEEDS,
  type NewsItem,
  type FeedHealth,
} from '../src/germany/rss.js';

const args = process.argv.slice(2);

function printUsage(): void {
  console.log(`
RSS Feed CLI Tool
═══════════════════════════════════════════════════════════════

Befehle:
  --health              Zeigt Health-Status aller Feeds
  --fetch               Fetched alle Feeds und zeigt Items
  --fetch-experimental  Fetched auch experimentelle Feeds
  --test <url>          Testet einen einzelnen Feed
  --list                Listet alle konfigurierten Feeds
  --categories          Zeigt Items gruppiert nach Kategorie

Optionen:
  --limit <n>           Begrenzt Ausgabe auf n Items (default: 20)
  --category <cat>      Filtert nach Kategorie (politics, economics, sports, geopolitics, tech, crypto)

Beispiele:
  npm run rss -- --health
  npm run rss -- --fetch --limit 10
  npm run rss -- --fetch --category politics
  npm run rss -- --test "https://www.tagesschau.de/xml/rss2/"
  `);
}

function formatDate(date: Date | null): string {
  if (!date) return 'nie';
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusIcon(status: string): string {
  switch (status) {
    case 'ok': return '[OK]';
    case 'error': return '[FAIL]';
    case 'timeout': return '[TIMEOUT]';
    default: return '[?]';
  }
}

async function showHealth(): Promise<void> {
  console.log('\nLade Feed-Status...\n');

  // Einmal fetchen um Health-Daten zu sammeln
  await fetchAllRSSFeeds({ includeExperimental: true });

  const health = getFeedHealth();
  const summary = getHealthSummary();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    RSS FEED HEALTH STATUS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Summary
  console.log(`Gesamt: ${summary.total} Feeds`);
  console.log(`  OK:      ${summary.ok}`);
  console.log(`  Error:   ${summary.error}`);
  console.log(`  Timeout: ${summary.timeout}`);
  console.log(`  Unbekannt: ${summary.unknown}`);
  console.log(`  Durchschnittliche Erfolgsrate: ${summary.avgSuccessRate}%\n`);

  // Gruppiert nach Status
  const grouped = {
    ok: health.filter(h => h.status === 'ok'),
    error: health.filter(h => h.status === 'error'),
    timeout: health.filter(h => h.status === 'timeout'),
    unknown: health.filter(h => h.status === 'unknown'),
  };

  // OK Feeds
  if (grouped.ok.length > 0) {
    console.log('\n[OK] Funktionierende Feeds:');
    console.log('─'.repeat(60));
    for (const feed of grouped.ok) {
      console.log(`  ${feed.name.padEnd(25)} ${feed.lastItemCount.toString().padStart(3)} Items  ${feed.avgFetchTimeMs}ms  ${feed.successRate}%`);
    }
  }

  // Error Feeds
  if (grouped.error.length > 0) {
    console.log('\n[FAIL] Fehlerhafte Feeds:');
    console.log('─'.repeat(60));
    for (const feed of grouped.error) {
      console.log(`  ${feed.name.padEnd(25)} ${feed.errorMessage?.substring(0, 40) || 'Unbekannter Fehler'}`);
    }
  }

  // Timeout Feeds
  if (grouped.timeout.length > 0) {
    console.log('\n[TIMEOUT] Timeout-Feeds:');
    console.log('─'.repeat(60));
    for (const feed of grouped.timeout) {
      console.log(`  ${feed.name.padEnd(25)} ${feed.avgFetchTimeMs}ms`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

async function fetchAndShow(includeExperimental: boolean, limit: number, category?: string): Promise<void> {
  console.log('\nFetche RSS Feeds...\n');

  const categories = category ? [category] : undefined;
  const result = await fetchAllRSSFeeds({
    includeExperimental,
    categories,
  });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    RSS FEED ERGEBNISSE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`Feeds:     ${result.successfulFeeds}/${result.totalFeeds} erfolgreich`);
  console.log(`Items:     ${result.uniqueItems} unique (${result.totalItems} total)`);
  console.log(`Dauer:     ${result.fetchDurationMs}ms`);
  console.log(`Filter:    ${category || 'alle Kategorien'}`);
  console.log('\n' + '-'.repeat(60));

  const items = result.items.slice(0, limit);

  for (const item of items) {
    const age = Math.round((Date.now() - item.publishedAt.getTime()) / 1000 / 60);
    const ageStr = age < 60 ? `${age}m` : `${Math.round(age / 60)}h`;

    console.log(`\n[${item.category.toUpperCase().padEnd(10)}] ${item.source}`);
    console.log(`  ${item.title.substring(0, 80)}${item.title.length > 80 ? '...' : ''}`);
    console.log(`  ${ageStr} ago | ${item.url?.substring(0, 60) || 'Keine URL'}...`);
  }

  if (result.items.length > limit) {
    console.log(`\n... und ${result.items.length - limit} weitere Items`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

async function testFeed(url: string): Promise<void> {
  console.log(`\nTeste Feed: ${url}\n`);

  const result = await fetchRSSFeed(url, 'Test Feed', 'test', 10000);

  if (result.success) {
    console.log(`[OK] Feed erfolgreich geladen in ${result.fetchTimeMs}ms`);
    console.log(`Items: ${result.items.length}\n`);

    for (const item of result.items.slice(0, 5)) {
      console.log(`  - ${item.title.substring(0, 70)}${item.title.length > 70 ? '...' : ''}`);
    }

    if (result.items.length > 5) {
      console.log(`  ... und ${result.items.length - 5} weitere`);
    }
  } else {
    console.log(`[FAIL] Feed-Fehler: ${result.error}`);
    console.log(`Dauer: ${result.fetchTimeMs}ms`);
  }
}

function listFeeds(): void {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    KONFIGURIERTE RSS FEEDS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`WORKING FEEDS (${WORKING_RSS_FEEDS.length}):`);
  console.log('─'.repeat(60));

  const byCategory = new Map<string, typeof WORKING_RSS_FEEDS>();
  for (const feed of WORKING_RSS_FEEDS) {
    const list = byCategory.get(feed.category) || [];
    list.push(feed);
    byCategory.set(feed.category, list);
  }

  for (const [cat, feeds] of byCategory) {
    console.log(`\n  [${cat.toUpperCase()}]`);
    for (const feed of feeds) {
      console.log(`    - ${feed.name.padEnd(25)} ${feed.url}`);
    }
  }

  console.log(`\n\nEXPERIMENTAL FEEDS (${EXPERIMENTAL_RSS_FEEDS.length}):`);
  console.log('─'.repeat(60));

  const byCategory2 = new Map<string, typeof EXPERIMENTAL_RSS_FEEDS>();
  for (const feed of EXPERIMENTAL_RSS_FEEDS) {
    const list = byCategory2.get(feed.category) || [];
    list.push(feed);
    byCategory2.set(feed.category, list);
  }

  for (const [cat, feeds] of byCategory2) {
    console.log(`\n  [${cat.toUpperCase()}]`);
    for (const feed of feeds) {
      console.log(`    - ${feed.name.padEnd(25)} ${feed.url}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

async function showByCategory(limit: number): Promise<void> {
  console.log('\nFetche RSS Feeds...\n');

  const result = await fetchAllRSSFeeds({ includeExperimental: true });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    NEWS NACH KATEGORIE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const byCategory = new Map<string, NewsItem[]>();
  for (const item of result.items) {
    const list = byCategory.get(item.category) || [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  const categories = ['politics', 'economics', 'geopolitics', 'sports', 'tech', 'crypto'];

  for (const cat of categories) {
    const items = byCategory.get(cat) || [];
    if (items.length === 0) continue;

    console.log(`\n[${cat.toUpperCase()}] (${items.length} Items)`);
    console.log('─'.repeat(60));

    for (const item of items.slice(0, Math.ceil(limit / categories.length))) {
      const age = Math.round((Date.now() - item.publishedAt.getTime()) / 1000 / 60);
      const ageStr = age < 60 ? `${age}m` : `${Math.round(age / 60)}h`;
      console.log(`  [${ageStr.padStart(4)}] ${item.source.padEnd(20)} ${item.title.substring(0, 50)}...`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

// Main
async function main(): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const limit = args.includes('--limit')
    ? parseInt(args[args.indexOf('--limit') + 1], 10) || 20
    : 20;

  const category = args.includes('--category')
    ? args[args.indexOf('--category') + 1]
    : undefined;

  if (args.includes('--health')) {
    await showHealth();
  } else if (args.includes('--fetch-experimental')) {
    await fetchAndShow(true, limit, category);
  } else if (args.includes('--fetch')) {
    await fetchAndShow(false, limit, category);
  } else if (args.includes('--test')) {
    const url = args[args.indexOf('--test') + 1];
    if (!url || url.startsWith('--')) {
      console.error('Fehler: URL fehlt nach --test');
      process.exit(1);
    }
    await testFeed(url);
  } else if (args.includes('--list')) {
    listFeeds();
  } else if (args.includes('--categories')) {
    await showByCategory(limit);
  } else {
    console.error('Unbekannter Befehl. Nutze --help für Hilfe.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
