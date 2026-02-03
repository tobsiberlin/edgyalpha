/**
 * Late-Entry V3 Strategy Types
 * Typen für 15-Min Crypto Markets mit spätem Einstieg
 */

/**
 * Unterstützte Coins für die Late-Entry Strategie
 */
export type SupportedCoin = 'BTC' | 'ETH' | 'SOL' | 'XRP';

/**
 * Market-Zeitfenster
 */
export interface MarketWindow {
  marketId: string;
  coin: SupportedCoin;
  question: string;
  slug?: string;

  // Zeitfenster
  startTime: Date;         // Markt-Start
  endTime: Date;           // Markt-Ende (Resolution)
  durationMinutes: number; // Typisch: 15 Min

  // Aktueller Stand
  currentPrice: number;    // YES Preis (0-1)
  direction: 'up' | 'down' | 'neutral'; // Implizierte Richtung

  // Timing
  secondsRemaining: number;
  isInEntryWindow: boolean; // Letzten 4 Minuten?
  entryWindowStart: Date;   // Wann Entry-Window beginnt
}

/**
 * Late-Entry Signal
 * Ein Signal zum Einsteigen in den letzten 4 Minuten
 */
export interface LateEntrySignal {
  id: string;
  window: MarketWindow;

  // Signal Details
  direction: 'yes' | 'no';
  confidence: number;       // 0-1 basierend auf Preis-Momentum
  entryPrice: number;       // Aktueller Preis
  targetPrice: number;      // Erwarteter Auszahlungspreis (meist 0 oder 1)

  // Timing
  secondsToClose: number;
  urgency: 'high' | 'medium' | 'low';

  // Sizing
  recommendedSize: number;
  maxSize: number;

  // Reasoning
  reasoning: string[];
  createdAt: Date;
}

/**
 * Late-Entry Trade
 */
export interface LateEntryTrade {
  id: string;
  signalId: string;
  marketId: string;
  coin: SupportedCoin;

  // Order Details
  orderId?: string;
  direction: 'yes' | 'no';
  size: number;             // In $
  entryPrice: number;

  // Status
  status: 'pending' | 'filled' | 'failed' | 'resolved';
  fillPrice?: number;

  // Resolution
  resolved: boolean;
  outcome?: 'yes' | 'no';
  payout?: number;          // Auszahlung ($1 pro Share wenn gewonnen)
  profit?: number;          // Profit = Payout - Size

  // Timing
  createdAt: Date;
  filledAt?: Date;
  resolvedAt?: Date;
}

/**
 * Late-Entry Config
 */
export interface LateEntryConfig {
  enabled: boolean;

  // Coins
  enabledCoins: SupportedCoin[];

  // Timing
  entryWindowSeconds: number;    // Letzten X Sekunden (default: 240 = 4 min)
  minSecondsRemaining: number;   // Min. Sekunden vor Close (default: 30)

  // Confidence
  minConfidence: number;         // Min. Konfidenz (default: 0.30)
  strongConfidenceThreshold: number; // Ab wann "stark" (default: 0.70)

  // Sizing
  minTradeSize: number;          // Min. Size in $ (default: 1)
  maxTradeSize: number;          // Max. Size in $ (default: 50)
  sizingMultiplierByConfidence: boolean; // Higher confidence = larger size?

  // Risk
  maxDailyLoss: number;          // Max. täglicher Verlust in $ (default: 100)
  maxConcurrentTrades: number;   // Max. parallele Trades (default: 4)

  // Execution
  useMarketOrders: boolean;      // Market Orders für Speed
  orderTimeout: number;          // Timeout in ms
}

export const DEFAULT_LATE_ENTRY_CONFIG: LateEntryConfig = {
  enabled: false,

  enabledCoins: ['BTC', 'ETH', 'SOL', 'XRP'],

  entryWindowSeconds: 240,       // 4 Minuten
  minSecondsRemaining: 30,       // 30 Sekunden Mindestabstand

  minConfidence: 0.30,           // 30% Minimum
  strongConfidenceThreshold: 0.70,

  minTradeSize: 1,               // $1 Minimum
  maxTradeSize: 50,              // $50 Maximum
  sizingMultiplierByConfidence: true,

  maxDailyLoss: 100,             // $100/Tag Max Verlust
  maxConcurrentTrades: 4,        // 4 Coins = 4 Trades parallel

  useMarketOrders: true,         // Speed > Price
  orderTimeout: 3000,            // 3 Sekunden
};

/**
 * Late-Entry Stats
 */
export interface LateEntryStats {
  // Counts
  marketsMonitored: number;
  signalsGenerated: number;
  tradesExecuted: number;
  tradesWon: number;
  tradesLost: number;

  // Financial
  totalVolume: number;
  totalPayout: number;
  totalProfit: number;
  winRate: number;              // 0-1

  // By Coin
  statsByCoin: Record<SupportedCoin, {
    trades: number;
    wins: number;
    profit: number;
  }>;

  // Timing
  lastSignalAt?: Date;
  lastTradeAt?: Date;
}

/**
 * Crypto Market Pattern für 15-Min Märkte
 */
export const CRYPTO_MARKET_PATTERNS: Record<SupportedCoin, RegExp> = {
  BTC: /bitcoin|btc/i,
  ETH: /ethereum|eth/i,
  SOL: /solana|sol/i,
  XRP: /xrp|ripple/i,
};

/**
 * Prüft ob ein Markt ein 15-Min Crypto Markt ist
 */
export function isCryptoMarket(question: string): SupportedCoin | null {
  for (const [coin, pattern] of Object.entries(CRYPTO_MARKET_PATTERNS)) {
    if (pattern.test(question)) {
      return coin as SupportedCoin;
    }
  }
  return null;
}
