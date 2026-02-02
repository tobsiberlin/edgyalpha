/**
 * Trade Simulator für Backtesting
 * Simuliert Trades mit realistischem Slippage und Fees
 */

import {
  AlphaSignalV2,
  BacktestTrade,
  MarketQuality,
  HistoricalTrade,
} from '../alpha/types.js';
import { estimateSlippage, DEFAULT_SLIPPAGE_MODEL } from '../alpha/sizing.js';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface SimulatorConfig {
  initialBankroll: number;
  slippageEnabled: boolean;
  feesPercent: number; // Default: 0.1%
}

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  initialBankroll: 1000,
  slippageEnabled: true,
  feesPercent: 0.001, // 0.1%
};

// ═══════════════════════════════════════════════════════════════
// TRADE SIMULATOR
// ═══════════════════════════════════════════════════════════════

export class TradeSimulator {
  private bankroll: number;
  private config: SimulatorConfig;
  private tradeHistory: BacktestTrade[] = [];

  constructor(config?: Partial<SimulatorConfig>) {
    this.config = { ...DEFAULT_SIMULATOR_CONFIG, ...config };
    this.bankroll = this.config.initialBankroll;
  }

  /**
   * Simuliere einen Trade mit historischen Daten
   * @param signal - Das Alpha-Signal
   * @param historicalTrades - Trades die zum Zeitpunkt des Signals verfügbar waren
   * @param resolution - 'yes' oder 'no' wenn der Markt resolved ist, null sonst
   */
  simulateTrade(
    signal: AlphaSignalV2,
    historicalTrades: HistoricalTrade[],
    resolution: 'yes' | 'no' | null
  ): BacktestTrade {
    // Filtere nur Trades VOR dem Signal (kein Lookahead-Bias)
    const tradesBeforeSignal = historicalTrades.filter(
      (t) => t.timestamp <= signal.createdAt
    );

    // Berechne Trade-Size (Quarter-Kelly vereinfacht)
    const kellyFraction = 0.25;
    const rawSize = this.bankroll * signal.predictedEdge * 2 * kellyFraction;
    const size = Math.min(rawSize, this.bankroll * 0.1, 100); // Max 10% oder $100

    // Berechne Fill-Preis aus historischen Trades
    const { price: fillPrice, slippage } = this.calculateFillPrice(
      tradesBeforeSignal,
      signal.direction,
      size,
      signal.createdAt
    );

    // Entry-Preis mit Slippage
    const entryPrice = this.config.slippageEnabled
      ? fillPrice + (signal.direction === 'yes' ? slippage : -slippage)
      : fillPrice;

    // Exit-Preis und PnL basierend auf Resolution
    let exitPrice: number | null = null;
    let pnl: number | null = null;
    let actualEdge: number | null = null;

    if (resolution !== null) {
      // Market hat resolved
      exitPrice = resolution === 'yes' ? 1.0 : 0.0;
      pnl = this.calculatePnL(entryPrice, exitPrice, size, signal.direction, resolution);

      // Actual Edge = was wir bekommen haben vs. was wir bezahlt haben
      if (signal.direction === 'yes') {
        actualEdge = resolution === 'yes' ? (1 - entryPrice) : -entryPrice;
      } else {
        actualEdge = resolution === 'no' ? (1 - entryPrice) : -entryPrice;
      }

      // Update Bankroll
      if (pnl !== null) {
        this.bankroll += pnl;
      }
    }

    // Fees abziehen
    const fees = size * this.config.feesPercent;
    if (pnl !== null) {
      pnl -= fees;
      this.bankroll -= fees;
    }

    const trade: BacktestTrade = {
      signalId: signal.signalId,
      marketId: signal.marketId,
      direction: signal.direction,
      entryPrice: Math.max(0.01, Math.min(0.99, entryPrice)), // Clamp to valid range
      exitPrice,
      size,
      pnl,
      predictedEdge: signal.predictedEdge,
      actualEdge,
      slippage: this.config.slippageEnabled ? slippage : 0,
    };

    this.tradeHistory.push(trade);

    logger.debug(
      `Simulierter Trade: ${signal.marketId.substring(0, 8)}... | ` +
        `${signal.direction.toUpperCase()} @ ${entryPrice.toFixed(3)} | ` +
        `Size: $${size.toFixed(2)} | PnL: ${pnl !== null ? `$${pnl.toFixed(2)}` : 'pending'}`
    );

    return trade;
  }

  /**
   * Berechne realistischen Fill-Preis aus historischen Trades
   * Verwendet VWAP der letzten Trades als Basis
   */
  private calculateFillPrice(
    trades: HistoricalTrade[],
    direction: 'yes' | 'no',
    size: number,
    signalTime: Date
  ): { price: number; slippage: number } {
    if (trades.length === 0) {
      // Fallback: 50/50 mit Standard-Slippage
      return {
        price: 0.5,
        slippage: 0.01,
      };
    }

    // Nimm die letzten 10 Trades vor Signal-Zeit
    const recentTrades = trades
      .filter((t) => t.timestamp <= signalTime)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 10);

    if (recentTrades.length === 0) {
      const lastTrade = trades[trades.length - 1];
      return {
        price: lastTrade.price,
        slippage: 0.01,
      };
    }

    // VWAP berechnen
    let totalValue = 0;
    let totalVolume = 0;

    for (const trade of recentTrades) {
      totalValue += trade.price * trade.usdAmount;
      totalVolume += trade.usdAmount;
    }

    const vwap = totalVolume > 0 ? totalValue / totalVolume : recentTrades[0].price;

    // Slippage schätzen basierend auf Liquidität
    // Mehr Volume in letzten Trades = weniger Slippage
    const avgVolume = totalVolume / recentTrades.length;
    const liquidityFactor = Math.min(1, avgVolume / 1000); // $1000 = volle Liquidität

    // Basis-Slippage + Size-Impact
    let slippage = 0.005; // 0.5% Basis
    slippage += (size / 1000) * 0.002; // 0.2% pro $1000
    slippage *= 1 + (1 - liquidityFactor) * 2; // Illiquiditäts-Penalty

    // Bei NO-Trades: Inverse Betrachtung
    const basePrice = direction === 'yes' ? vwap : 1 - vwap;

    return {
      price: basePrice,
      slippage: Math.min(slippage, 0.05), // Max 5% Slippage
    };
  }

  /**
   * Berechne PnL
   */
  private calculatePnL(
    entryPrice: number,
    exitPrice: number | null,
    size: number,
    direction: 'yes' | 'no',
    resolution: 'yes' | 'no' | null
  ): number | null {
    if (exitPrice === null || resolution === null) {
      return null;
    }

    // Anzahl Contracts = Size / Entry Price
    const contracts = size / entryPrice;

    if (direction === 'yes') {
      // YES gekauft: Gewinn wenn resolution = yes
      if (resolution === 'yes') {
        return contracts * 1.0 - size; // Jeder Contract zahlt $1 aus
      } else {
        return -size; // Totalverlust
      }
    } else {
      // NO gekauft (= YES verkauft): Gewinn wenn resolution = no
      if (resolution === 'no') {
        return contracts * 1.0 - size;
      } else {
        return -size;
      }
    }
  }

  /**
   * Getter für aktuellen Bankroll
   */
  getBankroll(): number {
    return this.bankroll;
  }

  /**
   * Getter für Trade-History
   */
  getTradeHistory(): BacktestTrade[] {
    return [...this.tradeHistory];
  }

  /**
   * Reset Simulator
   */
  reset(): void {
    this.bankroll = this.config.initialBankroll;
    this.tradeHistory = [];
  }

  /**
   * Bankroll-Curve für Drawdown-Berechnung
   */
  getBankrollCurve(): number[] {
    const curve: number[] = [this.config.initialBankroll];
    let running = this.config.initialBankroll;

    for (const trade of this.tradeHistory) {
      if (trade.pnl !== null) {
        running += trade.pnl;
        curve.push(running);
      }
    }

    return curve;
  }
}

export default TradeSimulator;
