# EDGY ALPHA – MASTERPLAN ZUR MARKTFÜHRERSCHAFT

**Status:** IN PROGRESS
**Version:** 1.0
**Erstellt:** 2026-02-02
**Ziel:** Institutionelles Referenzsystem für Polymarket Alpha

---

## PHASE 1: STABILITÄT (Sofort – 48h) ✅ ABGESCHLOSSEN
*"Ein System, das crasht, ist kein System."*

### 1.1 Risk State Persistence ✅
- [x] `risk_state` Tabelle in SQLite
- [x] Persistente Kill-Switch (überlebt Restart)
- [x] Daily PnL aus DB rekonstruieren
- [x] Positions aus DB laden beim Start
- [x] Audit-Trail für alle State-Änderungen

### 1.2 Data Freshness Guarantees ✅
- [x] `as_of` Timestamp auf allen kritischen Tabellen
- [x] Stale-Data Detection (>5min = ROT)
- [x] Pipeline Health Status persistent
- [ ] Auto-Pause wenn Daten stale

### 1.3 Graceful Degradation (Teilweise)
- [x] Bei API-Fehler: Retry mit Backoff
- [ ] Bei DB-Fehler: Read-only Mode
- [x] Bei Wallet-Fehler: Auto Paper-Mode
- [x] Alle Fehler im UI sichtbar

---

## PHASE 2: VISUALISIERUNG (Diese Woche) 🟡 IN PROGRESS
*"Kein Chart → Kein Trade"*

### 2.1 TradingView Lightweight Charts Integration ✅
- [x] Price History API: `/api/polymarket/prices/:tokenId`
- [x] Chart-Komponente mit Lightweight-Charts
- [ ] Signal-Marker auf Chart
- [ ] Entry/Exit-Marker auf Chart
- [ ] Volume-Bars unter Chart

### 2.2 Dashboard Charts ✅
- [x] Equity Curve (tägliches PnL kumuliert)
- [x] Audit Log Widget
- [ ] Win/Loss Ratio Pie
- [ ] Edge Capture Rate Timeline
- [ ] Signal-Verteilung nach Engine
- [ ] Drawdown-Chart

### 2.3 Market-Specific Views
- [ ] Jeder Markt: eigene Seite mit Chart
- [ ] Order Book Visualization (wenn API verfügbar)
- [ ] Related Markets Correlation
- [ ] Historical Signals für diesen Markt

---

## PHASE 3: ALPHA ENGINES PERFEKTIONIEREN (Woche 2)
*"Lieber kein Signal als ein schlechtes Signal"*

### 3.1 TIME_DELAY Engine Fixes
- [ ] Volatility30d aus historischen Daten berechnen
- [ ] Volume-Change-Since-News implementieren
- [ ] Source Reliability Score dynamisch (basierend auf vergangener Accuracy)
- [ ] Lag-Expectation pro Markt-Kategorie kalibrieren

### 3.2 MISPRICING Engine Fixes
- [ ] Historical Bias pro Markt-Typ
- [ ] Uncertainty-Bounds visualisieren
- [ ] Liquidity-adjusted P_true

### 3.3 META-COMBINER Hardening
- [ ] Walk-Forward Window: 30 → 90 Tage
- [ ] Automatic Feature Selection
- [ ] Engine-Drift Detection (auto-disable)
- [ ] Daily Weight Report via Telegram

---

## PHASE 4: BACKTESTING ALS GERICHTSHOF (Woche 2-3)
*"Backtests entscheiden, nicht Meinungen"*

### 4.1 Web-Based Backtest Runner
- [ ] Backtest-Konfiguration im Web
- [ ] Progress-Anzeige mit WebSocket
- [ ] Results als interaktive Charts
- [ ] Download als JSON/CSV

### 4.2 Backtest Quality
- [ ] Out-of-Sample Validation (70/30 Split)
- [ ] Walk-Forward Reports
- [ ] Monte-Carlo Simulation (1000 Runs)
- [ ] Stress-Test Scenarios

### 4.3 Backtest-Gated Live Mode
- [ ] Live-Modus NUR wenn Backtest positiv
- [ ] Automatische Re-Validierung täglich
- [ ] Backtest-Report als Voraussetzung

---

## PHASE 5: TELEGRAM = VOLLWERTIGES OPERATIONS DESK (Woche 3)
*"Telegram ist gleichwertig zur Website"*

### 5.1 Position Management
- [ ] `/positions` – Alle offenen Positionen
- [ ] `/close [id]` – Position schließen
- [ ] `/pnl` – Tages-PnL mit Breakdown
- [ ] Position-Alerts bei Threshold

### 5.2 Market Intelligence
- [ ] `/market [slug]` – Markt-Details mit Mini-Chart
- [ ] `/watch [slug]` – Watchlist hinzufügen
- [ ] `/alerts` – Aktive Alerts verwalten
- [ ] Chart-Bilder via Telegram

### 5.3 System Control
- [ ] `/mode [paper|shadow|live]` – Mode wechseln
- [ ] `/kill` – Kill-Switch aktivieren
- [ ] `/resume` – Kill-Switch deaktivieren
- [ ] `/health` – System Health Report

---

## PHASE 6: INSTITUTIONELLE COMPLIANCE (Woche 4)
*"Jede Entscheidung muss auditierbar sein"*

### 6.1 Audit Trail
- [ ] `audit_log` Tabelle (who/what/when/why)
- [ ] Alle Trades mit Reasoning
- [ ] Alle Settings-Änderungen geloggt
- [ ] Export für Compliance

### 6.2 Risk Reports
- [ ] Daily Risk Summary (automatisch)
- [ ] Weekly Performance Report
- [ ] Monthly Backtest Validation
- [ ] Anomaly Detection Alerts

### 6.3 Secure Operations
- [ ] Wallet Keys in Environment (nicht Code)
- [ ] Rate Limiting auf allen Endpoints
- [ ] Session Timeout Enforcement
- [ ] 2FA für Live-Mode Aktivierung (optional)

---

## DEFINITION OF DONE – PRO PHASE

### Phase 1 DoD:
- [ ] Server kann 100x neustarten ohne Datenverlust
- [ ] Kill-Switch überlebt Restart
- [ ] Stale Daten werden ROT angezeigt

### Phase 2 DoD:
- [ ] Jeder Markt hat einen funktionierenden Chart
- [ ] Equity Curve zeigt echte Performance
- [ ] Signal-Marker auf Charts sichtbar

### Phase 3 DoD:
- [ ] Volatility30d ist echte Berechnung
- [ ] Engine-Drift wird erkannt
- [ ] Backtest zeigt bessere Sharpe als vorher

### Phase 4 DoD:
- [ ] Backtest komplett via Web
- [ ] Live-Mode verweigert bei negativem Backtest
- [ ] Out-of-Sample Validation Report verfügbar

### Phase 5 DoD:
- [ ] Position Management komplett via Telegram
- [ ] Chart-Bilder werden gesendet
- [ ] Kill-Switch via Telegram funktioniert

### Phase 6 DoD:
- [ ] Audit Trail für 30 Tage
- [ ] Daily Risk Report automatisch
- [ ] Keine Secrets im Code

---

## PRIORISIERTE TASK-LISTE (NÄCHSTE 48h)

1. **Risk State → SQLite** [BLOCKER]
2. **Charts mit Lightweight-Charts** [BLOCKER]
3. **Volatility30d Berechnung** [KRITISCH]
4. **Backtest via Web** [KRITISCH]
5. **Kill-Switch persistent** [KRITISCH]
6. **as_of Timestamps** [WICHTIG]
7. **Audit Trail Tabelle** [WICHTIG]

---

## ERFOLGSMETRIKEN

| Metrik | Aktuell | Ziel |
|--------|---------|------|
| Uptime | ~95% | 99.9% |
| Data Freshness | Ungeprüft | <5min garantiert |
| Chart Coverage | 0% | 100% |
| Backtest Web | Nein | Ja |
| Risk Persistence | Nein | Ja |
| Audit Trail | Nein | 30 Tage |

---

## COMMITMENT

Dieses System wird NICHT deployed mit:
- In-Memory Risk State
- Fehlenden Charts
- Hardcoded Volatility
- Terminal-abhängigen Features

**Kein Kompromiss. Kein Spielzeug. Marktführer.**
