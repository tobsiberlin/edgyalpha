-- EdgyAlpha SQLite Schema
-- ====================================

-- sources_events (Event-Dedupe, Source-Reliability)
CREATE TABLE IF NOT EXISTS sources_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_hash TEXT UNIQUE NOT NULL,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT,
  keywords TEXT,
  published_at TEXT,
  ingested_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reliability_score REAL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_events_hash ON sources_events(event_hash);
CREATE INDEX IF NOT EXISTS idx_events_source ON sources_events(source_id);
CREATE INDEX IF NOT EXISTS idx_events_published ON sources_events(published_at);

-- markets_snapshot
CREATE TABLE IF NOT EXISTS markets_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  condition_id TEXT,
  question TEXT NOT NULL,
  category TEXT,
  outcomes TEXT NOT NULL,
  prices TEXT NOT NULL,
  volume_24h REAL,
  volume_total REAL,
  spread_proxy REAL,
  liquidity_score REAL,
  end_date TEXT,
  snapshot_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_markets_id ON markets_snapshot(market_id);
CREATE INDEX IF NOT EXISTS idx_markets_snapshot ON markets_snapshot(snapshot_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_unique ON markets_snapshot(market_id, snapshot_at);

-- signals
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT UNIQUE NOT NULL,
  alpha_type TEXT NOT NULL,
  market_id TEXT NOT NULL,
  features TEXT NOT NULL,
  predicted_edge REAL NOT NULL,
  confidence REAL NOT NULL,
  direction TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_signals_market ON signals(market_id);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(alpha_type);

-- decisions
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT UNIQUE NOT NULL,
  signal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  size_usdc REAL,
  risk_checks TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (signal_id) REFERENCES signals(signal_id)
);

-- executions
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT UNIQUE NOT NULL,
  decision_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  fill_price REAL,
  fill_size REAL,
  slippage REAL,
  fees REAL,
  tx_hash TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  filled_at TEXT,
  FOREIGN KEY (decision_id) REFERENCES decisions(decision_id)
);

-- outcomes
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  resolution TEXT,
  exit_price REAL,
  pnl_usdc REAL,
  predicted_prob REAL,
  actual_outcome INTEGER,
  resolved_at TEXT,
  FOREIGN KEY (execution_id) REFERENCES executions(execution_id)
);

-- historical_trades (poly_data)
CREATE TABLE IF NOT EXISTS historical_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  market_id TEXT NOT NULL,
  price REAL NOT NULL,
  usd_amount REAL NOT NULL,
  token_amount REAL,
  maker TEXT,
  taker TEXT,
  maker_direction TEXT,
  taker_direction TEXT,
  tx_hash TEXT UNIQUE,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hist_trades_market ON historical_trades(market_id);
CREATE INDEX IF NOT EXISTS idx_hist_trades_ts ON historical_trades(timestamp);

-- historical_markets (poly_data)
CREATE TABLE IF NOT EXISTS historical_markets (
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
  outcome TEXT,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- meta_combiner_state (ML-Weights und Koeffizienten)
CREATE TABLE IF NOT EXISTS meta_combiner_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weights TEXT NOT NULL,           -- JSON: {timeDelay: number, mispricing: number}
  coefficients TEXT NOT NULL,       -- JSON: {feature_name: coefficient}
  training_count INTEGER NOT NULL,  -- Anzahl Trainingsbeispiele
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_combiner_updated ON meta_combiner_state(updated_at);

-- risk_state (PERSISTENT - überlebt Restarts)
CREATE TABLE IF NOT EXISTS risk_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Singleton: nur eine Zeile
  execution_mode TEXT NOT NULL DEFAULT 'paper',
  kill_switch_active INTEGER NOT NULL DEFAULT 0,
  kill_switch_reason TEXT,
  kill_switch_activated_at TEXT,
  daily_pnl REAL NOT NULL DEFAULT 0,
  daily_trades INTEGER NOT NULL DEFAULT 0,
  daily_wins INTEGER NOT NULL DEFAULT 0,
  daily_losses INTEGER NOT NULL DEFAULT 0,
  daily_date TEXT NOT NULL,  -- Format: YYYY-MM-DD
  total_exposure REAL NOT NULL DEFAULT 0,
  positions TEXT NOT NULL DEFAULT '{}',  -- JSON: {marketId: {size, entryPrice, direction}}
  settings TEXT NOT NULL DEFAULT '{}',   -- JSON: Runtime-Settings
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- audit_log (COMPLIANCE - jede Entscheidung auditierbar)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,  -- 'trade', 'mode_change', 'kill_switch', 'settings', 'login', 'error'
  actor TEXT NOT NULL,       -- 'web', 'telegram', 'system', 'scheduler'
  action TEXT NOT NULL,      -- Human-readable Beschreibung
  details TEXT,              -- JSON: Zusätzliche Daten
  market_id TEXT,            -- Optional: betroffener Markt
  signal_id TEXT,            -- Optional: betroffenes Signal
  pnl_impact REAL,           -- Optional: PnL-Auswirkung
  risk_state_before TEXT,    -- JSON: Risk State vor Aktion
  risk_state_after TEXT,     -- JSON: Risk State nach Aktion
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_market ON audit_log(market_id);

-- price_history (lokaler Cache für Charts)
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,  -- Unix timestamp in ms
  price REAL NOT NULL,
  volume REAL,
  source TEXT DEFAULT 'polymarket',
  fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_price_market ON price_history(market_id);
CREATE INDEX IF NOT EXISTS idx_price_token ON price_history(token_id);
CREATE INDEX IF NOT EXISTS idx_price_ts ON price_history(timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_unique ON price_history(token_id, timestamp);

-- pipeline_health (Persistent Pipeline Status für Stale-Data Detection)
CREATE TABLE IF NOT EXISTS pipeline_health (
  pipeline_name TEXT PRIMARY KEY,  -- 'polymarket', 'rss', 'dawum', 'telegram'
  last_success_at TEXT,            -- Letzter erfolgreicher Fetch
  last_error_at TEXT,              -- Letzter Fehler
  last_error_message TEXT,         -- Fehlermeldung
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  total_runs INTEGER NOT NULL DEFAULT 0,
  total_errors INTEGER NOT NULL DEFAULT 0,
  avg_duration_ms REAL,            -- Durchschnittliche Laufzeit
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- data_freshness (Tracking für Daten-Aktualität pro Quelle)
CREATE TABLE IF NOT EXISTS data_freshness (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,       -- 'market_prices', 'news', 'polls', 'signals'
  source_id TEXT,                  -- Optional: spezifische ID
  as_of TEXT NOT NULL,             -- Zeitpunkt der Daten (nicht Fetch-Zeit!)
  fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
  stale_threshold_minutes INTEGER DEFAULT 5,  -- Ab wann als "stale" betrachtet
  UNIQUE(source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_freshness_type ON data_freshness(source_type);
CREATE INDEX IF NOT EXISTS idx_freshness_as_of ON data_freshness(as_of);

-- news_candidates (Entkopplung News → Push)
-- News werden hier gesammelt und erst nach Gate-Check gepusht
CREATE TABLE IF NOT EXISTS news_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_hash TEXT UNIQUE NOT NULL,        -- Hash für Deduplizierung
  source_id TEXT NOT NULL,                 -- RSS Feed ID
  source_name TEXT NOT NULL,               -- z.B. "Tagesschau", "Reuters"
  title TEXT NOT NULL,
  url TEXT,
  content TEXT,
  published_at TEXT NOT NULL,              -- Originalzeit der News
  ingested_at TEXT DEFAULT CURRENT_TIMESTAMP,
  categories TEXT,                         -- JSON Array: ["politics", "economy"]
  keywords TEXT,                           -- JSON Array: Erkannte Keywords
  time_advantage_seconds INTEGER,          -- Zeitvorsprung in Sekunden
  status TEXT NOT NULL DEFAULT 'new',      -- new|matching|matched|rejected|expired|pushed
  rejection_reason TEXT,                   -- Wenn rejected: Grund
  -- Matching-Ergebnisse
  matched_market_id TEXT,
  matched_market_question TEXT,
  match_confidence REAL,
  match_method TEXT,                       -- 'keyword'|'semantic'|'hybrid'
  -- Gate-Check Ergebnisse
  gate_results TEXT,                       -- JSON: {gate_name: {passed: bool, value: X, threshold: Y}}
  gates_passed INTEGER DEFAULT 0,          -- 1 wenn alle Gates grün
  -- Push-Status
  push_queued_at TEXT,
  push_sent_at TEXT,
  push_message_id TEXT,                    -- Telegram Message ID
  -- TTL
  expires_at TEXT,                         -- Nach X Stunden automatisch expired
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON news_candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_published ON news_candidates(published_at);
CREATE INDEX IF NOT EXISTS idx_candidates_market ON news_candidates(matched_market_id);
CREATE INDEX IF NOT EXISTS idx_candidates_expires ON news_candidates(expires_at);

-- notification_state (Rate Limiter Persistence)
CREATE TABLE IF NOT EXISTS notification_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- Singleton
  last_push_at TEXT,                       -- Letzter Push-Zeitpunkt
  pushes_today INTEGER NOT NULL DEFAULT 0, -- Pushes heute
  pushes_today_date TEXT,                  -- Datum für Daily Reset
  quiet_hours_queue TEXT DEFAULT '[]',     -- JSON: Geparkete Notifications während Quiet Hours
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- notification_settings (Push-Einstellungen pro User/Chat)
CREATE TABLE IF NOT EXISTS notification_settings (
  chat_id TEXT PRIMARY KEY,                -- Telegram Chat ID
  push_mode TEXT NOT NULL DEFAULT 'TIME_DELAY_ONLY',  -- OFF|TIME_DELAY_ONLY|SYSTEM_ONLY|DIGEST_ONLY|FULL
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 1,
  quiet_hours_start TEXT DEFAULT '23:00',  -- Format HH:MM
  quiet_hours_end TEXT DEFAULT '07:00',
  timezone TEXT DEFAULT 'Europe/Berlin',
  -- Thresholds
  min_match_confidence REAL DEFAULT 0.75,
  min_edge REAL DEFAULT 0.03,
  min_volume REAL DEFAULT 50000,
  -- Category Toggles (1=enabled, 0=disabled)
  category_politics INTEGER DEFAULT 1,
  category_economy INTEGER DEFAULT 1,
  category_sports INTEGER DEFAULT 0,
  category_geopolitics INTEGER DEFAULT 1,
  category_crypto INTEGER DEFAULT 0,
  -- Rate Limits
  cooldown_minutes INTEGER DEFAULT 15,
  max_per_day INTEGER DEFAULT 8,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
