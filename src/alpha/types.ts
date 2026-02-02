/**
 * Alpha Engines V2 - Type Definitions
 * Strikte Trennung: TIME_DELAY vs MISPRICING
 */

// Feature-Registry für Versionierung
export interface FeatureSet {
  version: string;  // "1.0.0"
  features: Record<string, number | string | boolean | null>;
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL CERTAINTY LEVELS
// Bestimmt das Sizing-Verhalten
// ═══════════════════════════════════════════════════════════════
export type SignalCertainty =
  | 'low'              // Quarter-Kelly, normal
  | 'medium'           // Quarter-Kelly, normal
  | 'high'             // Half-Kelly
  | 'breaking_confirmed';  // HALF IN! 50% Bankroll bei "quasi safe" News

// Basis-Signal (beide Engines)
export interface AlphaSignalV2 {
  signalId: string;
  alphaType: 'timeDelay' | 'mispricing';
  marketId: string;
  question: string;
  direction: 'yes' | 'no';
  predictedEdge: number;
  confidence: number;
  certainty?: SignalCertainty;  // NEU: Für aggressives Sizing bei Breaking News
  features: FeatureSet;
  reasoning: string[];
  createdAt: Date;
}

// TIME_DELAY Features
export interface TimeDelayFeatures extends FeatureSet {
  version: string;
  features: {
    sourceCount: number;
    avgSourceReliability: number;
    newsAgeMinutes: number;
    sentimentScore: number;
    impactScore: number;
    marketPriceAtNews: number;
    priceMoveSinceNews: number;
    volumeAtNews: number;
    volumeChangeSinceNews: number;
    matchConfidence: number;
  };
}

// MISPRICING Features
export interface MispricingFeatures extends FeatureSet {
  version: string;
  features: {
    impliedProb: number;
    estimatedProb: number;
    probUncertainty: number;
    pollDelta: number | null;
    historicalBias: number;
    liquidityScore: number;
    spreadProxy: number;
    volatility30d: number;
    daysToExpiry: number;
  };
}

// Decision mit Risk-Checks
export interface Decision {
  decisionId: string;
  signalId: string;
  action: 'show' | 'watch' | 'trade' | 'high_conviction' | 'reject';
  sizeUsdc: number | null;
  riskChecks: RiskChecks;
  rationale: Rationale;
  createdAt: Date;
}

export interface RiskChecks {
  dailyLossOk: boolean;
  maxPositionsOk: boolean;
  perMarketCapOk: boolean;
  liquidityOk: boolean;
  spreadOk: boolean;
  killSwitchOk: boolean;
}

export interface Rationale {
  alphaType: string;
  edge: number;
  confidence: number;
  topFeatures: string[];
  rejectionReasons?: string[];
}

// Execution
export interface Execution {
  executionId: string;
  decisionId: string;
  mode: 'paper' | 'shadow' | 'live';
  status: 'pending' | 'filled' | 'cancelled' | 'failed';
  fillPrice: number | null;
  fillSize: number | null;
  slippage: number | null;
  fees: number | null;
  txHash: string | null;
  createdAt: Date;
  filledAt: Date | null;
}

// Outcome für Kalibrierung
export interface Outcome {
  executionId: string;
  marketId: string;
  resolution: 'yes' | 'no' | 'invalid' | null;
  exitPrice: number | null;
  pnlUsdc: number | null;
  predictedProb: number;
  actualOutcome: 0 | 1 | null;
  resolvedAt: Date | null;
}

// Market-Quality für Risk-Gates
export interface MarketQuality {
  marketId: string;
  liquidityScore: number;
  spreadProxy: number;
  volume24h: number;
  volatility: number;
  tradeable: boolean;
  reasons: string[];
}

// Source Event für Dedupe
export interface SourceEvent {
  eventHash: string;
  sourceId: string;
  sourceName: string;
  url: string | null;
  title: string;
  content: string | null;
  category: string | null;
  keywords: string[];
  publishedAt: Date | null;
  ingestedAt: Date;
  reliabilityScore: number;
}

// Market Snapshot
export interface MarketSnapshot {
  marketId: string;
  conditionId: string | null;
  question: string;
  category: string | null;
  outcomes: string[];
  prices: number[];
  volume24h: number | null;
  volumeTotal: number | null;
  spreadProxy: number | null;
  liquidityScore: number | null;
  endDate: Date | null;
  snapshotAt: Date;
}

// Historical Trade (poly_data)
export interface HistoricalTrade {
  timestamp: Date;
  marketId: string;
  price: number;
  usdAmount: number;
  tokenAmount: number | null;
  maker: string | null;
  taker: string | null;
  makerDirection: string | null;
  takerDirection: string | null;
  txHash: string | null;
}

// Historical Market (poly_data)
export interface HistoricalMarket {
  marketId: string;
  conditionId: string | null;
  question: string;
  answer1: string | null;
  answer2: string | null;
  token1: string | null;
  token2: string | null;
  marketSlug: string | null;
  volumeTotal: number | null;
  createdAt: Date | null;
  closedAt: Date | null;
  outcome: 'answer1' | 'answer2' | null;
}

// Slippage Model
export interface SlippageModel {
  baseSlippage: number;
  sizeImpact: number;
  liquidityFactor: number;
  volatilityFactor: number;
}

// Calibration Bucket
export interface CalibrationBucket {
  range: [number, number];
  predictedAvg: number;
  actualAvg: number;
  count: number;
}

// Backtest Result
export interface BacktestResult {
  engine: 'timeDelay' | 'mispricing' | 'meta';
  period: { from: Date; to: Date };
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  calibration: CalibrationBucket[];
}

export interface BacktestTrade {
  signalId: string;
  marketId: string;
  direction: 'yes' | 'no';
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  pnl: number | null;
  predictedEdge: number;
  actualEdge: number | null;
  slippage: number;
}

export interface BacktestMetrics {
  totalPnl: number;
  tradeCount: number;
  winRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  brierScore: number;
  avgEdgeCapture: number;
  avgSlippage: number;
}
