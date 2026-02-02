#!/usr/bin/env tsx
/**
 * Setzt Outcomes fuer Demo-Markets (fuer Backtesting)
 * Simuliert realistische Resolutionen basierend auf historischen Trades
 */

import { initDatabase, getDatabase } from '../src/storage/db.js';
import chalk from 'chalk';

async function main(): Promise<void> {
  console.log(chalk.bold.blue('\n  Demo Markets Resolution\n'));

  initDatabase();
  const db = getDatabase();

  // Hole alle geschlossenen Markets ohne Outcome
  const markets = db.prepare(`
    SELECT market_id, question, closed_at
    FROM historical_markets
    WHERE closed_at IS NOT NULL AND outcome IS NULL
  `).all() as Array<{ market_id: string; question: string; closed_at: string }>;

  console.log(chalk.gray(`Gefunden: ${markets.length} Markets ohne Outcome\n`));

  if (markets.length === 0) {
    console.log(chalk.yellow('Keine Markets zu resolven.'));
    return;
  }

  const updateStmt = db.prepare(`
    UPDATE historical_markets
    SET outcome = ?
    WHERE market_id = ?
  `);

  let answer1Count = 0;
  let answer2Count = 0;

  const transaction = db.transaction(() => {
    for (const market of markets) {
      // Hole den letzten Trade-Preis fuer diesen Market
      const lastTrade = db.prepare(`
        SELECT price FROM historical_trades
        WHERE market_id = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `).get(market.market_id) as { price: number } | undefined;

      let outcome: 'answer1' | 'answer2';

      if (lastTrade) {
        // Verwende letzten Preis als Wahrscheinlichkeit
        // Wenn Preis > 0.5, dann answer1 (Yes) gewinnt mit hoeherer Wahrscheinlichkeit
        const probability = lastTrade.price;
        outcome = Math.random() < probability ? 'answer1' : 'answer2';
      } else {
        // Ohne Trades: 50/50
        outcome = Math.random() < 0.5 ? 'answer1' : 'answer2';
      }

      updateStmt.run(outcome, market.market_id);

      if (outcome === 'answer1') {
        answer1Count++;
      } else {
        answer2Count++;
      }
    }
  });

  transaction();

  console.log(chalk.green(`Resolved: ${markets.length} Markets`));
  console.log(chalk.gray(`  - Answer1 (Yes): ${answer1Count}`));
  console.log(chalk.gray(`  - Answer2 (No):  ${answer2Count}`));
  console.log('');

  // Zeige Stats
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved
    FROM historical_markets
  `).get() as { total: number; resolved: number };

  console.log(chalk.bold('Aktueller Stand:'));
  console.log(chalk.gray(`  Total Markets:    ${stats.total}`));
  console.log(chalk.gray(`  Resolved Markets: ${stats.resolved}`));
  console.log('');
}

main().catch(console.error);
