#!/usr/bin/env tsx
/**
 * Generiert realistische Backtest-Daten direkt in der Datenbank
 *
 * Usage:
 *   npm run generate:backtest                    # 50 Markets, 90 Tage
 *   npm run generate:backtest -- --markets 100   # 100 Markets
 *   npm run generate:backtest -- --days 180      # 180 Tage Historie
 *   npm run generate:backtest -- --clear         # Erst alle Daten loeschen
 */

import chalk from 'chalk';
import { initDatabase, getDatabase } from '../src/storage/db.js';
import {
  bulkInsertTrades,
  bulkInsertMarkets,
} from '../src/storage/repositories/historical.js';
import type {
  HistoricalTrade,
  HistoricalMarket,
} from '../src/alpha/types.js';

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

interface Config {
  marketsCount: number;
  daysOfHistory: number;
  tradesPerDay: { min: number; max: number };
  clearExisting: boolean;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    marketsCount: 50,
    daysOfHistory: 90,
    tradesPerDay: { min: 10, max: 50 },
    clearExisting: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--markets':
        if (args[i + 1]) config.marketsCount = parseInt(args[++i], 10);
        break;
      case '--days':
        if (args[i + 1]) config.daysOfHistory = parseInt(args[++i], 10);
        break;
      case '--clear':
        config.clearExisting = true;
        break;
    }
  }

  return config;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function generateMarketId(): string {
  return (
    '0x' +
    Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')
  );
}

function generateTxHash(): string {
  return (
    '0x' +
    Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')
  );
}

function generateAddress(): string {
  return (
    '0x' +
    Array.from({ length: 40 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')
  );
}

// ═══════════════════════════════════════════════════════════════
// MARKET TEMPLATES
// ═══════════════════════════════════════════════════════════════

const MARKET_TEMPLATES = [
  // Politik
  { category: 'politics', template: 'Will {party} win the {country} {year} election?', subjects: ['CDU/CSU', 'SPD', 'Greens', 'AfD', 'FDP', 'Republicans', 'Democrats'], countries: ['German', 'French', 'UK', 'US'] },
  { category: 'politics', template: 'Will {person} become {position} by {date}?', subjects: ['Merz', 'Scholz', 'Habeck', 'Trump', 'Biden', 'Macron'], positions: ['Chancellor', 'President', 'Prime Minister'] },
  { category: 'politics', template: 'Will {country} hold early elections in {year}?', countries: ['Germany', 'France', 'Italy', 'UK', 'Poland'] },

  // Wirtschaft
  { category: 'economy', template: 'Will {index} reach {target} by {date}?', subjects: ['S&P 500', 'DAX', 'Bitcoin', 'Ethereum', 'Gold', 'Oil'], targets: ['$100k', '20000', '50000', '$5000', '$150'] },
  { category: 'economy', template: 'Will the {bank} {action} rates in {month} {year}?', banks: ['Fed', 'ECB', 'BoE', 'BoJ'], actions: ['raise', 'cut', 'hold'] },
  { category: 'economy', template: 'Will {company} stock be above ${target} on {date}?', companies: ['Apple', 'Tesla', 'Nvidia', 'Microsoft', 'Google', 'Amazon'], targets: ['200', '300', '400', '500', '1000'] },

  // Geopolitik
  { category: 'geopolitics', template: 'Will {country} {action} by {date}?', countries: ['Russia', 'China', 'Iran', 'North Korea'], actions: ['sign a peace deal', 'lift sanctions', 'hold summit'] },
  { category: 'geopolitics', template: 'Will {org} expand in {year}?', orgs: ['NATO', 'EU', 'BRICS'], years: ['2025', '2026'] },

  // Technologie
  { category: 'tech', template: 'Will {company} release {product} in {year}?', companies: ['Apple', 'Google', 'OpenAI', 'Tesla', 'SpaceX'], products: ['new AI model', 'autonomous vehicle', 'VR headset', 'next-gen chip'] },
  { category: 'tech', template: 'Will {company} reach {metric} {users} users by {date}?', companies: ['ChatGPT', 'Claude', 'Threads', 'Bluesky'], metrics: ['100M', '500M', '1B'] },
];

function generateMarketQuestion(): { question: string; category: string } {
  const template = randomChoice(MARKET_TEMPLATES);
  let question = template.template;

  // Ersetze Platzhalter
  if (question.includes('{party}') && 'subjects' in template) {
    question = question.replace('{party}', randomChoice(template.subjects));
  }
  if (question.includes('{person}') && 'subjects' in template) {
    question = question.replace('{person}', randomChoice(template.subjects));
  }
  if (question.includes('{position}') && 'positions' in template) {
    question = question.replace('{position}', randomChoice(template.positions));
  }
  if (question.includes('{country}') && 'countries' in template) {
    question = question.replace('{country}', randomChoice(template.countries));
  }
  if (question.includes('{index}') && 'subjects' in template) {
    question = question.replace('{index}', randomChoice(template.subjects));
  }
  if (question.includes('{target}') && 'targets' in template) {
    question = question.replace('{target}', randomChoice(template.targets));
  }
  if (question.includes('{bank}') && 'banks' in template) {
    question = question.replace('{bank}', randomChoice(template.banks));
  }
  if (question.includes('{action}') && 'actions' in template) {
    question = question.replace('{action}', randomChoice(template.actions));
  }
  if (question.includes('{company}') && 'companies' in template) {
    question = question.replace('{company}', randomChoice(template.companies));
  }
  if (question.includes('{product}') && 'products' in template) {
    question = question.replace('{product}', randomChoice(template.products));
  }
  if (question.includes('{metric}') && 'metrics' in template) {
    question = question.replace('{metric}', randomChoice(template.metrics));
  }
  if (question.includes('{org}') && 'orgs' in template) {
    question = question.replace('{org}', randomChoice(template.orgs));
  }

  // Datum-Platzhalter
  const year = randomChoice(['2025', '2026']);
  const month = randomChoice(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
  const day = randomInt(1, 28);
  const date = `${month} ${day}, ${year}`;

  question = question.replace('{year}', year);
  question = question.replace('{month}', month);
  question = question.replace('{date}', date);
  question = question.replace('{users}', '');

  return { question: question.trim(), category: template.category };
}

// ═══════════════════════════════════════════════════════════════
// DATA GENERATION
// ═══════════════════════════════════════════════════════════════

function generateMarkets(count: number, daysOfHistory: number): HistoricalMarket[] {
  const markets: HistoricalMarket[] = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const { question, category } = generateMarketQuestion();

    // Markt wurde vor X Tagen erstellt
    const daysAgo = randomInt(daysOfHistory / 2, daysOfHistory);
    const createdAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);

    // 80% der Maerkte sind abgeschlossen
    const isClosed = Math.random() < 0.8;
    const closedAt = isClosed
      ? new Date(createdAt.getTime() + randomInt(5, 30) * 24 * 60 * 60 * 1000)
      : null;

    // Nur geschlossene Maerkte haben ein Outcome
    // Outcome wird basierend auf "Realismus" gesetzt (nicht zufaellig 50/50)
    let outcome: HistoricalMarket['outcome'] = null;
    if (isClosed) {
      // Simuliere realistische Outcomes:
      // - Fragen mit hoher Wahrscheinlichkeit ("Will X reach target") scheitern oft
      // - Politik-Fragen sind unvorhersehbarer
      const yesProb = question.includes('reach') || question.includes('above')
        ? 0.35 // Ziele werden oft nicht erreicht
        : question.includes('election')
          ? 0.5 // Wahlen sind 50/50
          : 0.45; // Default etwas unter 50%

      outcome = Math.random() < yesProb ? 'answer1' : 'answer2';
    }

    const volume = randomInt(10000, 500000);
    const slug = question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 50);

    markets.push({
      marketId: generateMarketId(),
      conditionId: generateMarketId(),
      question,
      answer1: 'Yes',
      answer2: 'No',
      token1: generateMarketId().slice(0, 42),
      token2: generateMarketId().slice(0, 42),
      marketSlug: slug,
      volumeTotal: volume,
      createdAt,
      closedAt,
      outcome,
    });
  }

  return markets;
}

function generateTradesForMarket(
  market: HistoricalMarket,
  config: Config
): HistoricalTrade[] {
  const trades: HistoricalTrade[] = [];

  if (!market.createdAt) return trades;

  const endDate = market.closedAt || new Date();
  const startDate = market.createdAt;
  const totalDays = Math.ceil(
    (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)
  );

  if (totalDays <= 0) return trades;

  // Initiale Wahrscheinlichkeit (beeinflusst von Outcome fuer Realismus)
  let price: number;
  if (market.outcome === 'answer1') {
    // Markt endet bei Yes -> Preis tendiert nach oben
    price = randomFloat(0.3, 0.5);
  } else if (market.outcome === 'answer2') {
    // Markt endet bei No -> Preis tendiert nach unten
    price = randomFloat(0.5, 0.7);
  } else {
    // Offener Markt
    price = randomFloat(0.4, 0.6);
  }

  // Drift Richtung Outcome
  const driftDirection = market.outcome === 'answer1' ? 1 : market.outcome === 'answer2' ? -1 : 0;
  const driftStrength = 0.002; // Kleine taegliche Drift

  // Generiere Trades fuer jeden Tag
  for (let day = 0; day < totalDays; day++) {
    const dayStart = new Date(
      startDate.getTime() + day * 24 * 60 * 60 * 1000
    );

    // Mehr Trades gegen Ende des Markts
    const isNearEnd = day > totalDays * 0.7;
    const tradesCount = isNearEnd
      ? randomInt(config.tradesPerDay.max, config.tradesPerDay.max * 2)
      : randomInt(config.tradesPerDay.min, config.tradesPerDay.max);

    for (let t = 0; t < tradesCount; t++) {
      // Zeitpunkt im Tag
      const timeOffset = randomInt(0, 24 * 60 * 60 * 1000 - 1);
      const timestamp = new Date(dayStart.getTime() + timeOffset);

      // Preisaenderung: Random Walk + Drift
      const noise = (Math.random() - 0.5) * 0.04; // +/- 2%
      const drift = driftDirection * driftStrength;
      price = Math.max(0.02, Math.min(0.98, price + noise + drift));

      // Am Ende des Markts: Preis naehert sich 0 oder 1
      if (market.closedAt && isNearEnd) {
        const finalPrice = market.outcome === 'answer1' ? 0.95 : 0.05;
        price = price * 0.95 + finalPrice * 0.05;
      }

      const usdAmount = randomFloat(10, 500);
      const tokenAmount = usdAmount / price;
      const direction = Math.random() > 0.5 ? 'buy' : 'sell';

      trades.push({
        timestamp,
        marketId: market.marketId,
        price: Math.round(price * 10000) / 10000,
        usdAmount: Math.round(usdAmount * 100) / 100,
        tokenAmount: Math.round(tokenAmount * 100) / 100,
        maker: generateAddress(),
        taker: generateAddress(),
        makerDirection: direction,
        takerDirection: direction === 'buy' ? 'sell' : 'buy',
        txHash: generateTxHash(),
      });
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const config = parseArgs();

  console.log(chalk.bold.blue('\n  EdgyAlpha Backtest Data Generator\n'));
  console.log(chalk.gray(`  Markets:     ${config.marketsCount}`));
  console.log(chalk.gray(`  Days:        ${config.daysOfHistory}`));
  console.log(chalk.gray(`  Trades/Day:  ${config.tradesPerDay.min}-${config.tradesPerDay.max}`));
  console.log(chalk.gray(`  Clear:       ${config.clearExisting ? 'Ja' : 'Nein'}`));
  console.log('');

  // Datenbank initialisieren
  console.log(chalk.yellow('Initialisiere Datenbank...'));
  initDatabase();
  const db = getDatabase();

  // Optional: Alte Daten loeschen
  if (config.clearExisting) {
    console.log(chalk.yellow('Loesche existierende Daten...'));
    db.exec('DELETE FROM historical_trades');
    db.exec('DELETE FROM historical_markets');
    console.log(chalk.green('  Daten geloescht'));
  }

  // Markets generieren
  console.log(chalk.yellow('\nGeneriere Markets...'));
  const markets = generateMarkets(config.marketsCount, config.daysOfHistory);

  const insertedMarkets = bulkInsertMarkets(markets);
  console.log(chalk.green(`  ${insertedMarkets} Markets eingefuegt`));

  // Trades fuer jeden Markt generieren
  console.log(chalk.yellow('\nGeneriere Trades...'));
  let totalTrades = 0;

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    const trades = generateTradesForMarket(market, config);

    if (trades.length > 0) {
      const inserted = bulkInsertTrades(trades);
      totalTrades += inserted;
    }

    // Fortschritt alle 10 Markets
    if ((i + 1) % 10 === 0 || i === markets.length - 1) {
      process.stdout.write(
        `\r  ${i + 1}/${markets.length} Markets verarbeitet, ${totalTrades.toLocaleString()} Trades...`
      );
    }
  }
  console.log(chalk.green(`\n  ${totalTrades.toLocaleString()} Trades eingefuegt`));

  // Statistiken anzeigen
  console.log(chalk.yellow('\nStatistiken:'));
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM historical_markets) as markets,
      (SELECT COUNT(*) FROM historical_markets WHERE outcome IS NOT NULL) as resolved,
      (SELECT COUNT(*) FROM historical_trades) as trades,
      (SELECT MIN(timestamp) FROM historical_trades) as min_date,
      (SELECT MAX(timestamp) FROM historical_trades) as max_date
  `).get() as {
    markets: number;
    resolved: number;
    trades: number;
    min_date: string;
    max_date: string;
  };

  console.log(chalk.gray(`  Markets:          ${stats.markets}`));
  console.log(chalk.gray(`  Davon resolved:   ${stats.resolved} (${((stats.resolved / stats.markets) * 100).toFixed(0)}%)`));
  console.log(chalk.gray(`  Trades:           ${stats.trades.toLocaleString()}`));
  console.log(chalk.gray(`  Zeitraum:         ${stats.min_date?.slice(0, 10)} bis ${stats.max_date?.slice(0, 10)}`));

  console.log(chalk.bold.green('\nBacktest-Daten erfolgreich generiert!'));
  console.log(chalk.gray('\nBacktest ausfuehren mit:'));
  console.log(chalk.cyan('  npm run backtest\n'));
}

main().catch((err) => {
  console.error(chalk.red('Fehler:'), err);
  process.exit(1);
});
