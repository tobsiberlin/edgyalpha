```
███████╗██████╗  ██████╗ ██╗   ██╗     █████╗ ██╗     ██████╗ ██╗  ██╗ █████╗
██╔════╝██╔══██╗██╔════╝ ╚██╗ ██╔╝    ██╔══██╗██║     ██╔══██╗██║  ██║██╔══██╗
█████╗  ██║  ██║██║  ███╗ ╚████╔╝     ███████║██║     ██████╔╝███████║███████║
██╔══╝  ██║  ██║██║   ██║  ╚██╔╝      ██╔══██║██║     ██╔═══╝ ██╔══██║██╔══██║
███████╗██████╔╝╚██████╔╝   ██║       ██║  ██║███████╗██║     ██║  ██║██║  ██║
╚══════╝╚═════╝  ╚═════╝    ╚═╝       ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝
                 M I T   A L M A N I E N - V O R S P R U N G
```

<p align="center">
  <strong>Polymarket Alpha Scanner mit Deutschland-Informationsvorsprung</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Polygon-8247E5?style=for-the-badge&logo=polygon&logoColor=white" alt="Polygon">
  <img src="https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram">
</p>

---

## Status

```
┌──────────────────────────────────────────────────────────────────┐
│  SYSTEM STATUS                                                    │
├──────────────────────────────────────────────────────────────────┤
│  Polymarket API    [████████████████████████████████████] ONLINE │
│  Alman Modul    [████████████████████████████████████] AKTIV  │
│  WebSocket         [████████████████████████████████████] BEREIT │
│  Trading Engine    [████████████████████████████████████] ARMED  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Features

### Core Scanner

| Feature | Status | Beschreibung |
|---------|--------|--------------|
| Polymarket Gamma API | `[████]` | Echtzeit-Marktdaten |
| Alpha-Scoring | `[████]` | Intelligente Signalanalyse |
| Kelly-Kriterium | `[████]` | Mathematisch optimale Positionsgrößen |
| Kategorie-Filter | `[████]` | Politik, Wirtschaft, Crypto, Sport |

### Live News Ticker - DAUERFEUER MODUS

```
╔════════════════════════════════════════════════════════════════════╗
║     🔥 LIVE TICKER - DAUERFEUER MODUS 🔥                           ║
╠════════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  📰 14:32:05 Tagesschau      │ Scholz trifft Macron...            ║
║  🔍 Matching gegen 238 Märkte...                                   ║
║  ✅ ████████░░ 80% MATCH! → "Will Scholz resign before..."        ║
║                                                                    ║
║  📰 14:32:47 Reuters         │ Ukraine ceasefire talks...          ║
║  🔍 Matching gegen 238 Märkte...                                   ║
║  ❌ ░░░░░░░░░░ kein Match (45ms)                                   ║
║                                                                    ║
║  📰 14:33:12 Kicker          │ Kompany vor dem Aus?               ║
║  🔍 Matching gegen 238 Märkte...                                   ║
║  ✅ ██████████ 95% MATCH! → "Vincent Kompany next Bayern coach"   ║
║                                                                    ║
╠════════════════════════════════════════════════════════════════════╣
║  News: 1,247 │ Matches: 89 │ Alpha: 12 │ Ø Latenz: 34ms           ║
╚════════════════════════════════════════════════════════════════════╝
```

### Alman-Modul (Der Deutschland-Edge)

```
╔═══════════════════════════════════════════════════════════════════╗
║  A L M A N I E N   -   D E R   D E U T S C H L A N D - E D G E   ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Dawum API        [████████████] Wahlumfragen aller Institute     ║
║  Bundestag DIP    [████████████] Gesetzgebungsverfahren           ║
║  RSS Feeds        [████████████] 188+ Quellen (DE + INT)          ║
║  Event-Listener   [████████████] 60s Polling, Breaking News       ║
║                                                                   ║
║  > Informationsvorsprung durch deutsche Quellen                   ║
║  > Zeitdifferenz zwischen DE-News und Quotenänderung nutzen       ║
║  > Echtzeit-Matching: News → Polymarket Märkte                    ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

#### Almanien Intelligence View (NEU!)

Die "ALMANIEN"-Seite im Web-Interface zeigt das Herzstück des Features:

- **News-Markt Matches**: Deutsche News mit passenden Polymarket-Märkten
- **Match-Confidence**: Farbkodierte Anzeige (grün >70%, gelb >40%, grau <40%)
- **Zeitvorsprung**: Wie alt ist die News (m/h/d)?
- **Direkter Link**: "MARKT ÖFFNEN"-Button führt direkt zu Polymarket
- **Match-Details**: Entities und Keywords die zum Match führten
- **Aktueller Preis**: Wenn verfügbar, Marktpreis als Prozent

#### Zeitvorsprung-Tracking (NEU!)

```
╔═══════════════════════════════════════════════════════════════════╗
║     Z E I T V O R S P R U N G - T R A C K I N G                  ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  EDGE-BEWEIS in Echtzeit:                                         ║
║  1. Deutsche News wird erkannt (publishedAt)                      ║
║  2. Markt-Match gefunden (priceAtNews gespeichert)                ║
║  3. Preis-Checks: 5min, 15min, 30min, 60min, 4h, 24h             ║
║  4. Signifikante Bewegung (>2%) → Zeitvorsprung berechnet        ║
║                                                                   ║
║  Dashboard-Metriken:                                              ║
║  > Avg. Zeitvorsprung in Minuten                                 ║
║  > Avg. Preisbewegung nach News                                  ║
║  > Vorhersage-Genauigkeit (News-Richtung = Markt-Richtung?)      ║
║  > Top-Quellen Ranking nach Performance                          ║
║                                                                   ║
║  Telegram: /edge                                                  ║
║  Hauptmenü: "Zeitvorsprung" Button                               ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

### Interfaces

- **Trading Desk Console** - Bloomberg/Palantir-Style UI (Dark-First, Three-Column Layout)
- **Telegram Bot** - Inline-Buttons, 1-Click Trading, Runtime Controls
- **REST API** - WebSocket-Support fuer Live-Updates + Runtime State Events
- **Browser Notifications** - Desktop Push-Alerts fuer wichtige Events (NEU!)

### Browser Push-Notifications (NEU!)

```
╔═══════════════════════════════════════════════════════════════════╗
║         B R O W S E R   N O T I F I C A T I O N S                 ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Events die Notifications triggern:                               ║
║  > High-Alpha Signal (Edge > 20%)                                 ║
║  > Almanien Zeitvorsprung gefunden                                ║
║  > Trade ausgefuehrt (auto oder manuell)                          ║
║  > Risk Warning (Kill-Switch, Daily Limit > 80%)                  ║
║  > Pipeline Fehler                                                ║
║                                                                   ║
║  Settings (in SETTINGS-View):                                     ║
║  > Master on/off Toggle                                           ║
║  > Sound on/off                                                   ║
║  > Individuelle Event-Typ Toggles                                 ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

### Runtime Controls (NEU!)

```
╔═══════════════════════════════════════════════════════════════════╗
║               R U N T I M E   C O N T R O L S                     ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  KILL-SWITCH    [████████████] Web + Telegram steuerbar          ║
║  MODE TOGGLE    [████████████] paper → shadow → live (no restart)║
║  RISK DASHBOARD [████████████] Daily PnL, Positions, Limits      ║
║  STATE SYNC     [████████████] WebSocket Real-Time Broadcast     ║
║  POSITION-SYNC  [████████████] Auto-Sync bei Restart (NEU!)      ║
║                                                                   ║
║  > Kein Terminal/CLI nötig - alles via Web & Telegram            ║
║  > Automatischer Kill-Switch bei -20% Daily Loss                 ║
║  > Mode-Wechsel ohne Server-Neustart                             ║
║  > Position-Tracking ueberlebt Server-Neustarts                  ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

---

## Cash-Machine V2.0 (NEU!)

```
┌───────────────────────────────────────────────────────────────────────┐
│                    CASH-MACHINE V2.0 - ADVANCED INFRASTRUCTURE         │
├───────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  ECHTE KELLY-FORMEL                                         │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  f* = p - q/b  (mathematisch korrekt für Prediction Markets) │     │
│   │  • Korrekte Odds-Berechnung: b = (1/price) - 1              │     │
│   │  • EV-Validierung vor jedem Trade                           │     │
│   │  • Unterstützt YES und NO Positionen                        │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  ADAPTIVE SCALING                                           │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  Dynamische Position-Sizing basierend auf:                  │     │
│   │  • Drawdown Scaling (reduziert ab 10% DD, stoppt bei 30%)   │     │
│   │  • Streak Scaling (reduziert nach 2+ konsekutiven Losses)   │     │
│   │  • Volatility Scaling (reduziert bei hoher Volatilität)     │     │
│   │  • Regime Scaling (passt an Recent Win Rate an)             │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  EXECUTION QUALITY MONITOR                                  │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  Vollständiges Tracking: Signal → Order → Fill              │     │
│   │  • Slippage-Analyse (Expected vs. Actual)                   │     │
│   │  • Latency-Monitoring (P50, P95, Max)                       │     │
│   │  • Fill Rate & Execution Quality Score (0-100)              │     │
│   │  • Alerts: High Slippage, Slow Fill, Model Drift            │     │
│   │  • Automatische Optimierungs-Empfehlungen                   │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  PERFORMANCE DASHBOARD                                      │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  Rolling Performance Dashboard im Web UI:                   │     │
│   │  • Live KPIs: PnL, Win Rate, Sharpe, Max DD                 │     │
│   │  • Equity Curve (Canvas-basiert, keine Dependencies)        │     │
│   │  • Engine Performance (TimeDelay, Mispricing, Meta)         │     │
│   │  • Streak Stats & Profit Factor                             │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  ERWEITERTES BACKTEST UI                                    │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  • Equity Curve Chart                                       │     │
│   │  • Download: JSON, CSV, Markdown                            │     │
│   │  • Erweiterte Metriken: Profit Factor, Avg Win/Loss         │     │
│   │  • Calibration Chart (Predicted vs. Actual)                 │     │
│   │  • Walk-Forward Out-of-Sample Validation                    │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Alpha Engines V2

```
┌───────────────────────────────────────────────────────────────────────┐
│               ALPHA ENGINES V2 - ZWEI STRIKT GETRENNTE ENGINES        │
├───────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  TIME_DELAY ENGINE                                           │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  Informations-Timing: DE/EU-Quellen vs. Marktreaktion        │     │
│   │  • Fuzzy-Matching (Levenshtein)                              │     │
│   │  • Multi-Source Confirmation (≥2 Quellen)                    │     │
│   │  • Sentiment & Impact Score                                  │     │
│   │  • Blockt wenn Markt bereits bewegt                          │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  MISPRICING ENGINE                                           │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  Value-/Struktur-Alpha OHNE Zeitvorsprung                    │     │
│   │  • Transparente P_true Schätzung (keine Blackbox)            │     │
│   │  • Poll-Delta (Dawum vs. Markt)                              │     │
│   │  • Mean-Reversion bei Extremen                               │     │
│   │  • Market-Quality Gates (Spread, Liquidity)                  │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  META-COMBINER (ML)                                          │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  Online Logistic Regression + Walk-Forward Learning          │     │
│   │  • Kombiniert beide Engines                                  │     │
│   │  • Erklärbare Top-Features                                   │     │
│   │  • Persistente Weights in SQLite                             │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  EXECUTION (paper | shadow | live)                           │     │
│   │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │     │
│   │  • Risk-Gates: Daily-Loss, Max-Positions, Kill-Switch        │     │
│   │  • Quarter-Kelly Sizing mit Liquidity-Anpassung              │     │
│   │  • Slippage-Modell kalibriert aus echten Trades              │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                        │
└───────────────────────────────────────────────────────────────────────┘
```

### CLI-Tools

```bash
npm run markets -- --minVolume 10000 --limit 50    # Polymarket Märkte
npm run rss -- --health                             # RSS Feed Health
npm run dawum                                       # Aktuelle Umfragen
npm run import:polydata -- --all                    # Historische Daten importieren
npm run generate:demo                               # Demo-Daten generieren
npm run resolve:demo                                # Demo-Markets auflösen
npm run backtest -- --engine meta --from 2024-01-01 # Backtesting
```

### Historische Daten für Backtest

```bash
# Option 1: Demo-Daten generieren (für Tests)
npm run generate:demo -- --markets 100 --trades 100
npm run resolve:demo  # Markets mit Outcomes versehen
npm run import:polydata -- --all

# Option 2: Echte poly_data CSVs
# 1. Lade markets.csv und trades.csv von poly_data
# 2. Kopiere nach ./data/polydata/
# 3. npm run import:polydata -- --all
```

### Feature-Flags

```env
ALPHA_ENGINE=meta              # timeDelay | mispricing | meta
EXECUTION_MODE=paper           # paper | shadow | live
SQLITE_PATH=./data/edgyalpha.db
BACKTEST_MODE=false
```

---

## Tech Stack

```
┌─────────────────────────────────────────────────────────────┐
│                        TECH STACK                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Runtime         │ Node.js 20 LTS                          │
│   Language        │ TypeScript (strict mode)                │
│   Web Framework   │ Express.js + Socket.io                  │
│   Blockchain      │ ethers.js (Polygon/USDC)                │
│   Process Mgr     │ PM2                                     │
│   CI/CD           │ GitHub Actions                          │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                        APIS                                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Polymarket      │ gamma-api.polymarket.com                │
│   Trading         │ clob.polymarket.com                     │
│   Dawum           │ api.dawum.de                            │
│   Bundestag       │ search.dip.bundestag.de                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
# Klonen
git clone https://github.com/tobsiberlin/edgyalpha.git && cd edgyalpha

# Installieren
npm install

# Konfigurieren
cp .env.example .env
# Dann .env editieren

# Build & Start
npm run build && npm start

# Development
npm run dev
```

---

## Konfiguration

### .env

```env
# ═══════════════════════════════════════════════════════════════
#                        CORE CONFIG
# ═══════════════════════════════════════════════════════════════

NODE_ENV=production
PORT=3000

# ═══════════════════════════════════════════════════════════════
#                      TELEGRAM BOT
# ═══════════════════════════════════════════════════════════════

TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ENABLED=true

# Quick-Buy Button Betraege (USDC)
QUICK_BUY_AMOUNTS=5,10,25,50

# ═══════════════════════════════════════════════════════════════
#                    TRADING (POLYGON/USDC)
# ═══════════════════════════════════════════════════════════════

POLYGON_RPC_URL=https://polygon-rpc.com
WALLET_PRIVATE_KEY=0x...
WALLET_ADDRESS=0x...
MAX_BANKROLL_USDC=1000
MAX_BET_USDC=10
RISK_PER_TRADE_PERCENT=10
KELLY_FRACTION=0.25
TRADING_ENABLED=true
REQUIRE_CONFIRMATION=true

# ═══════════════════════════════════════════════════════════════
#                        SCANNER
# ═══════════════════════════════════════════════════════════════

SCAN_INTERVAL_MS=300000          # 5 Minuten
MIN_VOLUME_USD=10000             # $10K minimum
CATEGORIES=politics,economics   # Kategorien

# ═══════════════════════════════════════════════════════════════
#                    ALMANIEN MODUL
# ═══════════════════════════════════════════════════════════════

GERMANY_MODE_ENABLED=true
GERMANY_AUTO_TRADE=false
GERMANY_MIN_EDGE=0.10
DAWUM_ENABLED=true
BUNDESTAG_ENABLED=true
RSS_FEEDS_ENABLED=true
```

---

## Alpha-Score v2.0

```
┌───────────────────────────────────────────────────────────────┐
│                ALPHA GENERATOR v2.0 - ALLE QUELLEN            │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│   ┌─────────────────┐                                          │
│   │  MARKT-METRIKEN │ ════════════════════ 25%                │
│   │  Volume, Liquid │                                          │
│   │  Mispricing     │                                          │
│   └─────────────────┘                                          │
│                                                                │
│   ┌─────────────────┐                                          │
│   │  NEWS-ALPHA     │ ════════════════════════════ 35%        │
│   │  188+ RSS Feeds │ ← Sentiment-Analyse                      │
│   │  Breaking Boost │ ← Impact-Score                           │
│   │  Fresh News!    │ ← < 30 Min = Extra Alpha                 │
│   └─────────────────┘                                          │
│                                                                │
│   ┌─────────────────┐                                          │
│   │  ALMANIEN-EDGE  │ ════════════════════════ 30%            │
│   │  DE/EU Sources  │ ← Zeitvorsprung                          │
│   │  Dawum, Bundest │                                          │
│   └─────────────────┘                                          │
│                                                                │
│   ┌─────────────────┐                                          │
│   │  FUZZY MATCH    │ ════════════ 10%                        │
│   │  Levenshtein    │ ← "Kompany" → "Vincent Kompany"         │
│   │  Named Entities │                                          │
│   └─────────────────┘                                          │
│                                                                │
│   ══════════════════════════════════════════════════════════   │
│   TOTAL SCORE: 0.0 ─────────────────────────────────────► 1.0  │
│   MAX EDGE: 30%                                                │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

---

## Kelly-Kriterium

```
┌───────────────────────────────────────────────────────────────┐
│                     KELLY CRITERION                            │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│   f* = (p × b - q) / b                                        │
│                                                                │
│   ├── f* = Optimaler Einsatz (Anteil Bankroll)               │
│   ├── p  = Geschätzte Gewinnwahrscheinlichkeit               │
│   ├── q  = 1 - p (Verlustwahrscheinlichkeit)                 │
│   └── b  = Potentieller Gewinn (Odds - 1)                    │
│                                                                │
│   Default: Quarter-Kelly (0.25 × f*)                          │
│   → Konservativere Position, weniger Varianz                  │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

### REST

| Endpoint | Methode | Beschreibung |
|----------|---------|--------------|
| `/api/status` | `GET` | System-Status |
| `/api/config` | `GET` | Konfiguration |
| `/api/scan` | `POST` | Scan triggern |
| `/api/signals` | `GET` | Alpha-Signale |
| `/api/markets` | `GET` | Aktive Märkte |
| `/api/germany/polls` | `GET` | Dawum-Umfragen |
| `/api/germany/news` | `GET` | RSS-News |
| `/api/trade/:id` | `POST` | Trade ausführen |
| `/api/risk/dashboard` | `GET` | Risk Dashboard |
| `/api/risk/killswitch` | `POST` | Kill-Switch Toggle |
| `/api/execution/mode` | `GET/POST` | Execution Mode |
| `/api/execution/quality` | `GET` | Execution Quality Metrics (V3.0!) |
| `/api/runtime` | `GET` | Vollständiger Runtime-State |
| `/api/settings` | `POST` | Settings Update |
| `/api/settings/all` | `GET` | Alle Settings fuer Settings-Seite |
| `/api/stats/equity` | `GET` | Equity Curve Daten (V3.0!) |
| `/api/stats/trading` | `GET` | Trading Stats (V3.0!) |
| `/api/backtest` | `POST` | Backtest starten |
| `/api/backtest/status` | `GET` | Backtest Progress |
| `/api/backtest/results` | `GET` | Ergebnisse (JSON/CSV/MD) (V3.0!) |

### WebSocket Events

| Event | → | Beschreibung |
|-------|---|--------------|
| `scan_started` | Client | Scan gestartet |
| `scan_completed` | Client | Scan fertig |
| `signal_found` | Client | Neues Alpha-Signal |
| `trade_executed` | Client | Trade ausgeführt |
| `ticker` | Client | Live News Ticker Event |
| `runtime_state_change` | Client | State-Änderung (NEU!) |
| `kill_switch` | Client | Kill-Switch Event (NEU!) |
| `risk_update` | Client | Risk-Limit Update (NEU!) |
| `daily_reset` | Client | 00:00 UTC Reset (NEU!) |

### Ticker Event Typen

| Type | Beschreibung |
|------|--------------|
| `news_in` | Neue News erkannt |
| `matching` | Matching läuft |
| `match_found` | ✅ Polymarket-Match gefunden |
| `no_match` | ❌ Kein Match |
| `alpha_signal` | 🔥 Alpha-Signal generiert |

---

## Projektstruktur

```
edgyalpha/
├── src/
│   ├── runtime/          # Runtime State Manager (NEU!)
│   │   ├── index.ts      # Exports
│   │   └── state.ts      # Zentrale State-Verwaltung
│   ├── alpha/            # Alpha Engines V2
│   │   ├── types.ts      # AlphaSignalV2, Features, Decision
│   │   ├── timeDelayEngine.ts   # TIME_DELAY Engine
│   │   ├── mispricingEngine.ts  # MISPRICING Engine
│   │   ├── metaCombiner.ts      # Meta-Combiner (ML)
│   │   ├── matching.ts   # Fuzzy-Matching
│   │   ├── riskGates.ts  # Risk-Management
│   │   ├── sizing.ts     # Kelly-Sizing
│   │   └── telemetry.ts  # Observability
│   ├── storage/          # SQLite Storage
│   │   ├── db.ts         # Database Singleton
│   │   ├── schema.sql    # 8 Tabellen
│   │   └── repositories/ # Typsichere CRUD
│   ├── backtest/         # Backtesting
│   │   ├── simulator.ts  # Trade-Simulation
│   │   ├── metrics.ts    # PnL, Sharpe, Drawdown
│   │   ├── calibration.ts # Brier-Score
│   │   └── report.ts     # Markdown/JSON Output
│   ├── data/polydata/    # poly_data Import
│   ├── api/              # API-Clients
│   │   ├── polymarket.ts # Gamma + CLOB API
│   │   └── trading.ts    # Gestufte Execution
│   ├── germany/          # Alman-Modul
│   │   ├── index.ts      # Koordination
│   │   ├── rss.ts        # 40 kuratierte Feeds
│   │   └── dawum.ts      # Wahlumfragen
│   ├── scanner/          # Legacy Scanner
│   ├── ticker/           # Live News Ticker
│   ├── telegram/         # Telegram Bot V2
│   ├── web/              # Express + Bloomberg UI
│   ├── types/            # TypeScript Types
│   └── utils/            # Config, Logger
├── scripts/              # CLI-Tools (NEU!)
│   ├── markets.ts        # npm run markets
│   ├── rss.ts            # npm run rss
│   ├── dawum.ts          # npm run dawum
│   ├── import-polydata.ts # npm run import:polydata
│   └── backtest.ts       # npm run backtest
├── tasks/                # Task-Management
│   ├── todo.md           # Alle Tasks erledigt ✅
│   └── lessons.md        # Workflow-Regeln
├── tests/                # Vitest Tests
├── src/__tests__/        # Unit Tests (102 Tests)
├── PLAN.md               # Implementierungsplan
├── CHANGELOG.md          # Versionshistorie
└── package.json
```

---

## Deployment

### GitHub Actions (Automatisch)

```yaml
# Bei jedem Push auf main:
# 1. SSH zum VPS
# 2. git pull
# 3. npm install && npm run build
# 4. pm2 restart
```

### Manuell

```bash
./deploy.sh
```

### PM2 Commands

```bash
pm2 start ecosystem.config.js --env production
pm2 logs polymarket-scanner
pm2 restart polymarket-scanner
pm2 monit
```

---

## Development

```bash
# Tests
npm test

# Linting
npm run lint

# Type-Check
npm run typecheck

# Dev mit Watch
npm run dev
```

---

## Kategorien

```
┌─────────────────────────────────────────────────────────┐
│                    KATEGORIEN                            │
├─────────────────────────────────────────────────────────┤
│                                                          │
│   politics      │ Trump, Biden, Wahlen, Bundestag       │
│   economics     │ Fed, Inflation, GDP, DAX, S&P 500     │
│   crypto        │ Bitcoin, Ethereum, Solana             │
│   sports        │ NFL, NBA, Bundesliga, Champions League│
│   tech          │ AI, Apple, Tesla, SpaceX, OpenAI      │
│   geopolitics   │ Ukraine, Russia, NATO, Sanctions      │
│   entertainment │ Oscars, Grammys, Netflix              │
│   weather       │ Climate, Hurricanes                   │
│   science       │ NASA, Research                        │
│   society       │ Culture, Population                   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Disclaimer

```
╔═══════════════════════════════════════════════════════════════╗
║                         DISCLAIMER                             ║
╠═══════════════════════════════════════════════════════════════╣
║                                                                ║
║  Dieses Tool ist für Bildungs- und Unterhaltungszwecke.       ║
║  Trading mit echtem Geld erfolgt auf eigenes Risiko.          ║
║                                                                ║
║  Keine Finanzberatung. DYOR.                                  ║
║                                                                ║
╚═══════════════════════════════════════════════════════════════╝
```

---

<p align="center">
  <sub>Built with by <a href="https://github.com/tobsiberlin">@tobsiberlin</a></sub>
</p>
