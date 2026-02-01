/**
 * poly_data CSV Import Loader
 * Streaming CSV-Parse mit Batch-Inserts
 */

import { parse } from 'csv-parse';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import type { HistoricalTrade, HistoricalMarket } from '../../alpha/types.js';
import { bulkInsertTrades, bulkInsertMarkets } from '../../storage/repositories/historical.js';
import { parseMarketRow, isValidMarket } from './markets.js';
import { parseTradeRow, isValidTrade } from './trades.js';

export interface LoaderOptions {
  dataDir: string;  // Pfad zu poly_data CSVs
  batchSize?: number;  // Default: 10000
  since?: Date;  // Nur Daten nach diesem Datum
  onProgress?: (progress: ProgressInfo) => void;
}

export interface ProgressInfo {
  type: 'markets' | 'trades';
  processed: number;
  inserted: number;
  skipped: number;
  errors: number;
  totalEstimate: number;
}

export interface LoaderStats {
  marketsLoaded: number;
  tradesLoaded: number;
  marketsSkipped: number;
  tradesSkipped: number;
  errors: string[];
  duration: number;
}

/**
 * Schaetzt die Anzahl der Zeilen basierend auf Dateigroesse
 * (ungefaehr 100-200 Bytes pro Zeile)
 */
async function estimateRowCount(filePath: string): Promise<number> {
  try {
    const stats = await stat(filePath);
    return Math.floor(stats.size / 150); // ~150 Bytes pro Zeile
  } catch {
    return 0;
  }
}

/**
 * Laedt Markets aus markets.csv
 */
export async function loadMarkets(options: LoaderOptions): Promise<LoaderStats> {
  const startTime = Date.now();
  const stats: LoaderStats = {
    marketsLoaded: 0,
    tradesLoaded: 0,
    marketsSkipped: 0,
    tradesSkipped: 0,
    errors: [],
    duration: 0,
  };

  const batchSize = options.batchSize ?? 10000;
  const marketsFile = join(options.dataDir, 'markets.csv');

  // Datei existiert?
  try {
    await stat(marketsFile);
  } catch {
    stats.errors.push(`markets.csv nicht gefunden in ${options.dataDir}`);
    stats.duration = Date.now() - startTime;
    return stats;
  }

  const totalEstimate = await estimateRowCount(marketsFile);
  let batch: HistoricalMarket[] = [];
  let processed = 0;
  let skipped = 0;
  let errorCount = 0;

  return new Promise((resolve) => {
    const parser = createReadStream(marketsFile).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      })
    );

    parser.on('data', (row: Record<string, string>) => {
      processed++;

      try {
        const market = parseMarketRow(row);

        // Since-Filter
        if (options.since && market?.createdAt && market.createdAt < options.since) {
          skipped++;
          return;
        }

        if (isValidMarket(market)) {
          batch.push(market);

          // Batch voll -> in DB schreiben
          if (batch.length >= batchSize) {
            const inserted = bulkInsertMarkets(batch);
            stats.marketsLoaded += inserted;
            batch = [];

            if (options.onProgress) {
              options.onProgress({
                type: 'markets',
                processed,
                inserted: stats.marketsLoaded,
                skipped,
                errors: errorCount,
                totalEstimate,
              });
            }
          }
        } else {
          skipped++;
        }
      } catch (err) {
        errorCount++;
        if (stats.errors.length < 10) {
          stats.errors.push(`Zeile ${processed}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    parser.on('end', () => {
      // Restliche Batch einfuegen
      if (batch.length > 0) {
        const inserted = bulkInsertMarkets(batch);
        stats.marketsLoaded += inserted;
      }

      stats.marketsSkipped = skipped;
      stats.duration = Date.now() - startTime;

      if (options.onProgress) {
        options.onProgress({
          type: 'markets',
          processed,
          inserted: stats.marketsLoaded,
          skipped,
          errors: errorCount,
          totalEstimate: processed,
        });
      }

      resolve(stats);
    });

    parser.on('error', (err: Error) => {
      stats.errors.push(`Parser-Fehler: ${err.message}`);
      stats.duration = Date.now() - startTime;
      resolve(stats);
    });
  });
}

/**
 * Laedt Trades aus trades.csv
 */
export async function loadTrades(options: LoaderOptions): Promise<LoaderStats> {
  const startTime = Date.now();
  const stats: LoaderStats = {
    marketsLoaded: 0,
    tradesLoaded: 0,
    marketsSkipped: 0,
    tradesSkipped: 0,
    errors: [],
    duration: 0,
  };

  const batchSize = options.batchSize ?? 10000;
  const tradesFile = join(options.dataDir, 'trades.csv');

  // Datei existiert?
  try {
    await stat(tradesFile);
  } catch {
    stats.errors.push(`trades.csv nicht gefunden in ${options.dataDir}`);
    stats.duration = Date.now() - startTime;
    return stats;
  }

  const totalEstimate = await estimateRowCount(tradesFile);
  let batch: HistoricalTrade[] = [];
  let processed = 0;
  let skipped = 0;
  let errorCount = 0;

  return new Promise((resolve) => {
    const parser = createReadStream(tradesFile).pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      })
    );

    parser.on('data', (row: Record<string, string>) => {
      processed++;

      try {
        const trade = parseTradeRow(row);

        // Since-Filter
        if (options.since && trade?.timestamp && trade.timestamp < options.since) {
          skipped++;
          return;
        }

        if (isValidTrade(trade)) {
          batch.push(trade);

          // Batch voll -> in DB schreiben
          if (batch.length >= batchSize) {
            const inserted = bulkInsertTrades(batch);
            stats.tradesLoaded += inserted;
            batch = [];

            if (options.onProgress) {
              options.onProgress({
                type: 'trades',
                processed,
                inserted: stats.tradesLoaded,
                skipped,
                errors: errorCount,
                totalEstimate,
              });
            }
          }
        } else {
          skipped++;
        }
      } catch (err) {
        errorCount++;
        if (stats.errors.length < 10) {
          stats.errors.push(`Zeile ${processed}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    parser.on('end', () => {
      // Restliche Batch einfuegen
      if (batch.length > 0) {
        const inserted = bulkInsertTrades(batch);
        stats.tradesLoaded += inserted;
      }

      stats.tradesSkipped = skipped;
      stats.duration = Date.now() - startTime;

      if (options.onProgress) {
        options.onProgress({
          type: 'trades',
          processed,
          inserted: stats.tradesLoaded,
          skipped,
          errors: errorCount,
          totalEstimate: processed,
        });
      }

      resolve(stats);
    });

    parser.on('error', (err: Error) => {
      stats.errors.push(`Parser-Fehler: ${err.message}`);
      stats.duration = Date.now() - startTime;
      resolve(stats);
    });
  });
}

/**
 * Laedt alle Daten (Markets und Trades)
 */
export async function loadAll(options: LoaderOptions): Promise<LoaderStats> {
  const startTime = Date.now();

  // Erst Markets laden (werden von Trades referenziert)
  const marketStats = await loadMarkets(options);

  // Dann Trades laden
  const tradeStats = await loadTrades(options);

  return {
    marketsLoaded: marketStats.marketsLoaded,
    tradesLoaded: tradeStats.tradesLoaded,
    marketsSkipped: marketStats.marketsSkipped,
    tradesSkipped: tradeStats.tradesSkipped,
    errors: [...marketStats.errors, ...tradeStats.errors],
    duration: Date.now() - startTime,
  };
}
