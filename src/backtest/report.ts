/**
 * Backtest Report Generator
 * Generiert Markdown- und JSON-Reports
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { BacktestResult, CalibrationBucket } from '../alpha/types.js';
import {
  interpretBrierScore,
  analyzeCalibration,
  formatBucket,
  calculateECE,
  interpretECE,
} from './calibration.js';
import {
  calculateProfitFactor,
  calculateAvgWinLoss,
  calculateCalmarRatio,
} from './metrics.js';
import { logger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// MARKDOWN REPORT
// ═══════════════════════════════════════════════════════════════

/**
 * Generiere Markdown-Report
 */
export function generateMarkdownReport(result: BacktestResult): string {
  const { engine, period, trades, metrics, calibration } = result;

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
export function generateJsonReport(result: BacktestResult): string {
  const { engine, period, trades, metrics, calibration } = result;

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
export function generateConsoleOutput(result: BacktestResult): string {
  const { engine, period, trades, metrics, calibration } = result;

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

export default {
  generateMarkdownReport,
  generateJsonReport,
  saveReports,
  generateConsoleOutput,
};
