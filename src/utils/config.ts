import { config as dotenvConfig } from 'dotenv';
import { Config, MarketCategory, AlphaEngine, ExecutionMode } from '../types/index.js';
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
  TRADING_ENABLED: z.string().default('false'),
  REQUIRE_CONFIRMATION: z.string().default('true'),  // Default: true (sicher)
  MIN_ALPHA_FOR_TRADE: z.string().default('0.15'),

  // Scanner
  SCAN_INTERVAL_MS: z.string().default('300000'),
  MIN_VOLUME_USD: z.string().default('10000'),
  CATEGORIES: z.string().default('politics,economics'),

  // Germany
  GERMANY_MODE_ENABLED: z.string().default('true'),
  GERMANY_AUTO_TRADE: z.string().default('false'),
  GERMANY_MIN_EDGE: z.string().default('0.05'),
  BUNDESTAG_API_KEY: z.string().optional(),
  DAWUM_ENABLED: z.string().default('true'),
  BUNDESTAG_ENABLED: z.string().default('true'),
  DESTATIS_ENABLED: z.string().default('true'),
  RSS_FEEDS_ENABLED: z.string().default('true'),

  // Web Security
  WEB_AUTH_ENABLED: z.string().default('false'),  // Default: keine Auth (für einfaches Setup)
  WEB_USERNAME: z.string().default('admin'),
  WEB_PASSWORD_HASH: z.string().optional(),  // bcrypt hash - REQUIRED wenn WEB_AUTH_ENABLED=true
  WEB_SESSION_SECRET: z.string().optional(),  // min 32 chars - REQUIRED wenn WEB_AUTH_ENABLED=true
  WEB_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),  // comma-separated allowlist für CORS

  // Feature Flags
  ALPHA_ENGINE: z.enum(['timeDelay', 'mispricing', 'meta']).default('meta'),
  EXECUTION_MODE: z.enum(['paper', 'shadow', 'live']).default('paper'),  // Default: paper (kein echtes Trading)
  SQLITE_PATH: z.string().default('./data/edgyalpha.db'),
  BACKTEST_MODE: z.string().default('false'),

  // Auto-Trading bei Breaking News (GEFÄHRLICH - default: false)
  AUTO_TRADE_ENABLED: z.string().default('false'),
  AUTO_TRADE_MIN_EDGE: z.string().default('0.15'),  // 15% minimum Edge
  AUTO_TRADE_MAX_SIZE: z.string().default('50'),    // Max 50 USDC pro Auto-Trade

  // Quick-Buy Button Beträge (USDC)
  QUICK_BUY_AMOUNTS: z.string().default('5,10,25,50'),
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
    autoTrade: env.GERMANY_AUTO_TRADE === 'true',  // Fix: Muss explizit 'true' sein
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
  // Feature Flags
  alphaEngine: env.ALPHA_ENGINE as AlphaEngine,
  executionMode: env.EXECUTION_MODE as ExecutionMode,
  sqlitePath: env.SQLITE_PATH,
  backtestMode: env.BACKTEST_MODE === 'true',
  // Auto-Trading bei Breaking News
  autoTrade: {
    enabled: env.AUTO_TRADE_ENABLED === 'true',
    minEdge: parseFloat(env.AUTO_TRADE_MIN_EDGE),
    maxSize: parseFloat(env.AUTO_TRADE_MAX_SIZE),
  },
  // Quick-Buy Button Beträge
  quickBuy: {
    amounts: env.QUICK_BUY_AMOUNTS.split(',').map(a => parseFloat(a.trim())).filter(a => !isNaN(a) && a > 0),
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
export const WEB_SESSION_SECRET = env.WEB_SESSION_SECRET;
export const WEB_ALLOWED_ORIGINS = env.WEB_ALLOWED_ORIGINS;
export const WEB_AUTH_ENABLED = env.WEB_AUTH_ENABLED === 'true';

export default config;
