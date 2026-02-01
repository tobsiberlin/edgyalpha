#!/usr/bin/env tsx
/**
 * CLI Tool zum Abrufen von Polymarket Märkten
 *
 * Verwendung:
 *   npm run markets -- --minVolume 10000 --limit 50
 *   npm run markets -- --category politics --limit 20
 *   npm run markets -- --help
 *
 * Standalone-Script (keine polymarket-Client Abhängigkeit wegen p-limit Bug in Node v24)
 */

import axios from 'axios';

const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const MAX_MARKETS_CAP = 2000;

type MarketCategory =
  | 'politics'
  | 'economics'
  | 'crypto'
  | 'sports'
  | 'tech'
  | 'entertainment'
  | 'weather'
  | 'science'
  | 'society'
  | 'geopolitics'
  | 'unknown';

interface CLIMarket {
  id: string;
  question: string;
  category: string;
  volume: number;
  volume24h: number;
  yesPrice: number;
  noPrice: number;
  spread: number;
}

// CLI Argumente parsen
function parseArgs(): {
  minVolume: number;
  limit: number;
  category?: string;
  json: boolean;
  help: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    minVolume: 0,
    limit: 50,
    category: undefined as string | undefined,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--minVolume':
      case '-v':
        result.minVolume = parseInt(nextArg, 10) || 0;
        i++;
        break;
      case '--limit':
      case '-l':
        result.limit = parseInt(nextArg, 10) || 50;
        i++;
        break;
      case '--category':
      case '-c':
        result.category = nextArg;
        i++;
        break;
      case '--json':
      case '-j':
        result.json = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Polymarket Markets CLI

Verwendung:
  npm run markets -- [optionen]

Optionen:
  --minVolume, -v <number>   Minimum Total Volume in USD (default: 0)
  --limit, -l <number>       Maximum Anzahl Märkte (default: 50)
  --category, -c <string>    Filter nach Kategorie (politics, crypto, etc.)
  --json, -j                 Output als JSON
  --help, -h                 Diese Hilfe anzeigen

Beispiele:
  npm run markets -- --minVolume 10000 --limit 50
  npm run markets -- --category politics --limit 20
  npm run markets -- --json

Kategorien:
  politics, economics, crypto, sports, tech, entertainment,
  weather, science, society, geopolitics, unknown
`);
}

function formatVolume(volume: number): string {
  if (volume >= 1_000_000) {
    return `$${(volume / 1_000_000).toFixed(2)}M`;
  } else if (volume >= 1_000) {
    return `$${(volume / 1_000).toFixed(1)}K`;
  }
  return `$${volume.toFixed(0)}`;
}

function formatPrice(price: number): string {
  return `${(price * 100).toFixed(1)}%`;
}

function formatSpread(spread: number): string {
  const percent = (spread * 100).toFixed(2);
  if (spread <= 0.02) return `\x1b[32m${percent}%\x1b[0m`; // Grün
  if (spread <= 0.05) return `\x1b[33m${percent}%\x1b[0m`; // Gelb
  return `\x1b[31m${percent}%\x1b[0m`; // Rot
}

function truncateQuestion(question: string, maxLen: number = 60): string {
  if (question.length <= maxLen) return question;
  return question.substring(0, maxLen - 3) + '...';
}

function parseCategory(question: string): MarketCategory {
  const q = question.toLowerCase();

  // GEOPOLITICS ZUERST
  if (
    q.includes('ukraine') ||
    q.includes('russia') ||
    q.includes('putin') ||
    q.includes('zelensky') ||
    q.includes('ceasefire') ||
    q.includes('war ') ||
    q.includes(' war') ||
    q.includes('military') ||
    q.includes('nato')
  ) {
    return 'geopolitics';
  }

  // Politics
  if (
    q.includes('trump') ||
    q.includes('biden') ||
    q.includes('president') ||
    q.includes('congress') ||
    q.includes('election') ||
    q.includes('government') ||
    q.includes('merz') ||
    q.includes('scholz') ||
    q.includes('bundestag') ||
    q.includes('afd') ||
    q.includes('cdu') ||
    q.includes('germany') ||
    q.includes('eu ')
  ) {
    return 'politics';
  }

  // Economics
  if (
    q.includes('econom') ||
    q.includes('fed') ||
    q.includes('inflation') ||
    q.includes('stock') ||
    q.includes('gdp') ||
    q.includes('recession') ||
    q.includes('interest rate') ||
    q.includes('ecb') ||
    q.includes('eurozone')
  ) {
    return 'economics';
  }

  // Crypto
  if (
    q.includes('crypto') ||
    q.includes('bitcoin') ||
    q.includes('ethereum') ||
    q.includes('btc') ||
    q.includes('eth') ||
    q.includes('solana')
  ) {
    return 'crypto';
  }

  // Sports
  if (
    q.includes('nba') ||
    q.includes('nfl') ||
    q.includes('soccer') ||
    q.includes('football') ||
    q.includes('super bowl')
  ) {
    return 'sports';
  }

  // Tech
  if (
    q.includes('tech') ||
    q.includes(' ai ') ||
    q.includes('artificial intelligence') ||
    q.includes('openai') ||
    q.includes('tesla')
  ) {
    return 'tech';
  }

  // Entertainment
  if (q.includes('movie') || q.includes('oscar') || q.includes('grammy')) {
    return 'entertainment';
  }

  // Geopolitics Fallback
  if (q.includes('china') || q.includes('taiwan') || q.includes('israel')) {
    return 'geopolitics';
  }

  return 'unknown';
}

interface RawMarket {
  id?: string;
  conditionId?: string;
  question?: string;
  title?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  volume?: string | number;
  volumeNum?: number;
  volume24hr?: string | number;
}

function parseMarket(raw: RawMarket): CLIMarket | null {
  const question = String(raw.question || raw.title || '');
  if (!question) return null;

  // Parse outcome prices
  let outcomePrices: string[] = [];
  try {
    if (typeof raw.outcomePrices === 'string') {
      outcomePrices = JSON.parse(raw.outcomePrices);
    } else if (Array.isArray(raw.outcomePrices)) {
      outcomePrices = raw.outcomePrices;
    }
  } catch {
    outcomePrices = ['0.5', '0.5'];
  }

  const yesPrice = parseFloat(outcomePrices[0] || '0.5');
  const noPrice = parseFloat(outcomePrices[1] || '0.5');
  const spread = Math.abs(yesPrice + noPrice - 1);

  return {
    id: String(raw.id || raw.conditionId || ''),
    question,
    category: parseCategory(question),
    volume: parseFloat(String(raw.volume || raw.volumeNum || 0)),
    volume24h: parseFloat(String(raw.volume24hr || 0)),
    yesPrice,
    noPrice,
    spread,
  };
}

async function fetchMarkets(options: {
  minVolume: number;
  limit: number;
  category?: string;
}): Promise<CLIMarket[]> {
  const { minVolume, limit: maxResults, category } = options;

  const telemetry = {
    stage1_active: 0,
    stage2_volume: 0,
    stage3_filtered: 0,
    totalPages: 0,
    totalFetched: 0,
  };

  const allMarkets: CLIMarket[] = [];
  let offset = 0;
  const batchSize = 100;
  let hasMore = true;

  const client = axios.create({
    baseURL: GAMMA_API_URL,
    timeout: 30000,
  });

  while (hasMore && allMarkets.length < maxResults) {
    try {
      const response = await client.get('/markets', {
        params: {
          limit: batchSize,
          offset,
          active: true,
          closed: false,
        },
      });

      const rawMarkets = response.data as RawMarket[];
      telemetry.totalPages++;
      telemetry.totalFetched += rawMarkets.length;

      if (rawMarkets.length === 0) {
        hasMore = false;
      } else {
        telemetry.stage1_active += rawMarkets.length;

        // Parse und filtern
        for (const raw of rawMarkets) {
          const market = parseMarket(raw);
          if (!market) continue;

          // Volume Filter
          if (market.volume < minVolume) continue;
          telemetry.stage2_volume++;

          // Kategorie Filter
          if (category && market.category !== category) continue;
          telemetry.stage3_filtered++;

          allMarkets.push(market);

          if (allMarkets.length >= maxResults) break;
        }

        offset += batchSize;

        if (offset >= MAX_MARKETS_CAP) {
          hasMore = false;
        }
      }
    } catch (error) {
      console.error('API Fehler:', error);
      hasMore = false;
    }
  }

  console.log(
    `[MARKETS] Stage 1: ${telemetry.stage1_active} active -> Stage 2: ${telemetry.stage2_volume} with volume -> Stage 3: ${telemetry.stage3_filtered} filtered`
  );
  console.log(
    `[MARKETS] ${telemetry.totalPages} Pages, ${telemetry.totalFetched} total fetched`
  );

  // Nach Volume sortieren
  allMarkets.sort((a, b) => b.volume - a.volume);

  return allMarkets.slice(0, maxResults);
}

function printTable(markets: CLIMarket[]): void {
  console.log('\n' + '='.repeat(120));
  console.log('POLYMARKET MAERKTE');
  console.log('='.repeat(120));

  // Header
  console.log(
    `${'#'.padEnd(4)} ${'Kategorie'.padEnd(12)} ${'Volume'.padEnd(10)} ${'24h Vol'.padEnd(10)} ${'Yes'.padEnd(8)} ${'No'.padEnd(8)} ${'Spread'.padEnd(10)} Frage`
  );
  console.log('-'.repeat(120));

  // Rows
  markets.forEach((m, i) => {
    const row = [
      String(i + 1).padEnd(4),
      m.category.padEnd(12),
      formatVolume(m.volume).padEnd(10),
      formatVolume(m.volume24h).padEnd(10),
      formatPrice(m.yesPrice).padEnd(8),
      formatPrice(m.noPrice).padEnd(8),
      formatSpread(m.spread).padEnd(10),
      truncateQuestion(m.question),
    ].join(' ');
    console.log(row);
  });

  console.log('-'.repeat(120));
  console.log(`Total: ${markets.length} Maerkte`);
  console.log('='.repeat(120) + '\n');
}

function printStats(markets: CLIMarket[]): void {
  const totalVolume = markets.reduce((sum, m) => sum + m.volume, 0);
  const avgSpread = markets.length > 0 ? markets.reduce((sum, m) => sum + m.spread, 0) / markets.length : 0;

  // Kategorie-Verteilung
  const categories: Record<string, number> = {};
  markets.forEach((m) => {
    categories[m.category] = (categories[m.category] || 0) + 1;
  });

  console.log('STATISTIKEN');
  console.log('-'.repeat(40));
  console.log(`Gesamt-Volume: ${formatVolume(totalVolume)}`);
  console.log(`Durchschnittlicher Spread: ${(avgSpread * 100).toFixed(2)}%`);
  console.log('\nKategorien:');
  Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      console.log(`  ${cat}: ${count}`);
    });
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`\nLade Polymarket Maerkte...`);
  console.log(`  MinVolume: $${args.minVolume.toLocaleString()}`);
  console.log(`  Limit: ${args.limit}`);
  if (args.category) {
    console.log(`  Kategorie: ${args.category}`);
  }

  try {
    const markets = await fetchMarkets({
      minVolume: args.minVolume,
      limit: args.limit,
      category: args.category,
    });

    if (args.json) {
      console.log(JSON.stringify(markets, null, 2));
    } else {
      printTable(markets);
      printStats(markets);
    }
  } catch (error) {
    console.error('Fehler beim Laden der Maerkte:', error);
    process.exit(1);
  }
}

main();
