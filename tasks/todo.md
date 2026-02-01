# Alpha Engines V2 - Task Tracker

> Detaillierter Plan: siehe `../PLAN.md`

## Status: PHASE 1 - FOUNDATION

---

## Phase 1: Foundation

### Schritt 1: Feature-Flags & Config
- [ ] `ALPHA_ENGINE` env-var hinzufügen (timeDelay|mispricing|meta)
- [ ] `EXECUTION_MODE` env-var hinzufügen (paper|shadow|live)
- [ ] `SQLITE_PATH` env-var hinzufügen
- [ ] Zod-Schema erweitern
- [ ] Type-Check grün

### Schritt 2: SQLite Storage-Layer
- [ ] `better-sqlite3` installieren
- [ ] `src/storage/db.ts` - Singleton, Init, Migrations
- [ ] `src/storage/schema.sql` - Alle Tabellen
- [ ] `src/storage/repositories/events.ts`
- [ ] `src/storage/repositories/markets.ts`
- [ ] `src/storage/repositories/signals.ts`
- [ ] `src/storage/repositories/decisions.ts`
- [ ] `src/storage/repositories/executions.ts`
- [ ] `src/storage/repositories/outcomes.ts`
- [ ] Idempotenz-Test (Duplicate Insert)

### Schritt 2.5: poly_data Integration
- [ ] `src/data/polydata/loader.ts` - CSV Parser
- [ ] `src/data/polydata/markets.ts` - markets.csv
- [ ] `src/data/polydata/trades.ts` - trades.csv
- [ ] `scripts/import-polydata.ts` - CLI
- [ ] Schema: `historical_trades` Tabelle
- [ ] Schema: `historical_markets` Tabelle
- [ ] Inkrementeller Import (--since)
- [ ] Stats-Output

### Schritt 3: Alpha Types
- [ ] `src/alpha/types.ts` erstellen
- [ ] `AlphaSignalV2` Interface
- [ ] `TimeDelayFeatures` Interface
- [ ] `MispricingFeatures` Interface
- [ ] `Decision` Interface
- [ ] `Execution` Interface
- [ ] `Outcome` Interface
- [ ] `MarketQuality` Interface

---

## Phase 2: Source Hotfixes

### Schritt 4: Polymarket Markets-Fix
- [ ] Volume-Felder verifizieren
- [ ] Paginated Fetch (max 2000)
- [ ] Filter-Kaskade mit Telemetrie
- [ ] CLI: `npm run markets`

### Schritt 5: RSS Produktionsfest
- [ ] `src/germany/rss.ts` extrahieren
- [ ] WORKING_RSS_FEEDS (~30 stabile)
- [ ] Per-Feed Timeout (8s)
- [ ] Promise.allSettled
- [ ] Dedupe via Hash
- [ ] CLI: `npm run rss --health`

### Schritt 6: Dawum Korrekt
- [ ] `src/germany/dawum.ts` extrahieren
- [ ] Objekt-Iteration (nicht Arrays)
- [ ] Bundestag-Filter
- [ ] CDU/CSU zusammenführen
- [ ] CLI: `npm run dawum`

---

## Phase 3: Alpha Engines

### Schritt 7: TIME_DELAY Engine
- [ ] `src/alpha/timeDelayEngine.ts`
- [ ] `src/alpha/matching.ts`
- [ ] Dedupe via sources_events
- [ ] 2-Stage Matching
- [ ] Reaction-Speed Features
- [ ] Multi-Source Confirmation

### Schritt 8: MISPRICING Engine
- [ ] `src/alpha/mispricingEngine.ts`
- [ ] P_true Schätzung mit Unsicherheit
- [ ] Edge-Berechnung
- [ ] Market-Structure Features
- [ ] Historische Kalibrierung nutzen

### Schritt 9: Meta-Combiner
- [ ] `src/alpha/metaCombiner.ts`
- [ ] Gewichtetes Averaging
- [ ] Walk-Forward Weights
- [ ] Source-Attribution

---

## Phase 4: Execution & Risk

### Schritt 10: Gestufte Execution
- [ ] paper Mode (Default)
- [ ] shadow Mode (Quotes, no Trade)
- [ ] live Mode (mit Credential-Check)
- [ ] Risk-Gates implementieren
- [ ] Quarter-Kelly Sizing
- [ ] Slippage-Modell

### Schritt 11: Observability
- [ ] Rationale in jeder Decision
- [ ] Risk-Checks in jeder Decision
- [ ] Telegram-Alert Format erweitern

---

## Phase 5: Backtesting

### Schritt 12: Backtest-Framework
- [ ] `src/backtest/index.ts` CLI
- [ ] `src/backtest/simulator.ts`
- [ ] `src/backtest/slippage.ts` (aus poly_data)
- [ ] `src/backtest/metrics.ts`
- [ ] `src/backtest/calibration.ts`
- [ ] `src/backtest/report.ts`
- [ ] Walk-Forward Validation
- [ ] Markdown-Report

---

## Verification Checklist (vor "Done")

- [ ] `npm run type-check` grün
- [ ] `npm run lint` grün
- [ ] `npm run dev` startet ohne Fehler
- [ ] Bestehende Funktionalität unverändert
- [ ] Feature-Flags respektiert
- [ ] Keine Secrets in Logs

---

## Review Notes

_Wird nach Abschluss jeder Phase ausgefüllt_
