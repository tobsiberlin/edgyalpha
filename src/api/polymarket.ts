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

    // Parse outcomes from tokens
    const tokens = (raw.tokens as Array<Record<string, unknown>>) || [];
    for (const token of tokens) {
      outcomes.push({
        id: String(token.token_id || token.id || ''),
        name: String(token.outcome || 'Unknown'),
        price: parseFloat(String(token.price || 0)),
        volume24h: parseFloat(String(token.volume_24h || 0)),
      });
    }

    // Falls keine outcomes aus tokens, versuche clobTokenIds
    if (outcomes.length === 0) {
      const clobTokenIds = raw.clobTokenIds as string[] | undefined;
      if (clobTokenIds && clobTokenIds.length >= 2) {
        outcomes.push(
          { id: clobTokenIds[0], name: 'Yes', price: 0.5, volume24h: 0 },
          { id: clobTokenIds[1], name: 'No', price: 0.5, volume24h: 0 }
        );
      }
    }

    return {
      id: String(raw.id || raw.condition_id || ''),
      question: String(raw.question || raw.title || ''),
      slug: String(raw.slug || ''),
      category: this.parseCategory(String(raw.category || raw.tags || '')),
      volume24h: parseFloat(String(raw.volume_24h || raw.volume24hr || 0)),
      totalVolume: parseFloat(String(raw.volume || raw.totalVolume || 0)),
      liquidity: parseFloat(String(raw.liquidity || 0)),
      outcomes,
      endDate: String(raw.end_date_iso || raw.endDate || ''),
      resolved: Boolean(raw.resolved || raw.closed),
      createdAt: String(raw.created_at || raw.createdAt || ''),
      updatedAt: String(raw.updated_at || raw.updatedAt || ''),
    };
  }

  private parseCategory(category: string): MarketCategory {
    const cat = category.toLowerCase();

    if (cat.includes('politic') || cat.includes('election') || cat.includes('government')) {
      return 'politics';
    }
    if (cat.includes('econom') || cat.includes('fed') || cat.includes('inflation') || cat.includes('stock')) {
      return 'economics';
    }
    if (cat.includes('crypto') || cat.includes('bitcoin') || cat.includes('ethereum')) {
      return 'crypto';
    }
    if (cat.includes('sport') || cat.includes('nba') || cat.includes('nfl') || cat.includes('soccer')) {
      return 'sports';
    }
    if (cat.includes('tech') || cat.includes('ai') || cat.includes('apple') || cat.includes('tesla')) {
      return 'tech';
    }
    if (cat.includes('entertainment') || cat.includes('movie') || cat.includes('music')) {
      return 'entertainment';
    }
    if (cat.includes('weather') || cat.includes('climate')) {
      return 'weather';
    }
    if (cat.includes('science')) {
      return 'science';
    }
    if (cat.includes('society') || cat.includes('culture')) {
      return 'society';
    }
    if (cat.includes('geopolit') || cat.includes('war') || cat.includes('international')) {
      return 'geopolitics';
    }

    return 'unknown';
  }
}

export const polymarketClient = new PolymarketClient();
export default polymarketClient;
