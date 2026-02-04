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
// SIGNAL REASONING - Erklärt WARUM ein Signal interessant ist
// ═══════════════════════════════════════════════════════════════

/**
 * Einzelner Faktor, der zum Signal beiträgt
 * Macht transparent, welche Komponenten wie stark einfließen
 */
export interface ReasoningFactor {
  name: string;         // "Zeitvorsprung", "Quellen-Qualität", "News-Match"
  value: number;        // 0-1 Rohwert
  weight: number;       // Gewichtung im Gesamtscore
  contribution: number; // value * weight = Beitrag zum Score
  explanation: string;  // "News 15 Min vor Marktreaktion"
}

/**
 * News-Match Information (wenn Signal durch News getriggert)
 */
export interface NewsMatchInfo {
  newsTitle: string;
  newsSource: string;
  matchConfidence: number;     // 0-1 wie gut passt News zu Markt
  matchedKeywords: string[];   // Welche Keywords haben gematcht
  isBreaking: boolean;         // Ist es eine Breaking News?
  ageMinutes: number;          // Alter der News in Minuten
}

/**
 * Vollständiges Reasoning für ein Signal
 * Erklärt dem User, WARUM dieses Signal interessant ist
 */
export interface SignalReasoning {
  summary: string;             // "Deutsche News über Bundestagswahl matched mit CDU-Umfrage-Markt"
  factors: ReasoningFactor[];  // Alle Score-Komponenten
  totalScore: number;          // Gesamtscore 0-1
  matchInfo?: NewsMatchInfo;   // News-Details (falls vorhanden)
  whyInteresting: string[];    // Kurze Bullet-Points warum das interessant ist
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
  // NEU: Strukturiertes Reasoning
  structuredReasoning?: SignalReasoning;
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
  direction: 'yes' | 'no';  // EXPLIZITE RICHTUNG - nicht aus String-Matching!
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
  direction?: 'yes' | 'no';  // Gespeichert für Backwards-Compatibility
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

// Out-of-Sample Validation Result
export interface ValidationResult {
  trainMetrics: BacktestMetrics;
  testMetrics: BacktestMetrics;
  trainTrades: BacktestTrade[];
  testTrades: BacktestTrade[];
  splitRatio: number; // z.B. 0.7 = 70% Train
  overfittingWarnings: OverfittingWarning[];
}

export interface OverfittingWarning {
  type: 'sharpe_too_high' | 'train_test_divergence' | 'unrealistic_returns' | 'low_trade_count';
  severity: 'low' | 'medium' | 'high';
  message: string;
  details?: Record<string, number>;
}

// Monte Carlo Result
export interface MonteCarloResult {
  simulations: number;
  pnlDistribution: {
    mean: number;
    median: number;
    stdDev: number;
    percentile5: number;
    percentile25: number;
    percentile75: number;
    percentile95: number;
  };
  winRateDistribution: {
    mean: number;
    stdDev: number;
    percentile5: number;
    percentile95: number;
  };
  maxDrawdownDistribution: {
    mean: number;
    worst: number;
    percentile5: number;
    percentile95: number;
  };
  confidenceInterval95: {
    pnlLower: number;
    pnlUpper: number;
  };
}

// Extended Backtest Result with Validation
export interface ExtendedBacktestResult extends BacktestResult {
  validation?: ValidationResult;
  monteCarlo?: MonteCarloResult;
  walkForwardWindow: number;
}
