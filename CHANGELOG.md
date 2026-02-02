# Changelog

Alle wichtigen Änderungen an diesem Projekt werden hier dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

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

### Geplant (noch nicht implementiert)
- SQLite Storage-Layer mit `better-sqlite3`
- Feature-Flags: `ALPHA_ENGINE` (timeDelay|mispricing|meta), `EXECUTION_MODE` (paper|shadow|live)
- TIME_DELAY Alpha-Engine (Informations-Timing)
- MISPRICING Alpha-Engine (Value-/Struktur-Alpha)
- Meta-Combiner (Walk-Forward Weights)
- Backtesting-Framework mit echten Daten aus poly_data
- Gestufte Execution (paper/shadow/live)
- Risk-Gates und Quarter-Kelly Sizing
- Slippage-Modell aus echten Trades kalibriert

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
