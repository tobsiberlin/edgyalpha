/**
 * Execution Quality Monitoring V1
 *
 * Trackt und analysiert die Qualität der Trade-Execution:
 * - Slippage Analysis (Expected vs. Actual)
 * - Latency Monitoring (Signal → Fill)
 * - Fill Rate Tracking
 * - Execution Quality Score
 *
 * Cash-Machine Maxim: "Kosten senken = Alpha steigern"
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
//                         INTERFACES
// ═══════════════════════════════════════════════════════════════

export interface ExecutionRecord {
  executionId: string;
  signalId: string;
  marketId: string;
  direction: 'yes' | 'no';

  // Prices
  signalPrice: number;        // Preis bei Signal-Generierung
  orderPrice: number;         // Limit-Order Preis (wenn applicable)
  fillPrice: number | null;   // Tatsächlicher Fill-Preis

  // Size
  requestedSize: number;      // Gewünschte Size
  filledSize: number | null;  // Tatsächliche Fill Size

  // Timing
  signalTime: Date;
  orderTime: Date | null;
  fillTime: Date | null;

  // Slippage
  expectedSlippage: number;   // Geschätzter Slippage
  actualSlippage: number | null;  // Tatsächlicher Slippage

  // Status
  status: 'pending' | 'partial' | 'filled' | 'cancelled' | 'failed';
  failureReason?: string;

  // Market Conditions
  spreadAtSignal: number;
  volumeAtSignal: number;
  volatilityAtSignal: number;
}

export interface ExecutionMetrics {
  // Counts
  totalExecutions: number;
  filledExecutions: number;
  partialFills: number;
  cancelledExecutions: number;
  failedExecutions: number;
  fillRate: number;

  // Slippage
  avgExpectedSlippage: number;
  avgActualSlippage: number;
  slippageAccuracy: number;  // Wie gut predicted unser Modell?
  worstSlippage: number;
  slippageCost: number;      // Total $ verloren durch Slippage

  // Latency (ms)
  avgLatencySignalToOrder: number;
  avgLatencyOrderToFill: number;
  avgTotalLatency: number;
  maxLatency: number;
  p95Latency: number;

  // Quality Scores
  executionQualityScore: number;  // 0-100
  priceImprovementRate: number;   // Wie oft besser als erwartet?
  slippageControlScore: number;   // Wie gut kontrollieren wir Slippage?
}

export interface ExecutionAlert {
  type: 'high_slippage' | 'slow_fill' | 'fill_failure' | 'model_drift';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  details: Record<string, unknown>;
  timestamp: Date;
}

// ═══════════════════════════════════════════════════════════════
//                         CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface ExecutionQualityConfig {
  // Alert Thresholds
  highSlippageThreshold: number;      // Alert wenn Slippage > X (z.B. 0.02 = 2%)
  slowFillThresholdMs: number;        // Alert wenn Fill > X ms (z.B. 30000 = 30s)
  modelDriftThreshold: number;        // Alert wenn Actual/Expected Slippage > X

  // Analysis Window
  rollingWindowSize: number;          // Anzahl Executions für Rolling Metrics
  alertCooldownMs: number;            // Cooldown zwischen gleichen Alerts
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionQualityConfig = {
  highSlippageThreshold: 0.02,        // 2%
  slowFillThresholdMs: 30000,         // 30 Sekunden
  modelDriftThreshold: 2.0,           // Wenn Actual > 2x Expected
  rollingWindowSize: 100,
  alertCooldownMs: 300000,            // 5 Minuten
};

// ═══════════════════════════════════════════════════════════════
//                    EXECUTION QUALITY MONITOR
// ═══════════════════════════════════════════════════════════════

export class ExecutionQualityMonitor extends EventEmitter {
  private config: ExecutionQualityConfig;
  private executions: ExecutionRecord[] = [];
  private lastAlerts: Map<string, Date> = new Map();

  constructor(config?: Partial<ExecutionQualityConfig>) {
    super();
    this.config = { ...DEFAULT_EXECUTION_CONFIG, ...config };
  }

  // ═══════════════════════════════════════════════════════════════
  //                       RECORD METHODS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Erstelle neuen Execution Record bei Signal
   */
  recordSignal(data: {
    executionId: string;
    signalId: string;
    marketId: string;
    direction: 'yes' | 'no';
    signalPrice: number;
    requestedSize: number;
    expectedSlippage: number;
    spreadAtSignal: number;
    volumeAtSignal: number;
    volatilityAtSignal: number;
  }): ExecutionRecord {
    const record: ExecutionRecord = {
      ...data,
      orderPrice: 0,
      fillPrice: null,
      filledSize: null,
      signalTime: new Date(),
      orderTime: null,
      fillTime: null,
      actualSlippage: null,
      status: 'pending',
    };

    this.executions.push(record);

    // Rolling Window
    while (this.executions.length > this.config.rollingWindowSize * 2) {
      this.executions.shift();
    }

    return record;
  }

  /**
   * Aktualisiere Record bei Order-Submission
   */
  recordOrder(executionId: string, orderPrice: number): void {
    const record = this.findRecord(executionId);
    if (!record) return;

    record.orderPrice = orderPrice;
    record.orderTime = new Date();
  }

  /**
   * Aktualisiere Record bei Fill
   */
  recordFill(
    executionId: string,
    fillPrice: number,
    filledSize: number,
    partial: boolean = false
  ): void {
    const record = this.findRecord(executionId);
    if (!record) return;

    record.fillPrice = fillPrice;
    record.filledSize = filledSize;
    record.fillTime = new Date();
    record.status = partial ? 'partial' : 'filled';

    // Actual Slippage berechnen
    // Slippage = (fillPrice - signalPrice) / signalPrice * direction
    // Für YES: höherer Fill = schlechter (positiver Slippage)
    // Für NO: niedrigerer Fill = schlechter (positiver Slippage)
    const priceDiff = fillPrice - record.signalPrice;
    const slippageSign = record.direction === 'yes' ? 1 : -1;
    record.actualSlippage = (priceDiff / record.signalPrice) * slippageSign;

    // Check for Alerts
    this.checkAlerts(record);

    // Emit Event
    this.emit('fill', {
      executionId,
      actualSlippage: record.actualSlippage,
      expectedSlippage: record.expectedSlippage,
      latencyMs: record.fillTime.getTime() - record.signalTime.getTime(),
    });

    logger.debug(
      `[EXECUTION] Fill: ${executionId} | ` +
      `Slippage: ${(record.actualSlippage * 100).toFixed(3)}% ` +
      `(expected: ${(record.expectedSlippage * 100).toFixed(3)}%)`
    );
  }

  /**
   * Markiere als cancelled oder failed
   */
  recordFailure(executionId: string, status: 'cancelled' | 'failed', reason?: string): void {
    const record = this.findRecord(executionId);
    if (!record) return;

    record.status = status;
    record.failureReason = reason;

    // Alert für Failures
    if (status === 'failed') {
      this.emitAlert({
        type: 'fill_failure',
        severity: 'warning',
        message: `Execution fehlgeschlagen: ${reason || 'Unbekannter Grund'}`,
        details: { executionId, marketId: record.marketId, reason },
        timestamp: new Date(),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                       ALERT METHODS
  // ═══════════════════════════════════════════════════════════════

  private checkAlerts(record: ExecutionRecord): void {
    // High Slippage Alert
    if (record.actualSlippage && record.actualSlippage > this.config.highSlippageThreshold) {
      this.emitAlert({
        type: 'high_slippage',
        severity: record.actualSlippage > this.config.highSlippageThreshold * 2 ? 'critical' : 'warning',
        message: `Hoher Slippage: ${(record.actualSlippage * 100).toFixed(2)}%`,
        details: {
          executionId: record.executionId,
          marketId: record.marketId,
          expectedSlippage: record.expectedSlippage,
          actualSlippage: record.actualSlippage,
        },
        timestamp: new Date(),
      });
    }

    // Slow Fill Alert
    if (record.fillTime && record.signalTime) {
      const latency = record.fillTime.getTime() - record.signalTime.getTime();
      if (latency > this.config.slowFillThresholdMs) {
        this.emitAlert({
          type: 'slow_fill',
          severity: latency > this.config.slowFillThresholdMs * 2 ? 'critical' : 'warning',
          message: `Langsamer Fill: ${(latency / 1000).toFixed(1)}s`,
          details: {
            executionId: record.executionId,
            marketId: record.marketId,
            latencyMs: latency,
          },
          timestamp: new Date(),
        });
      }
    }

    // Model Drift Alert
    if (record.actualSlippage && record.expectedSlippage > 0) {
      const ratio = record.actualSlippage / record.expectedSlippage;
      if (ratio > this.config.modelDriftThreshold) {
        this.emitAlert({
          type: 'model_drift',
          severity: 'warning',
          message: `Slippage-Model Drift: Actual ${ratio.toFixed(1)}x Expected`,
          details: {
            executionId: record.executionId,
            expectedSlippage: record.expectedSlippage,
            actualSlippage: record.actualSlippage,
            ratio,
          },
          timestamp: new Date(),
        });
      }
    }
  }

  private emitAlert(alert: ExecutionAlert): void {
    // Cooldown Check
    const alertKey = `${alert.type}:${alert.severity}`;
    const lastAlert = this.lastAlerts.get(alertKey);

    if (lastAlert && Date.now() - lastAlert.getTime() < this.config.alertCooldownMs) {
      return; // Skip wegen Cooldown
    }

    this.lastAlerts.set(alertKey, new Date());
    this.emit('alert', alert);
    logger.warn(`[EXECUTION ALERT] ${alert.type}: ${alert.message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                       METRICS METHODS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Berechne Execution Quality Metrics
   */
  getMetrics(): ExecutionMetrics {
    const recentExecutions = this.executions.slice(-this.config.rollingWindowSize);

    if (recentExecutions.length === 0) {
      return this.emptyMetrics();
    }

    // Counts
    const filledExecutions = recentExecutions.filter(e => e.status === 'filled');
    const partialFills = recentExecutions.filter(e => e.status === 'partial');
    const cancelledExecutions = recentExecutions.filter(e => e.status === 'cancelled');
    const failedExecutions = recentExecutions.filter(e => e.status === 'failed');

    // Fill Rate
    const completedExecutions = filledExecutions.length + partialFills.length;
    const fillRate = completedExecutions / recentExecutions.length;

    // Slippage (nur für gefüllte Trades)
    const executionsWithSlippage = recentExecutions.filter(e => e.actualSlippage !== null);
    const avgExpectedSlippage = this.avg(executionsWithSlippage.map(e => e.expectedSlippage));
    const avgActualSlippage = this.avg(executionsWithSlippage.map(e => e.actualSlippage!));
    const worstSlippage = executionsWithSlippage.length > 0
      ? Math.max(...executionsWithSlippage.map(e => e.actualSlippage!))
      : 0;

    // Slippage Accuracy (wie gut predicted unser Modell)
    // 1.0 = perfekt, <1 = überschätzt, >1 = unterschätzt
    const slippageAccuracy = avgExpectedSlippage > 0 ? avgActualSlippage / avgExpectedSlippage : 1;

    // Slippage Cost
    const slippageCost = executionsWithSlippage.reduce((sum, e) => {
      const slippageDiff = (e.actualSlippage ?? 0) - e.expectedSlippage;
      return sum + slippageDiff * (e.filledSize ?? 0);
    }, 0);

    // Latency
    const executionsWithTiming = recentExecutions.filter(e => e.fillTime && e.signalTime);
    const latencies = executionsWithTiming.map(e =>
      e.fillTime!.getTime() - e.signalTime.getTime()
    );
    const orderToFillLatencies = executionsWithTiming
      .filter(e => e.orderTime)
      .map(e => e.fillTime!.getTime() - e.orderTime!.getTime());
    const signalToOrderLatencies = executionsWithTiming
      .filter(e => e.orderTime)
      .map(e => e.orderTime!.getTime() - e.signalTime.getTime());

    const avgTotalLatency = this.avg(latencies);
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
    const p95Latency = this.percentile(latencies, 0.95);

    // Price Improvement Rate
    const priceImprovements = executionsWithSlippage.filter(e =>
      (e.actualSlippage ?? 0) < e.expectedSlippage
    );
    const priceImprovementRate = executionsWithSlippage.length > 0
      ? priceImprovements.length / executionsWithSlippage.length
      : 0;

    // Slippage Control Score (0-100)
    // Basierend auf: Wie oft unter Expected Slippage?
    const slippageControlScore = Math.round(priceImprovementRate * 100);

    // Execution Quality Score (0-100)
    // Kombiniert: Fill Rate, Slippage Control, Latency
    const executionQualityScore = this.calculateQualityScore({
      fillRate,
      slippageAccuracy,
      priceImprovementRate,
      avgLatencyMs: avgTotalLatency,
    });

    return {
      totalExecutions: recentExecutions.length,
      filledExecutions: filledExecutions.length,
      partialFills: partialFills.length,
      cancelledExecutions: cancelledExecutions.length,
      failedExecutions: failedExecutions.length,
      fillRate,
      avgExpectedSlippage,
      avgActualSlippage,
      slippageAccuracy,
      worstSlippage,
      slippageCost,
      avgLatencySignalToOrder: this.avg(signalToOrderLatencies),
      avgLatencyOrderToFill: this.avg(orderToFillLatencies),
      avgTotalLatency,
      maxLatency,
      p95Latency,
      executionQualityScore,
      priceImprovementRate,
      slippageControlScore,
    };
  }

  private calculateQualityScore(params: {
    fillRate: number;
    slippageAccuracy: number;
    priceImprovementRate: number;
    avgLatencyMs: number;
  }): number {
    // Gewichtungen
    const weights = {
      fillRate: 0.3,
      slippageControl: 0.4,
      latency: 0.3,
    };

    // Fill Rate Score (0-100)
    const fillRateScore = params.fillRate * 100;

    // Slippage Score (0-100)
    // 1.0 = perfekt (expected == actual)
    // <0.5 oder >1.5 = schlecht
    let slippageScore = 100;
    if (params.slippageAccuracy > 1) {
      // Unterschätzt → schlecht
      slippageScore = Math.max(0, 100 - (params.slippageAccuracy - 1) * 100);
    } else if (params.slippageAccuracy < 1) {
      // Überschätzt → gut (konservativ)
      slippageScore = 100;
    }
    // Bonus für Price Improvement
    slippageScore = Math.min(100, slippageScore + params.priceImprovementRate * 20);

    // Latency Score (0-100)
    // <5s = 100, >60s = 0
    const latencySeconds = params.avgLatencyMs / 1000;
    const latencyScore = Math.max(0, Math.min(100, 100 - (latencySeconds - 5) * 2));

    // Kombinierter Score
    return Math.round(
      fillRateScore * weights.fillRate +
      slippageScore * weights.slippageControl +
      latencyScore * weights.latency
    );
  }

  private emptyMetrics(): ExecutionMetrics {
    return {
      totalExecutions: 0,
      filledExecutions: 0,
      partialFills: 0,
      cancelledExecutions: 0,
      failedExecutions: 0,
      fillRate: 0,
      avgExpectedSlippage: 0,
      avgActualSlippage: 0,
      slippageAccuracy: 1,
      worstSlippage: 0,
      slippageCost: 0,
      avgLatencySignalToOrder: 0,
      avgLatencyOrderToFill: 0,
      avgTotalLatency: 0,
      maxLatency: 0,
      p95Latency: 0,
      executionQualityScore: 0,
      priceImprovementRate: 0,
      slippageControlScore: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //                       ANALYSIS METHODS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Analysiere Slippage nach verschiedenen Dimensionen
   */
  analyzeSlippageByDimension(): {
    byDirection: { yes: number; no: number };
    byMarketVolume: { low: number; medium: number; high: number };
    bySpread: { tight: number; medium: number; wide: number };
    byVolatility: { low: number; medium: number; high: number };
  } {
    const executions = this.executions.filter(e => e.actualSlippage !== null);

    // By Direction
    const yesTrades = executions.filter(e => e.direction === 'yes');
    const noTrades = executions.filter(e => e.direction === 'no');

    // By Volume (Buckets: <10k, 10k-100k, >100k)
    const lowVolume = executions.filter(e => e.volumeAtSignal < 10000);
    const medVolume = executions.filter(e => e.volumeAtSignal >= 10000 && e.volumeAtSignal < 100000);
    const highVolume = executions.filter(e => e.volumeAtSignal >= 100000);

    // By Spread (Buckets: <2%, 2-5%, >5%)
    const tightSpread = executions.filter(e => e.spreadAtSignal < 0.02);
    const medSpread = executions.filter(e => e.spreadAtSignal >= 0.02 && e.spreadAtSignal < 0.05);
    const wideSpread = executions.filter(e => e.spreadAtSignal >= 0.05);

    // By Volatility (Buckets: <0.2, 0.2-0.4, >0.4)
    const lowVol = executions.filter(e => e.volatilityAtSignal < 0.2);
    const medVol = executions.filter(e => e.volatilityAtSignal >= 0.2 && e.volatilityAtSignal < 0.4);
    const highVol = executions.filter(e => e.volatilityAtSignal >= 0.4);

    return {
      byDirection: {
        yes: this.avg(yesTrades.map(e => e.actualSlippage!)),
        no: this.avg(noTrades.map(e => e.actualSlippage!)),
      },
      byMarketVolume: {
        low: this.avg(lowVolume.map(e => e.actualSlippage!)),
        medium: this.avg(medVolume.map(e => e.actualSlippage!)),
        high: this.avg(highVolume.map(e => e.actualSlippage!)),
      },
      bySpread: {
        tight: this.avg(tightSpread.map(e => e.actualSlippage!)),
        medium: this.avg(medSpread.map(e => e.actualSlippage!)),
        wide: this.avg(wideSpread.map(e => e.actualSlippage!)),
      },
      byVolatility: {
        low: this.avg(lowVol.map(e => e.actualSlippage!)),
        medium: this.avg(medVol.map(e => e.actualSlippage!)),
        high: this.avg(highVol.map(e => e.actualSlippage!)),
      },
    };
  }

  /**
   * Empfehlungen zur Verbesserung der Execution Quality
   */
  getRecommendations(): string[] {
    const metrics = this.getMetrics();
    const recommendations: string[] = [];

    if (metrics.fillRate < 0.9) {
      recommendations.push(
        `Fill Rate niedrig (${(metrics.fillRate * 100).toFixed(1)}%). ` +
        `Erwäge aggressivere Limit-Preise oder Market Orders.`
      );
    }

    if (metrics.slippageAccuracy > 1.5) {
      recommendations.push(
        `Slippage-Modell unterschätzt realen Slippage um ${((metrics.slippageAccuracy - 1) * 100).toFixed(0)}%. ` +
        `Erhöhe baseSlippage oder sizeImpact im Modell.`
      );
    }

    if (metrics.avgTotalLatency > 30000) {
      recommendations.push(
        `Hohe Latenz (${(metrics.avgTotalLatency / 1000).toFixed(1)}s). ` +
        `Optimiere Signal-to-Order Pipeline.`
      );
    }

    if (metrics.priceImprovementRate < 0.3) {
      recommendations.push(
        `Selten Price Improvement (${(metrics.priceImprovementRate * 100).toFixed(0)}%). ` +
        `Slippage-Schätzung ist möglicherweise zu konservativ.`
      );
    }

    if (metrics.worstSlippage > 0.05) {
      recommendations.push(
        `Worst-Case Slippage hoch (${(metrics.worstSlippage * 100).toFixed(1)}%). ` +
        `Implementiere Slippage-Cap oder Size-Reduktion bei illiquiden Märkten.`
      );
    }

    if (recommendations.length === 0) {
      recommendations.push('Execution Quality ist gut. Keine Empfehlungen.');
    }

    return recommendations;
  }

  // ═══════════════════════════════════════════════════════════════
  //                       HELPER METHODS
  // ═══════════════════════════════════════════════════════════════

  private findRecord(executionId: string): ExecutionRecord | undefined {
    return this.executions.find(e => e.executionId === executionId);
  }

  private avg(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Export für Dashboard/API
   */
  toJSON(): {
    metrics: ExecutionMetrics;
    recentExecutions: ExecutionRecord[];
    analysis: {
      byDirection: { yes: number; no: number };
      byMarketVolume: { low: number; medium: number; high: number };
      bySpread: { tight: number; medium: number; wide: number };
      byVolatility: { low: number; medium: number; high: number };
    };
    recommendations: string[];
  } {
    return {
      metrics: this.getMetrics(),
      recentExecutions: this.executions.slice(-20),
      analysis: this.analyzeSlippageByDimension(),
      recommendations: this.getRecommendations(),
    };
  }

  /**
   * Reset (für Tests oder neuen Tag)
   */
  reset(): void {
    this.executions = [];
    this.lastAlerts.clear();
    logger.info('[EXECUTION] Monitor zurückgesetzt');
  }
}

// Singleton Instance
export const executionQualityMonitor = new ExecutionQualityMonitor();
