#!/usr/bin/env tsx
/**
 * Generiert Demo-Daten fuer Backtest-Tests
 *
 * Usage:
 *   npm run generate:demo           # 100 Markets, 10000 Trades
 *   npm run generate:demo -- --markets 50 --trades 5000
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

interface DemoConfig {
  marketsCount: number;
  tradesPerMarket: number;
  outputDir: string;
}

function parseArgs(): DemoConfig {
  const args = process.argv.slice(2);
  const config: DemoConfig = {
    marketsCount: 100,
    tradesPerMarket: 100,
    outputDir: './data/polydata',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--markets':
        if (args[i + 1]) config.marketsCount = parseInt(args[++i], 10);
        break;
      case '--trades':
        if (args[i + 1]) config.tradesPerMarket = parseInt(args[++i], 10);
        break;
      case '--dir':
        if (args[i + 1]) config.outputDir = args[++i];
        break;
    }
  }

  return config;
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function generateMarketId(): string {
  return '0x' + Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

function generateTxHash(): string {
  return '0x' + Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

function generateAddress(): string {
  return '0x' + Array.from({ length: 40 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

const QUESTIONS = [
  'Will {subject} win the {event}?',
  'Will {subject} reach {target} by {date}?',
  'Will {subject} announce {event} in {year}?',
  'Will {subject} be above {target} on {date}?',
  'Will {subject} happen before {date}?',
];

const SUBJECTS = [
  'Bitcoin', 'Ethereum', 'Trump', 'Biden', 'Germany', 'France',
  'Apple', 'Tesla', 'SpaceX', 'OpenAI', 'Fed', 'ECB',
  'S&P 500', 'Gold', 'Oil', 'Interest Rates'
];

const EVENTS = [
  'election', 'championship', 'summit', 'conference', 'referendum'
];

const TARGETS = [
  '$100k', '$50k', '10%', '5%', '1 million', '50%'
];

function generateQuestion(): { question: string; answer1: string; answer2: string } {
  const template = randomChoice(QUESTIONS);
  const subject = randomChoice(SUBJECTS);
  const event = randomChoice(EVENTS);
  const target = randomChoice(TARGETS);
  const year = 2024 + Math.floor(Math.random() * 2);
  const month = Math.floor(Math.random() * 12) + 1;
  const date = `${year}-${month.toString().padStart(2, '0')}-01`;

  const question = template
    .replace('{subject}', subject)
    .replace('{event}', event)
    .replace('{target}', target)
    .replace('{year}', year.toString())
    .replace('{date}', date);

  return {
    question,
    answer1: 'Yes',
    answer2: 'No',
  };
}

function generateMarkets(count: number): string {
  const headers = [
    'createdAt', 'id', 'question', 'answer1', 'answer2', 'neg_risk',
    'market_slug', 'token1', 'token2', 'condition_id', 'volume', 'ticker', 'closedTime'
  ];

  const rows: string[] = [headers.join(',')];
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const marketId = generateMarketId();
    const { question, answer1, answer2 } = generateQuestion();

    // Market wurde vor 30-180 Tagen erstellt
    const createdAt = now - (30 + Math.random() * 150) * 24 * 60 * 60 * 1000;

    // 70% der Markets sind geschlossen (fuer Backtesting)
    const isClosed = Math.random() < 0.7;
    const closedAt = isClosed
      ? createdAt + (10 + Math.random() * 60) * 24 * 60 * 60 * 1000
      : '';

    const volume = Math.floor(1000 + Math.random() * 500000);
    const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);

    const row = [
      Math.floor(createdAt / 1000).toString(), // Unix timestamp in Sekunden
      marketId,
      `"${question.replace(/"/g, '""')}"`,
      answer1,
      answer2,
      'false',
      slug,
      generateMarketId().slice(0, 42), // token1
      generateMarketId().slice(0, 42), // token2
      generateMarketId(), // condition_id
      volume.toString(),
      '',
      closedAt ? Math.floor(closedAt / 1000).toString() : '',
    ];

    rows.push(row.join(','));
  }

  return rows.join('\n');
}

function generateTrades(marketIds: string[], tradesPerMarket: number): string {
  const headers = [
    'timestamp', 'market_id', 'maker', 'taker', 'nonusdc_side',
    'maker_direction', 'taker_direction', 'price', 'usd_amount', 'token_amount', 'transactionHash'
  ];

  const rows: string[] = [headers.join(',')];
  const now = Date.now();

  for (const marketId of marketIds) {
    // Startzeit: vor 30-180 Tagen
    let timestamp = now - (30 + Math.random() * 150) * 24 * 60 * 60 * 1000;

    // Initiale Wahrscheinlichkeit
    let price = 0.3 + Math.random() * 0.4; // Start zwischen 30% und 70%

    for (let i = 0; i < tradesPerMarket; i++) {
      // Zeit voranschreiten (1 Min - 4 Stunden)
      timestamp += (60 + Math.random() * 14400) * 1000;

      // Preis aendert sich leicht (Random Walk)
      const change = (Math.random() - 0.5) * 0.05;
      price = Math.max(0.01, Math.min(0.99, price + change));

      const usdAmount = 10 + Math.random() * 1000;
      const tokenAmount = usdAmount / price;
      const direction = Math.random() > 0.5 ? 'buy' : 'sell';

      const row = [
        Math.floor(timestamp / 1000).toString(),
        marketId,
        generateAddress(),
        generateAddress(),
        direction,
        direction,
        direction === 'buy' ? 'sell' : 'buy',
        price.toFixed(4),
        usdAmount.toFixed(2),
        tokenAmount.toFixed(2),
        generateTxHash(),
      ];

      rows.push(row.join(','));
    }
  }

  return rows.join('\n');
}

async function main(): Promise<void> {
  const config = parseArgs();

  console.log(chalk.bold.blue('\n  EdgyAlpha Demo Data Generator\n'));
  console.log(chalk.gray(`  Markets:     ${config.marketsCount}`));
  console.log(chalk.gray(`  Trades/Mkt:  ${config.tradesPerMarket}`));
  console.log(chalk.gray(`  Total Trades: ~${config.marketsCount * config.tradesPerMarket}`));
  console.log(chalk.gray(`  Output:      ${config.outputDir}\n`));

  // Markets generieren
  console.log(chalk.yellow('Generiere Markets...'));
  const marketsCSV = generateMarkets(config.marketsCount);
  const marketsPath = join(config.outputDir, 'markets.csv');
  writeFileSync(marketsPath, marketsCSV, 'utf-8');
  console.log(chalk.green(`  ${marketsPath} geschrieben`));

  // Market IDs extrahieren
  const marketIds = marketsCSV
    .split('\n')
    .slice(1) // Header ueberspringen
    .map(line => {
      const parts = line.split(',');
      return parts[1]; // id ist 2. Spalte
    })
    .filter(id => id && id.startsWith('0x'));

  // Trades generieren
  console.log(chalk.yellow('Generiere Trades...'));
  const tradesCSV = generateTrades(marketIds, config.tradesPerMarket);
  const tradesPath = join(config.outputDir, 'trades.csv');
  writeFileSync(tradesPath, tradesCSV, 'utf-8');
  console.log(chalk.green(`  ${tradesPath} geschrieben`));

  console.log(chalk.bold.green('\nDemo-Daten erfolgreich generiert!'));
  console.log(chalk.gray('\nImportiere mit:'));
  console.log(chalk.cyan('  npm run import:polydata -- --all\n'));
}

main().catch(console.error);
