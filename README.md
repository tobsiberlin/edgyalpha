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
│  Almanien Modul    [████████████████████████████████████] AKTIV  │
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

### Almanien-Modul (Der Deutschland-Edge)

```
╔═══════════════════════════════════════════════════════════════════╗
║  A L M A N I E N   -   D E R   D E U T S C H L A N D - E D G E   ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Dawum API        [████████████] Wahlumfragen aller Institute     ║
║  Bundestag DIP    [████████████] Gesetzgebungsverfahren           ║
║  RSS Feeds        [████████████] Tagesschau, Handelsblatt, etc.   ║
║  Destatis         [████████░░░░] Wirtschaftsdaten (WIP)           ║
║                                                                   ║
║  > Informationsvorsprung durch deutsche Quellen                   ║
║  > Zeitdifferenz zwischen DE-News und Quotenänderung nutzen       ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

### Interfaces

- **Terminal-Dashboard** - Matrix-Style Web-UI (JetBrains Mono, Green on Black)
- **Telegram Bot** - Inline-Buttons, 1-Click Trading
- **REST API** - WebSocket-Support für Live-Updates

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

## Alpha-Score

```
┌───────────────────────────────────────────────────────────────┐
│                    ALPHA SCORE BERECHNUNG                      │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│   ┌─────────────────┐                                          │
│   │  MARKT-METRIKEN │ ════════════════════════════ 40%        │
│   │  Volume, Liquid │                                          │
│   └─────────────────┘                                          │
│                                                                │
│   ┌─────────────────┐                                          │
│   │  PREISBEWEGUNG  │ ════════════════════════ 30%            │
│   │  Momentum, Vol  │                                          │
│   └─────────────────┘                                          │
│                                                                │
│   ┌─────────────────┐                                          │
│   │  ALMANIEN-EDGE  │ ════════════════════════ 30%            │
│   │  Dawum, News    │                                          │
│   └─────────────────┘                                          │
│                                                                │
│   ══════════════════════════════════════════════════════════   │
│   TOTAL SCORE: 0.0 ─────────────────────────────────────► 1.0  │
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

### WebSocket Events

| Event | → | Beschreibung |
|-------|---|--------------|
| `scan_started` | Client | Scan gestartet |
| `scan_completed` | Client | Scan fertig |
| `signal_found` | Client | Neues Alpha-Signal |
| `trade_executed` | Client | Trade ausgeführt |

---

## Projektstruktur

```
edgyalpha/
├── src/
│   ├── api/              # API-Clients
│   │   └── polymarket.ts # Gamma + CLOB API
│   ├── germany/          # Almanien-Modul
│   │   └── index.ts      # Dawum, Bundestag, RSS
│   ├── scanner/          # Alpha-Scanner
│   │   ├── index.ts      # Scanner-Logik
│   │   └── alpha.ts      # Scoring + Kelly
│   ├── telegram/         # Telegram Bot
│   ├── trading/          # Trading-Engine
│   ├── web/              # Express + Frontend
│   │   └── public/       # Terminal-UI
│   ├── types/            # TypeScript Types
│   ├── utils/            # Config, Logger
│   └── index.ts          # Entry Point
├── tests/                # Vitest Tests
├── .github/workflows/    # CI/CD
├── ecosystem.config.js   # PM2 Config
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
