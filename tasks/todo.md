# Alpha Engines V2 - Task Tracker

> Detaillierter Plan: siehe `../PLAN.md`

## Status: ✅ PHASE 5 + STABILITY + PERFEKTIONIERUNG COMPLETE

---

## Perfektionierung Web & Telegram Bot (2026-02-02)

### Phase 1: Kritische Fixes (Stabilitat)

#### 1.1 Telegram Bot - Trade-Execution Bug
- [x] **Problem:** `handleConfirm()` emittet nur Event, fuhrt Trade nicht aus
- [x] **Fix:** Direkte Trade-Execution wie bei Quick-Buy implementieren
- [x] **Datei:** `src/telegram/index.ts` Zeilen 2251-2287

#### 1.2 Telegram Bot - User-Authentifizierung
- [x] **Problem:** Bot antwortet auf ALLE Chat-IDs
- [x] **Fix:** Auth-Check auf konfigurierte chatId
- [x] **Datei:** `src/telegram/index.ts` - setupCommands()

#### 1.3 Web - XSS-Schutz
- [x] **Problem:** innerHTML mit unsanitierten Market-Fragen
- [x] **Fix:** textContent statt innerHTML verwenden
- [x] **Datei:** `src/web/public/index.html`

#### 1.4 Stabilitat - Process Lock bei uncaughtException
- [x] **Problem:** Lock wird nicht freigegeben bei uncaughtException
- [x] **Fix:** releaseLock() in allen exit-Pfaden
- [x] **Datei:** `src/index.ts` Zeilen 155-159

#### 1.5 Stabilitat - Graceful Shutdown Timeout
- [x] **Problem:** Shutdown kann hangen ohne Timeout
- [x] **Fix:** Max 10s Timeout, dann forceful exit
- [x] **Datei:** `src/index.ts` - setupGracefulShutdown()

#### 1.6 Scanner - isScanning Flag
- [x] **Problem:** Flag nicht in finally-Block zuruckgesetzt
- [x] **Fix:** finally-Block hinzufugen
- [x] **Datei:** `src/scanner/index.ts`

### Phase 2: Stabilitat & UX

#### 2.1 WebSocket Reconnect-Logik
- [x] **Problem:** Keine Reconnect-Strategie bei Disconnect
- [x] **Fix:** Exponential Backoff Reconnection
- [x] **Datei:** `src/web/public/index.html`

#### 2.2 Telegram - pendingTrades Cleanup
- [x] **Problem:** Memory Leak - alte Trades werden nicht entfernt
- [x] **Fix:** TTL-basiertes Cleanup (1h)
- [x] **Datei:** `src/telegram/index.ts`

#### 2.3 Telegram - editingField Reset
- [x] **Problem:** editingField nicht zuruckgesetzt bei Fehler
- [x] **Fix:** Reset bei ungultigem Wert
- [x] **Datei:** `src/telegram/index.ts` - handleTextInput()

#### 2.4 Telegram - MarketURL Fix
- [x] **Problem:** MarketURL nutzt signalId statt marketId
- [x] **Fix:** Korrekten marketId verwenden
- [x] **Datei:** `src/telegram/index.ts` - handleSafeBetConfirm()

#### 2.5 Watchdog Tuning
- [x] **Problem:** maxFailures 3x30s = 90s zu lang
- [x] **Fix:** Auf 2 Versuche reduzieren (60s)
- [x] **Datei:** `src/runtime/watchdog.ts`

#### 2.6 Config - Web-Auth Default
- [x] **Problem:** WEB_AUTH_ENABLED default false (Dashboard offen!)
- [x] **Fix:** Warnung wenn Auth deaktiviert
- [x] **Datei:** `src/utils/config.ts` und `src/web/server.ts`

#### 2.7 Web - Chart Memory Leak
- [x] **Problem:** Chart bei jedem Signal-Wechsel neu erstellt
- [x] **Fix:** Chart-Instanz cachen, clear() statt remove()
- [x] **Datei:** `src/web/public/index.html`

#### 2.8 Web - Equity Curve Timestamp
- [x] **Problem:** Timestamp nutzt Date.now() statt echtem Timestamp
- [x] **Fix:** createdAt aus Audit-Log verwenden
- [x] **Datei:** `src/web/server.ts`

### Phase 3: Dokumentation & Deploy

- [x] CHANGELOG.md aktualisieren (Version 3.5.0)
- [x] README.md aktualisieren
- [x] Build verifizieren (`npm run build`, `npm run lint`)
- [x] Alle Anderungen committen und pushen

---

## Stabilitaetsmechanismen ✅ (2026-02-02)

### Watchdog Service ✅
- [x] `src/runtime/watchdog.ts` erstellt
- [x] 5 Checks: scanner, ticker, database, memory, eventLoop
- [x] Automatische Selbstheilung bei Fehlern
- [x] API Endpoints: `/api/watchdog`, `/api/watchdog/check`

### Process Lock ✅
- [x] `src/utils/processLock.ts` erstellt
- [x] Verhindert mehrere Server-Instanzen
- [x] Stale Lock Detection (alte Prozesse)
- [x] Lock-Datei: `data/.scanner.lock`

### Erweiterter Health Check ✅
- [x] `/health` und `/api/health` beide aktiv
- [x] Detaillierte Checks: server, scanner, websocket, database
- [x] HTTP 503 bei degraded Status
- [x] Scanner-Stats und Connection-Count

---

## Phase 1: Foundation ✅

### Schritt 1: Feature-Flags & Config ✅
- [x] `ALPHA_ENGINE` env-var hinzufügen (timeDelay|mispricing|meta)
- [x] `EXECUTION_MODE` env-var hinzufügen (paper|shadow|live)
- [x] `SQLITE_PATH` env-var hinzufügen
- [x] Zod-Schema erweitern
- [x] Type-Check grün

### Schritt 2: SQLite Storage-Layer ✅
- [x] `better-sqlite3` installieren
- [x] `src/storage/db.ts` - Singleton, Init, Migrations
- [x] `src/storage/schema.sql` - Alle Tabellen
- [x] `src/storage/repositories/events.ts`
- [x] `src/storage/repositories/markets.ts`
- [x] `src/storage/repositories/signals.ts`
- [x] `src/storage/repositories/decisions.ts`
- [x] `src/storage/repositories/executions.ts`
- [x] `src/storage/repositories/outcomes.ts`
- [x] Idempotenz-Test (Duplicate Insert)

### Schritt 2.5: poly_data Integration ✅
- [x] `src/data/polydata/loader.ts` - CSV Parser
- [x] `src/data/polydata/markets.ts` - markets.csv
- [x] `src/data/polydata/trades.ts` - trades.csv
- [x] `scripts/import-polydata.ts` - CLI
- [x] Schema: `historical_trades` Tabelle
- [x] Schema: `historical_markets` Tabelle
- [x] Inkrementeller Import (--since)
- [x] Stats-Output

### Schritt 3: Alpha Types ✅
- [x] `src/alpha/types.ts` erstellen
- [x] `AlphaSignalV2` Interface
- [x] `TimeDelayFeatures` Interface
- [x] `MispricingFeatures` Interface
- [x] `Decision` Interface
- [x] `Execution` Interface
- [x] `Outcome` Interface
- [x] `MarketQuality` Interface

---

## Phase 2: Source Hotfixes ✅

### Schritt 4: Polymarket Markets-Fix ✅
- [x] Volume-Felder verifizieren
- [x] Paginated Fetch (max 2000)
- [x] Filter-Kaskade mit Telemetrie
- [x] CLI: `npm run markets`

### Schritt 5: RSS Produktionsfest ✅
- [x] `src/germany/rss.ts` extrahieren
- [x] WORKING_RSS_FEEDS (~40 stabile)
- [x] Per-Feed Timeout (8s)
- [x] Promise.allSettled
- [x] Dedupe via Hash
- [x] CLI: `npm run rss --health`

### Schritt 6: Dawum Korrekt ✅
- [x] `src/germany/dawum.ts` extrahieren
- [x] Objekt-Iteration (nicht Arrays)
- [x] Bundestag-Filter
- [x] CDU/CSU zusammenführen
- [x] CLI: `npm run dawum`

---

## Phase 3: Alpha Engines ✅

### Schritt 7: TIME_DELAY Engine ✅
- [x] `src/alpha/timeDelayEngine.ts`
- [x] `src/alpha/matching.ts`
- [x] Dedupe via sources_events
- [x] 2-Stage Matching (Fuzzy + Levenshtein)
- [x] Reaction-Speed Features
- [x] Multi-Source Confirmation

### Schritt 8: MISPRICING Engine ✅
- [x] `src/alpha/mispricingEngine.ts`
- [x] P_true Schätzung mit Unsicherheit
- [x] Edge-Berechnung
- [x] Market-Structure Features
- [x] Historische Kalibrierung nutzen

### Schritt 9: Meta-Combiner ✅
- [x] `src/alpha/metaCombiner.ts`
- [x] Online Logistic Regression
- [x] Walk-Forward Weights
- [x] Source-Attribution
- [x] Top-Features erklärbar

---

## Phase 4: Execution & Risk ✅

### Schritt 10: Gestufte Execution ✅
- [x] paper Mode (Default)
- [x] shadow Mode (Quotes, no Trade)
- [x] live Mode (mit Credential-Check)
- [x] Risk-Gates implementieren
- [x] Quarter-Kelly Sizing
- [x] Slippage-Modell

### Schritt 11: Observability ✅
- [x] Rationale in jeder Decision
- [x] Risk-Checks in jeder Decision
- [x] Telegram-Alert Format erweitern
- [x] Telemetry-Modul

---

## Phase 5: Backtesting ✅

### Schritt 12: Backtest-Framework ✅
- [x] `src/backtest/index.ts` CLI
- [x] `src/backtest/simulator.ts`
- [x] `src/backtest/metrics.ts`
- [x] `src/backtest/calibration.ts`
- [x] `src/backtest/report.ts`
- [x] Walk-Forward Validation
- [x] Markdown-Report
- [x] CLI: `npm run backtest`

---

## Verification Checklist ✅

- [x] `npm run type-check` grün
- [x] Bestehende Funktionalität unverändert
- [x] Feature-Flags respektiert
- [x] Keine Secrets in Logs
- [x] Default = paper Mode

---

## 🚀 PRODUCTION READY ZUSAMMENFASSUNG

### ✅ Alle kritischen Komponenten implementiert:

1. **CLOB Order Execution**
   - Order-Lifecycle-Management (pending → filled → cancelled)
   - Retry-Logik mit exponential backoff
   - ethers v6→v5 Kompatibilität

2. **Kill-Switch Hardening**
   - `FORCE_PAPER_MODE` ENV (Hardware Kill-Switch)
   - Auto-Kill nach 3 fehlgeschlagenen Trades
   - Manueller Kill via Telegram

3. **Risk Management**
   - 6 Risk Gates + Extended Orderbook Checks
   - Slippage-Schätzung vor Trade
   - Quarter-Kelly Sizing mit Caps

4. **Observability**
   - `/health` Telegram Command
   - RiskDashboard mit `consecutiveFailures`
   - Vollständiges Audit-Log

5. **Alpha Engines**
   - TIME_DELAY mit Fuzzy-Matching
   - MISPRICING mit Bayesian P_true
   - Meta-Combiner mit Online Learning

6. **Perfektionierung (V3.5.0)**
   - Telegram Trade-Execution Fix
   - User-Authentifizierung
   - XSS-Schutz
   - Graceful Shutdown mit Timeout
   - WebSocket Reconnect
   - Memory Leak Fixes
   - Watchdog Tuning

### ⚠️ Ausstehend für Go-Live:
- [ ] VPN-Zugang für Deutschland
- [ ] Wallet mit USDC funden
- [ ] End-to-End Live-Test mit Minimal-Trade
