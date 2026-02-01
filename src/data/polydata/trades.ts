/**
 * Parser fuer trades.csv aus poly_data
 * Felder: timestamp, market_id, maker, taker, nonusdc_side, maker_direction, taker_direction, price, usd_amount, token_amount, transactionHash
 */

import type { HistoricalTrade } from '../../alpha/types.js';

/**
 * Parst eine Zeile aus trades.csv zu HistoricalTrade
 * @param row - Record mit CSV-Feldern
 * @returns HistoricalTrade oder null bei fehlerhaften Daten
 */
export function parseTradeRow(row: Record<string, string>): HistoricalTrade | null {
  try {
    // Pflichtfelder
    const timestamp = parseTimestamp(row.timestamp);
    const marketId = row.market_id?.trim();
    const price = parseFloat(row.price);
    const usdAmount = parseFloat(row.usd_amount);

    // Validierung der Pflichtfelder
    if (!timestamp || !marketId || isNaN(price) || isNaN(usdAmount)) {
      return null;
    }

    // Price muss zwischen 0 und 1 liegen (Wahrscheinlichkeit)
    if (price < 0 || price > 1) {
      return null;
    }

    // USD Amount muss positiv sein
    if (usdAmount < 0) {
      return null;
    }

    // Optionale Felder
    const tokenAmount = row.token_amount ? parseFloat(row.token_amount) : null;

    return {
      timestamp,
      marketId,
      price,
      usdAmount,
      tokenAmount: tokenAmount && !isNaN(tokenAmount) ? tokenAmount : null,
      maker: row.maker?.trim() || null,
      taker: row.taker?.trim() || null,
      makerDirection: row.maker_direction?.trim() || null,
      takerDirection: row.taker_direction?.trim() || null,
      txHash: row.transactionHash?.trim() || null,
    };
  } catch {
    return null;
  }
}

/**
 * Parst verschiedene Timestamp-Formate
 */
function parseTimestamp(timestampStr: string): Date | null {
  if (!timestampStr || timestampStr.trim() === '') {
    return null;
  }

  const trimmed = timestampStr.trim();

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
 * Validiert, ob ein Trade-Objekt vollstaendig ist
 */
export function isValidTrade(trade: HistoricalTrade | null): trade is HistoricalTrade {
  if (!trade) return false;
  return (
    trade.timestamp instanceof Date &&
    !isNaN(trade.timestamp.getTime()) &&
    typeof trade.marketId === 'string' &&
    trade.marketId.length > 0 &&
    typeof trade.price === 'number' &&
    trade.price >= 0 &&
    trade.price <= 1 &&
    typeof trade.usdAmount === 'number' &&
    trade.usdAmount >= 0
  );
}
