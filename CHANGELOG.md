# Changelog

Alle wichtigen Änderungen an diesem Projekt werden hier dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

---

## [4.0.0] - 2026-02-03

### BREAKING CHANGE: Alpha-Bereich entfernt

Die bisherige Alpha-Scoring-Engine wurde entfernt, da sie nicht die gewuenschten Ergebnisse lieferte. Das System wird auf bewährte Polymarket-Trading-Strategien umgestellt.

### Entfernt
- **PerplexityEngine** (`src/alpha/perplexityEngine.ts`) - LLM-basierte Analyse
- **MetaCombiner** (`src/alpha/metaCombiner.ts`) - Signal-Kombination
- **DriftDetection** (`src/alpha/driftDetection.ts`) - Drift-Erkennung
- **AutoTrader** (`src/alpha/autoTrader.ts`) - Automatisches Trading
- **MispricingEngine** (`src/alpha/mispricingEngine.ts`) - Mispricing-Erkennung
- **scanner/alpha.ts** - Alpha-Score Berechnung
- **tests/alpha.test.ts** - Veraltete Tests

### Behalten (für News-Matching)
- **LLMMatcher** - LLM-Validierung für Ticker-Matching (verhindert False Positives)
- **TimeDelayEngine** - News-Event Verarbeitung (ohne Auto-Trade)
- **FuzzyMatching** - Schnelles Vorfiltern von News-Market Paaren
- **RiskGates, Sizing, Volatility, ExecutionQuality, Telemetry** - Infrastruktur

### Geaendert
- Web API: `/api/llm/*` Endpoints geben jetzt Stubs zurueck
- Backtest: `mispricing` und `meta` Engines fallen auf `timeDelay` zurueck
- Scanner: Vereinfachte Alpha-Signal-Generierung
- Telegram: AutoTrader-Integration deaktiviert

### Hinzugefuegt (V4.0.1)
- **Dutch-Book Arbitrage Engine** (`src/arbitrage/`)
  - Scannt Märkte auf YES+NO < $1.00 Opportunitäten
  - Automatische Profit-Berechnung und Quality-Scoring
  - Event-basierte Signal-Generierung
  - Konfigurierbares Min-Spread, Liquidität, Trade-Size

- **Late-Entry V3 Strategy** (`src/lateEntry/`)
  - 15-Min Crypto Markets (BTC, ETH, SOL, XRP)
  - Entry nur in letzten 4 Minuten (konfigurierbar)
  - Confidence-basiertes Sizing (Preis-Distanz von 50%)
  - Time-basierter Multiplikator (später = sicherer = größer)

---

## [3.7.0] - 2026-02-02

### Hinzugefuegt
- **TimeDelayEngine Integration in Scanner**
  - Scanner ruft jetzt `timeDelayEngine.generateSignals()` in jeder Scan-Loop auf
  - Konvertiert News zu SourceEvents fuer strukturierte Signal-Generierung
  - Emittiert `time_delay_signal` Events fuer bessere Signale

- **NewsTicker → NotificationService Event-Verbindung**
  - NewsTicker emittiert `ticker:match_found` Events mit detaillierten Match-Daten
  - Telegram Bot hoert auf `ticker:match_found` und leitet an NotificationService weiter
  - Verbesserte Direction-Inferenz basierend auf News-Sentiment
  - Fallback auf Legacy-Methode `notifyMatchToNotificationService()`

- **Scanner → AutoTrader Integration**
  - `time_delay_signal` Events im Telegram Bot geloggt
  - AutoTrader wird von TimeDelayEngine bei `breaking_confirmed` automatisch aufgerufen

- **Web UI Live-Updates erweitert**
  - `time_delay_signal` Events an Socket.IO weitergeleitet
  - `ticker_match` Events fuer Dashboard-Matching-Visualisierung

### Geaendert
- Event-Flow Architektur: Telegram Bot als zentraler Orchestrator
- Strukturierte Event-Weiterleitung statt direkter Service-Calls
- Bessere Logging-Ausgaben mit Certainty-Emojis

---

## [3.6.0] - 2026-02-02

### Hinzugefuegt
- **Web Dashboard: Echte Trade-Execution**
  - `/api/trade/:signalId` Endpoint vollstaendig implementiert (war Platzhalter)
  - Paper Mode: Trades werden simuliert und im Risk State getrackt
  - Shadow Mode: Trades werden mit echtem Orderbook-Quote simuliert
  - Live Mode: Echte CLOB API Orders via `tradingClient.placeMarketOrder()`
  - Kill-Switch und Risk Gates werden vor jedem Trade geprueft

- **Web Dashboard: Konfigurierbarer Trade-Betrag**
  - Input-Feld im Drilldown-Panel fuer Trade-Betrag (1-100 USDC)
  - Betrag wird im Trade-Request an Backend gesendet
  - Live-Mode Warnung mit Bestaetigung vor echtem Trade

- **WebSocket Events fuer Trades**
  - `trade_executed` Event wird bei jedem Trade emittiert
  - Frontend-Handler aktualisiert Risk Dashboard automatisch
  - Log-Eintrag mit Mode, Direction, Betrag und Order-ID

### Behoben
- **Stats-TODOs im System Status**
  - `tradesToday` und `pnlToday` zeigen jetzt echte Werte aus `runtimeState.getRiskDashboard()`

---

## [3.5.0] - 2026-02-02

### Hinzugefuegt
- **Telegram Bot: Echte Trade-Execution**
  - `handleConfirm()` fuehrt Trades jetzt direkt aus (vorher: nur Event emit)
  - Paper/Shadow Mode: Trades werden simuliert
  - Live Mode: Trades werden via CLOB API ausgefuehrt
  - Bestaetigungsnachricht mit Fill-Preis und Order-ID

- **Telegram Bot: User-Authentifizierung**
  - Auth-Check auf konfigurierte Chat-ID
  - Nicht autorisierte Nutzer erhalten Fehlermeldung
  - Logging bei unauthorized access attempts

- **WebSocket Reconnect-Logik**
  - Exponential Backoff bei Verbindungsabbruch
  - Max 10 Reconnect-Versuche mit bis zu 30s Delay
  - Automatisches Daten-Neuladen nach Reconnect
  - Status-Anzeige im Frontend

- **XSS-Schutz im Web-Frontend**
  - `escapeHtml()` Funktion fuer alle User-generierten Inhalte
  - Market-Fragen, Kategorien, Directions werden escaped
  - Reasoning-Faktoren werden escaped

- **Graceful Shutdown mit Timeout**
  - Max 10 Sekunden Timeout fuer Shutdown
  - Process Lock wird bei allen Exit-Pfaden freigegeben
  - Verhindert haengende Prozesse

- **Equity Curve mit echten Timestamps**
  - `createdAt` Feld im AuditLogEntry Interface
  - Equity Curve zeigt echte Trade-Zeitpunkte
  - Nicht mehr alle Datenpunkte mit gleichem Timestamp

### Geaendert
- **Scanner: isScanning Flag in finally-Block**
  - Flag wird IMMER zurueckgesetzt, auch bei Fehlern
  - Verhindert permanentes Blockieren des Scanners

- **Watchdog: Schnellere Reaktion**
  - maxFailures von 3 auf 2 reduziert
  - Healing startet nach 60s statt 90s

- **Telegram: pendingTrades mit TTL**
  - Alte Trades werden nach 1 Stunde automatisch entfernt
  - Verhindert Memory Leaks
  - Cleanup-Intervall alle 5 Minuten

- **Telegram: editingField Reset**
  - Bei ungueltiger Eingabe wird editingField zurueckgesetzt
  - Verhindert State-Bugs bei wiederholter Eingabe

- **Telegram: MarketURL Fix**
  - SafeBet-Confirm nutzt jetzt marketId aus Scanner-Cache
  - Korrekte Polymarket-Links statt ungueltige signalId-URLs

### Behoben
- **Kritisch: Trades wurden nicht ausgefuehrt**
  - `handleConfirm()` emittete nur Event, fuehrte Trade nicht aus
  - Jetzt: Direkte Execution wie bei Quick-Buy

- **Kritisch: Process Lock bei Crash**
  - `uncaughtException` und `unhandledRejection` geben Lock frei
  - Neue Instanz kann starten nach Crash

- **Kritisch: Scanner konnte blockieren**
  - `isScanning` Flag nicht in finally-Block
  - Konnte bei Fehler permanent true bleiben

---

## [3.4.0] - 2026-02-02

### Hinzugefuegt
- **Stabilitaetsmechanismen**
  - **Watchdog Service:** Automatische Selbstheilung bei Fehlern
    - 5 Checks: Scanner, Ticker, Database, Memory, EventLoop
    - Automatischer Heal-Versuch nach 3-5 Fehlern
    - 30-Sekunden Check-Intervall
    - API: `GET /api/watchdog`, `POST /api/watchdog/check`
  - **Process Lock:** Verhindert mehrere Server-Instanzen
    - Lock-Datei unter `data/.scanner.lock`
    - Automatische Stale-Lock-Erkennung
  - **Erweiterter Health Check:** `/health` und `/api/health`
    - Detaillierte Checks: Server, Scanner, WebSocket, Database
    - Status 503 bei degraded Zustand
    - Scanner-Stats und Connection-Count

### Geaendert
- **PM2 Config:** Exponential Backoff bei Crashes aktiviert

---

## [3.3.0] - 2026-02-02

### Hinzugefuegt
- **Deutsche Markt-Watchlist System**
  - Neue SQLite-Tabelle `german_market_watchlist` fuer 1000+ EU-Maerkte
  - Kategorien: bundesliga, politik, eu_ukraine, wirtschaft, sonstige
  - Automatische Synchronisation taeglich um 6:00 Uhr
  - 869 europaeische Maerkte (UK, FR, IT, ES Politik + Premier League, La Liga, Serie A, Ligue 1, Champions League)
  - 113 manuell hinzugefuegte Maerkte (Bundesliga Abstieg, Landtagswahlen, CDU/SPD Koalition, Bank-Pleiten)
  - Total: 1058 Maerkte mit $558M Volume
  - Scripts: `add-european-markets.ts`, `add-manual-markets.ts`, `show-watchlist.ts`

- **Europaeische RSS-Feeds**
  - 30+ neue internationale Feeds fuer EUSSR-Tracker Matching
  - UK: BBC Politics, Guardian, Telegraph, Independent
  - FR: France24, RFI, Le Monde
  - IT: ANSA Politics, Reuters Italy
  - ES: El Pais
  - Sport: BBC Football, Guardian Football, Sky Sports, ESPN FC, Marca, Gazzetta

- **LLM-Matcher fuer News → Market Matching**
  - Claude 3.5 Haiku fuer schnelles, praezises Matching
  - Keyword Pre-Filter reduziert API-Calls
  - Richtungs-Bestimmung (YES/NO) mit Confidence

### Geaendert
- **Branding:** "Almanien" → "ALMANIEN-EUSSR-Tracker" ueberall in Docs und Code
- **Crypto entfernt:** Keine Crypto-Feeds oder -Kategorie mehr

### Behoben
- **Web-Auth bei WEB_AUTH_ENABLED=false:** requireAuth prueft jetzt Config-Flag
- **TypeScript Build:** newsCandidates.ts fehlende Felder hinzugefuegt

---

## [3.2.0] - 2026-02-02

### Hinzugefuegt
- **Alpha Engine Kalibrierung** (Phase 4 abgeschlossen)
  - `volatility30d` fuer jeden Markt bereits in `src/alpha/volatility.ts`
  - Source Reliability Tracking im DB Schema (`reliability_score`)
  - Push Gates evaluieren Source Reliability bei jedem Signal
  - Time Advantage Stats aggregieren `prediction_accuracy` pro Quelle

### Dokumentation
- **tasks/todo.md** aktualisiert mit vollstaendiger Production Ready Zusammenfassung
- Phase 5 (Operations) als "uebersprungen" markiert - nicht kritisch fuer MVP

### Status: PRODUCTION READY
- Alle kritischen Komponenten implementiert
- Ausstehend: VPN-Zugang + Wallet-Funding + E2E Live-Test

---

## [3.1.0] - 2026-02-02

### Hinzugefuegt
- **CLOB Order Execution Validierung** (Phase 1.1)
  - `getOrderStatus(orderId)`: Holt aktuellen Order-Status vom CLOB
  - `cancelOrder(orderId)`: Storniert offene Orders
  - `waitForFill(orderId, options)`: Polling mit Timeout und Auto-Cancel
  - `placeOrderWithRetry(params, options)`: Retry-Logik mit exponentiellem Backoff
  - `executeOrderWithTracking()`: Vollstaendiger Trade-Flow mit Status-Tracking
- **Error-Type-Klassifizierung** (`ClobOrderError`)
  - `insufficient_balance`: Nicht wiederholbar
  - `market_closed`: Nicht wiederholbar
  - `price_moved`: Wiederholbar (mit neuem Preis)
  - `rate_limited`: Wiederholbar (mit Backoff)
  - `network_error`: Wiederholbar
- **Position Tracking & Sync** (Phase 1.2)
  - `getOpenOrders()`: Alle offenen Orders vom CLOB
  - `getRecentTrades()`: Abgeschlossene Trades fuer PnL
  - `syncPositions()`: CLOB → Local DB Sync mit Mismatch Detection
  - `calculateRealizedPnL()`: Echte PnL aus CLOB Fills
- **Kill-Switch Hardening** (Phase 1.3)
  - `FORCE_PAPER_MODE` ENV-Variable (Hardware Kill-Switch)
  - `CONSECUTIVE_FAILURES_KILL` ENV-Variable (default: 3)
  - Auto Kill-Switch bei 3+ fehlgeschlagenen Trades
  - `recordTradeSuccess()` / `recordTradeFailure()` Tracking
- **Risk Management Hardening** (Phase 2)
  - `maxPerMarketPercent`: 10% Bankroll pro Markt
  - `maxSlippagePercent`: 2% Slippage Limit
  - `minOrderbookDepth`: 2x Trade Size Liquiditaet
  - `checkOrderbookDepth()`: Slippage-Schaetzung vor Trade
  - `checkExtendedRiskGates()`: Erweiterte Checks mit Orderbook
- **Observability** (Phase 3)
  - `/health` Telegram Command - System Status Check
  - `/positions` erweitert mit echten CLOB-Daten und Open Orders
  - `consecutiveFailures` im RiskDashboard
- **Test-Script**: `npm run test:clob` fuer Order-Flow-Tests

### Geaendert
- **`executeLive()`** nutzt jetzt `executeOrderWithTracking()`:
  - Order-Status-Polling statt Annahme "success = filled"
  - Partial Fill Handling (>50% = Erfolg)
  - Automatische Cancellation bei 30s Timeout
  - Detailliertes Logging mit Error-Type

### Behoben
- **Live-Trading fehlte Order-Status-Tracking** - Orders wurden blind platziert
- **Keine Retry-Logik** bei transienten Fehlern (Rate Limits, Network)
- **Kein Timeout/Cancellation** fuer haengende Orders
- **ethers v6 → v5 Kompatibilitaet**: `_signTypedData` Proxy-Wrapper fuer CLOB Client

### Technische Hinweise
- Test-Script ist standalone wegen p-limit Bug in Node v24 mit tsx
- Echter E2E-Test benoetigt gefundetes Wallet ($0.01+ USDC, MATIC fuer Gas)

---

## [3.0.25] - 2026-02-02

### Hinzugefuegt
- **Responsive Design fuer Mobile Geraete**
  - Hamburger-Menue: Sidebar als Slide-In Panel auf Mobile (<768px)
  - Toggle-Button mit animiertem Icon im Header
  - Overlay zum Schliessen des Menues durch Tippen ausserhalb
  - Escape-Taste schliesst Menue
  - Automatisches Schliessen bei View-Wechsel

### Geaendert
- **Mobile-optimierte UI**
  - Kompakterer Header mit versteckten Metriken auf Mobile
  - Signal-Liste mit responsivem Grid-Layout
  - Groessere Touch-Targets (min 44px) fuer Buttons
  - Tabellen horizontal scrollbar fuer kleine Bildschirme
  - Stats-Grid zu 2-spaltigem Layout auf Mobile
  - Charts auf 180px Hoehe reduziert
  - Footer vereinfacht (weniger Stats sichtbar)
  - Settings-Formulare stacken vertikal
- **Tablet-Optimierungen** (769px-1024px)
  - Schmalere Sidebar (180px statt 280px)
  - Weniger Header-Metriken sichtbar
- **Viewport Meta Tag**: Zoom deaktiviert fuer native App-Feeling

---

## [3.0.24] - 2026-02-02

### Hinzugefuegt
- **Signal Reasoning - zeigt WARUM ein Signal interessant ist**
  - Neues `structuredReasoning` Feld im AlphaSignal Interface
  - `SignalReasoning` Interface mit: summary, factors[], newsMatch
  - Faktoren: Match-Score, Quellen, Timing, Sentiment - jeweils mit Erklaerung
  - News-Match: Titel, Quelle und Confidence des besten News-Treffers
  - Web-Frontend: Neue "WARUM INTERESSANT?" Sektion im Signal-Drilldown
  - Telegram Bot: Formatiertes Reasoning bei Signal-Details und Alerts
  - Faktoren nach Wert sortiert (hoechster zuerst)
  - Automatische Summary-Generierung aus besten Faktoren

---

## [3.0.23] - 2026-02-02

### Hinzugefuegt
- **Backtest Demo-Data Generator** (`scripts/generate-backtest-data.ts`)
  - Neues Script fuer realistische Backtest-Daten direkt in SQLite
  - `npm run generate:backtest` - 50 Markets, 90 Tage Historie
  - `npm run generate:backtest -- --markets 100 --days 180 --clear`
  - Generiert realistische Market-Fragen (Politik, Wirtschaft, Geopolitik, Tech)
  - Preisbewegungen mit Drift-Richtung basierend auf Outcome
  - 80% der Markets werden als resolved generiert
  - ~1000 Trades pro Market ueber 90 Tage
  - Outcome-Logik: "reach target" Fragen scheitern oefters
  - Keine CSV-Dateien noetig - direkt in Datenbank

### Geaendert
- `package.json`: Neues Script `generate:backtest` hinzugefuegt

### Behoben
- **Backtest zeigte "Keine Daten"**
  - Problem: Es gab keine historischen Trades/Markets in der Datenbank
  - Vorheriges Demo-System war CSV-basiert und kompliziert
  - Jetzt: Ein Befehl generiert alle Daten fuer sofortiges Backtesting

---

## [3.0.22] - 2026-02-02

### Verbessert
- **Telegram Quick-Buy-Buttons vollstaendig**
  - Live-Mode: Echte Trades via TradingClient CLOB API statt nur Polymarket-Links
  - Signal-Lookup aus Scanner-Cache fuer Token-ID Bestimmung
  - Bestaetigungsdialog mit Modus-Anzeige (Paper/Shadow/Live)
  - Status-Nachrichten waehrend Trade-Ausfuehrung
  - Erfolgs-Nachricht mit Fill-Preis und Order-ID
  - Fehler-Handling mit Fallback zu manuellem Polymarket-Link
  - Verbesserter Cancel-Handler mit formatierter Nachricht

---

## [3.0.21] - 2026-02-02

### Behoben
- **Matching-Algorithmus: Thematische Relevanz**
  - Neue `isThematicallyRelevant()` Funktion verhindert falsche Keyword-Matches
  - Problem: "Iran-USA Treffen" matchte mit "Trump 2028 nomination" nur wegen "Trump"
  - Loesung: Kategorien-System prueft ob News und Market im gleichen Themenbereich sind
  - Kategorien: US-Wahlen, Iran-Diplomatie, Deutschland-Politik, Ukraine-Konflikt, Sport, Crypto, Nahost
  - Personen-Match: Bei gleichem Namen (z.B. "Trump") muessen mindestens 2 weitere Woerter matchen
  - Fallback-Threshold erhoeht: Nur noch Matches mit 3+ Keywords werden akzeptiert
  - Schwache Matches (1-2 Keywords) werden jetzt uebersprungen mit Debug-Log
  - `isNewsRelevantToMarket()` nutzt jetzt thematische Relevanz-Pruefung

---

## [3.0.20] - 2026-02-02

### Hinzugefuegt
- **Telegram Quick-Buy-Buttons**
  - Neue direkte Kauf-Buttons bei Alerts: 💰 5$ / 10$ / 25$ / 50$
  - Konfigurierbare Betraege via `QUICK_BUY_AMOUNTS` ENV Variable
  - Bestaetigung vor Trade-Ausfuehrung
  - Paper/Shadow Mode: Simuliert Trade ohne echtes Geld
  - Live Mode: Leitet zu Polymarket (Auto-Execution kommt spaeter)
  - Watch-Button: Markt zur Watchlist hinzufuegen (Placeholder)
  - Chart-Button: Direktlink zum Polymarket-Chart
  - Quick-Buy-Betraege in Settings-Menue angezeigt

### Geaendert
- **Config erweitert**
  - Neues `quickBuy.amounts` Array in Config
  - Default: [5, 10, 25, 50] USDC

---

## [3.0.19] - 2026-02-02

### Geaendert
- **Telegram Almanien-Alerts ueberarbeitet**
  - Titel von "TIME_DELAY - TRADEABLE" zu "ALMANIEN ALERT" geaendert
  - Deutschland-Relevanz-Filter: Alerts nur fuer DE-bezogene Maerkte
  - Neue GERMANY_KEYWORDS Liste mit 30+ relevanten Begriffen
  - Zeitvorsprung-Text korrigiert: "Markt hat noch nicht reagiert" statt "X Min vor US-Medien"
  - Verbesserte Alert-Struktur mit "Zeitvorsprung aktiv!" Indikator
  - Batch-Alerts filtern jetzt auch nach Deutschland-Bezug
  - UI: Module-Toggle zeigt jetzt "ALMANIEN" statt "TIME_DELAY"

---

## [3.0.18] - 2026-02-02

### Behoben
- **ESLint Flat Config Fix**
  - Veraltetes `--ext` Flag entfernt (kompatibel mit ESLint 9.x Flat Config)
  - Fehlende Dependencies: `typescript-eslint`, `@eslint/js` hinzugefuegt
  - Deploy-Failures behoben

### Hinzugefuegt
- **Polymarket CLOB Client Integration**
  - Echte Order-Platzierung via Polymarket CLOB API
  - API Credentials Derivation
  - FOK (Fill-or-Kill) Orders
  - Slippage-Berechnung

---

## [3.0.17] - 2026-02-02

### Geaendert
- **Benutzerhandbuch komplett ueberarbeitet** (Task #44)
  - Modernes, sauberes Design mit Inter-Schriftart statt ASCII-Art
  - Laienfreundliche Sprache fuer alle Begriffe (Edge, Signal, Kelly, etc.)
  - Neue Suchfunktion mit Echtzeit-Filterung und Highlighting
  - Sticky Sidebar-Navigation mit Scroll-Tracking
  - Interaktives FAQ-Akkordeon mit 10 wichtigen Fragen
  - Erweitertes Glossar mit 12 Begriffen in Card-Grid-Layout
  - Neue Sektion "Almanien" erklaert den Deutschland-Vorteil
  - Responsive Design fuer Desktop und Mobile
  - Dark/Light Theme-Toggle
  - Keine technischen Setup-Anleitungen mehr (gehoeren in README)

---

## [3.0.16] - 2026-02-02

### Hinzugefuegt
- **Zeitvorsprung-Tracking System** (Task #36)
  - **Neues Datenmodell:**
    - `time_advantage_tracking` Tabelle: News-zu-Markt Tracking mit allen Zeitstempeln
    - `time_advantage_stats` Tabelle: Aggregierte Statistiken pro Quelle und Zeitraum
    - `price_check_queue` Tabelle: Queue fuer automatische Preis-Checks
  - **Automatisches Tracking:**
    - Bei jeder deutschen News: Timestamp und Quelle gespeichert
    - Bei Markt-Match: Initialer Preis-Snapshot
    - Automatische Price-Checks nach 5/15/30/60 Minuten, 4h und 24h
    - Erkennung signifikanter Bewegungen (>2%)
  - **Time Advantage Service:**
    - Orchestriert das gesamte Tracking
    - Berechnet Zeitvorsprung bei signifikanten Marktbewegungen
    - Statistik-Aggregation nach Quelle, Tag, Woche, Monat
  - **Telegram Dashboard:**
    - Neuer `/edge` Befehl zeigt Zeitvorsprung-Dashboard
    - Neuer "Zeitvorsprung" Button im Hauptmenue
    - Anzeige: Getrackte News, Matches, Signifikante Moves
    - Avg. Zeitvorsprung, Avg. Preisbewegung, Vorhersage-Genauigkeit
    - Top-Quellen Tabelle mit Performance-Metriken
    - Letzte Trackings mit Status-Emojis
  - **Metriken:**
    - `timeAdvantageMinutes`: Zeit zwischen News und Marktbewegung
    - `predictionAccuracy`: Wie oft stimmt News-Richtung mit Markt ueberein
    - `edgeCaptured`: Tatsaechlicher Edge wenn getradet
  - **Integration:**
    - Germany-Modul: Automatisches Tracking bei Breaking News
    - Matching-Modul: Automatisches Verknuepfen von News mit Maerkten
    - Sentiment-Analyse fuer Vorhersage-Richtung

---

## [3.0.15] - 2026-02-02

### Behoben
- **Pipeline Health Reporting (Task #40)**
  - Pipeline Status startet jetzt mit 'unknown' statt falschem 'healthy'
  - HEALTHY nur wenn lastSuccess < 10 Minuten alt
  - Neuer Status 'unknown' fuer Pipelines ohne Daten
  - recordPipelineSuccess() wird bei echten Erfolgen aufgerufen:
    - Polymarket: Bei erfolgreichem Markt-Fetch
    - RSS: Bei erfolgreichen Feed-Fetches
    - Dawum: Bei erfolgreichen Umfrage-Abrufen
    - Telegram: Bei erfolgreichen Nachricht-Sendungen
  - JSON Parse Error Fix: Content-Type Pruefung vor .json()
  - Overall Status zeigt INITIALIZING statt ALL HEALTHY bei fehlenden Daten

---

## [3.0.14] - 2026-02-02

### Hinzugefuegt
- **Browser Push-Notifications** (Task #43)
  - **Notification API Integration:**
    - Permission Request beim ersten Besuch
    - Desktop-Notifications fuer wichtige Events
    - Auto-close nach 10 Sekunden (ausser kritische Alerts)
  - **Event-Typen:**
    - High-Alpha Signal (Edge > 20%)
    - Almanien Zeitvorsprung gefunden
    - Trade ausgefuehrt (auto oder manuell)
    - Risk Warning (Kill-Switch, Daily Limit > 80%)
    - Pipeline Fehler
  - **Settings-UI:**
    - Neuer SETTINGS-View in der Navigation
    - Master on/off Toggle
    - Sound on/off Toggle
    - Individuelle Checkboxen fuer jeden Event-Typ
    - Status-Anzeige (Browser Support, Permission, WebSocket)
    - Test-Button zum Pruefen der Notifications
  - **Backend WebSocket Events:**
    - Neues `browser_notification` Event via Socket.io
    - Events werden bei High-Alpha Signalen, Trades, Risk-Warnings emittiert

### Neue Dateien
- `src/web/public/index.html` erweitert um:
  - Notification-JavaScript (Settings-Persistenz in localStorage)
  - Settings-View mit Toggles und Status

---

## [3.0.13] - 2026-02-02

### Hinzugefuegt
- **Backtest Overfitting Prevention** (Task #34)
  - **Out-of-Sample Validation:**
    - Train/Test Split (default: 70/30, konfigurierbar)
    - Separate Metriken fuer Train und Test Daten
    - Divergenz-Erkennung zwischen Train/Test Performance
  - **Monte Carlo Simulation:**
    - Trade-Reihenfolge shufflen fuer Robustness-Check
    - 1000 Simulationen (konfigurierbar mit `--mc-sims`)
    - 95% Confidence Interval fuer PnL
    - Max Drawdown Distribution
  - **Overfitting-Warnungen:**
    - Unrealistisch hohe Sharpe Ratio (>3) wird gewarnt
    - Train >> Test Performance Divergenz erkannt
    - Zu wenig Test-Trades Warnung
    - Unrealistische Returns Detection
  - **Robustness Score (0-100):**
    - Aggregiert alle Overfitting-Indikatoren
    - Empfehlungen zur Strategie-Verbesserung
    - ROBUST vs NICHT ROBUST Klassifikation

### Geaendert
- **Walk-Forward Window von 30 auf 90 Tage erhoeht** (mehr Robustheit)
- Neue CLI-Optionen fuer Backtest:
  - `--no-validation` - Out-of-Sample Validation deaktivieren
  - `--split RATIO` - Train/Test Split anpassen (default: 0.7)
  - `--no-monte-carlo` - Monte Carlo deaktivieren
  - `--mc-sims NUM` - Anzahl Simulationen (default: 1000)
  - `--walk-forward, -w` - Walk-Forward Window in Tagen
- `BacktestResult` erweitert zu `ExtendedBacktestResult` mit Validation & Monte Carlo
- Reports (Markdown, JSON, Console) zeigen jetzt Validation-Ergebnisse

### Neue Dateien
- `src/backtest/validation.ts` - Out-of-Sample Validation, Monte Carlo, Robustness Check
- `src/alpha/types.ts` erweitert um:
  - `ValidationResult` Interface
  - `MonteCarloResult` Interface
  - `OverfittingWarning` Interface
  - `ExtendedBacktestResult` Interface

### Warum wichtig
- **Overfitting ist das groesste Risiko beim Backtesting!**
- Strategie die in-sample funktioniert kann out-of-sample versagen
- Monte Carlo zeigt Varianz der Ergebnisse (nicht nur Best-Case)
- Automatische Warnungen verhindern falsche Zuversicht
- 90-Tage Walk-Forward vermeidet kurzfristige Zufalls-Fits

---

## [3.0.12] - 2026-02-02

### Hinzugefuegt
- **Settings-Seite im Web-Interface** (Task #42)
  - Neue View "SETTINGS" in der Navigation (unten bei CONSOLE)
  - Vollstaendiges Einstellungs-Panel mit 4 Kategorien:

  **Trading-Einstellungen:**
  - Execution Mode (Paper/Shadow/Live) - direkt aenderbar
  - Max Daily Loss ($) - taegliches Verlust-Limit
  - Max Positions - maximale gleichzeitige Positionen
  - Max pro Markt ($) - Exposure-Limit pro Markt
  - Kelly Fraction (%) - Position Sizing Aggressivitaet
  - Bankroll ($) - Gesamtkapital fuer Berechnungen
  - Max Bet pro Trade ($) - absolutes Trade-Maximum

  **Signal-Einstellungen:**
  - Min Alpha Threshold (%) - Qualitaetsfilter fuer Signale
  - Min Edge (%) - minimale Preisdifferenz
  - Min Volumen ($) - Liquiditaetsfilter
  - Auto-Trade bei "breaking_confirmed" (Checkbox)

  **Benachrichtigungs-Einstellungen:**
  - Browser-Notifications (on/off)
  - Event-Checkboxen: Signal, Trade, Kill-Switch, Daily Reset, High-Alpha

  **System Status:**
  - Telegram Bot Status
  - Wallet Konfiguration
  - Deutschland-Modus Status
  - Dawum API Status
  - RSS Feeds Status

- Neuer API-Endpoint `GET /api/settings/all`
  - Liefert alle aktuellen Settings fuer die Settings-Seite
  - Kombiniert Server-State mit Config-Werten

- Persistenz:
  - Trading/Signal-Settings werden auf dem Server gespeichert (SQLite)
  - Notification-Settings werden in localStorage gespeichert
  - Kelly/Bankroll werden lokal gespeichert (da .env Werte)

- UI-Features:
  - SPEICHERN Button mit Erfolgs-/Fehler-Feedback
  - DEFAULTS Button setzt alle Werte auf Standardwerte zurueck
  - Settings werden beim View-Wechsel automatisch geladen
  - Erklaerungstexte unter jedem Eingabefeld

### Warum wichtig
- **Keine .env Aenderungen mehr noetig** fuer Runtime-Einstellungen
- Alle wichtigen Parameter zentral im Web-UI konfigurierbar
- Sofortige Aenderungen ohne Server-Neustart
- Einmal einstellen, dann laeuft es

---

## [3.0.11] - 2026-02-02

### Hinzugefuegt
- **Breaking News Auto-Execute Feature** (Task #46)
  - Neuer `AutoTrader` Service (`src/alpha/autoTrader.ts`)
    - Automatische Trade-Ausfuehrung bei `breaking_confirmed` Signals
    - Konfigurierbar: `AUTO_TRADE_MIN_EDGE` (default: 15%)
    - Konfigurierbar: `AUTO_TRADE_MAX_SIZE` (default: 50 USDC)
    - Event-basierte Architektur fuer Notifications
  - Erweiterte Config (`src/utils/config.ts`)
    - `AUTO_TRADE_ENABLED` (default: false - Sicherheit!)
    - `AUTO_TRADE_MIN_EDGE` (default: 0.15 = 15%)
    - `AUTO_TRADE_MAX_SIZE` (default: 50 USDC)
  - TimeDelayEngine Integration
    - Automatischer Auto-Trade Trigger bei `breaking_confirmed`
    - `autoTradeEnabled` Config-Option
  - Telegram Bot Erweiterungen
    - Auto-Trade Notifications (ausgefuehrt/blockiert)
    - Toggle fuer Auto-Trade im Settings-Menue
    - Sync zwischen `autoBetOnSafeBet` und AutoTrader/TimeDelayEngine

### Warum wichtig
- **Speed ist essentiell** - Zeitvorsprung nur wertvoll wenn schnell gehandelt wird!
- Automatisiertes Trading bei quasi-sicheren Breaking News (breaking_confirmed)
- Risk Gates werden vor jedem Auto-Trade geprueft
- Kill-Switch stoppt auch Auto-Trading
- Default: AUS (muss explizit aktiviert werden)

---

## [3.0.10] - 2026-02-02

### Hinzugefuegt
- **Almanien Intelligence: News-Markt Matches** (Herzstück des Features!)
  - Neuer API-Endpoint `/api/germany/matches` (`src/web/server.ts`)
    - Deutsche News werden mit Polymarket-Märkten gematched
    - Nutzt Fuzzy-Matching aus `src/alpha/matching.ts`
    - Gibt Confidence-Score, Keywords, Entities und Zeitvorsprung zurück
    - Direkter Link zum Polymarket-Markt
  - Komplett neu gestaltete Almanien-View (`src/web/public/index.html`)
    - Matches-Panel zeigt News mit gematchten Märkten
    - Confidence-Bar mit Farbkodierung (grün/gelb/grau)
    - Zeitvorsprung-Anzeige (m/h/d)
    - "MARKT ÖFFNEN"-Button mit direktem Link
    - Match-Details: Entities und Keywords
    - Aktueller Marktpreis (wenn verfügbar)
  - Umfragen-Panel bleibt erhalten (Sonntagsfrage)

### Behoben
- TypeScript-Fehler in `src/alpha/timeAdvantageService.ts` (null -> undefined)
- TypeScript-Fehler in `src/backtest/validation.ts` (drawdownStats.worst)

### Warum wichtig
- **Das ist das Herzstück des Almanien-Features!**
- Zeigt deutschen Informationsvorsprung konkret an
- Ermöglicht schnelles Handeln auf Polymarket bei deutschen Breaking News
- Messbare Match-Qualität durch Confidence-Scoring

---

## [3.0.9] - 2026-02-02

### Geaendert
- **Echte Volatilitaets-Berechnung fuer Kelly Sizing** (`src/alpha/volatility.ts`)
  - Mindestens 30 taegliche Datenpunkte fuer echte Berechnung (vorher 7)
  - Fallback auf DEFAULT_VOLATILITY (0.15) nur bei zu wenig Daten
  - **Wichtiges Logging bei Fallback** mit `[VOLATILITY FALLBACK]` Prefix
  - Cache speichert jetzt auch Datenpunkte-Anzahl
  - Neue Konstanten exportiert: `DEFAULT_VOLATILITY`, `MIN_DAILY_RETURNS`
  - Neue Funktion `getVolatilityCacheStats()` fuer Monitoring

- **MispricingEngine: Bessere Volatility-Integration** (`src/alpha/mispricingEngine.ts`)
  - `calculateMarketQualityAsync()` loggt jetzt Volatility-Quelle (calculated/cached/fallback)
  - `calculateMarketQuality()` (sync) hat jetzt `volatilityOverride` Parameter
  - Warnung in Reasons wenn Default-Volatilitaet verwendet wird

### Hinzugefuegt
- **Volatility Tests** (`src/__tests__/volatility.test.ts`)
  - Tests fuer Fallback-Verhalten
  - Tests fuer Cache-Funktionalitaet
  - Tests fuer Konstanten

### Warum wichtig
- **Korrektes Kelly Sizing benoetigt echte Volatilitaet!**
- Hardcoded 0.15 fuehrte zu falschem Position-Sizing
- Jetzt: 30-Tage annualisierte Volatilitaet aus historischen Preisdaten
- Bei wenig Daten: Explizites Logging fuer Debugging

---

## [3.0.8] - 2026-02-02

### Hinzugefuegt
- **Position-Sync beim Server-Start** (`src/runtime/positionSync.ts`)
  - KRITISCH: Nach Restart "vergisst" das System offene Positionen
  - Neue `syncPositionsToRiskState()` Funktion synchronisiert automatisch:
    - Holt aktuelle Positionen von Polymarket API
    - Berechnet Exposure pro Market
    - Aktualisiert `riskGates.ts` Risk State
    - Aktualisiert `runtime/state.ts` Runtime State
  - Neue `syncPositionsFromApi()` Methode in RuntimeStateManager
  - Audit-Log Eintrag bei jeder Synchronisierung
  - Wird automatisch beim Server-Start in `src/index.ts` aufgerufen

### Geaendert
- `src/index.ts`: Position-Sync nach DB-Init hinzugefuegt
- `src/runtime/state.ts`: Neue `syncPositionsFromApi()` Methode

---

## [3.0.7] - 2026-02-02

### Behoben
- **KRITISCH: Schema-Migration hat Tabellen nicht erstellt** (`src/storage/db.ts`)
  - Problem: SQL-Statements wurden am Semikolon gesplittet, aber der erste Block
    enthielt Kommentare am Anfang (`-- EdgyAlpha...`), wodurch das gesamte
    erste Statement (inkl. CREATE TABLE) gefiltert wurde
  - Lösung: Kommentarzeilen werden jetzt zeilenweise entfernt BEVOR am Semikolon
    gesplittet wird
  - Vorher: "0 OK, 28 übersprungen" (nur INDEX-Statements)
  - Jetzt: "47 OK, 0 übersprungen" (alle Tabellen + Indizes)

- **historical_trades/historical_markets Tabellen fehlten**
  - Backtest fehlgeschlagen mit "no such table: historical_trades"
  - Jetzt: Tabellen werden korrekt erstellt bei DB-Initialisierung

### Hinzugefügt
- **Demo-Daten Generator** (`scripts/generate-demo-data.ts`)
  - `npm run generate:demo` - Generiert synthetische Markets und Trades
  - Optionen: `--markets 50 --trades 100` für Anzahl
  - Realistische Random-Walk Preisbewegungen
  - 70% der Markets werden als "geschlossen" generiert

- **Demo-Markets Resolution** (`scripts/resolve-demo-markets.ts`)
  - `npm run resolve:demo` - Setzt Outcomes für geschlossene Demo-Markets
  - Outcome basiert auf letztem Trade-Preis (probabilistisch)
  - Notwendig für Backtesting mit Demo-Daten

### Geändert
- `scripts/import-polydata.ts`: Null-Handling in `formatNumber()` verbessert
- `package.json`: Neue Scripts `generate:demo` und `resolve:demo` hinzugefügt
- `README.md`: Dokumentation für historische Daten und Demo-Daten erweitert

---

## [3.0.6] - 2026-02-02

### Behoben
- **KRITISCH: Alpha-Berechnung überarbeitet** (`src/scanner/alpha.ts`)
  - Problem: Alle Signale zeigten +30.0% Edge und 87-95% Confidence (quasi hardcoded)
  - Lösung: Komplett neue `calculateAlphaScore()` Funktion mit echten, variierenden Werten

### Geändert
- **Neue Alpha-Score Berechnung mit 6 gewichteten Faktoren:**
  1. Match-Qualität (25%): Wie gut passt die News zum Markt?
  2. Quellen-Anzahl (15%): Mehrere Quellen = höhere Sicherheit
  3. Quellen-Qualität (10%): Breaking News Indikatoren
  4. News-Frische (20%): Frische News = höherer Zeitvorsprung
  5. Zeitvorsprung (10%): Hat der Markt schon reagiert?
  6. Sentiment/Impact (20%): Stärke und Richtung der News

- **Echte Edge-Berechnung:**
  - Formel: `BaseEdge * MatchMultiplier * TimingMultiplier`
  - Range: 0% - 25% (realistisches Maximum statt 30%)
  - Minimum 2% Edge wenn gute Daten vorhanden

- **Echte Confidence-Berechnung:**
  - Basiert auf: Multi-Source (35%), Match-Qualität (30%), Frische (20%), Sentiment (15%)
  - Single-Source Penalty: -30%
  - Alte News Penalty: -20%
  - Range: 10% - 95%

- **Detailliertes Reasoning:**
  - Zeigt jetzt Breakdown: `[M:65% S:70% T:80% C:45%]`
  - Erklärt jeden Faktor der zum Score beiträgt

### Hinzugefügt
- `AlphaCalculationResult` Interface mit `breakdown` Objekt für Transparenz
- Logging der einzelnen Score-Komponenten für Debugging

---

## [3.0.5] - 2026-02-02

### Behoben
- **KRITISCH: Telegram Bot Spam behoben** (`src/telegram/index.ts`)
  - Automatisches `sendWelcome()` beim Bot-Start entfernt
  - Vorher: Bei jedem Prozess-Restart wurde das Hauptmenü gesendet
  - Jetzt: Menü wird NUR gesendet wenn User /start oder /menu eingibt
  - Bot sendet jetzt nur noch echte Alerts (TIME_DELAY, SAFE_BET, etc.)

- **KRITISCH: Deutsche News Bereich zeigte englische Quellen!**
  - Problem: "Deutsche News" im Telegram Bot zeigte CNN, Bloomberg, MarketWatch, Guardian, BBC, etc.
  - Diese englischen Quellen bieten KEINEN Zeitvorsprung für deutsche Nutzer!

- **Lösung: Strikte Trennung deutsche vs. internationale Feeds**
  - `WORKING_RSS_FEEDS` enthält jetzt NUR 34 echte deutsche Quellen:
    - Politik: Tagesschau, Spiegel, FAZ, Zeit, Welt, n-tv, DW Deutsch, Bundesregierung
    - Wirtschaft: Handelsblatt, Manager Magazin, Wirtschaftswoche, Capital
    - Sport: Kicker, Sportschau, Sport1, Spox, Transfermarkt
    - Tech: Heise, Golem, t3n, Chip
    - Ausland: Tagesschau Ausland, Spiegel Ausland, FAZ Ausland, Zeit Ausland
  - Neue Liste `INTERNATIONAL_RSS_FEEDS` (22 Quellen) für optionales Alpha-Matching
  - Neuer Parameter `germanOnly: true` in `fetchAllRSSFeeds()` für strikte Filterung
  - Telegram `/news` und der Event-Listener nutzen jetzt NUR deutsche Quellen

### Geändert
- `src/germany/rss.ts`: Feed-Listen komplett überarbeitet
- `src/germany/index.ts`: `fetchRSSFeeds()` und `fetchRSSFeedsWithDelta()` nutzen `germanOnly: true`
- `src/telegram/index.ts`: `handleNews()` nutzt `germanOnly: true`

---

## [3.0.4] - 2026-02-02

### Hinzugefügt
- **KRITISCH: Risk State SQLite Persistierung** (`src/alpha/riskGates.ts`)
  - Risk State (dailyPnL, openPositions, killSwitchActive) wird jetzt in SQLite persistiert
  - `ensureStateInitialized()` - Lädt State automatisch aus DB beim ersten Zugriff
  - `persistRiskState()` - Speichert State bei JEDER Änderung
  - Kill-Switch überlebt jetzt Server-Restarts (vorher verloren!)
  - Positions-Tracking persistiert (vorher verloren!)
  - Daily PnL überlebt Restarts (vorher verloren!)
  - Audit-Logging für alle Risk-Änderungen

- **Neue Funktionen:**
  - `initializeRiskState()` - Explizites Force-Reload aus DB
  - `isRiskStateInitialized()` - Prüft ob State geladen wurde

### Behoben
- **KRITISCH: Risk-Limits gingen bei Server-Restart verloren**
  - Vorher: Kill-Switch deaktiviert nach Restart → unkontrolliertes Trading
  - Vorher: Daily PnL auf 0 nach Restart → Verlust-Limits umgangen
  - Vorher: Positions vergessen → Over-Exposure möglich
  - Jetzt: Alles persistiert in `risk_state` Tabelle

- **UI: Rechte Sidebar nur auf Signals-Seite:**
  - Drilldown-Panel mit "SELECT SIGNAL" erscheint nicht mehr auf Risk/Almanien-Seiten
  - X-Button zum Schliessen des Drilldown-Panels hinzugefuegt
  - Sauberes Layout ohne Trading-UI auf Dashboard-Seiten

- **Chart-Overlay Bug behoben:**
  - Chart wird bei Seitenwechsel korrekt entfernt (nicht mehr "klebend")
  - `priceChart.remove()` wird aufgerufen bevor neuer Chart erstellt wird
  - Drilldown-Reset beim Verlassen der Signals-Seite

### Geändert
- Grid-Layout dynamisch: 2 Spalten ohne Drilldown, 3 Spalten mit Drilldown
- Deutsche UI-Texte in Drilldown-Placeholder

---

## [3.0.3] - 2026-02-02

### Hinzugefügt
- **SAFE BET Feature:** Bei `breaking_confirmed` Certainty (quasi-sichere Breaking News)
  - 🚨 SAFE BET Alert mit 50% Bankroll Empfehlung
  - Auto-Bet Toggle in Settings (default: AUS für Sicherheit)
  - Manuelle Buttons: 1/4 Bankroll, 1/2 Bankroll, Custom-Betrag
  - Paper/Shadow Mode: Simuliert Trades ohne echte Ausführung
  - Live Mode: Zeigt Polymarket-Link für manuelle Ausführung

- **Verbesserte Richtungserkennung:**
  - KI-ähnliche Heuristik für YES/NO Bestimmung
  - Erkennt Action-Keywords (entlassen, gestorben, gewonnen, etc.)
  - Analysiert Frage-Typ (will_happen, will_stay, will_end, will_win)
  - Korrekte Zuordnung: "Kompany entlassen" + "Wird Kompany entlassen?" → YES

- **News-Ansicht verbessert:**
  - Zeigt jetzt 25 News (statt 5)
  - Direkter RSS-Fetch falls Cache leer
  - Zeitstempel und Quelle pro News
  - Aktualisieren-Button

### Behoben
- **KRITISCH: Telegram Spam-Bug:** `markAsPushed()` wurde nicht aufgerufen
  - Kandidaten wurden bei jedem 2-Min-Interval erneut gepusht
  - Jetzt: Kandidat wird sofort nach Push als "gepusht" markiert

- **Automatische Menü-Rücksprünge entfernt:**
  - Kein `sleep(2000) → sendMainMenu()` mehr nach Aktionen
  - User klickt explizit "Zurück" wenn gewünscht

### Geändert
- NotificationService: `SafeBetNotification` Interface hinzugefügt
- TimeDelayEngine: `determineDirection()` komplett überarbeitet
- Settings: Auto-Bet Toggle mit Warnung bei Aktivierung

---

## [3.0.2] - 2026-02-02

### Hinzugefügt
- **RSS-Feeds Wiederherstellung:** Fehlende Feeds aus ursprünglicher "ULTRA-MASSIVE" Liste zurückgeholt
  - Vorher: 80 Feeds (40 Working + 40 Experimental)
  - Jetzt: **156 Feeds** (40 Working + 116 Experimental)
  - +15 Deutsche Politik (Regionale ARD-Sender, Bild, Stern, Focus)
  - +16 Wirtschaft (Handelsblatt Finanzen/Unternehmen, CNBC, WSJ, FT, Bundesbank)
  - +30 Sport (Bundesliga-Clubs, Premier League, La Liga, NFL, NBA)
  - +35 Geopolitik (Ukraine-Spezial, Defense, EU, US-Medien)
  - +12 Tech/AI (OpenAI, VentureBeat AI, MIT Tech Review)

- **MEGA-Keywords für Markt-Matching:** ~600+ Keywords für maximale Alpha-Erkennung
  - **Politik:** DE, US 2028, UK, FR, NL, IT, ES, EU, NATO, China, Naher Osten
  - **Wirtschaft:** Zentralbanken, Börsen, DAX, US Tech Giants, Energie, Crypto
  - **Sport:**
    - Bundesliga, Premier League, La Liga, Serie A, Ligue 1 (alle Clubs)
    - 50+ Trainer-Namen (Nagelsmann, Klopp, Guardiola, etc.)
    - FIFA WM 2026 Nationalteams & Qualifikation
    - NFL (alle Teams + Awards), NBA (alle Teams + MVP), NHL (Stanley Cup)
    - Formel 1, Tennis Grand Slams, UFC/Boxing, Golf
  - **Markets:** Breaking News Keywords, Geopolitik-Events, Wahlen

---

## [3.0.1] - 2026-02-02

### Hinzugefügt
- **Module-Toggles in Telegram:** TIME_DELAY und MISPRICING einzeln aktivierbar/deaktivierbar
  - Neue Toggle-Buttons in ⚙️ Settings
  - "Nur Deutschland" Filter schaltbar
  - Push-Notifications nur für TIME_DELAY (MISPRICING nur Digest)

### Geändert
- **Branding:** "Almanien-Vorsprung" → "Alman Heimvorteil" (weniger boomer)
- Telegram Bot, Web-Login, README aktualisiert
- MISPRICING ist jetzt default AUS (fokus auf TIME_DELAY)

### Behoben
- **DB-Init beim Startup:** `initDatabase()` wird jetzt automatisch beim App-Start aufgerufen
- **Robustere Migrations:** Schema-Fehler werden jetzt toleriert statt abzubrechen
- Behebt `SqliteError: no such table` Fehler auf dem Server
- Rate-Limiting für Telegram-Notifications funktioniert jetzt korrekt

---

## [3.0.0] - 2026-02-02 - CASH-MACHINE V2.0

### Hinzugefügt

- **Echte Kelly-Formel für Prediction Markets** (`src/alpha/sizing.ts`)
  - `calculateKellyFraction()` - Mathematisch korrekte Kelly-Berechnung
  - Formel: f* = p - q/b (wobei b = (1/price) - 1)
  - Korrekte Odds-Berechnung für YES und NO Positionen
  - Edge/EV-Validierung vor Sizing

- **Adaptive Scaling System**
  - `calculateScalingFactors()` - Dynamische Position-Sizing-Anpassung
  - Drawdown Scaling: Reduziert ab 10% DD, stoppt bei 30%
  - Streak Scaling: Reduziert nach 2+ konsekutiven Losses
  - Volatility Scaling: Reduziert bei hoher Markt-Volatilität
  - Regime Scaling: Passt an Recent Win Rate an
  - Time Scaling: Optional für Off-Hours (deaktiviert für 24/7 Markets)

- **Execution Quality Monitor** (`src/alpha/executionQuality.ts`)
  - Vollständiges Tracking von Signal → Order → Fill
  - Slippage-Analyse: Expected vs. Actual
  - Latency-Monitoring: Signal-to-Order, Order-to-Fill, Total
  - Fill Rate Tracking
  - Execution Quality Score (0-100)
  - Alerts: High Slippage, Slow Fill, Model Drift
  - Slippage-Analyse nach Dimension: Direction, Volume, Spread, Volatility
  - Automatische Empfehlungen zur Optimierung
  - API: `GET /api/execution/quality`

- **Rolling Performance Dashboard** (Web UI)
  - Neuer View "PERFORMANCE" im Web-Interface
  - Live KPI Cards: PnL, Win Rate, Trades, Sharpe, Max DD, Exec Quality
  - Rolling Equity Curve (Canvas-basiert, keine Dependencies)
  - Engine Performance Tracking (TimeDelay, Mispricing, Meta)
  - Streak Stats: Current Streak, Best Win, Worst Loss
  - Avg Win/Loss, Profit Factor
  - Execution Quality Details im Dashboard
  - System Recommendations Anzeige
  - Auto-Refresh alle 60 Sekunden

- **Erweitertes Backtest UI**
  - Equity Curve Chart (Canvas-basiert)
  - Download-Buttons: JSON, CSV, Markdown
  - Erweiterte Metriken: Profit Factor, Avg Win/Loss, Gross Profit/Loss
  - Calibration Chart (Predicted vs. Actual)
  - Out-of-Sample Checkbox für Walk-Forward Validation
  - CSV Export: `GET /api/backtest/results?format=csv`

### Geändert
- `calculatePositionSize()` unterstützt jetzt optionalen `AdaptiveState` Parameter
- `SizingResult` Interface enthält jetzt optionale `scalingFactors`
- Backtest Results API liefert jetzt `equityCurve` Daten

### Neue Dateien
- `src/alpha/executionQuality.ts` - Execution Quality Monitoring
- `src/alpha/index.ts` - Export ergänzt

---

## [2.7.0] - 2026-02-02

### Hinzugefügt
- **Equity Curve Chart im Dashboard**
  - Canvas-basierter Chart für kumuliertes PnL
  - `/api/stats/equity` Endpoint für Trade-Historie

- **Audit Log API**
  - `/api/audit` für vollständiges Audit-Log
  - Anzeige im Web-Dashboard

---

## [2.6.0] - 2026-02-02

### Hinzugefügt
- **Telegram Slash-Commands für Operations**
  - `/cooldown` - Intraday Risk Status anzeigen
  - `/digest` - Tages-Zusammenfassung
  - `/settings` - Push-Einstellungen
  - `/push [mode]` - Push-Modus ändern
  - `/quiet [on|off]` - Quiet Hours Toggle

---

## [2.5.0] - 2026-02-02

### Hinzugefügt
- **Telegram Push Policy V1 - Anti-Spam System** (`src/notifications/`)
  - Rate Limiter mit Cooldown (15 Min), Daily Cap (8), Quiet Hours (23:00-07:00)
  - Push Gates: match_confidence, price_premove, expected_lag, volume, spread
  - News Candidate Pipeline: RSS → Candidate (DB) → Gate Check → Push
  - `news_candidates` und `notification_state` Tabellen in SQLite
  - Decoupling: `breaking_news` Events → `push_ready` Events

- **Notification Settings pro Chat**
  - Push-Modi: TIME_DELAY_ONLY, ALL_ENGINES, CRITICAL_ONLY
  - Quiet Hours konfigurierbar
  - Min Match Confidence einstellbar

---

## [2.4.0] - 2026-02-02

### Hinzugefügt
- **Intraday Drawdown-Limits** (`src/runtime/state.ts`)
  - Rolling Window Trade-Tracking
  - Intraday High Water Mark
  - Auto-Cooldown nach 3 konsekutiven Losses
  - Rapid Loss Detection (30% in 15 Min)
  - 50% Daily Limit Protection

- **Meta-Combiner Drift Detection** (`src/alpha/driftDetection.ts`)
  - Coefficient Drift Detection
  - Weight Drift Detection (Flip-Erkennung)
  - Performance Drift Detection
  - Auto-Throttle nach 3 kritischen Drifts (30 Min)
  - `DriftDetector` Singleton mit EventEmitter

---

## [2.3.0] - 2026-02-02

### Hinzugefügt
- **Polymarket Price Charts**
  - Lightweight-Charts (TradingView) Integration
  - GET /api/polymarket/prices/:tokenId für historische Preise
  - Echtzeit-Chart im Drilldown-Panel bei Signal-Auswahl
  - Fallback: Synthetische Daten wenn API nicht verfügbar
  - Link zu Polymarket für Details

---

## [2.2.0] - 2026-02-02

### Hinzugefügt
- **Backtest Web-Integration**
  - POST /api/backtest - Backtest starten via Web
  - GET /api/backtest/status - Progress-Tracking
  - GET /api/backtest/results - Ergebnisse in UI/Markdown/JSON
  - WebSocket Progress-Events (backtest_progress, backtest_completed)
  - Full UI mit Engine-Auswahl, Zeitraum, Bankroll, Slippage
  - Live Results-Dashboard mit Top/Worst Trades

- **Pipeline Health Dashboard**
  - View für alle System-Pipelines (RSS, Dawum, Polymarket, Scanner, Ticker, WebSocket)
  - Echtzeit-Status mit Stale-Detection (>10 Min = stale)
  - Error-Count Tracking
  - Pipeline Event Log
  - Auto-Refresh alle 30 Sekunden
  - WebSocket Reconnect-Tracking

---

## [2.1.0] - 2026-02-02

### Hinzugefügt
- **Runtime State Manager** (`src/runtime/state.ts`)
  - Zentrale Verwaltung aller zur Laufzeit änderbaren Zustände
  - Kein Server-Neustart mehr nötig für Mode-Wechsel
  - EventEmitter für Real-Time State-Synchronisation
  - Thread-Safe State-Updates mit Audit-Trail

- **Kill-Switch System**
  - Aktivierbar via Web UI UND Telegram
  - Automatische Aktivierung bei Daily-Loss-Limit (-20%)
  - Source-Tracking (wer hat aktiviert?)
  - WebSocket-Broadcast an alle Clients

- **Execution Mode Runtime-Toggle**
  - Umschalten zwischen `paper`, `shadow`, `live` ohne Restart
  - Mode-Validierung (live nur mit Wallet-Credentials)
  - Mode-Anzeige in Telegram Menu und Web UI

- **Risk Dashboard API**
  - `GET /api/risk/dashboard` - Vollständiges Risk-Dashboard
  - `POST /api/risk/killswitch` - Kill-Switch Toggle
  - `POST /api/execution/mode` - Mode-Wechsel
  - `GET /api/runtime` - Kompletter Runtime-State
  - `POST /api/risk/reset` - Manueller Daily-Reset

- **Bloomberg/Palantir-Style Trading Desk UI**
  - Radikales UI-Redesign: Dark-Terminal-Ästhetik
  - Three-Column Layout: Nav (180px) | Main | Drilldown (320px)
  - Design-Tokens in CSS-Variablen
  - JetBrains Mono / Fira Code Typografie
  - Blinkende Cursor-Animation
  - Views: SIGNALS, CONSOLE, RISK, TICKER, ALMANIEN, MARKETS, BACKTEST, HISTORY

- **Telegram Runtime Controls**
  - 🛑 Kill-Switch Toggle im Hauptmenü
  - 📊 Risk-Dashboard Ansicht
  - ⚙️ Mode-Selector (paper/shadow/live)
  - Dynamische Status-Indikatoren

- **WebSocket Events für State-Changes**
  - `runtime_state_change` - Alle State-Änderungen
  - `kill_switch` - Kill-Switch Events
  - `trade_recorded` - Paper-Trades
  - `risk_update` - Risk-Limit Updates
  - `daily_reset` - 00:00 UTC Resets

### Geändert
- Web UI komplett neu geschrieben (Bloomberg/Palantir-Style)
- Telegram Bot zeigt jetzt Runtime-Status im Menü
- API-Server unterstützt jetzt Runtime-State Events

---

## [Unreleased] - Alpha Engines V2

### Hinzugefügt
- `PLAN.md`: Detaillierter 12-Schritte-Implementierungsplan für Alpha Engines V2
- `tasks/todo.md`: Task-Tracker mit Checkboxen pro Schritt
- `tasks/lessons.md`: Lessons Learned und Workflow-Regeln
- Schritt 2.5: poly_data Integration für historische Trade-Daten

**Phase 1 - Foundation (ERLEDIGT):**
- Feature-Flags: `ALPHA_ENGINE`, `EXECUTION_MODE`, `SQLITE_PATH`, `BACKTEST_MODE`
- SQLite Storage-Layer mit `better-sqlite3`
- Schema mit 8 Tabellen (sources_events, markets_snapshot, signals, decisions, executions, outcomes, historical_trades, historical_markets)
- Repositories für typsicheres CRUD (events, markets, signals, decisions, executions, outcomes, historical)
- Alpha Types (`src/alpha/types.ts`): AlphaSignalV2, TimeDelayFeatures, MispricingFeatures, Decision, Execution, Outcome, etc.
- ML-Regeln dokumentiert (Meta-Combiner mit Online Logistic Regression, Walk-Forward-Backtests)

**Phase 2 - Source Hotfixes (ERLEDIGT):**
- Polymarket Markets-Fix: Filter-Kaskade mit Telemetrie, Spread-Proxy, CLI `npm run markets`
- RSS produktionsfest: 40 kuratierte WORKING_FEEDS, Timeout-Handling, SHA256-Dedupe, Health-Tracking, CLI `npm run rss`
- Dawum korrekt: Objekt-Iteration, Bundestag-Filter, CDU/CSU zusammengeführt, CLI `npm run dawum`
- poly_data Loader: Streaming CSV-Import, Batch-Inserts, Progress-Bar, CLI `npm run import:polydata`

**Phase 3 - Alpha Engines (ERLEDIGT):**
- TIME_DELAY Engine: News→Market Matching (Fuzzy + Levenshtein), Multi-Source Confirmation, Sentiment-Analyse
- MISPRICING Engine: Transparente P_true Schätzung (Polls, Mean-Reversion, Historical Bias), Market-Quality Gates
- Meta-Combiner: Online Logistic Regression, Walk-Forward Learning, Feature-Koeffizienten, Erklärbare Top-Features
- Neue DB-Tabelle: meta_combiner_state für persistente Weights

**Phase 4 - Execution & Risk (ERLEDIGT):**
- Risk-Gates Modul: Daily-Loss, Max-Positions, Per-Market-Cap, Liquidity, Spread, Kill-Switch
- Sizing Modul: Quarter-Kelly mit Caps, Slippage-Modell, Liquidity-Adjustments
- Gestufte Execution: paper (Default), shadow (Quotes+Simulation), live (mit Credential-Check)
- Harte Verweigerung: LiveModeNoCredentialsError wenn Wallet fehlt
- Telemetry Modul: formatSignalForDisplay, formatRiskGates, buildTelegramAlert
- Telegram V2: Neues Alert-Format mit Alpha-Type, Top-Features, Risk-Gates Summary

**Phase 5 - Backtesting (ERLEDIGT):**
- TradeSimulator: VWAP-basierte Fill-Preise, Slippage-Modellierung, Fees
- Metrics: PnL, Win-Rate, Max-Drawdown, Sharpe-Ratio, Edge-Capture
- Calibration: Brier-Score, ECE, Reliability-Buckets, Over-/Underconfidence-Analyse
- Report: Markdown + JSON Output, Console-Formatierung
- CLI: `npm run backtest --engine meta --from 2024-01-01 --to 2024-06-30`
- Walk-Forward für Meta-Combiner (kein Lookahead-Bias)

**Tests & Dokumentation (ERLEDIGT):**
- 102 Unit Tests (dedupe, riskGates, sizing, matching, calibration)
- README.md aktualisiert mit V2 Features
- tasks/todo.md alle Checkboxen erledigt

---

## [2.0.0] - 2026-02-01

### Hinzugefügt
- **EVENT-DRIVEN ALMAN SCANNER**
  - 60-Sekunden-Polling statt 5 Minuten
  - Delta-Detection: Nur NEUE News emittieren Events
  - `breaking_news` Events für sofortige Alerts
  - Automatischer Start bei System-Boot

- **LIVE NEWS TICKER - DAUERFEUER MODUS** (`src/ticker/index.ts`)
  - Echtzeit-News-Matching gegen alle Polymarket-Märkte
  - ASCII-Balken zeigen Match-Stärke: `████████░░ 80% MATCH!`
  - Statistiken: News verarbeitet, Matches gefunden, Latenz
  - WebSocket-Events für Live-Updates

- **ALPHA GENERATOR v2.0** (`src/scanner/alpha.ts`)
  - ALLE 188+ RSS-Quellen werden jetzt für Alpha genutzt (DE + International)
  - Sentiment-Analyse (Bullish/Bearish Keywords)
  - Impact-Score (Breaking News = Extra Boost!)
  - Levenshtein Fuzzy-Matching für Namen
  - Named Entity Extraction
  - Fresh News Boost (< 30 Min = Gold!)
  - Phrase Matching für bessere Relevanz

- **188+ RSS FEEDS** erweitert
  - Deutsche Politik: Tagesschau, Spiegel, Zeit, FAZ, Welt, Focus, Stern, Bild
  - Wirtschaft: Handelsblatt, Bloomberg, CNBC, WSJ, FT, Reuters
  - Sport: Kicker, Sport1, Transfermarkt, ESPN, Sky Sports
  - Geopolitik: Reuters, BBC, Guardian, Al Jazeera, Kyiv Independent
  - Ukraine/Russland: Meduza, Moscow Times, ISW, RFERL
  - Tech/Crypto: Heise, TechCrunch, CoinDesk, The Verge

- **WEB LIVE TICKER TAB**
  - Neuer "LIVE TICKER" Tab im Dashboard
  - Echtzeit-Updates via WebSocket
  - ASCII-Art Match-Balken
  - Stats: News, Matches, Latenz

- **TELEGRAM LIVE TICKER**
  - "📡 LIVE TICKER" Button im Hauptmenü
  - Breaking News Alerts bei relevanten News
  - Statistiken im Telegram-Format

### Geändert
- Scanner nutzt jetzt `newsAlpha` für jeden Markt
- Alpha-Score Berechnung komplett überarbeitet
- Mehr News-Quellen = Mehr Alpha-Potential

---

## [1.8.0] - 2026-02-01

### Behoben
- **Kategorie-Filter für Geopolitik**
  - Ukraine, Russland, Putin, Zelensky, Ceasefire → "politics"
  - NATO, European, Germany → "politics"
  - Märkte werden jetzt korrekt als Politik kategorisiert

### Geändert
- parseCategory() erkennt jetzt alle EU/NATO-Märkte

---

## [1.7.0] - 2026-02-01

### Hinzugefügt
- **Erweitertes Markt-Matching**
  - EU/NATO/Geopolitik-Keywords (Ukraine, Russland, Ceasefire, etc.)
  - Mehr europäische Politik-Keywords (von der Leyen, Brussels, etc.)
  - Energie-Keywords (Gas, LNG, Oil) für wirtschaftsrelevante Märkte
  - Deutsche Automarken (BMW, Mercedes, Porsche, SAP)

### Geändert
- Matching erkennt jetzt auch geopolitische Märkte
- Bessere Logging bei Markt-Matching
- Hinweis wenn keine DE/EU-Märkte gefunden werden

---

## [1.6.0] - 2026-02-01

### Hinzugefügt
- **Trading-Feedback**
  - Trade-Buttons zeigen klare Fehlermeldungen
  - Prüfung: Trading aktiviert? Wallet konfiguriert? Genug Balance?
  - Detaillierte Log-Ausgaben bei Trade-Versuchen

### Geändert
- `/api/trade` prüft jetzt alle Voraussetzungen
- Frontend zeigt Trading-Feedback in der Konsole
- Version auf 1.6.0 aktualisiert

---

## [1.5.0] - 2026-02-01

### Hinzugefügt
- **Telegram Commands**
  - `/scan` - Starte Markt-Scan direkt per Command
  - `/status` - System-Status anzeigen
  - `/wallet` - Echte Wallet-Balance
  - `/polls` - Aktuelle Wahlumfragen
  - `/news` - Deutsche News
  - `/signals` - Aktuelle Alpha-Signale
- Telegram Wallet zeigt echte Polygon-Balance

### Geändert
- Telegram Bot nutzt jetzt tradingClient für echte Balance
- Version auf 1.5.0 aktualisiert

---

## [1.4.0] - 2026-02-01

### Hinzugefügt
- **Wallet-Integration**
  - `/api/wallet` Endpoint zeigt echte USDC/MATIC Balance von Polygon
  - Wallet-Anzeige im Dashboard (Balance + Adresse)
  - Klare "Nicht konfiguriert" Meldung wenn kein Private Key
- Wallet-Status in `/api/config` Response

### Geändert
- Bankroll-Anzeige ersetzt durch echte Wallet-Balance
- Dashboard zeigt Wallet-Adresse (gekürzt)

---

## [1.3.0] - 2026-02-01

### Hinzugefügt
- **Almanien-Modul komplett aktiviert**
  - Dawum-Umfragen zeigen echte Werte (CDU/CSU, AfD, SPD, Grüne, BSW, Linke, FDP)
  - RSS-News-Feed mit deutschen Quellen (Tagesschau, Spiegel, Zeit, FAZ, Handelsblatt)
  - Bundestag-Feed mit Hinweis auf API-Key-Registrierung
- BSW (Bündnis Sahra Wagenknecht) als neue Partei in Umfragen
- Linke-Partei mit korrekter Farbe
- Parteifarben im Matrix-Style mit Glow-Effekten

### Geändert
- Umfragen-Anzeige zeigt Institut und Datum
- "GRÜNE" → "Grüne" (korrekte API-Bezeichnung)
- Mehr Almanien-Humor in Fehlermeldungen

### Behoben
- Bundestag-Feed zeigte endlos "Lade Gesetzgebungsdaten..." - jetzt klare Meldung
- News-Feed zeigte "Keine News verfügbar" ohne Humor - jetzt mit Almanien-Style

---

## [1.2.0] - 2026-02-01

### Hinzugefügt
- **Session-basierte Authentifizierung** statt nerviger Basic Auth
- Neue Login-Seite (`/login`) mit Matrix-Style Design
- Logout-Funktion (`/logout`)
- 24h Session-Cookies (einmal einloggen reicht)

### Geändert
- Nginx Basic Auth entfernt (war nervig bei Navigation)
- Alle API-Calls nutzen jetzt Session-Cookies

### Behoben
- Kein ständiges Auth-Popup mehr beim Navigieren

---

## [1.1.1] - 2026-02-01

### Geändert
- Boot-Animation verlängert auf ~5 Sekunden
- ASCII-Logo mit Glow-Effekt animiert
- Blinkender Cursor während Boot-Sequenz
- Mehr Boot-Messages für authentisches Terminal-Feeling

### Behoben
- HTTP/2 deaktiviert (verursachte SSL-Fehler bei manchen Clients)

---

## [1.1.0] - 2026-02-01

### Hinzugefügt
- Ausführliches README mit ASCII-Art, Badges und Dokumentation
- CHANGELOG-Datei für Versionsverfolgung
- Deutsche Übersetzung der Web-Oberfläche ("Almanien-Modul")
- Krassere Telegram-Bot Sprache mit mehr Charakter

### Geändert
- Polymarket API Client: JSON-Strings (`outcomePrices`, `outcomes`, `clobTokenIds`) werden jetzt korrekt geparst
- Kategorie-Erkennung basiert jetzt auf der Frage statt auf nicht-existierendem `category`-Feld
- Standard `MIN_VOLUME_USD` von 100.000 auf 10.000 reduziert (mehr Märkte)
- Erweiterte Kategorie-Keywords für Politik (Trump, Biden, Merz, Scholz, etc.)
- Status-Dots im Header: Perplexity/Claude durch Almanien/WebSocket ersetzt
- Alle UI-Texte auf Deutsch umgestellt
- ASCII-Logo auf "EDGY ALPHA" geändert
- Telegram-Bot: Krassere Sprache, mehr Almanien-Stil

### Behoben
- Polymarket API gibt jetzt echte Marktdaten zurück (war vorher 0 Märkte)
- Kategorie-Filter filtert nicht mehr alle Märkte raus
- Bankroll-Anzeige zeigt jetzt Konfigurationswert statt hardcoded $1,000

---

## [1.0.1] - 2026-02-01

### Behoben
- SSH-Deployment via GitHub Actions
- SSH-Key Konfiguration auf VPS

---

## [1.0.0] - 2026-02-01

### Hinzugefügt
- Initiales Release
- Polymarket Scanner mit Gamma API Integration
- Almanien-Modul (Dawum, Bundestag DIP, RSS-Feeds)
- Terminal-Style Web-Dashboard (Matrix-Aesthetik)
- Telegram Bot mit Inline-Buttons
- Alpha-Scoring System
- Kelly-Kriterium für Position-Sizing
- GitHub Actions CI/CD Pipeline
- PM2 Prozessmanagement

---

## Versionsschema

- **MAJOR**: Inkompatible API-Änderungen
- **MINOR**: Neue Features, abwärtskompatibel
- **PATCH**: Bugfixes, abwärtskompatibel
