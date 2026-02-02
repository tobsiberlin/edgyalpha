/**
 * Volatility Calculator
 * Berechnet echte 30-Tage-Volatilität aus historischen Preisdaten
 *
 * Die Volatilität wird als annualisierte Standardabweichung der täglichen Returns berechnet:
 * 1. Lade Preisdaten für 30 Tage
 * 2. Berechne tägliche log-Returns: ln(P_t / P_t-1)
 * 3. Berechne Standardabweichung der Returns
 * 4. Annualisiere: σ_annual = σ_daily * sqrt(365)
 *
 * WICHTIG: Korrekte Volatilität = korrektes Kelly Sizing = besseres Risk Management!
 */

import { PolymarketClient, PriceHistoryPoint } from '../api/polymarket.js';
import logger from '../utils/logger.js';

// Singleton Polymarket Client für Volatility-Berechnungen
let polyClient: PolymarketClient | null = null;

function getPolyClient(): PolymarketClient {
  if (!polyClient) {
    polyClient = new PolymarketClient();
  }
  return polyClient;
}

// Cache für berechnete Volatilitäten (TTL: 1 Stunde)
const volatilityCache: Map<string, { value: number; timestamp: number; dataPoints: number }> = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 Stunde

// Minimum Datenpunkte für echte Berechnung (30 Tage tägliche Returns)
const MIN_DAILY_RETURNS = 30;
const DEFAULT_VOLATILITY = 0.15;

export interface VolatilityResult {
  volatility30d: number; // Annualisierte Volatilität (0-1 Scale)
  dataPoints: number; // Anzahl der verwendeten Datenpunkte (tägliche Returns)
  calculatedAt: Date;
  source: 'calculated' | 'cached' | 'fallback';
  fallbackReason?: string; // Grund für Fallback (wenn source === 'fallback')
}

/**
 * Berechne 30-Tage-Volatilität für einen Token
 * @param tokenId - Polymarket Token ID
 * @returns Volatilität als Dezimalzahl (z.B. 0.15 = 15% annualisiert)
 *
 * FALLBACK-LOGIK:
 * - Mindestens 30 tägliche Datenpunkte für echte Berechnung
 * - Bei weniger: Fallback auf DEFAULT_VOLATILITY (0.15)
 * - Logging bei Fallback für Monitoring
 */
export async function calculateVolatility30d(tokenId: string): Promise<VolatilityResult> {
  // 1. Check Cache
  const cached = volatilityCache.get(tokenId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return {
      volatility30d: cached.value,
      dataPoints: cached.dataPoints,
      calculatedAt: new Date(cached.timestamp),
      source: 'cached',
    };
  }

  try {
    // 2. Lade Preisdaten (stündlich für 30+ Tage = ~720+ Punkte)
    const client = getPolyClient();
    const priceHistory = await client.getPriceHistory(tokenId, 60); // 60min fidelity

    if (priceHistory.length < 24) {
      // Weniger als 24 Stunden Daten - neuer Markt
      const reason = `Zu wenig Preisdaten (${priceHistory.length} Stunden-Punkte, min. 24 benötigt)`;
      logger.warn(`[VOLATILITY FALLBACK] ${tokenId.substring(0, 16)}...: ${reason}`);
      return {
        volatility30d: DEFAULT_VOLATILITY,
        dataPoints: priceHistory.length,
        calculatedAt: new Date(),
        source: 'fallback',
        fallbackReason: reason,
      };
    }

    // 3. Berechne tägliche Returns aus stündlichen Daten
    const dailyReturns = calculateDailyReturns(priceHistory);

    if (dailyReturns.length < MIN_DAILY_RETURNS) {
      // Weniger als 30 Tage Daten - Fallback mit Warnung
      const reason = `Nur ${dailyReturns.length} Tage Returns (min. ${MIN_DAILY_RETURNS} benötigt)`;
      logger.warn(`[VOLATILITY FALLBACK] ${tokenId.substring(0, 16)}...: ${reason}`);
      return {
        volatility30d: DEFAULT_VOLATILITY,
        dataPoints: dailyReturns.length,
        calculatedAt: new Date(),
        source: 'fallback',
        fallbackReason: reason,
      };
    }

    // 4. Berechne Standardabweichung der täglichen Log-Returns
    const stdDev = calculateStandardDeviation(dailyReturns);

    // 5. Annualisiere (sqrt(365) für tägliche Daten)
    const annualizedVol = stdDev * Math.sqrt(365);

    // 6. Begrenze auf sinnvollen Bereich (0.01 - 2.0)
    const boundedVol = Math.max(0.01, Math.min(2.0, annualizedVol));

    // 7. Cache speichern mit Datenpunkten
    volatilityCache.set(tokenId, {
      value: boundedVol,
      timestamp: Date.now(),
      dataPoints: dailyReturns.length,
    });

    logger.debug(
      `[VOLATILITY] ${tokenId.substring(0, 16)}...: ${(boundedVol * 100).toFixed(1)}% (${dailyReturns.length} Tage, berechnet)`
    );

    return {
      volatility30d: boundedVol,
      dataPoints: dailyReturns.length,
      calculatedAt: new Date(),
      source: 'calculated',
    };
  } catch (err) {
    const reason = `API-Fehler: ${(err as Error).message}`;
    logger.warn(`[VOLATILITY FALLBACK] ${tokenId.substring(0, 16)}...: ${reason}`);
    return {
      volatility30d: DEFAULT_VOLATILITY,
      dataPoints: 0,
      calculatedAt: new Date(),
      source: 'fallback',
      fallbackReason: reason,
    };
  }
}

/**
 * Berechne tägliche Returns aus stündlichen Preisdaten
 * Aggregiert stündliche Daten zu täglichen Schlusskursen
 */
function calculateDailyReturns(hourlyData: PriceHistoryPoint[]): number[] {
  // Sortiere nach Zeitstempel (älteste zuerst)
  const sorted = [...hourlyData].sort((a, b) => a.timestamp - b.timestamp);

  // Gruppiere nach Tag (UTC)
  const dailyPrices: Map<string, number[]> = new Map();

  for (const point of sorted) {
    const date = new Date(point.timestamp);
    const dayKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;

    if (!dailyPrices.has(dayKey)) {
      dailyPrices.set(dayKey, []);
    }
    dailyPrices.get(dayKey)!.push(point.price);
  }

  // Extrahiere tägliche Schlusskurse (letzter Preis des Tages)
  const dailyCloses: { date: string; price: number }[] = [];
  dailyPrices.forEach((prices, date) => {
    dailyCloses.push({
      date,
      price: prices[prices.length - 1], // Letzter Preis = Schlusskurs
    });
  });

  // Sortiere nach Datum
  dailyCloses.sort((a, b) => a.date.localeCompare(b.date));

  // Berechne log-Returns
  const returns: number[] = [];
  for (let i = 1; i < dailyCloses.length; i++) {
    const prevPrice = dailyCloses[i - 1].price;
    const currPrice = dailyCloses[i].price;

    // Vermeide Division durch 0 oder negative Preise
    if (prevPrice > 0.001 && currPrice > 0.001) {
      // Log-Return: ln(P_t / P_t-1)
      const logReturn = Math.log(currPrice / prevPrice);
      returns.push(logReturn);
    }
  }

  return returns;
}

/**
 * Berechne Standardabweichung einer Zahlenreihe
 */
function calculateStandardDeviation(values: number[]): number {
  if (values.length < 2) return 0;

  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / (n - 1); // Sample variance

  return Math.sqrt(variance);
}

/**
 * Batch-Berechnung für mehrere Tokens (parallel)
 */
export async function calculateVolatilityBatch(
  tokenIds: string[]
): Promise<Map<string, VolatilityResult>> {
  const results = new Map<string, VolatilityResult>();

  // Parallel ausführen (max 5 gleichzeitig)
  const batchSize = 5;
  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (tokenId) => ({
        tokenId,
        result: await calculateVolatility30d(tokenId),
      }))
    );

    for (const { tokenId, result } of batchResults) {
      results.set(tokenId, result);
    }
  }

  return results;
}

/**
 * Cache leeren (für Tests oder Force-Refresh)
 */
export function clearVolatilityCache(): void {
  volatilityCache.clear();
}

/**
 * Cache-Statistiken für Monitoring
 */
export function getVolatilityCacheStats(): {
  size: number;
  entries: Array<{ tokenId: string; volatility: number; dataPoints: number; ageMinutes: number }>;
} {
  const now = Date.now();
  const entries: Array<{ tokenId: string; volatility: number; dataPoints: number; ageMinutes: number }> = [];

  volatilityCache.forEach((data, tokenId) => {
    entries.push({
      tokenId: tokenId.substring(0, 16) + '...',
      volatility: Math.round(data.value * 1000) / 10, // In Prozent, 1 Dezimalstelle
      dataPoints: data.dataPoints,
      ageMinutes: Math.round((now - data.timestamp) / 60000),
    });
  });

  // Sortiere nach Alter (neueste zuerst)
  entries.sort((a, b) => a.ageMinutes - b.ageMinutes);

  return {
    size: volatilityCache.size,
    entries,
  };
}

/**
 * Exportiere Default-Volatilität für externe Verwendung
 */
export { DEFAULT_VOLATILITY, MIN_DAILY_RETURNS };
