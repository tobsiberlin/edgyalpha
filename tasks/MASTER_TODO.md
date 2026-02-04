# EDGY ALPHA - MASTER TODO LIST
## Cash-Machine Completion Plan

**Erstellt:** 2026-02-02
**Ziel:** Profitable Almanien Cash-Machine

---

## 🔴 PRIORITÄT 1: KRITISCH (Ohne das = kein Profit)

### 1.1 Deutsche Quellen fixen [BLOCKER]
- [ ] RSS Feeds auf echte deutsche Quellen umstellen
  - Tagesschau, Spiegel, FAZ, Handelsblatt, Zeit, Welt, n-tv
  - Reuters DE, dpa (wenn verfügbar)
- [ ] Bundestag API integrieren
- [ ] Bundesregierung Pressemitteilungen
- [ ] BaFin, Bundesbank, EZB Meldungen
- [ ] Filter: Nur DE-Quellen im "Deutsche News" Bereich anzeigen
- **Warum kritisch:** Ohne echte DE-Quellen = kein Zeitvorsprung = kein Edge

### 1.2 Zeitvorsprung-Tracking implementieren [BLOCKER]
- [ ] Timestamp für jede deutsche News speichern
- [ ] Tracking: Wann erscheint englische Version (Reuters/Bloomberg)?
- [ ] Tracking: Wann bewegt sich Polymarket-Preis?
- [ ] Delta-Berechnung und Speicherung
- [ ] Dashboard: Durchschnittlicher Vorsprung pro Quelle anzeigen
- **Warum kritisch:** Ohne Messung weißt du nicht ob Edge real ist

### 1.3 Historical Data Pipeline [BLOCKER]
- [ ] SQLite Tabelle `historical_trades` erstellen
- [ ] Polymarket Trade-Historie importieren
- [ ] Deutsche News-Historie importieren (mit Timestamps)
- [ ] `npm run import:polydata` Command fixen
- **Warum kritisch:** Ohne historische Daten = kein Backtest = keine Validierung

### 1.4 Risk State Persistierung [KRITISCH]
- [ ] SQLite Tabelle `risk_state` erstellen
- [ ] Bei jedem State-Change persistieren
- [ ] Bei Start aus DB laden
- [ ] Position-Sync bei Restart
- **Warum kritisch:** Restart = Verlust aller Risk-Limits = unkontrollierter Geldverlust

### 1.5 Telegram Spam-Fix [KRITISCH]
- [ ] Finde den Timer der alle 5 Min das Menü sendet
- [ ] Entfernen/deaktivieren
- [ ] Nur echte Alerts senden
- **Warum kritisch:** Unbrauchbar für echten Einsatz

---

## 🟠 PRIORITÄT 2: HOCH (Für Profitabilität nötig)

### 2.1 Alpha-Berechnung fixen
- [ ] Nicht hardcoded +30% Edge
- [ ] Echte Berechnung basierend auf:
  - Zeitvorsprung (gemessen!)
  - Quellen-Qualität & Anzahl
  - Sentiment Score
  - Impact Score
  - Match-Confidence
- [ ] Reasoning/Erklärung generieren und anzeigen
- [ ] Confidence differenzieren (nicht alles 87-95%)

### 2.2 Volatilität aus echten Daten
- [ ] `calculateVolatility30d()` implementieren
- [ ] Aus historischen Polymarket-Trades berechnen
- [ ] Fallback auf 0.15 nur wenn <30 Datenpunkte
- [ ] Pro Market cachen (stündlich aktualisieren)

### 2.3 Backtest Engine fixen
- [ ] Walk-Forward Window auf 90 Tage erhöhen
- [ ] Out-of-Sample Validation (70/30 Split)
- [ ] Slippage-Modell integrieren
- [ ] Monte Carlo für Robustheit (optional)

### 2.4 Breaking News Detection
- [ ] Eilmeldung-Keywords erkennen ("BREAKING", "EILMELDUNG", etc.)
- [ ] Multi-Source Confirmation (2+ Quellen = `breaking_confirmed`)
- [ ] Auto-Execute bei `breaking_confirmed` + hohem Edge

### 2.5 Pipeline Health fixen
- [ ] "HEALTHY" nur wenn wirklich Daten fließen
- [ ] Last Success Timestamp korrekt setzen
- [ ] JSON Parse Error beheben (`Unexpected token '<'`)

---

## 🟡 PRIORITÄT 3: MITTEL (Wichtig für UX)

### 3.1 UI Fixes
- [ ] Rechte Sidebar: Nur auf relevanten Seiten anzeigen ODER schließbar machen
- [ ] Chart-Overlay Bug fixen (bleibt kleben)
- [ ] Almanien-Seite: Matches + Zeitvorsprung anzeigen
- [ ] Signal-Tabelle: Reasoning/Erklärung hinzufügen
- [ ] Live Ticker: Matches klickbar → zum Markt

### 3.2 Settings-Seite erstellen
- [ ] Alle Einstellungen im Web-UI
  - Risk Limits (Daily Loss, Max Positions, etc.)
  - Kelly Fraction, Bankroll
  - Notification Events
  - Quellen aktivieren/deaktivieren
  - Scan Intervall
- [ ] Speicherung in SQLite oder localStorage

### 3.3 Browser Notifications
- [ ] Permission Request implementieren
- [ ] Konfigurierbare Events:
  - [ ] Neue High-Alpha Signals
  - [ ] Almanien Zeitvorsprung Alerts
  - [ ] Trade Executions
  - [ ] Risk Warnings
  - [ ] System Errors

### 3.4 Benutzerhandbuch überarbeiten
- [ ] Modernes Design (kein ASCII-Art)
- [ ] Laienverständliche Erklärungen
- [ ] Ausführliche FAQ-Sektion
- [ ] Suchfunktion
- [ ] Glossar (Was ist Edge? Was ist Kelly? etc.)
- [ ] Keine technischen Setup-Anleitungen (gehören in README)

### 3.5 Live Ticker fixen
- [ ] Timestamps variieren (nicht alle identisch)
- [ ] Keine Block-Patterns (NEWS/MATCH gemischt)
- [ ] Duplikate entfernen
- [ ] Matches klickbar zum Markt

---

## 🟢 PRIORITÄT 4: NICE-TO-HAVE (Phase 2)

### 4.1 Advanced Sources
- [ ] Twitter/X Integration (deutsche Politiker, Journalisten)
- [ ] Telegram-Kanäle monitoren
- [ ] dpa-Ticker (kostenpflichtig prüfen)

### 4.2 LLM Integration
- [ ] GPT/Claude für News-Zusammenfassung
- [ ] Automatische Markt-Relevanz-Bewertung
- [ ] Besseres Sentiment-Analyse

### 4.3 Performance Attribution
- [ ] Dashboard: Welche Quellen liefern Alpha?
- [ ] Dashboard: Welche Kategorien sind profitabel?
- [ ] Brier Score für Kalibrierung
- [ ] Slippage-Analyse (Theorie vs. Realität)

### 4.4 Whale Tracking
- [ ] Große Polymarket-Trades verfolgen
- [ ] Smart Money Indikator

### 4.5 Event Calendar
- [ ] Bekannte Events (Wahlen, EZB-Meetings, etc.)
- [ ] Automatische Relevanz-Zuweisung zu Märkten

### 4.6 Portfolio-Management
- [ ] Korrelation zwischen Positionen
- [ ] Diversifikation erzwingen
- [ ] Hedging-Möglichkeiten

---

## Gesammelte Bug-Reports

| Bug | Severity | Status |
|-----|----------|--------|
| Deutsche News zeigt englische Quellen | BLOCKER | TODO |
| Backtest: `no such table: historical_trades` | BLOCKER | TODO |
| Telegram sendet alle 5 Min Menü | KRITISCH | ✅ FIXED (V4.2.1) |
| Risk State in-memory (verliert bei Restart) | KRITISCH | TODO |
| Alpha alle +30% (hardcoded?) | HOCH | ✅ FIXED (V4.2.1) - Fake signals removed |
| Confidence alle 87-95% (keine Differenzierung) | HOCH | ✅ FIXED (V4.2.1) - Only real strategies |
| Volatility hardcoded 0.15 | HOCH | TODO |
| Pipeline "HEALTHY" ohne echte Daten | HOCH | TODO |
| JSON Parse Error in Pipeline | HOCH | TODO |
| Rechte Sidebar nicht schließbar | MITTEL | TODO |
| Chart-Overlay bleibt kleben | MITTEL | TODO |
| Live Ticker identische Timestamps | MITTEL | TODO |
| Live Ticker Block-Patterns | MITTEL | TODO |
| Benutzerhandbuch hässlich | NIEDRIG | TODO |
| Keine Settings-Seite | MITTEL | TODO |
| Keine Browser Notifications | NIEDRIG | TODO |
| Deep Dive placeholder | HOCH | ✅ FIXED (V4.2.1) |
| Charts nicht funktional | HOCH | ✅ FIXED (V4.2.1) |
| Web nicht iPhone responsive | MITTEL | ✅ FIXED (V4.2.1) |
| 47 ESLint Errors | MITTEL | ✅ FIXED (V4.2.1) - Down to 2 |

---

## Abarbeitungs-Reihenfolge

**Phase 1 (Diese Woche):**
1. 1.1 Deutsche Quellen fixen
2. 1.3 Historical Data Pipeline
3. 1.4 Risk State Persistierung
4. 1.5 Telegram Spam-Fix

**Phase 2 (Nächste Woche):**
1. 1.2 Zeitvorsprung-Tracking
2. 2.1 Alpha-Berechnung fixen
3. 2.4 Breaking News Detection
4. 2.5 Pipeline Health fixen

**Phase 3 (Danach):**
1. 3.1-3.5 UI/UX Verbesserungen
2. 2.2-2.3 Volatilität & Backtest

**Phase 4 (Bonus):**
- Advanced Features (4.1-4.6)

---

*Diese Liste wird von Claude abgearbeitet. Fortschritt wird hier dokumentiert.*
