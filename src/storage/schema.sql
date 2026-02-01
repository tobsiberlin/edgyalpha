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
