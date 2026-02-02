# Backtest Report: TIMEDELAY Engine

**Generiert:** 2.2.2026, 15:20:58

## Zusammenfassung

| Parameter | Wert |
|-----------|------|
| Engine | timeDelay |
| Zeitraum | 2025-08-19 bis 2026-01-02 |
| Trades | 9 |
| Tage | 136 |

## Performance

| Metrik | Wert |
|--------|------|
| Total PnL | -$76.75 |
| Win Rate | 44.4% |
| Max Drawdown | $152.60 |
| Sharpe Ratio | -2.63 |
| Profit Factor | 0.50 |
| Avg Win | $18.96 |
| Avg Loss | -$30.52 |
| Calmar Ratio | -1.35 |

## Edge-Analyse

| Metrik | Wert |
|--------|------|
| Avg Predicted Edge | 5.3% |
| Avg Actual Edge | -3.5% |
| Edge Capture Rate | -66.0% |
| Avg Slippage | 1.0% |

## Kalibrierung

| Metrik | Wert | Interpretation |
|--------|------|----------------|
| Brier Score | 0.198 | akzeptabel |
| ECE | 0.389 | schlecht |

### Kalibrierungs-Analyse

- **Overconfident:** Ja
- **Underconfident:** Nein
- **Durchschn. Abweichung:** 8.1%
- **Empfehlung:** Overconfident um 8.1%. Edge-Schätzungen sollten konservativer sein. Erwäge Kelly-Fraction zu reduzieren. Achtung: Bucket 50-60% hat 31.2% Abweichung.

### Reliability Buckets

| Bucket | Predicted | Actual | Deviation | Count |
|--------|-----------|--------|-----------|-------|
| 20-30% | 29.0% | 100.0% | -71.0% | 1 |
| 40-50% | 43.4% | 0.0% | +43.4% | 2 |
| 50-60% | 56.2% | 25.0% | +31.2% | 4 |
| 60-70% | 66.3% | 100.0% | -33.7% | 2 |

## Top 10 Trades (nach PnL)

| Market ID | Direction | Entry | PnL | Pred. Edge | Act. Edge |
|-----------|-----------|-------|-----|------------|-----------|n| 0x87be00ea53... | NO | 0.369 | $37.22 | 4.3% | 63.1% |
| 0x8fd76e9f98... | NO | 0.634 | $21.92 | 7.6% | 36.6% |
| 0x8cfce70436... | YES | 0.603 | $9.25 | 3.1% | 39.7% |
| 0x46066a1e9e... | YES | 0.665 | $7.46 | 2.8% | 33.5% |
| 0xfff21352d2... | YES | 0.514 | -$23.98 | 4.9% | -51.4% |
| 0x458511d8c6... | YES | 0.379 | -$24.04 | 4.5% | -37.9% |
| 0x6e8e889b31... | YES | 0.445 | -$31.77 | 6.3% | -44.5% |
| 0x27a69acde5... | NO | 0.343 | -$32.61 | 6.9% | -34.3% |
| 0xb904359d88... | YES | 0.366 | -$40.20 | 7.7% | -36.6% |

## Worst 10 Trades (nach PnL)

| Market ID | Direction | Entry | PnL | Pred. Edge | Act. Edge |
|-----------|-----------|-------|-----|------------|------------|
| 0xb904359d88... | YES | 0.366 | -$40.20 | 7.7% | -36.6% |
| 0x27a69acde5... | NO | 0.343 | -$32.61 | 6.9% | -34.3% |
| 0x6e8e889b31... | YES | 0.445 | -$31.77 | 6.3% | -44.5% |
| 0x458511d8c6... | YES | 0.379 | -$24.04 | 4.5% | -37.9% |
| 0xfff21352d2... | YES | 0.514 | -$23.98 | 4.9% | -51.4% |
| 0x46066a1e9e... | YES | 0.665 | $7.46 | 2.8% | 33.5% |
| 0x8cfce70436... | YES | 0.603 | $9.25 | 3.1% | 39.7% |
| 0x8fd76e9f98... | NO | 0.634 | $21.92 | 7.6% | 36.6% |
| 0x87be00ea53... | NO | 0.369 | $37.22 | 4.3% | 63.1% |

---
*Report generiert mit EdgyAlpha Backtesting Framework*
