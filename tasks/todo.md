# Alpha Engines V2 - Task Tracker

> Detaillierter Plan: siehe `../PLAN.md`

## Status: ✅ PHASE 5 ABGESCHLOSSEN

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

## Review Notes

### Phase 1 (2026-02-02)
- Feature-Flags funktionieren
- SQLite Storage läuft
- Types sind sauber getrennt

### Phase 2 (2026-02-02)
- Polymarket Filter-Kaskade mit Telemetrie
- RSS 40 stabile Feeds, Health-Tracking
- Dawum CDU/CSU korrekt zusammengeführt
- poly_data Loader mit Streaming

### Phase 3 (2026-02-02)
- TIME_DELAY: Fuzzy-Matching + Multi-Source Confirmation
- MISPRICING: Transparente P_true (keine Blackbox)
- Meta-Combiner: Online Logistic Regression

### Phase 4 (2026-02-02)
- Risk-Gates: 6 Checks, Kill-Switch
- Sizing: Quarter-Kelly mit Caps
- Execution: paper/shadow/live strikt getrennt

### Phase 5 (2026-02-02)
- Backtest: VWAP-Fills, Brier-Score, Reliability-Buckets
- Walk-Forward: kein Lookahead-Bias

---

## Task #46: Breaking News Auto-Execute

### Ziel
Automatische Trade-Ausführung bei `breaking_confirmed` Signals mit hohem Edge.
Speed ist essentiell für Zeitvorsprung!

### Implementierung
- [x] Config erweitern (AUTO_TRADE_*)
- [x] AutoTrader Service erstellen
- [x] TimeDelayEngine Integration
- [x] Telegram Notifications
- [x] Runtime-Settings erweitern

### Status: ABGESCHLOSSEN (2026-02-02)

---

## Task #47: PRODUCTION READY - CLOB Order Execution

> Ohne diese Tasks → Kein Live-Trading möglich

### Phase 1.1: CLOB Order Execution Validierung

**Problem:** `placeOrder()` und `placeMarketOrder()` sind implementiert, aber NICHT end-to-end getestet.

- [x] Order-Status-Polling implementieren (`getOrderStatus()`)
- [x] Partial Fill Handling
- [x] Order Cancellation bei Timeout (30s default)
- [x] Error-Type-Unterscheidung (insufficient_balance, market_closed, price_moved)
- [x] Retry-Logik bei transienten Fehlern (3 Versuche, exponential backoff)
- [x] Test-Script für Mini-Trade erstellen (`npm run test:clob`)
- [x] Dry-Run Test erfolgreich (CLOB Client, Balance, Orderbook)
- [x] ethers v6 → v5 Kompatibilitäts-Wrapper (`_signTypedData`)
- [ ] End-to-End Live-Test mit 0.01 USDC (benötigt gefundetes Wallet)

### Phase 1.2: Position Tracking & Sync
- [ ] `getOpenOrders()` Integration
- [ ] Position Sync bei Startup
- [ ] Mismatch Detection

### Phase 1.3: Kill-Switch Hardening
- [ ] ENV-basierter Force-Paper-Mode
- [ ] Kill-Switch bei 3+ fehlgeschlagenen Trades

### Status: IN ARBEIT
