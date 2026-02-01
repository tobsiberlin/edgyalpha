// ═══════════════════════════════════════════════════════════════
//                    POLYMARKET ALPHA SCANNER - TYPES
// ═══════════════════════════════════════════════════════════════

export interface Market {
  id: string;
  question: string;
  slug: string;
  category: MarketCategory;
  volume24h: number;
  totalVolume: number;
  liquidity: number;
  outcomes: Outcome[];
  endDate: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Outcome {
  id: string;
  name: string;
  price: number; // 0-1 (Wahrscheinlichkeit)
  volume24h: number;
}

export type MarketCategory =
  | 'politics'
  | 'economics'
  | 'crypto'
  | 'sports'
  | 'tech'
  | 'entertainment'
  | 'weather'
  | 'science'
  | 'society'
  | 'geopolitics'
  | 'unknown';

export interface AlphaSignal {
  id: string;
  market: Market;
  score: number; // 0-1 Alpha Score
  edge: number; // Erwarteter Vorteil in %
  confidence: number; // 0-1 Konfidenz
  direction: 'YES' | 'NO';
  reasoning: string;
  sources: string[];
  timestamp: Date;
  germanSource?: GermanSource;
}

export interface GermanSource {
  type: 'dawum' | 'bundestag' | 'destatis' | 'rss';
  title: string;
  url?: string;
  data: Record<string, unknown>;
  relevance: number;
  publishedAt: Date;
}

export interface TradeRecommendation {
  signal: AlphaSignal;
  positionSize: number; // in USDC
  kellyFraction: number;
  expectedValue: number;
  maxLoss: number;
  riskRewardRatio: number;
}

export interface ScanResult {
  timestamp: Date;
  marketsScanned: number;
  signalsFound: AlphaSignal[];
  recommendations: TradeRecommendation[];
  duration: number; // in ms
  errors: string[];
}

export interface WalletState {
  address: string;
  balanceUSDC: number;
  positions: Position[];
  pnl: {
    realized: number;
    unrealized: number;
  };
}

export interface Position {
  marketId: string;
  marketQuestion: string;
  outcome: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  createdAt: Date;
}

export interface Config {
  scanner: {
    intervalMs: number;
    minVolumeUsd: number;
    categories: MarketCategory[];
  };
  trading: {
    enabled: boolean;
    requireConfirmation: boolean;
    maxBetUsdc: number;
    maxBankrollUsdc: number;
    riskPerTradePercent: number;
    kellyFraction: number;
    minAlphaForTrade: number;
  };
  germany: {
    enabled: boolean;
    autoTrade: boolean;
    minEdge: number;
    sources: {
      dawum: boolean;
      bundestag: boolean;
      destatis: boolean;
      rss: boolean;
    };
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
  };
}

export interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: Record<string, unknown>;
}

// WebSocket Events
export type WSEvent =
  | { type: 'scan_started' }
  | { type: 'scan_completed'; data: ScanResult }
  | { type: 'signal_found'; data: AlphaSignal }
  | { type: 'trade_executed'; data: TradeExecution }
  | { type: 'error'; message: string }
  | { type: 'status'; data: SystemStatus };

export interface TradeExecution {
  id: string;
  signal: AlphaSignal;
  recommendation: TradeRecommendation;
  status: 'pending' | 'confirmed' | 'executed' | 'failed' | 'cancelled';
  txHash?: string;
  executedAt?: Date;
  error?: string;
}

export interface SystemStatus {
  uptime: number;
  lastScan: Date | null;
  totalScans: number;
  signalsToday: number;
  tradesToday: number;
  pnlToday: number;
  isScanning: boolean;
  errors: string[];
}
