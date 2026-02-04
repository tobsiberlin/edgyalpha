/**
 * Backtest Report Generator
 * Generiert Markdown- und JSON-Reports
 * V2: Mit Validation und Monte Carlo Ergebnissen
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  BacktestResult,
  ExtendedBacktestResult,
  ValidationResult,
  MonteCarloResult,
} from '../alpha/types.js';
import {
  interpretBrierScore,
  analyzeCalibration,
  calculateECE,
  interpretECE,
} from './calibration.js';
import {
  calculateProfitFactor,
  calculateAvgWinLoss,
  calculateCalmarRatio,
} from './metrics.js';
import { checkBacktestRobustness } from './validation.js';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// MARKDOWN REPORT
// ═══════════════════════════════════════════════════════════════

/**
 * Generiere Markdown-Report
 */
export function generateMarkdownReport(result: BacktestResult | ExtendedBacktestResult): string {
  const { engine, period, trades, metrics, calibration } = result;
  const extResult = result as ExtendedBacktestResult;

  // Header
  let md = `# Backtest Report: ${engine.toUpperCase()} Engine\n\n`;
  md += `**Generiert:** ${new Date().toLocaleString('de-DE')}\n\n`;

  // Zusammenfassung
  md += `## Zusammenfassung\n\n`;
  md += `| Parameter | Wert |\n`;
  md += `|-----------|------|\n`;
  md += `| Engine | ${engine} |\n`;
  md += `| Zeitraum | ${formatDate(period.from)} bis ${formatDate(period.to)} |\n`;
  md += `| Trades | ${metrics.tradeCount} |\n`;
  md += `| Tage | ${daysBetween(period.from, period.to)} |\n\n`;

  // Performance
  md += `## Performance\n\n`;
  md += `| Metrik | Wert |\n`;
  md += `|--------|------|\n`;
  md += `| Total PnL | ${formatCurrency(metrics.totalPnl)} |\n`;
  md += `| Win Rate | ${formatPercent(metrics.winRate)} |\n`;
  md += `| Max Drawdown | ${formatCurrency(metrics.maxDrawdown)} |\n`;
  md += `| Sharpe Ratio | ${metrics.sharpeRatio.toFixed(2)} |\n`;

  // Erweiterte Metriken
  const profitFactor = calculateProfitFactor(trades);
  const { avgWin, avgLoss } = calculateAvgWinLoss(trades);
  const calmarRatio = calculateCalmarRatio(
    trades,
    1000,
    daysBetween(period.from, period.to)
  );

  md += `| Profit Factor | ${profitFactor === Infinity ? 'Inf' : profitFactor.toFixed(2)} |\n`;
  md += `| Avg Win | ${formatCurrency(avgWin)} |\n`;
  md += `| Avg Loss | ${formatCurrency(avgLoss)} |\n`;
  md += `| Calmar Ratio | ${calmarRatio.toFixed(2)} |\n\n`;

  // Edge-Analyse
  md += `## Edge-Analyse\n\n`;
  md += `| Metrik | Wert |\n`;
  md += `|--------|------|\n`;

  // Berechne durchschnittliche Edges
  const tradesWithEdge = trades.filter((t) => t.actualEdge !== null);
  const avgPredictedEdge =
    tradesWithEdge.length > 0
      ? tradesWithEdge.reduce((sum, t) => sum + t.predictedEdge, 0) /
        tradesWithEdge.length
      : 0;
  const avgActualEdge =
    tradesWithEdge.length > 0
      ? tradesWithEdge.reduce((sum, t) => sum + (t.actualEdge ?? 0), 0) /
        tradesWithEdge.length
      : 0;

  md += `| Avg Predicted Edge | ${formatPercent(avgPredictedEdge)} |\n`;
  md += `| Avg Actual Edge | ${formatPercent(avgActualEdge)} |\n`;
  md += `| Edge Capture Rate | ${formatPercent(metrics.avgEdgeCapture)} |\n`;
  md += `| Avg Slippage | ${formatPercent(metrics.avgSlippage)} |\n\n`;

  // Kalibrierung
  md += `## Kalibrierung\n\n`;
  md += `| Metrik | Wert | Interpretation |\n`;
  md += `|--------|------|----------------|\n`;
  md += `| Brier Score | ${metrics.brierScore.toFixed(3)} | ${interpretBrierScore(metrics.brierScore)} |\n`;

  const ece = calculateECE(calibration);
  md += `| ECE | ${ece.toFixed(3)} | ${interpretECE(ece)} |\n\n`;

  // Calibration Analyse
  const analysis = analyzeCalibration(calibration);
  md += `### Kalibrierungs-Analyse\n\n`;
  md += `- **Overconfident:** ${analysis.isOverconfident ? 'Ja' : 'Nein'}\n`;
  md += `- **Underconfident:** ${analysis.isUnderconfident ? 'Ja' : 'Nein'}\n`;
  md += `- **Durchschn. Abweichung:** ${formatPercent(analysis.avgDeviation)}\n`;
  md += `- **Empfehlung:** ${analysis.recommendation}\n\n`;

  // Calibration Buckets
  if (calibration.length > 0) {
    md += `### Reliability Buckets\n\n`;
    md += `| Bucket | Predicted | Actual | Deviation | Count |\n`;
    md += `|--------|-----------|--------|-----------|-------|\n`;

    for (const bucket of calibration) {
      const deviation = bucket.predictedAvg - bucket.actualAvg;
      md += `| ${formatBucketRange(bucket.range)} | `;
      md += `${formatPercent(bucket.predictedAvg)} | `;
      md += `${formatPercent(bucket.actualAvg)} | `;
      md += `${deviation >= 0 ? '+' : ''}${formatPercent(deviation)} | `;
      md += `${bucket.count} |\n`;
    }
    md += `\n`;
  }

  // NEU: Out-of-Sample Validation
  if (extResult.validation) {
    md += generateValidationSection(extResult.validation);
  }

  // NEU: Monte Carlo Simulation
  if (extResult.monteCarlo) {
    md += generateMonteCarloSection(extResult.monteCarlo);
  }

  // NEU: Robustness Check
  if (extResult.validation && extResult.monteCarlo) {
    md += generateRobustnessSection(extResult.validation, extResult.monteCarlo);
  }

  // Top 10 Trades
  md += `## Top 10 Trades (nach PnL)\n\n`;
  const sortedTrades = [...trades]
    .filter((t) => t.pnl !== null)
    .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));

  md += `| Market ID | Direction | Entry | PnL | Pred. Edge | Act. Edge |\n`;
  md += `|-----------|-----------|-------|-----|------------|-----------|n`;

  for (const trade of sortedTrades.slice(0, 10)) {
    md += `| ${trade.marketId.substring(0, 12)}... | `;
    md += `${trade.direction.toUpperCase()} | `;
    md += `${trade.entryPrice.toFixed(3)} | `;
    md += `${formatCurrency(trade.pnl ?? 0)} | `;
    md += `${formatPercent(trade.predictedEdge)} | `;
    md += `${trade.actualEdge !== null ? formatPercent(trade.actualEdge) : 'N/A'} |\n`;
  }
  md += `\n`;

  // Worst 10 Trades
  md += `## Worst 10 Trades (nach PnL)\n\n`;
  md += `| Market ID | Direction | Entry | PnL | Pred. Edge | Act. Edge |\n`;
  md += `|-----------|-----------|-------|-----|------------|------------|\n`;

  for (const trade of sortedTrades.slice(-10).reverse()) {
    md += `| ${trade.marketId.substring(0, 12)}... | `;
    md += `${trade.direction.toUpperCase()} | `;
    md += `${trade.entryPrice.toFixed(3)} | `;
    md += `${formatCurrency(trade.pnl ?? 0)} | `;
    md += `${formatPercent(trade.predictedEdge)} | `;
    md += `${trade.actualEdge !== null ? formatPercent(trade.actualEdge) : 'N/A'} |\n`;
  }
  md += `\n`;

  // Footer
  md += `---\n`;
  md += `*Report generiert mit EdgyAlpha Backtesting Framework*\n`;

  return md;
}

// ═══════════════════════════════════════════════════════════════
// JSON REPORT
// ═══════════════════════════════════════════════════════════════

/**
 * Generiere JSON-Report
 */
export function generateJsonReport(result: BacktestResult | ExtendedBacktestResult): string {
  const { engine, period, trades, metrics, calibration } = result;
  const extResult = result as ExtendedBacktestResult;

  // Erweiterte Metriken berechnen
  const profitFactor = calculateProfitFactor(trades);
  const { avgWin, avgLoss } = calculateAvgWinLoss(trades);
  const calmarRatio = calculateCalmarRatio(
    trades,
    1000,
    daysBetween(period.from, period.to)
  );
  const ece = calculateECE(calibration);
  const analysis = analyzeCalibration(calibration);

  // Edge-Statistiken
  const tradesWithEdge = trades.filter((t) => t.actualEdge !== null);
  const avgPredictedEdge =
    tradesWithEdge.length > 0
      ? tradesWithEdge.reduce((sum, t) => sum + t.predictedEdge, 0) /
        tradesWithEdge.length
      : 0;
  const avgActualEdge =
    tradesWithEdge.length > 0
      ? tradesWithEdge.reduce((sum, t) => sum + (t.actualEdge ?? 0), 0) /
        tradesWithEdge.length
      : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    engine,
    period: {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      days: daysBetween(period.from, period.to),
    },
    summary: {
      tradeCount: metrics.tradeCount,
      totalPnl: metrics.totalPnl,
      winRate: metrics.winRate,
      maxDrawdown: metrics.maxDrawdown,
      sharpeRatio: metrics.sharpeRatio,
      profitFactor,
      avgWin,
      avgLoss,
      calmarRatio,
    },
    edge: {
      avgPredictedEdge,
      avgActualEdge,
      edgeCaptureRate: metrics.avgEdgeCapture,
      avgSlippage: metrics.avgSlippage,
    },
    calibration: {
      brierScore: metrics.brierScore,
      brierInterpretation: interpretBrierScore(metrics.brierScore),
      ece,
      eceInterpretation: interpretECE(ece),
      isOverconfident: analysis.isOverconfident,
      isUnderconfident: analysis.isUnderconfident,
      avgDeviation: analysis.avgDeviation,
      recommendation: analysis.recommendation,
      buckets: calibration.map((b) => ({
        range: b.range,
        predictedAvg: b.predictedAvg,
        actualAvg: b.actualAvg,
        deviation: b.predictedAvg - b.actualAvg,
        count: b.count,
      })),
    },
    trades: trades.map((t) => ({
      signalId: t.signalId,
      marketId: t.marketId,
      direction: t.direction,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      size: t.size,
      pnl: t.pnl,
      predictedEdge: t.predictedEdge,
      actualEdge: t.actualEdge,
      slippage: t.slippage,
    })),
    // NEU: Validation & Monte Carlo
    validation: extResult.validation ? {
      splitRatio: extResult.validation.splitRatio,
      trainCount: extResult.validation.trainTrades.length,
      testCount: extResult.validation.testTrades.length,
      trainMetrics: extResult.validation.trainMetrics,
      testMetrics: extResult.validation.testMetrics,
      overfittingWarnings: extResult.validation.overfittingWarnings,
    } : null,
    monteCarlo: extResult.monteCarlo ? {
      simulations: extResult.monteCarlo.simulations,
      pnlDistribution: extResult.monteCarlo.pnlDistribution,
      winRateDistribution: extResult.monteCarlo.winRateDistribution,
      maxDrawdownDistribution: extResult.monteCarlo.maxDrawdownDistribution,
      confidenceInterval95: extResult.monteCarlo.confidenceInterval95,
    } : null,
    walkForwardWindow: extResult.walkForwardWindow || 90,
  };

  return JSON.stringify(report, null, 2);
}

// ═══════════════════════════════════════════════════════════════
// FILE OPERATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Speichere Reports
 */
export async function saveReports(
  result: BacktestResult,
  outputDir: string
): Promise<{ json: string; markdown: string }> {
  // Erstelle Output-Directory falls nicht existiert
  await fs.mkdir(outputDir, { recursive: true });

  // Generiere Dateinamen mit Timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `backtest-${result.engine}-${timestamp}`;

  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const mdPath = path.join(outputDir, `${baseName}.md`);

  // Generiere Reports
  const jsonReport = generateJsonReport(result);
  const mdReport = generateMarkdownReport(result);

  // Schreibe Dateien
  await fs.writeFile(jsonPath, jsonReport, 'utf-8');
  await fs.writeFile(mdPath, mdReport, 'utf-8');

  logger.info(`Reports gespeichert: ${jsonPath}, ${mdPath}`);

  return {
    json: jsonPath,
    markdown: mdPath,
  };
}

// ═══════════════════════════════════════════════════════════════
// CONSOLE OUTPUT
// ═══════════════════════════════════════════════════════════════

/**
 * Generiere Console-Output
 */
export function generateConsoleOutput(result: BacktestResult | ExtendedBacktestResult): string {
  const { engine, period, trades, metrics, calibration } = result;
  const extResult = result as ExtendedBacktestResult;

  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push('  BACKTEST ERGEBNIS');
  lines.push('=' .repeat(50));
  lines.push(`  Engine:     ${engine}`);
  lines.push(
    `  Zeitraum:   ${formatDate(period.from)} bis ${formatDate(period.to)}`
  );
  lines.push(`  Trades:     ${metrics.tradeCount}`);
  lines.push('=' .repeat(50));
  lines.push('');

  // Performance
  lines.push('  PERFORMANCE');
  lines.push(`     Total PnL:     ${formatCurrency(metrics.totalPnl)}`);
  lines.push(`     Win Rate:      ${formatPercent(metrics.winRate)}`);
  lines.push(`     Max Drawdown:  ${formatCurrency(metrics.maxDrawdown)}`);
  lines.push(`     Sharpe Ratio:  ${metrics.sharpeRatio.toFixed(2)}`);
  lines.push('');

  // Edge-Analyse
  const tradesWithEdge = trades.filter((t) => t.actualEdge !== null);
  const avgPredictedEdge =
    tradesWithEdge.length > 0
      ? tradesWithEdge.reduce((sum, t) => sum + t.predictedEdge, 0) /
        tradesWithEdge.length
      : 0;
  const avgActualEdge =
    tradesWithEdge.length > 0
      ? tradesWithEdge.reduce((sum, t) => sum + (t.actualEdge ?? 0), 0) /
        tradesWithEdge.length
      : 0;
  const edgeCapturePercent =
    avgPredictedEdge > 0 ? (avgActualEdge / avgPredictedEdge) * 100 : 0;

  lines.push('  EDGE-ANALYSE');
  lines.push(`     Avg Edge Predicted: ${formatPercent(avgPredictedEdge)}`);
  lines.push(`     Avg Edge Captured:  ${formatPercent(avgActualEdge)}`);
  lines.push(`     Edge Capture Rate:  ${edgeCapturePercent.toFixed(1)}%`);
  lines.push(`     Avg Slippage:       ${formatPercent(metrics.avgSlippage)}`);
  lines.push('');

  // Kalibrierung
  const analysis = analyzeCalibration(calibration);
  let calibrationStatus = 'gut kalibriert';
  if (analysis.isOverconfident) calibrationStatus = 'leicht overconfident';
  if (analysis.isUnderconfident) calibrationStatus = 'leicht underconfident';

  lines.push('  KALIBRIERUNG');
  lines.push(
    `     Brier Score:   ${metrics.brierScore.toFixed(3)} (${interpretBrierScore(metrics.brierScore)})`
  );
  lines.push(`     Kalibrierung:  ${calibrationStatus}`);
  lines.push('');

  // Calibration Buckets
  if (calibration.length > 0) {
    lines.push('     Bucket    Predicted  Actual  Count');
    for (const bucket of calibration) {
      const range = `${(bucket.range[0] * 100).toFixed(0)}-${(bucket.range[1] * 100).toFixed(0)}%`.padEnd(9);
      const predicted = formatPercent(bucket.predictedAvg).padStart(8);
      const actual = formatPercent(bucket.actualAvg).padStart(8);
      lines.push(`     ${range}${predicted}${actual}    ${bucket.count}`);
    }
    lines.push('');
  }

  // NEU: Out-of-Sample Validation
  if (extResult.validation) {
    const v = extResult.validation;
    lines.push('=' .repeat(50));
    lines.push('  OUT-OF-SAMPLE VALIDATION');
    lines.push(`     Split:     ${(v.splitRatio * 100).toFixed(0)}% Train / ${((1 - v.splitRatio) * 100).toFixed(0)}% Test`);
    lines.push('');
    lines.push('     Metric         Train       Test');
    lines.push(`     Trades         ${String(v.trainTrades.length).padStart(8)}  ${String(v.testTrades.length).padStart(8)}`);
    lines.push(`     PnL            ${formatCurrency(v.trainMetrics.totalPnl).padStart(8)}  ${formatCurrency(v.testMetrics.totalPnl).padStart(8)}`);
    lines.push(`     Win Rate       ${formatPercent(v.trainMetrics.winRate).padStart(8)}  ${formatPercent(v.testMetrics.winRate).padStart(8)}`);
    lines.push(`     Sharpe         ${v.trainMetrics.sharpeRatio.toFixed(2).padStart(8)}  ${v.testMetrics.sharpeRatio.toFixed(2).padStart(8)}`);
    lines.push('');

    if (v.overfittingWarnings.length > 0) {
      lines.push('  OVERFITTING WARNUNGEN');
      for (const w of v.overfittingWarnings) {
        const icon = w.severity === 'high' ? '!!' : w.severity === 'medium' ? '!' : '-';
        lines.push(`     [${icon}] ${w.message}`);
      }
      lines.push('');
    }
  }

  // NEU: Monte Carlo
  if (extResult.monteCarlo) {
    const mc = extResult.monteCarlo;
    lines.push('=' .repeat(50));
    lines.push('  MONTE CARLO SIMULATION');
    lines.push(`     Simulationen:  ${mc.simulations}`);
    lines.push('');
    lines.push('     PnL Verteilung:');
    lines.push(`        5% (Worst):   ${formatCurrency(mc.pnlDistribution.percentile5)}`);
    lines.push(`        Median:       ${formatCurrency(mc.pnlDistribution.median)}`);
    lines.push(`        95% (Best):   ${formatCurrency(mc.pnlDistribution.percentile95)}`);
    lines.push(`        Mean:         ${formatCurrency(mc.pnlDistribution.mean)}`);
    lines.push(`        Std. Dev.:    ${formatCurrency(mc.pnlDistribution.stdDev)}`);
    lines.push('');
    lines.push(`     95% CI:  ${formatCurrency(mc.confidenceInterval95.pnlLower)} bis ${formatCurrency(mc.confidenceInterval95.pnlUpper)}`);
    lines.push(`     Worst DD: ${formatCurrency(mc.maxDrawdownDistribution.worst)}`);
    lines.push('');
  }

  // NEU: Robustness Score
  if (extResult.validation && extResult.monteCarlo) {
    const robustness = checkBacktestRobustness(extResult.validation, extResult.monteCarlo);
    lines.push('=' .repeat(50));
    lines.push(`  ROBUSTNESS SCORE: ${robustness.score}/100 ${robustness.isRobust ? '(ROBUST)' : '(NICHT ROBUST)'}`);
    lines.push('');
  }

  lines.push('=' .repeat(50));

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatCurrency(value: number): string {
  const sign = value >= 0 ? '' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatBucketRange(range: [number, number]): string {
  return `${(range[0] * 100).toFixed(0)}-${(range[1] * 100).toFixed(0)}%`;
}

function daysBetween(from: Date, to: Date): number {
  const diffMs = to.getTime() - from.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

// ═══════════════════════════════════════════════════════════════
// NEU: VALIDATION & MONTE CARLO REPORT SECTIONS
// ═══════════════════════════════════════════════════════════════

function generateValidationSection(validation: ValidationResult): string {
  let md = `## Out-of-Sample Validation\n\n`;
  md += `**Split:** ${(validation.splitRatio * 100).toFixed(0)}% Train / ${((1 - validation.splitRatio) * 100).toFixed(0)}% Test\n\n`;

  md += `| Metrik | Train | Test | Differenz |\n`;
  md += `|--------|-------|------|-----------|\n`;
  md += `| Trades | ${validation.trainTrades.length} | ${validation.testTrades.length} | - |\n`;
  md += `| Total PnL | ${formatCurrency(validation.trainMetrics.totalPnl)} | ${formatCurrency(validation.testMetrics.totalPnl)} | ${formatCurrency(validation.testMetrics.totalPnl - validation.trainMetrics.totalPnl)} |\n`;
  md += `| Win Rate | ${formatPercent(validation.trainMetrics.winRate)} | ${formatPercent(validation.testMetrics.winRate)} | ${formatPercent(validation.testMetrics.winRate - validation.trainMetrics.winRate)} |\n`;
  md += `| Sharpe Ratio | ${validation.trainMetrics.sharpeRatio.toFixed(2)} | ${validation.testMetrics.sharpeRatio.toFixed(2)} | ${(validation.testMetrics.sharpeRatio - validation.trainMetrics.sharpeRatio).toFixed(2)} |\n`;
  md += `| Max Drawdown | ${formatCurrency(validation.trainMetrics.maxDrawdown)} | ${formatCurrency(validation.testMetrics.maxDrawdown)} | - |\n\n`;

  if (validation.overfittingWarnings.length > 0) {
    md += `### Overfitting-Warnungen\n\n`;
    for (const warning of validation.overfittingWarnings) {
      const severity = warning.severity === 'high' ? '🔴' : warning.severity === 'medium' ? '🟡' : '🟢';
      md += `- ${severity} **[${warning.severity.toUpperCase()}]** ${warning.message}\n`;
    }
    md += `\n`;
  } else {
    md += `✅ Keine Overfitting-Warnungen erkannt.\n\n`;
  }

  return md;
}

function generateMonteCarloSection(mc: MonteCarloResult): string {
  let md = `## Monte Carlo Simulation\n\n`;
  md += `**Simulationen:** ${mc.simulations}\n\n`;

  md += `### PnL-Verteilung\n\n`;
  md += `| Perzentil | Wert |\n`;
  md += `|-----------|------|\n`;
  md += `| 5% (Worst Case) | ${formatCurrency(mc.pnlDistribution.percentile5)} |\n`;
  md += `| 25% | ${formatCurrency(mc.pnlDistribution.percentile25)} |\n`;
  md += `| 50% (Median) | ${formatCurrency(mc.pnlDistribution.median)} |\n`;
  md += `| 75% | ${formatCurrency(mc.pnlDistribution.percentile75)} |\n`;
  md += `| 95% (Best Case) | ${formatCurrency(mc.pnlDistribution.percentile95)} |\n`;
  md += `| **Mean** | ${formatCurrency(mc.pnlDistribution.mean)} |\n`;
  md += `| Std. Dev. | ${formatCurrency(mc.pnlDistribution.stdDev)} |\n\n`;

  md += `### 95% Confidence Interval\n\n`;
  md += `**PnL:** ${formatCurrency(mc.confidenceInterval95.pnlLower)} bis ${formatCurrency(mc.confidenceInterval95.pnlUpper)}\n\n`;

  md += `### Max Drawdown Verteilung\n\n`;
  md += `| Metrik | Wert |\n`;
  md += `|--------|------|\n`;
  md += `| Mean | ${formatCurrency(mc.maxDrawdownDistribution.mean)} |\n`;
  md += `| Worst (all Sims) | ${formatCurrency(mc.maxDrawdownDistribution.worst)} |\n`;
  md += `| 5% Percentile | ${formatCurrency(mc.maxDrawdownDistribution.percentile5)} |\n`;
  md += `| 95% Percentile | ${formatCurrency(mc.maxDrawdownDistribution.percentile95)} |\n\n`;

  return md;
}

function generateRobustnessSection(validation: ValidationResult, mc: MonteCarloResult): string {
  const robustness = checkBacktestRobustness(validation, mc);

  let md = `## Robustness Check\n\n`;
  md += `**Score:** ${robustness.score}/100 `;
  md += robustness.isRobust ? '✅ **ROBUST**\n\n' : '❌ **NICHT ROBUST**\n\n';

  if (robustness.issues.length > 0) {
    md += `### Probleme\n\n`;
    for (const issue of robustness.issues) {
      md += `- ⚠️ ${issue}\n`;
    }
    md += `\n`;
  }

  if (robustness.recommendations.length > 0) {
    md += `### Empfehlungen\n\n`;
    for (const rec of robustness.recommendations) {
      md += `- 💡 ${rec}\n`;
    }
    md += `\n`;
  }

  return md;
}

export default {
  generateMarkdownReport,
  generateJsonReport,
  saveReports,
  generateConsoleOutput,
};
