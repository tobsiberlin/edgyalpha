import axios, { AxiosInstance } from 'axios';
import pRetry from 'p-retry';
import pLimit from 'p-limit';
import { Market, Outcome, MarketCategory } from '../types/index.js';
import logger from '../utils/logger.js';

const POLYMARKET_API_URL = 'https://clob.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Rate limiting: max 10 requests parallel
const limit = pLimit(10);

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

  async getActiveMarketsWithVolume(minVolume: number): Promise<Market[]> {
    const allMarkets: Market[] = [];
    let offset = 0;
    const batchSize = 100;
    let hasMore = true;

    while (hasMore) {
      const markets = await limit(() =>
        this.getMarkets({ limit: batchSize, offset, active: true })
      );

      if (markets.length === 0) {
        hasMore = false;
      } else {
        const filtered = markets.filter((m) => m.volume24h >= minVolume);
        allMarkets.push(...filtered);
        offset += batchSize;

        // Max 1000 Märkte scannen
        if (offset >= 1000) {
          hasMore = false;
        }
      }
    }

    logger.info(
      `${allMarkets.length} Märkte mit Volume >= $${minVolume.toLocaleString()} gefunden`
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

    // Politics - erweiterte Keywords für US/DE Politik
    if (
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
      q.includes('merz') ||
      q.includes('scholz') ||
      q.includes('bundestag') ||
      q.includes('afd') ||
      q.includes('cdu') ||
      q.includes('spd') ||
      q.includes('grüne') ||
      q.includes('fdp')
    ) {
      return 'politics';
    }
    // Economics
    if (
      q.includes('econom') ||
      q.includes('fed') ||
      q.includes('inflation') ||
      q.includes('stock') ||
      q.includes('gdp') ||
      q.includes('recession') ||
      q.includes('interest rate') ||
      q.includes('unemployment') ||
      q.includes('s&p') ||
      q.includes('nasdaq') ||
      q.includes('dow')
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
    // Geopolitics
    if (
      q.includes('geopolit') ||
      q.includes('war') ||
      q.includes('international') ||
      q.includes('ukraine') ||
      q.includes('russia') ||
      q.includes('china') ||
      q.includes('nato') ||
      q.includes('sanction')
    ) {
      return 'geopolitics';
    }

    return 'unknown';
  }
}

export const polymarketClient = new PolymarketClient();
export default polymarketClient;
