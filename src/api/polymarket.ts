import axios, { AxiosInstance } from 'axios';
import pRetry from 'p-retry';
import pLimit from 'p-limit';
import { Market, Outcome, MarketCategory } from '../types/index.js';
import logger from '../utils/logger.js';

const POLYMARKET_API_URL = 'https://clob.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Rate limiting: max 10 requests parallel
const limit = pLimit(10);

// Konfiguration
const MAX_MARKETS_CAP = 2000;
const MAX_SPREAD_QUALITY = 0.05; // Guter Spread < 5%

export interface CLIMarket {
  id: string;
  question: string;
  category: string;
  volume: number;
  volume24h: number;
  yesPrice: number;
  noPrice: number;
  spread: number;
}

export interface FilterTelemetry {
  stage1_active: number;
  stage2_volume: number;
  stage3_quality: number;
  totalPages: number;
  totalFetched: number;
}

export class PolymarketClient {
  private clobClient: AxiosInstance;
  private gammaClient: AxiosInstance;

  constructor() {
    this.clobClient = axios.create({
      baseURL: POLYMARKET_API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.gammaClient = axios.create({
      baseURL: GAMMA_API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async getMarkets(options: {
    limit?: number;
    offset?: number;
    active?: boolean;
  } = {}): Promise<Market[]> {
    const { limit: maxResults = 100, offset = 0, active = true } = options;

    return pRetry(
      async () => {
        logger.debug(`Fetching markets: limit=${maxResults}, offset=${offset}`);

        const response = await this.gammaClient.get('/markets', {
          params: {
            limit: maxResults,
            offset,
            active,
            closed: false,
          },
        });

        const rawMarkets = response.data;
        return rawMarkets.map((m: Record<string, unknown>) => this.parseMarket(m));
      },
      {
        retries: 3,
        onFailedAttempt: (error) => {
          logger.warn(
            `Polymarket API Fehler (Versuch ${error.attemptNumber}): ${error.message}`
          );
        },
      }
    );
  }

  async getMarketById(marketId: string): Promise<Market | null> {
    return pRetry(
      async () => {
        const response = await this.gammaClient.get(`/markets/${marketId}`);
        return this.parseMarket(response.data);
      },
      { retries: 3 }
    ).catch((err) => {
      logger.error(`Markt ${marketId} nicht gefunden: ${err.message}`);
      return null;
    });
  }

  /**
   * Berechnet den Spread-Proxy für einen Markt
   * Spread = |yes_price + no_price - 1|
   * Ein guter Spread ist < 0.05 (5%)
   */
  calculateSpreadProxy(market: Market): number {
    if (market.outcomes.length < 2) return 1; // Kein gültiger Spread

    const yesPrice = market.outcomes.find(o => o.name.toLowerCase() === 'yes')?.price ?? market.outcomes[0].price;
    const noPrice = market.outcomes.find(o => o.name.toLowerCase() === 'no')?.price ?? market.outcomes[1]?.price ?? (1 - yesPrice);

    return Math.abs(yesPrice + noPrice - 1);
  }

  /**
   * Holt alle aktiven Märkte mit Volume-Filter und Telemetrie
   * Filter-Kaskade: active → volume → quality (spread)
   */
  async getActiveMarketsWithVolume(minVolume: number, maxSpread?: number): Promise<Market[]> {
    const telemetry: FilterTelemetry = {
      stage1_active: 0,
      stage2_volume: 0,
      stage3_quality: 0,
      totalPages: 0,
      totalFetched: 0,
    };

    const allMarkets: Market[] = [];
    let offset = 0;
    const batchSize = 100;
    let hasMore = true;
    const spreadThreshold = maxSpread ?? MAX_SPREAD_QUALITY;

    while (hasMore) {
      const markets = await limit(() =>
        this.getMarkets({ limit: batchSize, offset, active: true })
      );

      telemetry.totalPages++;
      telemetry.totalFetched += markets.length;

      if (markets.length === 0) {
        hasMore = false;
      } else {
        // Stage 1: active/open Filter (bereits durch API-Parameter)
        telemetry.stage1_active += markets.length;

        // Stage 2: Volume Filter
        const volumeFiltered = markets.filter((m) => m.totalVolume >= minVolume);
        telemetry.stage2_volume += volumeFiltered.length;

        // Stage 3: Quality Filter (Spread)
        const qualityFiltered = volumeFiltered.filter((m) => {
          const spread = this.calculateSpreadProxy(m);
          return spread <= spreadThreshold;
        });
        telemetry.stage3_quality += qualityFiltered.length;

        allMarkets.push(...qualityFiltered);
        offset += batchSize;

        // Max 2000 Märkte scannen (Cap)
        if (offset >= MAX_MARKETS_CAP) {
          hasMore = false;
          logger.debug(`Market cap von ${MAX_MARKETS_CAP} erreicht`);
        }
      }
    }

    logger.info(
      `[MARKETS] Stage 1: ${telemetry.stage1_active} active → Stage 2: ${telemetry.stage2_volume} with volume → Stage 3: ${telemetry.stage3_quality} quality`
    );
    logger.info(
      `[MARKETS] ${telemetry.totalPages} Pages, ${telemetry.totalFetched} total fetched, ${allMarkets.length} finale Märkte`
    );

    return allMarkets;
  }

  async getMarketsByCategory(
    category: MarketCategory,
    minVolume: number
  ): Promise<Market[]> {
    const markets = await this.getActiveMarketsWithVolume(minVolume);
    return markets.filter((m) => m.category === category);
  }

  /**
   * CLI-optimierte Funktion zum Abrufen von Märkten
   * Gibt ein vereinfachtes Format für CLI-Tools zurück
   */
  async getMarketsForCLI(options: {
    minVolume?: number;
    limit?: number;
    category?: string;
  } = {}): Promise<CLIMarket[]> {
    const { minVolume = 0, limit: maxResults = 100, category } = options;

    logger.info(`[CLI] Lade Märkte: minVolume=$${minVolume}, limit=${maxResults}, category=${category || 'all'}`);

    // Hole alle Märkte mit Volume-Filter (ohne Spread-Filter für CLI)
    const telemetry: FilterTelemetry = {
      stage1_active: 0,
      stage2_volume: 0,
      stage3_quality: 0,
      totalPages: 0,
      totalFetched: 0,
    };

    const allMarkets: Market[] = [];
    let offset = 0;
    const batchSize = 100;
    let hasMore = true;

    while (hasMore && allMarkets.length < maxResults) {
      const markets = await limit(() =>
        this.getMarkets({ limit: batchSize, offset, active: true })
      );

      telemetry.totalPages++;
      telemetry.totalFetched += markets.length;

      if (markets.length === 0) {
        hasMore = false;
      } else {
        telemetry.stage1_active += markets.length;

        // Volume Filter
        let filtered = markets.filter((m) => m.totalVolume >= minVolume);
        telemetry.stage2_volume += filtered.length;

        // Kategorie Filter (optional)
        if (category) {
          filtered = filtered.filter((m) => m.category === category);
        }
        telemetry.stage3_quality += filtered.length;

        allMarkets.push(...filtered);
        offset += batchSize;

        if (offset >= MAX_MARKETS_CAP) {
          hasMore = false;
        }
      }
    }

    logger.info(
      `[CLI] Stage 1: ${telemetry.stage1_active} active → Stage 2: ${telemetry.stage2_volume} with volume → Stage 3: ${telemetry.stage3_quality} filtered`
    );
    logger.info(
      `[CLI] ${telemetry.totalPages} Pages, ${telemetry.totalFetched} total fetched`
    );

    // In CLI-Format konvertieren und auf Limit beschränken
    const cliMarkets: CLIMarket[] = allMarkets.slice(0, maxResults).map((m) => {
      const yesPrice = m.outcomes.find(o => o.name.toLowerCase() === 'yes')?.price ?? m.outcomes[0]?.price ?? 0.5;
      const noPrice = m.outcomes.find(o => o.name.toLowerCase() === 'no')?.price ?? m.outcomes[1]?.price ?? (1 - yesPrice);
      const spread = Math.abs(yesPrice + noPrice - 1);

      return {
        id: m.id,
        question: m.question,
        category: m.category,
        volume: m.totalVolume,
        volume24h: m.volume24h,
        yesPrice,
        noPrice,
        spread,
      };
    });

    // Nach Volume sortieren (höchstes zuerst)
    cliMarkets.sort((a, b) => b.volume - a.volume);

    return cliMarkets;
  }

  async getOrderBook(tokenId: string): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  }> {
    return pRetry(
      async () => {
        const response = await this.clobClient.get(`/book`, {
          params: { token_id: tokenId },
        });
        return response.data;
      },
      { retries: 3 }
    );
  }

  private parseMarket(raw: Record<string, unknown>): Market {
    const outcomes: Outcome[] = [];

    // Parse JSON-strings from Gamma API
    let outcomeNames: string[] = [];
    let outcomePrices: string[] = [];
    let tokenIds: string[] = [];

    try {
      if (typeof raw.outcomes === 'string') {
        outcomeNames = JSON.parse(raw.outcomes);
      } else if (Array.isArray(raw.outcomes)) {
        outcomeNames = raw.outcomes;
      }
    } catch {
      outcomeNames = ['Yes', 'No'];
    }

    try {
      if (typeof raw.outcomePrices === 'string') {
        outcomePrices = JSON.parse(raw.outcomePrices);
      } else if (Array.isArray(raw.outcomePrices)) {
        outcomePrices = raw.outcomePrices;
      }
    } catch {
      outcomePrices = ['0.5', '0.5'];
    }

    try {
      if (typeof raw.clobTokenIds === 'string') {
        tokenIds = JSON.parse(raw.clobTokenIds);
      } else if (Array.isArray(raw.clobTokenIds)) {
        tokenIds = raw.clobTokenIds;
      }
    } catch {
      tokenIds = [];
    }

    // Build outcomes from parsed data
    for (let i = 0; i < outcomeNames.length; i++) {
      outcomes.push({
        id: tokenIds[i] || `outcome-${i}`,
        name: outcomeNames[i] || (i === 0 ? 'Yes' : 'No'),
        price: parseFloat(outcomePrices[i] || '0.5'),
        volume24h: 0, // Gamma API gibt kein per-outcome volume
      });
    }

    // Fallback falls keine outcomes
    if (outcomes.length === 0) {
      outcomes.push(
        { id: 'yes', name: 'Yes', price: 0.5, volume24h: 0 },
        { id: 'no', name: 'No', price: 0.5, volume24h: 0 }
      );
    }

    return {
      id: String(raw.id || raw.conditionId || ''),
      question: String(raw.question || raw.title || ''),
      slug: String(raw.slug || ''),
      category: this.parseCategory(String(raw.question || raw.title || '')),
      volume24h: parseFloat(String(raw.volume24hr || raw.volume_24h || 0)),
      totalVolume: parseFloat(String(raw.volume || raw.volumeNum || 0)),
      liquidity: parseFloat(String(raw.liquidity || raw.liquidityNum || 0)),
      outcomes,
      endDate: String(raw.endDateIso || raw.end_date_iso || raw.endDate || ''),
      resolved: Boolean(raw.resolved || raw.closed),
      createdAt: String(raw.createdAt || raw.created_at || ''),
      updatedAt: String(raw.updatedAt || raw.updated_at || ''),
    };
  }

  private parseCategory(question: string): MarketCategory {
    const q = question.toLowerCase();

    // GEOPOLITICS ZUERST - wichtig für DE/EU Information Edge
    // Diese Märkte haben höchste Priorität für Alpha
    if (
      q.includes('ukraine') ||
      q.includes('russia') ||
      q.includes('putin') ||
      q.includes('zelensky') ||
      q.includes('ceasefire') ||
      q.includes('waffenstillstand') ||
      q.includes('crimea') ||
      q.includes('donbas') ||
      q.includes('invasion') ||
      q.includes('war ') ||
      q.includes(' war') ||
      q.includes('troops') ||
      q.includes('military') ||
      q.includes('sanctions') ||
      q.includes('nato')
    ) {
      return 'geopolitics';
    }

    // Politics - US/DE/EU
    if (
      // US Politik
      q.includes('trump') ||
      q.includes('biden') ||
      q.includes('president') ||
      q.includes('congress') ||
      q.includes('senate') ||
      q.includes('politic') ||
      q.includes('election') ||
      q.includes('government') ||
      q.includes('deport') ||
      q.includes('tariff') ||
      q.includes('impeach') ||
      // DE Politik
      q.includes('merz') ||
      q.includes('scholz') ||
      q.includes('bundestag') ||
      q.includes('afd') ||
      q.includes('cdu') ||
      q.includes('spd') ||
      q.includes('grüne') ||
      q.includes('fdp') ||
      q.includes('koalition') ||
      q.includes('chancellor') ||
      q.includes('kanzler') ||
      // EU
      q.includes('european') ||
      q.includes('germany') ||
      q.includes('german') ||
      q.includes('eu ') ||
      q.includes(' eu')
    ) {
      return 'politics';
    }
    // Economics - inkl. EZB/Zentralbanken (wichtig für DE Edge)
    if (
      q.includes('econom') ||
      q.includes('fed') ||
      q.includes('inflation') ||
      q.includes('stock') ||
      q.includes('gdp') ||
      q.includes('recession') ||
      q.includes('interest rate') ||
      q.includes('rate hike') ||
      q.includes('rate cut') ||
      q.includes('unemployment') ||
      q.includes('s&p') ||
      q.includes('nasdaq') ||
      q.includes('dow') ||
      // EZB/Euro (DE Information Edge)
      q.includes('ecb') ||
      q.includes('ezb') ||
      q.includes('european central bank') ||
      q.includes('lagarde') ||
      q.includes('eurozone')
    ) {
      return 'economics';
    }
    // Crypto
    if (
      q.includes('crypto') ||
      q.includes('bitcoin') ||
      q.includes('ethereum') ||
      q.includes('btc') ||
      q.includes('eth') ||
      q.includes('solana') ||
      q.includes('blockchain')
    ) {
      return 'crypto';
    }
    // Sports
    if (
      q.includes('sport') ||
      q.includes('nba') ||
      q.includes('nfl') ||
      q.includes('soccer') ||
      q.includes('football') ||
      q.includes('basketball') ||
      q.includes('bundesliga') ||
      q.includes('champions league') ||
      q.includes('world cup') ||
      q.includes('super bowl')
    ) {
      return 'sports';
    }
    // Tech
    if (
      q.includes('tech') ||
      q.includes(' ai ') ||
      q.includes('artificial intelligence') ||
      q.includes('apple') ||
      q.includes('tesla') ||
      q.includes('google') ||
      q.includes('microsoft') ||
      q.includes('openai') ||
      q.includes('spacex')
    ) {
      return 'tech';
    }
    // Entertainment
    if (
      q.includes('entertainment') ||
      q.includes('movie') ||
      q.includes('music') ||
      q.includes('oscar') ||
      q.includes('grammy') ||
      q.includes('netflix')
    ) {
      return 'entertainment';
    }
    // Weather
    if (q.includes('weather') || q.includes('climate') || q.includes('hurricane') || q.includes('temperature')) {
      return 'weather';
    }
    // Science
    if (q.includes('science') || q.includes('nasa') || q.includes('research') || q.includes('study')) {
      return 'science';
    }
    // Society
    if (q.includes('society') || q.includes('culture') || q.includes('population')) {
      return 'society';
    }
    // Geopolitics (Fallback für restliche internationale Themen)
    if (
      q.includes('geopolit') ||
      q.includes('international') ||
      q.includes('china') ||
      q.includes('taiwan') ||
      q.includes('iran') ||
      q.includes('israel') ||
      q.includes('middle east')
    ) {
      return 'geopolitics';
    }

    return 'unknown';
  }
}

export const polymarketClient = new PolymarketClient();
export default polymarketClient;
