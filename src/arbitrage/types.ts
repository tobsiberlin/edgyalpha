/**
 * Dutch-Book Arbitrage Types
 * Typen für risikofreie Arbitrage-Opportunitäten
 */

/**
 * Arbitrage Opportunity
 * Repräsentiert eine Dutch-Book Arbitrage Gelegenheit
 */
export interface ArbitrageOpportunity {
  id: string;
  marketId: string;
  question: string;
  slug?: string;

  // Preise
  yesPrice: number;      // YES Token Preis (0-1)
  noPrice: number;       // NO Token Preis (0-1)
  totalCost: number;     // YES + NO Kosten
  spread: number;        // $1.00 - totalCost = garantierter Profit

  // Liquidität
  yesLiquidity: number;  // Verfügbare YES Liquidität in $
  noLiquidity: number;   // Verfügbare NO Liquidität in $
  maxSize: number;       // Max. Positionsgröße (min von beiden)

  // Qualität
  profitPercent: number; // Profit in Prozent
  qualityScore: number;  // 0-1 Score basierend auf Spread + Liquidität

  // Timing
  detectedAt: Date;
  expiresAt?: Date;
}

/**
 * Arbitrage Signal
 * Ein bestätigtes Signal zum Ausführen
 */
export interface ArbitrageSignal {
  opportunity: ArbitrageOpportunity;
  recommendedSize: number;  // Empfohlene Positionsgröße in $
  expectedProfit: number;   // Erwarteter Profit in $
  confidence: number;       // Konfidenz (0-1)
  reasoning: string[];      // Begründung
}

/**
 * Arbitrage Trade
 * Ein ausgeführter oder geplanter Trade
 */
export interface ArbitrageTrade {
  id: string;
  signalId: string;
  marketId: string;

  // Order Details
  yesOrderId?: string;
  noOrderId?: string;
  yesSize: number;        // Gekaufte YES Shares
  noSize: number;         // Gekaufte NO Shares
  totalCost: number;      // Gesamtkosten

  // Status
  status: 'pending' | 'partial' | 'filled' | 'failed' | 'cancelled';
  yesFilled: boolean;
  noFilled: boolean;

  // Execution Details
  yesFillPrice?: number;
  noFillPrice?: number;
  actualCost?: number;
  slippage?: number;

  // Timing
  createdAt: Date;
  executedAt?: Date;
  resolvedAt?: Date;

  // Profit
  grossProfit?: number;   // Vor Fees
  fees?: number;
  netProfit?: number;     // Nach Fees
}

/**
 * Arbitrage Engine Config
 */
export interface ArbitrageConfig {
  enabled: boolean;

  // Thresholds
  minSpread: number;          // Min. Spread für Signal (default: 0.01 = 1%)
  minLiquidity: number;       // Min. Liquidität pro Seite in $ (default: 100)
  maxSlippage: number;        // Max. erlaubte Slippage (default: 0.005 = 0.5%)

  // Sizing
  minTradeSize: number;       // Min. Trade Size in $ (default: 5)
  maxTradeSize: number;       // Max. Trade Size in $ (default: 100)
  maxBankrollPercent: number; // Max. % des Bankrolls pro Trade (default: 0.1)

  // Execution
  useMarketOrders: boolean;   // Market Orders statt Limit (schneller, mehr Slippage)
  orderTimeout: number;       // Timeout in ms für FOK Orders (default: 5000)

  // Scanner
  scanIntervalMs: number;     // Scan-Intervall in ms (default: 10000)
  maxMarketsPerScan: number;  // Max. Märkte pro Scan (default: 500)
}

export const DEFAULT_ARBITRAGE_CONFIG: ArbitrageConfig = {
  enabled: false,           // Default: deaktiviert bis User es aktiviert

  minSpread: 0.01,          // 1% Minimum Spread
  minLiquidity: 100,        // $100 Minimum pro Seite
  maxSlippage: 0.005,       // 0.5% Max Slippage

  minTradeSize: 5,          // $5 Minimum
  maxTradeSize: 100,        // $100 Maximum
  maxBankrollPercent: 0.1,  // 10% des Bankrolls max

  useMarketOrders: false,   // Limit Orders für bessere Preise
  orderTimeout: 5000,       // 5 Sekunden FOK Timeout

  scanIntervalMs: 10000,    // Alle 10 Sekunden scannen
  maxMarketsPerScan: 500,   // 500 Märkte max
};

/**
 * Arbitrage Stats
 */
export interface ArbitrageStats {
  scansTotal: number;
  opportunitiesFound: number;
  signalsGenerated: number;
  tradesExecuted: number;
  tradesFailed: number;

  totalVolume: number;      // Gesamtvolumen in $
  totalProfit: number;      // Gesamtprofit in $
  avgProfitPercent: number; // Durchschnittlicher Profit %

  lastScanAt?: Date;
  lastOpportunityAt?: Date;
  lastTradeAt?: Date;
}
