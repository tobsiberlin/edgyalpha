# ALPHA ENGINES V2 - IMPLEMENTATION PLAN

> **Kernprinzip:** Mehr Signale ≠ mehr Profit. Wir optimieren für weniger, bessere, kalibrierte Signale mit harten Risk-Gates.

## STATUS: IN PROGRESS

---

## PHASE 1: FOUNDATION (Schritte 1-3)

### Schritt 1: Feature-Flags & Config-Erweiterung
**Dateien:** `src/utils/config.ts`, `src/types/index.ts`

**Änderungen:**
- `ALPHA_ENGINE`: `timeDelay` | `mispricing` | `meta` (Default: `meta`)
- `EXECUTION_MODE`: `paper` | `shadow` | `live` (Default: `paper`)
- `SQLITE_PATH`: Default `./data/edgyalpha.db`
- `BACKTEST_MODE`: boolean (Default: false)

**Acceptance-Criteria:**
- [ ] `config.alphaEngine` typsicher verfügbar
- [ ] `config.executionMode` typsicher verfügbar
- [ ] Default-Werte greifen ohne ENV-Variablen
- [ ] Type-Check `npm run type-check` grün

---

### Schritt 2: SQLite Storage-Layer
**Neue Dateien:**
- `src/storage/db.ts` - Singleton, Initialisierung, Migrations
- `src/storage/schema.sql` - DDL für alle Tabellen
- `src/storage/repositories/events.ts` - sources_events CRUD
- `src/storage/repositories/markets.ts` - markets_snapshot CRUD
- `src/storage/repositories/signals.ts` - signals CRUD
- `src/storage/repositories/decisions.ts` - decisions CRUD
- `src/storage/repositories/executions.ts` - executions CRUD
- `src/storage/repositories/outcomes.ts` - outcomes CRUD

**Lib-Wahl:** `better-sqlite3` (synchron, schneller, einfachere API, deterministic)

**Schema (Tabellen):**
```sql
-- Event-Dedupe, Source-Reliability
sources_events (
  id INTEGER PRIMARY KEY,
  event_hash TEXT UNIQUE NOT NULL,  -- SHA256(source+url+title)
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT,
  keywords TEXT,  -- JSON array
  published_at TEXT,
  ingested_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reliability_score REAL DEFAULT 0.5
)

-- Markt-Snapshots (Preis/Volumen/Spread)
markets_snapshot (
  id INTEGER PRIMARY KEY,
  market_id TEXT NOT NULL,
  condition_id TEXT,
  question TEXT NOT NULL,
  category TEXT,
  outcomes TEXT NOT NULL,  -- JSON
  prices TEXT NOT NULL,  -- JSON [yes_price, no_price]
  volume_24h REAL,
  volume_total REAL,
  spread_proxy REAL,  -- |yes_price + no_price - 1|
  liquidity_score REAL,
  end_date TEXT,
  snapshot_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(market_id, snapshot_at)
)

-- Signale (beide Engines)
signals (
  id INTEGER PRIMARY KEY,
  signal_id TEXT UNIQUE NOT NULL,  -- UUID
  alpha_type TEXT NOT NULL,  -- 'timeDelay' | 'mispricing'
  market_id TEXT NOT NULL,
  features TEXT NOT NULL,  -- JSON mit Feature-Details
  predicted_edge REAL NOT NULL,
  confidence REAL NOT NULL,
  direction TEXT NOT NULL,  -- 'yes' | 'no'
  model_version TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(market_id, alpha_type, model_version, created_at)
)

-- Entscheidungen
decisions (
  id INTEGER PRIMARY KEY,
  decision_id TEXT UNIQUE NOT NULL,
  signal_id TEXT NOT NULL REFERENCES signals(signal_id),
  action TEXT NOT NULL,  -- 'show' | 'watch' | 'trade' | 'high_conviction' | 'reject'
  size_usdc REAL,
  risk_checks TEXT NOT NULL,  -- JSON
  rationale TEXT NOT NULL,  -- JSON
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)

-- Ausführungen
executions (
  id INTEGER PRIMARY KEY,
  execution_id TEXT UNIQUE NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
  mode TEXT NOT NULL,  -- 'paper' | 'shadow' | 'live'
  status TEXT NOT NULL,  -- 'pending' | 'filled' | 'cancelled' | 'failed'
  fill_price REAL,
  fill_size REAL,
  slippage REAL,
  fees REAL,
  tx_hash TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  filled_at TEXT
)

-- Outcomes (für Kalibrierung)
outcomes (
  id INTEGER PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  market_id TEXT NOT NULL,
  resolution TEXT,  -- 'yes' | 'no' | 'invalid' | NULL
  exit_price REAL,
  pnl_usdc REAL,
  predicted_prob REAL,
  actual_outcome INTEGER,  -- 1 = correct, 0 = wrong
  resolved_at TEXT
)
```

**Acceptance-Criteria:**
- [ ] `npm install better-sqlite3` erfolgreich
- [ ] DB-File wird bei App-Start automatisch erstellt
- [ ] Migrations laufen idempotent (wiederholbar)
- [ ] Alle Repositories exportieren typsichere CRUD-Funktionen
- [ ] Unique-Constraints verhindern Duplikate
- [ ] Test: Insert → Duplicate Insert → kein Fehler, kein Duplikat

---

### Schritt 2.5: poly_data Integration (Historische Daten)
**Quelle:** https://github.com/warproxxx/poly_data
**Neue Dateien:**
- `src/data/polydata/loader.ts` - CSV → SQLite Import
- `src/data/polydata/markets.ts` - markets.csv Parser
- `src/data/polydata/trades.ts` - trades.csv Parser
- `scripts/import-polydata.ts` - CLI für Import

**Warum:**
- **Echte historische Trade-Daten** für realistisches Backtesting
- **Market-Resolutions** für Kalibrierung (Ground Truth)
- **Slippage-Modelle** aus echten Fills kalibrieren
- Spart >2 Tage Datensammlung (Snapshot verfügbar)

**Schema-Erweiterung:**
```sql
-- Historische Trades (aus poly_data/trades.csv)
historical_trades (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  market_id TEXT NOT NULL,
  price REAL NOT NULL,
  usd_amount REAL NOT NULL,
  token_amount REAL,
  maker TEXT,
  taker TEXT,
  maker_direction TEXT,  -- 'buy' | 'sell'
  taker_direction TEXT,
  tx_hash TEXT UNIQUE,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP
)
CREATE INDEX idx_hist_trades_market ON historical_trades(market_id);
CREATE INDEX idx_hist_trades_ts ON historical_trades(timestamp);

-- Markt-Metadaten & Resolutions (aus poly_data/markets.csv)
historical_markets (
  market_id TEXT PRIMARY KEY,
  condition_id TEXT,
  question TEXT NOT NULL,
  answer1 TEXT,
  answer2 TEXT,
  token1 TEXT,
  token2 TEXT,
  market_slug TEXT,
  volume_total REAL,
  created_at TEXT,
  closed_at TEXT,
  outcome TEXT,  -- 'answer1' | 'answer2' | NULL (unresolved)
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP
)
```

**Import-Workflow:**
```bash
# 1. Snapshot herunterladen (einmalig)
cd data/polydata
wget https://[snapshot-url]/poly_data_snapshot.tar.gz
tar -xzf poly_data_snapshot.tar.gz

# 2. Import in SQLite
npm run import:polydata -- --markets --trades

# 3. Verify
npm run import:polydata -- --stats
```

**CLI:**
```bash
npm run import:polydata -- --markets          # Nur markets.csv
npm run import:polydata -- --trades           # Nur trades.csv
npm run import:polydata -- --all              # Beides
npm run import:polydata -- --stats            # Zeigt Import-Statistiken
npm run import:polydata -- --since 2024-01-01 # Inkrementeller Import
```

**Nutzung im Backtesting:**
```typescript
// Echte Fills für Slippage-Berechnung
const trades = await historicalTradesRepo.getByMarket(marketId, {
  from: signalTime,
  to: signalTime + 60_000, // 1 Minute nach Signal
});
const avgFillPrice = trades.reduce((s, t) => s + t.price * t.usd_amount, 0)
                   / trades.reduce((s, t) => s + t.usd_amount, 0);
const slippage = avgFillPrice - expectedPrice;

// Ground Truth für Kalibrierung
const resolution = await historicalMarketsRepo.getResolution(marketId);
const correct = (prediction === 'yes' && resolution === 'answer1')
             || (prediction === 'no' && resolution === 'answer2');
```

**Acceptance-Criteria:**
- [ ] `markets.csv` vollständig importiert (alle Felder)
- [ ] `trades.csv` vollständig importiert (Dedupe via tx_hash)
- [ ] Inkrementeller Import funktioniert (--since Flag)
- [ ] Stats-Output zeigt: Märkte, Trades, Zeitraum, Resolutions
- [ ] Backtest kann historische Trades für Slippage nutzen
- [ ] Kalibrierung kann Resolutions als Ground Truth nutzen

---

### Schritt 3: Types für Alpha-Engines
**Datei:** `src/alpha/types.ts`

**Neue Interfaces:**
```typescript
// Feature-Registry für Versionierung
interface FeatureSet {
  version: string;  // "1.0.0"
  features: Record<string, number | string | boolean>;
}

// Basis-Signal (beide Engines)
interface AlphaSignalV2 {
  signalId: string;
  alphaType: 'timeDelay' | 'mispricing';
  marketId: string;
  question: string;
  direction: 'yes' | 'no';
  predictedEdge: number;
  confidence: number;
  features: FeatureSet;
  reasoning: string[];
  createdAt: Date;
}

// TIME_DELAY spezifisch
interface TimeDelayFeatures extends FeatureSet {
  features: {
    sourceCount: number;
    avgSourceReliability: number;
    newsAgeMinutes: number;
    sentimentScore: number;
    impactScore: number;
    marketPriceAtNews: number;
    priceMoveSinceNews: number;
    volumeAtNews: number;
    volumeChangeSinceNews: number;
    matchConfidence: number;
  };
}

// MISPRICING spezifisch
interface MispricingFeatures extends FeatureSet {
  features: {
    impliedProb: number;
    estimatedProb: number;
    probUncertainty: number;  // Std-Dev der Schätzung
    pollDelta: number | null;  // Differenz zu Umfragen
    historicalBias: number;  // Markt-Fehlkalibrierung
    liquidityScore: number;
    spreadProxy: number;
    volatility30d: number;
    daysToExpiry: number;
  };
}

// Decision mit Risk-Checks
interface Decision {
  decisionId: string;
  signalId: string;
  action: 'show' | 'watch' | 'trade' | 'high_conviction' | 'reject';
  sizeUsdc: number | null;
  riskChecks: {
    dailyLossOk: boolean;
    maxPositionsOk: boolean;
    perMarketCapOk: boolean;
    liquidityOk: boolean;
    spreadOk: boolean;
    killSwitchOk: boolean;
  };
  rationale: {
    alphaType: string;
    edge: number;
    confidence: number;
    features: string[];  // Top-3 Treiber
    rejectionReasons?: string[];
  };
  createdAt: Date;
}

// Execution
interface Execution {
  executionId: string;
  decisionId: string;
  mode: 'paper' | 'shadow' | 'live';
  status: 'pending' | 'filled' | 'cancelled' | 'failed';
  fillPrice: number | null;
  fillSize: number | null;
  slippage: number | null;
  fees: number | null;
  txHash: string | null;
  createdAt: Date;
  filledAt: Date | null;
}

// Outcome für Kalibrierung
interface Outcome {
  executionId: string;
  marketId: string;
  resolution: 'yes' | 'no' | 'invalid' | null;
  exitPrice: number | null;
  pnlUsdc: number | null;
  predictedProb: number;
  actualOutcome: 0 | 1 | null;
  resolvedAt: Date | null;
}

// Market-Quality für Risk-Gates
interface MarketQuality {
  marketId: string;
  liquidityScore: number;  // 0-1
  spreadProxy: number;  // |yes + no - 1|
  volume24h: number;
  volatility: number;
  tradeable: boolean;
  reasons: string[];
}
```

**Acceptance-Criteria:**
- [ ] Alle Interfaces exportiert
- [ ] Keine Abhängigkeit zu bestehenden Types (isoliert)
- [ ] Feature-Versionierung in jedem Signal
- [ ] Type-Check grün

---

## PHASE 2: SOURCE HOTFIXES (Schritte 4-6)

### Schritt 4: Polymarket Markets-Fetch Fix
**Datei:** `src/api/polymarket.ts`

**Änderungen:**
1. Korrigiere Feld-Namen (totalVolume vs volume24h prüfen)
2. Paginated Fetch mit Cap (max 2000 Märkte)
3. Filter-Kaskade mit Telemetrie:
   - Stage 1: active/open
   - Stage 2: Volume > MIN_VOLUME
   - Stage 3: Market-Quality (Spread, Liquidity)
4. Logging: Märkte pro Filterstufe

**Neue CLI:**
```bash
npm run markets -- --minVolume 10000 --limit 50
```
Gibt aus: Question, Category, Volume, Prices, Spread

**Acceptance-Criteria:**
- [ ] CLI zeigt echte Märkte mit korrekten Feldern
- [ ] Filter-Kaskade loggt Counts pro Stufe
- [ ] Keine Rate-Limit-Fehler bei 2000 Märkten
- [ ] Spread-Proxy wird berechnet

---

### Schritt 5: RSS Produktionsfest
**Datei:** `src/germany/index.ts` (refactor), `src/germany/rss.ts` (neu)

**Änderungen:**
1. Extrahiere RSS-Logik in eigene Datei
2. `WORKING_RSS_FEEDS`: kuratierte, stabile Feeds (~30)
3. `EXPERIMENTAL_RSS_FEEDS`: optionale Feeds (Rest)
4. Per-Feed Timeout (8s)
5. `Promise.allSettled` statt `Promise.all`
6. Normalize + Dedupe via SHA256-Hash
7. Health-Output: Items/Feed, Failures

**Neue CLI:**
```bash
npm run rss -- --health
```
Gibt aus: Feed-Name, Items, Last-Fetch, Status (OK/FAIL)

**Acceptance-Criteria:**
- [ ] Keine Crashes bei Feed-Timeouts
- [ ] Dedupe via Hash funktioniert
- [ ] Health-Report zeigt Status pro Feed
- [ ] < 50% Failures bei WORKING_FEEDS = Error-Log

---

### Schritt 6: Dawum Korrekt Parsen
**Datei:** `src/germany/dawum.ts` (neu, extrahiert)

**Änderungen:**
1. Surveys/Results als Objekte iterieren (nicht Arrays)
2. Filter: nur Bundestag-Umfragen
3. Parteien mappen, CDU/CSU zusammenführen
4. Sortieren nach Datum (neueste zuerst)
5. Return: letzte N Umfragen

**Neue CLI:**
```bash
npm run dawum
```
Gibt aus: Institut, Datum, CDU/CSU, SPD, Grüne, AfD, FDP, BSW, Linke, Sonstige

**Acceptance-Criteria:**
- [ ] CLI zeigt letzte 3 Umfragen korrekt formatiert
- [ ] CDU+CSU werden addiert
- [ ] Nur Bundestag (nicht Landtag)
- [ ] Fehler bei API-Down = Graceful Degradation

---

## PHASE 3: ALPHA ENGINES (Schritte 7-9)

### Schritt 7: TIME_DELAY Engine
**Neue Dateien:**
- `src/alpha/timeDelayEngine.ts`
- `src/alpha/matching.ts` (Fuzzy + Verification)

**Pipeline:**
```
Ingest → Normalize → Dedupe → Classify → Map → Verify → Signal
```

**Matching (2-Stage):**
1. **Stage 1:** Robustes Fuzzy-Matching (Keywords, Entities, Levenshtein)
2. **Stage 2:** Strukturierte Verifikation (LLM nur wenn nötig, gecached)

**Reaction-Speed-Modelle:**
- `time_to_move`: Zeit von News bis Markt-Bewegung
- `post_event_volatility`: Preis-Volatilität nach Event
- `volume_shift`: Volume-Änderung nach News

**Confirmation-Logik:**
- ≥2 unabhängige Quellen ODER Source-Reliability > 0.8
- Blocke wenn Markt bereits > 5% bewegt seit News

**Acceptance-Criteria:**
- [ ] Engine produziert `AlphaSignalV2` mit `TimeDelayFeatures`
- [ ] Dedupe via `sources_events`-Tabelle
- [ ] Matching loggt Match-Confidence
- [ ] Bereits bewegte Märkte werden geblockt
- [ ] Multi-Source-Confirmation funktioniert

---

### Schritt 8: MISPRICING Engine
**Neue Datei:** `src/alpha/mispricingEngine.ts`

**P_true Schätzung:**
- Umfrage-Deltas (Dawum vs Markt)
- Priors (historische Basisraten)
- Mean-Reversion bei extremen Preisen
- **Unsicherheit:** Std-Dev der Schätzung

**Edge-Berechnung:**
```
edge = P_true - P_market
tradeable = edge > minEdge AND uncertainty < maxUncertainty AND quality.tradeable
```

**Market-Structure-Features:**
- Liquidity-Score
- Spread-Proxy
- 30d-Volatilität
- Historische Fehlkalibrierung (aus `outcomes`-Tabelle)

**Acceptance-Criteria:**
- [ ] Engine produziert `AlphaSignalV2` mit `MispricingFeatures`
- [ ] Unsicherheit wird geschätzt und gespeichert
- [ ] Nur tradeable bei allen Bedingungen
- [ ] Nutzt historische Kalibrierungsdaten (falls vorhanden)

---

### Schritt 9: Meta-Combiner
**Neue Datei:** `src/alpha/metaCombiner.ts`

**Kombination:**
- Gewichtetes Averaging von Edge/Confidence
- Weights basieren auf historischer Performance (Walk-Forward)
- Fallback: Equal-Weight wenn keine History

**Output:**
- Kombiniertes Signal mit Source-Attribution
- Confidence-Aggregation

**Acceptance-Criteria:**
- [ ] Kombiniert Signale beider Engines
- [ ] Weights aus DB (falls vorhanden)
- [ ] Kein Overfitting (Walk-Forward)
- [ ] Source-Attribution im Signal

---

## PHASE 4: EXECUTION & RISK (Schritte 10-11)

### Schritt 10: Gestufte Execution
**Datei:** `src/api/trading.ts` (refactor)

**Modi:**
1. **paper** (Default): Nur Logging, kein API-Call
2. **shadow**: Quotes holen, Checks durchführen, simulieren (kein Trade)
3. **live**: Echter Trade via CLOB-API

**Risk-Gates (vor jeder Aktion):**
- `dailyLossOk`: Tagesverlust < MAX_DAILY_LOSS
- `maxPositionsOk`: Offene Positionen < MAX_POSITIONS
- `perMarketCapOk`: Position in Markt < MAX_PER_MARKET
- `liquidityOk`: Liquidity-Score > MIN_LIQUIDITY
- `spreadOk`: Spread < MAX_SPREAD
- `killSwitchOk`: Kein manueller Kill-Switch aktiv

**Sizing:**
- Quarter-Kelly als Basis
- Gedeckelt durch Liquidity und Volatilität
- Slippage-Modell: `expected_slippage = size / liquidity * factor`

**Harte Verweigerung:**
- Wenn `EXECUTION_MODE=live` aber keine Credentials → Error + Exit
- Wenn Risk-Gates failen → Decision mit `action: 'reject'`

**Acceptance-Criteria:**
- [ ] `paper` Mode funktioniert ohne Wallet
- [ ] `shadow` holt echte Quotes (kein Trade)
- [ ] `live` verweigert ohne Credentials
- [ ] Alle Risk-Gates werden geprüft und geloggt
- [ ] Sizing berücksichtigt Liquidity

---

### Schritt 11: Observability & Telegram
**Dateien:** `src/telegram/index.ts`, `src/alpha/telemetry.ts` (neu)

**Jede Decision enthält:**
- `rationale`: Top-3 Feature-Treiber, Edge, Confidence
- `riskChecks`: Alle Gates mit Pass/Fail
- `alphaType`: Welche Engine

**Telegram-Alert Format:**
```
🔔 SIGNAL: {market.question}
━━━━━━━━━━━━━━━━
📊 Alpha-Type: {timeDelay|mispricing|meta}
📈 Direction: {YES|NO} @ {price}
💰 Size: ${size} USDC
📐 Edge: {edge}% | Conf: {confidence}%
━━━━━━━━━━━━━━━━
🔍 Treiber:
  1. {feature1}
  2. {feature2}
  3. {feature3}
━━━━━━━━━━━━━━━━
✅ Risk-Gates: {passed}/{total}
🔗 {polymarket_url}
```

**Acceptance-Criteria:**
- [ ] Telegram-Alert enthält alle Felder
- [ ] Risk-Gate-Status sichtbar
- [ ] Alpha-Type klar erkennbar
- [ ] Polymarket-Link funktioniert

---

## PHASE 5: BACKTESTING & TESTS (Schritt 12)

### Schritt 12: Backtesting-Framework
**Neue Dateien:**
- `src/backtest/index.ts` - CLI Entry
- `src/backtest/simulator.ts` - Trade-Simulation mit echten Fills
- `src/backtest/slippage.ts` - Slippage-Modell aus poly_data
- `src/backtest/metrics.ts` - Performance-Metriken
- `src/backtest/calibration.ts` - Brier-Score, Reliability Buckets
- `src/backtest/report.ts` - JSON + Markdown Output

**Datenquellen:**
- `historical_trades` (poly_data) → Echte Fills für Slippage
- `historical_markets` (poly_data) → Resolutions für Kalibrierung
- `sources_events` → News-Timing für TIME_DELAY Replay
- `markets_snapshot` → Preis-Historie

**CLI:**
```bash
npm run backtest -- --from 2024-01-01 --to 2024-06-30 --engine timeDelay
npm run backtest -- --from 2024-01-01 --to 2024-06-30 --engine mispricing
npm run backtest -- --from 2024-01-01 --to 2024-06-30 --engine meta
npm run backtest -- --from 2024-01-01 --to 2024-06-30 --engine meta --no-slippage
```

**Slippage-Modell (aus poly_data):**
```typescript
// Kalibriert aus historical_trades
interface SlippageModel {
  baseSlippage: number;      // Konstanter Faktor
  sizeImpact: number;        // $ pro $1000 Size
  liquidityFactor: number;   // Multiplikator bei niedriger Liquidity
  volatilityFactor: number;  // Multiplikator bei hoher Volatility
}

// Berechnung
expectedSlippage = baseSlippage
  + (sizeUsdc / 1000) * sizeImpact
  + (1 - liquidityScore) * liquidityFactor
  + volatility * volatilityFactor;
```

**Metriken:**
- **PnL:** Gesamt, pro Trade, pro Engine
- **Max Drawdown:** Peak-to-Trough
- **Hit-Rate:** % korrekte Richtung
- **Edge-Capture:** Realisierter vs. prognostizierter Edge
- **Slippage-Analyse:** Modell vs. Realität (aus poly_data)
- **Calibration:**
  - Brier-Score (gesamt)
  - Reliability Buckets (0-10%, 10-20%, ..., 90-100%)
  - Calibration Plot Daten

**Output:**
- `backtest-results.json`: Rohdaten (alle Trades, Metriken)
- `backtest-summary.md`: Lesbare Zusammenfassung
- `backtest-calibration.json`: Bucket-Daten für Plotting

**Acceptance-Criteria:**
- [ ] CLI läuft mit historischen Daten aus poly_data
- [ ] Slippage aus echten Trades kalibriert
- [ ] Resolutions als Ground Truth für Kalibrierung
- [ ] Alle Metriken werden berechnet
- [ ] Brier-Score zeigt Kalibrierung
- [ ] Reliability Buckets zeigen Over-/Underconfidence
- [ ] Markdown-Report ist lesbar
- [ ] Keine Zukunftsinformationen (kein Lookahead-Bias)
- [ ] Walk-Forward Validation implementiert

---

## UNIT & INTEGRATION TESTS

**Unit Tests (`src/__tests__/`):**
- `dedupe.test.ts`: Hash-Dedupe funktioniert
- `features.test.ts`: Feature-Berechnung korrekt
- `riskGates.test.ts`: Gates blockieren korrekt
- `sizing.test.ts`: Kelly-Sizing korrekt
- `matching.test.ts`: Fuzzy-Matching funktioniert

**Integration Tests:**
- `e2e.test.ts`: Signal → Decision → Paper Execution → Outcome

---

## DEPENDENCIES

```json
{
  "better-sqlite3": "^11.0.0",
  "@types/better-sqlite3": "^7.6.0",
  "csv-parse": "^5.5.0",
  "cli-progress": "^3.12.0",
  "@types/cli-progress": "^3.11.0"
}
```

**poly_data Setup:**
```bash
# Snapshot herunterladen (einmalig, ~1-2 GB)
mkdir -p data/polydata
cd data/polydata
# Download-Link aus poly_data README
wget [SNAPSHOT_URL]
tar -xzf poly_data_snapshot.tar.gz
```

---

## PARALLEL-AGENT FILE OWNERSHIP

| Agent | Dateien | Konflikte vermeiden |
|-------|---------|---------------------|
| A (Markets) | `api/polymarket.ts`, `scripts/markets.ts` | Keine |
| B (RSS) | `germany/rss.ts`, `scripts/rss.ts` | Keine |
| C (Dawum) | `germany/dawum.ts`, `scripts/dawum.ts` | Keine |
| D (Storage) | `storage/*`, `alpha/types.ts` | Types zuerst |
| E (PolyData) | `data/polydata/*`, `scripts/import-polydata.ts` | Nach D |
| F (Engines) | `alpha/*Engine.ts`, `alpha/metaCombiner.ts` | Nach D |
| G (Execution) | `api/trading.ts` | Nach F |
| H (Backtest) | `backtest/*` | Nach E, F, G |

---

## COMMIT-STRATEGIE

Nach jedem Schritt:
1. `npm run type-check` muss grün sein
2. Bestehende Funktionalität muss laufen (`npm run dev` startet)
3. Feature-Flags respektieren (neue Features hinter Flags)
4. Commit mit Präfix: `feat:`, `fix:`, `refactor:`, `test:`

---

## RISIKEN & MITIGATIONEN

| Risiko | Mitigation |
|--------|------------|
| better-sqlite3 native Build | Docker-Build testen, Fallback auf sql.js |
| Dawum API ändert Format | Schema-Validierung, Graceful Degradation |
| Polymarket API Rate-Limits | Exponential Backoff, Cache |
| LLM-Kosten bei Matching | Cache, nur bei niedriger Confidence |
| Overfitting im Backtest | Walk-Forward, Out-of-Sample Validation |

---

## FERTIG-KRITERIEN (V2 COMPLETE)

- [ ] SQLite-DB läuft produktionsstabil
- [ ] poly_data importiert (markets + trades)
- [ ] TIME_DELAY Engine produziert kalibrierte Signale
- [ ] MISPRICING Engine produziert kalibrierte Signale
- [ ] Meta-Combiner kombiniert beide
- [ ] Backtest mit echten Fills (poly_data) zeigt positive Expected Value
- [ ] Slippage-Modell aus echten Trades kalibriert
- [ ] Kalibrierung (Brier-Score) auf historischen Resolutions validiert
- [ ] Alle Risk-Gates funktionieren
- [ ] paper/shadow/live Trennung sauber
- [ ] Telegram-Alerts vollständig
- [ ] CLI-Tools für Markets, RSS, Dawum, PolyData-Import, Backtest
