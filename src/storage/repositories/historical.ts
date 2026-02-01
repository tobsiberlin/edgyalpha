/**
 * Repository für historical_trades und historical_markets Tabellen
 * Historische Polymarket-Daten für Backtesting
 */

import { getDatabase } from '../db.js';
import type { HistoricalTrade, HistoricalMarket } from '../../alpha/types.js';

/**
 * Konvertiert Datenbank-Row zu HistoricalTrade
 */
function rowToTrade(row: Record<string, unknown>): HistoricalTrade {
  return {
    timestamp: new Date(row.timestamp as string),
    marketId: row.market_id as string,
    price: row.price as number,
    usdAmount: row.usd_amount as number,
    tokenAmount: row.token_amount as number | null,
    maker: row.maker as string | null,
    taker: row.taker as string | null,
    makerDirection: row.maker_direction as string | null,
    takerDirection: row.taker_direction as string | null,
    txHash: row.tx_hash as string | null,
  };
}

/**
 * Konvertiert Datenbank-Row zu HistoricalMarket
 */
function rowToMarket(row: Record<string, unknown>): HistoricalMarket {
  return {
    marketId: row.market_id as string,
    conditionId: row.condition_id as string | null,
    question: row.question as string,
    answer1: row.answer1 as string | null,
    answer2: row.answer2 as string | null,
    token1: row.token1 as string | null,
    token2: row.token2 as string | null,
    marketSlug: row.market_slug as string | null,
    volumeTotal: row.volume_total as number | null,
    createdAt: row.created_at ? new Date(row.created_at as string) : null,
    closedAt: row.closed_at ? new Date(row.closed_at as string) : null,
    outcome: row.outcome as HistoricalMarket['outcome'],
  };
}

/**
 * Fügt einen historischen Trade ein
 */
export function insertTrade(trade: HistoricalTrade): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO historical_trades (
      timestamp, market_id, price, usd_amount, token_amount,
      maker, taker, maker_direction, taker_direction, tx_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tx_hash) DO NOTHING
  `);

  stmt.run(
    trade.timestamp.toISOString(),
    trade.marketId,
    trade.price,
    trade.usdAmount,
    trade.tokenAmount,
    trade.maker,
    trade.taker,
    trade.makerDirection,
    trade.takerDirection,
    trade.txHash
  );
}

/**
 * Fügt einen historischen Markt ein
 */
export function insertMarket(market: HistoricalMarket): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO historical_markets (
      market_id, condition_id, question, answer1, answer2,
      token1, token2, market_slug, volume_total, created_at, closed_at, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id) DO UPDATE SET
      condition_id = excluded.condition_id,
      question = excluded.question,
      answer1 = excluded.answer1,
      answer2 = excluded.answer2,
      token1 = excluded.token1,
      token2 = excluded.token2,
      market_slug = excluded.market_slug,
      volume_total = excluded.volume_total,
      closed_at = excluded.closed_at,
      outcome = excluded.outcome
  `);

  stmt.run(
    market.marketId,
    market.conditionId,
    market.question,
    market.answer1,
    market.answer2,
    market.token1,
    market.token2,
    market.marketSlug,
    market.volumeTotal,
    market.createdAt?.toISOString() ?? null,
    market.closedAt?.toISOString() ?? null,
    market.outcome
  );
}

/**
 * Fügt mehrere Trades in einer Transaktion ein
 * @returns Anzahl der eingefügten Trades
 */
export function bulkInsertTrades(trades: HistoricalTrade[]): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO historical_trades (
      timestamp, market_id, price, usd_amount, token_amount,
      maker, taker, maker_direction, taker_direction, tx_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tx_hash) DO NOTHING
  `);

  let insertedCount = 0;

  const insertMany = db.transaction((tradesToInsert: HistoricalTrade[]) => {
    for (const trade of tradesToInsert) {
      const result = stmt.run(
        trade.timestamp.toISOString(),
        trade.marketId,
        trade.price,
        trade.usdAmount,
        trade.tokenAmount,
        trade.maker,
        trade.taker,
        trade.makerDirection,
        trade.takerDirection,
        trade.txHash
      );
      if (result.changes > 0) {
        insertedCount++;
      }
    }
  });

  insertMany(trades);

  return insertedCount;
}

/**
 * Fügt mehrere Märkte in einer Transaktion ein
 * @returns Anzahl der eingefügten/aktualisierten Märkte
 */
export function bulkInsertMarkets(markets: HistoricalMarket[]): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO historical_markets (
      market_id, condition_id, question, answer1, answer2,
      token1, token2, market_slug, volume_total, created_at, closed_at, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id) DO UPDATE SET
      condition_id = excluded.condition_id,
      question = excluded.question,
      answer1 = excluded.answer1,
      answer2 = excluded.answer2,
      token1 = excluded.token1,
      token2 = excluded.token2,
      market_slug = excluded.market_slug,
      volume_total = excluded.volume_total,
      closed_at = excluded.closed_at,
      outcome = excluded.outcome
  `);

  let count = 0;

  const insertMany = db.transaction((marketsToInsert: HistoricalMarket[]) => {
    for (const market of marketsToInsert) {
      stmt.run(
        market.marketId,
        market.conditionId,
        market.question,
        market.answer1,
        market.answer2,
        market.token1,
        market.token2,
        market.marketSlug,
        market.volumeTotal,
        market.createdAt?.toISOString() ?? null,
        market.closedAt?.toISOString() ?? null,
        market.outcome
      );
      count++;
    }
  });

  insertMany(markets);

  return count;
}

/**
 * Holt Trades für einen Markt (optional mit Zeitraum)
 */
export function getTradesByMarket(
  marketId: string,
  from?: Date,
  to?: Date
): HistoricalTrade[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM historical_trades WHERE market_id = ?';
  const params: (string | number)[] = [marketId];

  if (from) {
    sql += ' AND timestamp >= ?';
    params.push(from.toISOString());
  }
  if (to) {
    sql += ' AND timestamp <= ?';
    params.push(to.toISOString());
  }

  sql += ' ORDER BY timestamp ASC';

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(rowToTrade);
}

/**
 * Holt die Market-Resolution (für Backtesting)
 */
export function getMarketResolution(marketId: string): HistoricalMarket | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM historical_markets WHERE market_id = ?
  `);

  const row = stmt.get(marketId) as Record<string, unknown> | undefined;

  return row ? rowToMarket(row) : null;
}

/**
 * Statistik-Interface
 */
export interface HistoricalStats {
  tradeCount: number;
  marketCount: number;
  resolvedCount: number;
  dateRange: {
    from: Date | null;
    to: Date | null;
  };
}

/**
 * Holt Statistiken über die historischen Daten
 */
export function getStats(): HistoricalStats {
  const db = getDatabase();

  const tradeStats = db
    .prepare(
      `
    SELECT
      COUNT(*) as count,
      MIN(timestamp) as min_ts,
      MAX(timestamp) as max_ts
    FROM historical_trades
  `
    )
    .get() as { count: number; min_ts: string | null; max_ts: string | null };

  const marketStats = db
    .prepare(
      `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved
    FROM historical_markets
  `
    )
    .get() as { total: number; resolved: number };

  return {
    tradeCount: tradeStats.count,
    marketCount: marketStats.total,
    resolvedCount: marketStats.resolved,
    dateRange: {
      from: tradeStats.min_ts ? new Date(tradeStats.min_ts) : null,
      to: tradeStats.max_ts ? new Date(tradeStats.max_ts) : null,
    },
  };
}
