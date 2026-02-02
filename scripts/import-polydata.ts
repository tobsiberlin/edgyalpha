#!/usr/bin/env tsx
/**
 * CLI fuer poly_data CSV Import
 *
 * Usage:
 *   npm run import:polydata -- --all              # Alles importieren
 *   npm run import:polydata -- --markets          # Nur markets
 *   npm run import:polydata -- --trades           # Nur trades
 *   npm run import:polydata -- --since 2024-01-01 # Inkrementell
 *   npm run import:polydata -- --stats            # Nur Stats zeigen
 *   npm run import:polydata -- --dir ./data/polydata  # Custom Verzeichnis
 */

import { resolve } from 'path';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import { loadAll, loadMarkets, loadTrades, type LoaderStats, type ProgressInfo } from '../src/data/polydata/loader.js';
import { getStats } from '../src/storage/repositories/historical.js';
import { initDatabase } from '../src/storage/db.js';

// CLI Argumente parsen
const args = process.argv.slice(2);

interface CliOptions {
  all: boolean;
  markets: boolean;
  trades: boolean;
  stats: boolean;
  since?: Date;
  dir: string;
  batchSize: number;
  help: boolean;
}

function parseArgs(): CliOptions {
  const options: CliOptions = {
    all: false,
    markets: false,
    trades: false,
    stats: false,
    since: undefined,
    dir: './data/polydata',
    batchSize: 10000,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--all':
      case '-a':
        options.all = true;
        break;
      case '--markets':
      case '-m':
        options.markets = true;
        break;
      case '--trades':
      case '-t':
        options.trades = true;
        break;
      case '--stats':
      case '-s':
        options.stats = true;
        break;
      case '--since':
        if (args[i + 1]) {
          const date = new Date(args[++i]);
          if (!isNaN(date.getTime())) {
            options.since = date;
          } else {
            console.error(chalk.red(`Ungueltiges Datum: ${args[i]}`));
            process.exit(1);
          }
        }
        break;
      case '--dir':
      case '-d':
        if (args[i + 1]) {
          options.dir = args[++i];
        }
        break;
      case '--batch':
      case '-b':
        if (args[i + 1]) {
          const size = parseInt(args[++i], 10);
          if (!isNaN(size) && size > 0) {
            options.batchSize = size;
          }
        }
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

function showHelp(): void {
  console.log(`
${chalk.bold('poly_data CSV Import')}

${chalk.yellow('Usage:')}
  npm run import:polydata -- [options]

${chalk.yellow('Options:')}
  --all, -a              Importiere markets und trades
  --markets, -m          Importiere nur markets.csv
  --trades, -t           Importiere nur trades.csv
  --stats, -s            Zeige nur Statistiken (kein Import)
  --since <date>         Nur Daten nach diesem Datum (YYYY-MM-DD)
  --dir, -d <path>       Pfad zum poly_data Verzeichnis (default: ./data/polydata)
  --batch, -b <size>     Batch-Groesse (default: 10000)
  --help, -h             Zeige diese Hilfe

${chalk.yellow('Beispiele:')}
  npm run import:polydata -- --all
  npm run import:polydata -- --trades --since 2024-01-01
  npm run import:polydata -- --stats
  npm run import:polydata -- --dir /path/to/poly_data --all
`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString('de-DE');
}

function showStats(): void {
  const stats = getStats();

  console.log(`
${chalk.bold.cyan('=== Historische Daten Statistiken ===')}

${chalk.yellow('Markets:')}  ${formatNumber(stats.marketCount)} total
           ${formatNumber(stats.resolvedCount)} resolved (${stats.marketCount > 0 ? ((stats.resolvedCount / stats.marketCount) * 100).toFixed(1) : 0}%)

${chalk.yellow('Trades:')}   ${formatNumber(stats.tradeCount)} total

${chalk.yellow('Zeitraum:')} ${stats.dateRange.from ? stats.dateRange.from.toISOString().split('T')[0] : 'N/A'} bis ${stats.dateRange.to ? stats.dateRange.to.toISOString().split('T')[0] : 'N/A'}
`);
}

function printResults(stats: LoaderStats): void {
  console.log(`
${chalk.bold.green('=== Import abgeschlossen ===')}

${chalk.yellow('Markets:')}
  Geladen:    ${formatNumber(stats.marketsLoaded)}
  Uebersprungen: ${formatNumber(stats.marketsSkipped)}

${chalk.yellow('Trades:')}
  Geladen:    ${formatNumber(stats.tradesLoaded)}
  Uebersprungen: ${formatNumber(stats.tradesSkipped)}

${chalk.yellow('Dauer:')}     ${formatDuration(stats.duration)}
`);

  if (stats.errors.length > 0) {
    console.log(chalk.red('\nFehler:'));
    stats.errors.forEach((err) => console.log(chalk.red(`  - ${err}`)));
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Datenbank initialisieren
  console.log(chalk.dim('Initialisiere Datenbank...'));
  initDatabase();

  // Nur Stats anzeigen?
  if (options.stats) {
    showStats();
    process.exit(0);
  }

  // Default: --all wenn nichts angegeben
  if (!options.markets && !options.trades && !options.all) {
    options.all = true;
  }

  const dataDir = resolve(options.dir);
  console.log(chalk.dim(`\nDatenverzeichnis: ${dataDir}`));

  if (options.since) {
    console.log(chalk.dim(`Filter: Nur Daten seit ${options.since.toISOString().split('T')[0]}`));
  }

  // Progress Bar erstellen
  const progressBar = new cliProgress.SingleBar(
    {
      format: `{type} |${chalk.cyan('{bar}')}| {percentage}% | {value}/{total} | ETA: {eta_formatted}`,
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_classic
  );

  let currentType: 'markets' | 'trades' | null = null;

  const onProgress = (progress: ProgressInfo): void => {
    if (currentType !== progress.type) {
      if (currentType !== null) {
        progressBar.stop();
        console.log(''); // Neue Zeile nach Progress Bar
      }
      currentType = progress.type;
      progressBar.start(progress.totalEstimate || 1, 0, {
        type: progress.type === 'markets' ? 'Markets ' : 'Trades  ',
      });
    }

    progressBar.update(progress.processed, {
      total: progress.totalEstimate || progress.processed,
    });
  };

  let stats: LoaderStats;

  try {
    if (options.all) {
      stats = await loadAll({
        dataDir,
        batchSize: options.batchSize,
        since: options.since,
        onProgress,
      });
    } else if (options.markets) {
      stats = await loadMarkets({
        dataDir,
        batchSize: options.batchSize,
        since: options.since,
        onProgress,
      });
    } else {
      stats = await loadTrades({
        dataDir,
        batchSize: options.batchSize,
        since: options.since,
        onProgress,
      });
    }

    progressBar.stop();
    printResults(stats);

    // Zeige aktuelle Stats
    showStats();
  } catch (err) {
    progressBar.stop();
    console.error(chalk.red(`\nFehler beim Import: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

main();
