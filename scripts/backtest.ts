#!/usr/bin/env tsx
/**
 * Backtest CLI Script
 *
 * Usage:
 *   npm run backtest -- --from 2024-01-01 --to 2024-06-30 --engine timeDelay
 *   npm run backtest -- --from 2024-01-01 --to 2024-06-30 --engine mispricing
 *   npm run backtest -- --from 2024-01-01 --to 2024-06-30 --engine meta
 *   npm run backtest -- --engine meta --no-slippage
 *   npm run backtest -- --help
 */

import {
  runBacktest,
  generateConsoleOutput,
  saveReports,
  BacktestOptions,
} from '../src/backtest/index.js';
import { getStats } from '../src/storage/repositories/historical.js';
import { initDatabase } from '../src/storage/db.js';
import chalk from 'chalk';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════
// CLI ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════

interface CliArgs {
  from?: Date;
  to?: Date;
  engine: 'timeDelay' | 'mispricing' | 'meta';
  slippage: boolean;
  bankroll: number;
  output: string;
  verbose: boolean;
  help: boolean;
  // NEU: Validation & Monte Carlo
  validation: boolean;
  trainTestSplit: number;
  monteCarlo: boolean;
  monteCarloSims: number;
  walkForwardWindow: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  const result: CliArgs = {
    engine: 'meta',
    slippage: true,
    bankroll: 1000,
    output: './backtest-results',
    verbose: false,
    help: false,
    // NEU: Defaults fuer Validation & Monte Carlo
    validation: true,
    trainTestSplit: 0.7,
    monteCarlo: true,
    monteCarloSims: 1000,
    walkForwardWindow: 90, // GEAENDERT: Von 30 auf 90 Tage
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--help':
      case '-h':
        result.help = true;
        break;

      case '--from':
        if (args[i + 1]) {
          result.from = new Date(args[i + 1]);
          i++;
        }
        break;

      case '--to':
        if (args[i + 1]) {
          result.to = new Date(args[i + 1]);
          i++;
        }
        break;

      case '--engine':
      case '-e':
        if (args[i + 1]) {
          const engine = args[i + 1];
          if (['timeDelay', 'mispricing', 'meta'].includes(engine)) {
            result.engine = engine as CliArgs['engine'];
          } else {
            console.error(chalk.red(`Unbekannte Engine: ${engine}`));
            console.error('Verfuegbare Engines: timeDelay, mispricing, meta');
            process.exit(1);
          }
          i++;
        }
        break;

      case '--no-slippage':
        result.slippage = false;
        break;

      case '--slippage':
        result.slippage = true;
        break;

      case '--bankroll':
      case '-b':
        if (args[i + 1]) {
          result.bankroll = parseFloat(args[i + 1]);
          i++;
        }
        break;

      case '--output':
      case '-o':
        if (args[i + 1]) {
          result.output = args[i + 1];
          i++;
        }
        break;

      case '--verbose':
      case '-v':
        result.verbose = true;
        break;

      // NEU: Validation & Monte Carlo Optionen
      case '--no-validation':
        result.validation = false;
        break;

      case '--validation':
        result.validation = true;
        break;

      case '--split':
        if (args[i + 1]) {
          result.trainTestSplit = parseFloat(args[i + 1]);
          i++;
        }
        break;

      case '--no-monte-carlo':
        result.monteCarlo = false;
        break;

      case '--monte-carlo':
        result.monteCarlo = true;
        break;

      case '--mc-sims':
        if (args[i + 1]) {
          result.monteCarloSims = parseInt(args[i + 1], 10);
          i++;
        }
        break;

      case '--walk-forward':
      case '-w':
        if (args[i + 1]) {
          result.walkForwardWindow = parseInt(args[i + 1], 10);
          i++;
        }
        break;

      default:
        if (arg.startsWith('-')) {
          console.error(chalk.yellow(`Unbekanntes Argument: ${arg}`));
        }
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
${chalk.bold('EdgyAlpha Backtest CLI')}

${chalk.bold('USAGE')}
  npm run backtest -- [OPTIONS]

${chalk.bold('OPTIONS')}
  --from DATE           Start-Datum (YYYY-MM-DD)
  --to DATE             End-Datum (YYYY-MM-DD)
  --engine, -e NAME     Engine: timeDelay, mispricing, meta (default: meta)
  --no-slippage         Slippage deaktivieren
  --bankroll, -b NUM    Initiales Kapital (default: 1000)
  --output, -o PATH     Output-Verzeichnis (default: ./backtest-results)
  --verbose, -v         Detaillierte Ausgabe
  --help, -h            Diese Hilfe anzeigen

${chalk.bold('VALIDATION & ROBUSTNESS')}
  --no-validation       Out-of-Sample Validation deaktivieren
  --split RATIO         Train/Test Split (default: 0.7 = 70% Train)
  --no-monte-carlo      Monte Carlo Simulation deaktivieren
  --mc-sims NUM         Anzahl Monte Carlo Simulationen (default: 1000)
  --walk-forward, -w    Walk-Forward Window in Tagen (default: 90)

${chalk.bold('BEISPIELE')}
  # Backtest mit meta-Engine fuer H1 2024
  npm run backtest -- --from 2024-01-01 --to 2024-06-30 --engine meta

  # TimeDelay-Engine ohne Slippage
  npm run backtest -- --engine timeDelay --no-slippage

  # Ohne Validation (schneller, aber weniger robust)
  npm run backtest -- --no-validation --no-monte-carlo

  # Mit aggressiverem 80/20 Split
  npm run backtest -- --split 0.8

  # Mit mehr Monte Carlo Simulationen
  npm run backtest -- --mc-sims 5000

${chalk.bold('ENGINES')}
  timeDelay   News-basierte Signale (Time-Delay Alpha)
  mispricing  Marktbewertungs-basierte Signale
  meta        Kombiniert beide Engines mit Walk-Forward Learning

${chalk.bold('OVERFITTING PROTECTION')}
  Der Backtest prueft automatisch auf Overfitting-Indikatoren:
  - Train >> Test Performance (Divergenz)
  - Unrealistisch hohe Sharpe Ratio (>3)
  - Monte Carlo Confidence Intervals
  - Robustness Score (0-100)
`);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log('');
  console.log(chalk.bold.blue('  EdgyAlpha Backtest'));
  console.log(chalk.gray('━'.repeat(50)));
  console.log('');

  // Initialisiere DB
  initDatabase();

  // Hole Statistiken
  const stats = getStats();

  if (stats.tradeCount === 0) {
    console.log(chalk.red('Keine historischen Daten gefunden!'));
    console.log('');
    console.log('Importiere Daten mit:');
    console.log(chalk.cyan('  npm run import:polydata'));
    console.log('');
    process.exit(1);
  }

  console.log(chalk.gray('Historische Daten:'));
  console.log(chalk.gray(`  Trades:   ${stats.tradeCount.toLocaleString()}`));
  console.log(chalk.gray(`  Maerkte:  ${stats.marketCount.toLocaleString()}`));
  console.log(chalk.gray(`  Resolved: ${stats.resolvedCount.toLocaleString()}`));

  if (stats.dateRange.from && stats.dateRange.to) {
    console.log(
      chalk.gray(
        `  Zeitraum: ${stats.dateRange.from.toISOString().slice(0, 10)} bis ${stats.dateRange.to.toISOString().slice(0, 10)}`
      )
    );
  }
  console.log('');

  // Bestimme Zeitraum
  const from = args.from ?? stats.dateRange.from ?? new Date('2024-01-01');
  const to = args.to ?? stats.dateRange.to ?? new Date();

  console.log(chalk.gray('Backtest-Konfiguration:'));
  console.log(chalk.gray(`  Engine:           ${args.engine}`));
  console.log(
    chalk.gray(
      `  Zeitraum:         ${from.toISOString().slice(0, 10)} bis ${to.toISOString().slice(0, 10)}`
    )
  );
  console.log(chalk.gray(`  Bankroll:         $${args.bankroll.toLocaleString()}`));
  console.log(chalk.gray(`  Slippage:         ${args.slippage ? 'Ja' : 'Nein'}`));
  console.log(chalk.gray(`  Walk-Forward:     ${args.walkForwardWindow} Tage`));
  console.log(chalk.gray(`  Validation:       ${args.validation ? `Ja (${(args.trainTestSplit * 100).toFixed(0)}/${((1 - args.trainTestSplit) * 100).toFixed(0)} Split)` : 'Nein'}`));
  console.log(chalk.gray(`  Monte Carlo:      ${args.monteCarlo ? `Ja (${args.monteCarloSims} Sims)` : 'Nein'}`));
  console.log('');

  console.log(chalk.yellow('Starte Backtest...'));
  console.log('');

  const startTime = Date.now();

  try {
    // Fuehre Backtest durch
    const result = await runBacktest({
      from,
      to,
      engine: args.engine,
      initialBankroll: args.bankroll,
      slippageEnabled: args.slippage,
      verbose: args.verbose,
      // NEU: Validation & Monte Carlo
      walkForwardWindow: args.walkForwardWindow,
      enableValidation: args.validation,
      trainTestSplit: args.trainTestSplit,
      enableMonteCarlo: args.monteCarlo,
      monteCarloSimulations: args.monteCarloSims,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Console Output
    const output = generateConsoleOutput(result);
    console.log(output);

    // Speichere Reports
    const { json, markdown } = await saveReports(
      result,
      path.resolve(args.output)
    );

    console.log(chalk.green('Reports gespeichert:'));
    console.log(chalk.cyan(`  - ${json}`));
    console.log(chalk.cyan(`  - ${markdown}`));
    console.log('');
    console.log(chalk.gray(`Backtest abgeschlossen in ${duration}s`));
    console.log('');
  } catch (error) {
    console.error(chalk.red('Backtest fehlgeschlagen:'));
    console.error(error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fehler:', error);
  process.exit(1);
});
