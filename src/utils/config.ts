import { config as dotenvConfig } from 'dotenv';
import { Config, MarketCategory } from '../types/index.js';
import { z } from 'zod';

// .env laden
dotenvConfig();
dotenvConfig({ path: '.env.local', override: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_ENABLED: z.string().default('false'),

  // Trading
  POLYGON_RPC_URL: z.string().default('https://polygon-rpc.com'),
  WALLET_PRIVATE_KEY: z.string().optional(),
  WALLET_ADDRESS: z.string().optional(),
  MAX_BANKROLL_USDC: z.string().default('1000'),
  MAX_BET_USDC: z.string().default('10'),
  RISK_PER_TRADE_PERCENT: z.string().default('10'),
  KELLY_FRACTION: z.string().default('0.25'),
  TRADING_ENABLED: z.string().default('true'),
  REQUIRE_CONFIRMATION: z.string().default('true'),
  MIN_ALPHA_FOR_TRADE: z.string().default('0.5'),

  // Scanner
  SCAN_INTERVAL_MS: z.string().default('300000'),
  MIN_VOLUME_USD: z.string().default('100000'),
  CATEGORIES: z.string().default('politics,economics'),

  // Germany
  GERMANY_MODE_ENABLED: z.string().default('true'),
  GERMANY_AUTO_TRADE: z.string().default('false'),
  GERMANY_MIN_EDGE: z.string().default('0.10'),
  BUNDESTAG_API_KEY: z.string().optional(),
  DAWUM_ENABLED: z.string().default('true'),
  BUNDESTAG_ENABLED: z.string().default('true'),
  DESTATIS_ENABLED: z.string().default('true'),
  RSS_FEEDS_ENABLED: z.string().default('true'),

  // Web
  WEB_AUTH_ENABLED: z.string().default('true'),
  WEB_USERNAME: z.string().default('admin'),
  WEB_PASSWORD_HASH: z.string().optional(),
});

const env = envSchema.parse(process.env);

function parseCategories(cats: string): MarketCategory[] {
  const validCategories: MarketCategory[] = [
    'politics',
    'economics',
    'crypto',
    'sports',
    'tech',
    'entertainment',
    'weather',
    'science',
    'society',
    'geopolitics',
  ];

  return cats
    .split(',')
    .map((c) => c.trim().toLowerCase() as MarketCategory)
    .filter((c) => validCategories.includes(c));
}

export const config: Config = {
  scanner: {
    intervalMs: parseInt(env.SCAN_INTERVAL_MS, 10),
    minVolumeUsd: parseInt(env.MIN_VOLUME_USD, 10),
    categories: parseCategories(env.CATEGORIES),
  },
  trading: {
    enabled: env.TRADING_ENABLED === 'true',
    requireConfirmation: env.REQUIRE_CONFIRMATION === 'true',
    maxBetUsdc: parseFloat(env.MAX_BET_USDC),
    maxBankrollUsdc: parseFloat(env.MAX_BANKROLL_USDC),
    riskPerTradePercent: parseFloat(env.RISK_PER_TRADE_PERCENT),
    kellyFraction: parseFloat(env.KELLY_FRACTION),
    minAlphaForTrade: parseFloat(env.MIN_ALPHA_FOR_TRADE),
  },
  germany: {
    enabled: env.GERMANY_MODE_ENABLED === 'true',
    autoTrade: env.GERMANY_AUTO_TRADE === 'false',
    minEdge: parseFloat(env.GERMANY_MIN_EDGE),
    sources: {
      dawum: env.DAWUM_ENABLED === 'true',
      bundestag: env.BUNDESTAG_ENABLED === 'true',
      destatis: env.DESTATIS_ENABLED === 'true',
      rss: env.RSS_FEEDS_ENABLED === 'true',
    },
  },
  telegram: {
    enabled: env.TELEGRAM_ENABLED === 'true',
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_CHAT_ID || '',
  },
};

export const PORT = parseInt(env.PORT, 10);
export const NODE_ENV = env.NODE_ENV;
export const WALLET_PRIVATE_KEY = env.WALLET_PRIVATE_KEY;
export const WALLET_ADDRESS = env.WALLET_ADDRESS;
export const POLYGON_RPC_URL = env.POLYGON_RPC_URL;
export const BUNDESTAG_API_KEY = env.BUNDESTAG_API_KEY;
export const WEB_USERNAME = env.WEB_USERNAME;
export const WEB_PASSWORD_HASH = env.WEB_PASSWORD_HASH;

export default config;
