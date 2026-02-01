/**
 * Parser fuer markets.csv aus poly_data
 * Felder: createdAt, id, question, answer1, answer2, neg_risk, market_slug, token1, token2, condition_id, volume, ticker, closedTime
 */

import type { HistoricalMarket } from '../../alpha/types.js';

/**
 * Parst eine Zeile aus markets.csv zu HistoricalMarket
 * @param row - Record mit CSV-Feldern
 * @returns HistoricalMarket oder null bei fehlerhaften Daten
 */
export function parseMarketRow(row: Record<string, string>): HistoricalMarket | null {
  try {
    // Pflichtfeld: id und question
    const marketId = row.id?.trim();
    const question = row.question?.trim();

    if (!marketId || !question) {
      return null;
    }

    // Optionale Felder parsen
    const createdAt = row.createdAt ? parseDate(row.createdAt) : null;
    const closedAt = row.closedTime ? parseDate(row.closedTime) : null;
    const volumeTotal = row.volume ? parseFloat(row.volume) : null;

    return {
      marketId,
      conditionId: row.condition_id?.trim() || null,
      question,
      answer1: row.answer1?.trim() || null,
      answer2: row.answer2?.trim() || null,
      token1: row.token1?.trim() || null,
      token2: row.token2?.trim() || null,
      marketSlug: row.market_slug?.trim() || null,
      volumeTotal: volumeTotal && !isNaN(volumeTotal) ? volumeTotal : null,
      createdAt,
      closedAt,
      // Outcome muss separat gesetzt werden (nicht in poly_data CSVs)
      outcome: null,
    };
  } catch {
    return null;
  }
}

/**
 * Parst verschiedene Datumsformate
 */
function parseDate(dateStr: string): Date | null {
  if (!dateStr || dateStr.trim() === '') {
    return null;
  }

  const trimmed = dateStr.trim();

  // Unix timestamp (Sekunden oder Millisekunden)
  const asNumber = Number(trimmed);
  if (!isNaN(asNumber)) {
    // Wenn < 1e12, dann Sekunden, sonst Millisekunden
    const ms = asNumber < 1e12 ? asNumber * 1000 : asNumber;
    const date = new Date(ms);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // ISO-String oder andere Formate
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    return date;
  }

  return null;
}

/**
 * Validiert, ob ein Market-Objekt vollstaendig ist
 */
export function isValidMarket(market: HistoricalMarket | null): market is HistoricalMarket {
  if (!market) return false;
  return (
    typeof market.marketId === 'string' &&
    market.marketId.length > 0 &&
    typeof market.question === 'string' &&
    market.question.length > 0
  );
}
