# Edgy Alpha - Polymarket Alpha Scanner

Ein intelligenter Bot zum Scannen von Polymarket-Wettmärkten mit Deutschland-Informationsvorsprung ("Almanien-Modul").

## Features

### Core Features
- **Polymarket Scanner**: Automatisches Scannen von aktiven Märkten via Gamma API
- **Alpha-Scoring**: Bewertung von Märkten basierend auf Volumen, Liquidität, Preisbewegungen
- **Kelly-Kriterium**: Automatische Position-Sizing basierend auf Edge und Bankroll
- **Kategorie-Filter**: Politik, Wirtschaft, Crypto, Sport, Tech, etc.

### Almanien-Modul (Deutschland-Edge)
Der einzigartige Vorteil: Deutsche Datenquellen für Informationsvorsprung bei DE-relevanten Märkten.

- **Dawum API**: Aktuelle Wahlumfragen aller deutschen Institute
- **Bundestag DIP API**: Gesetzgebungsverfahren, Bundestagsdrucksachen
- **RSS-Feeds**: Tagesschau, Handelsblatt, Kicker, DW
- **Destatis**: Wirtschaftsdaten vom Statistischen Bundesamt

### Interfaces
- **Terminal-Dashboard**: Matrix-Style Web-UI mit Echtzeit-Updates
- **Telegram Bot**: Inline-Buttons, 1-Click Trading, Benachrichtigungen
- **REST API**: WebSocket-Support für Live-Daten

## Tech Stack

- **Runtime**: Node.js 20 LTS
- **Language**: TypeScript (strict mode)
- **Web**: Express.js + Socket.io
- **Blockchain**: ethers.js (Polygon/USDC)
- **APIs**: Polymarket Gamma API, Polymarket CLOB API
- **Process Manager**: PM2
- **CI/CD**: GitHub Actions

## Installation

```bash
# Repository klonen
git clone https://github.com/tobsiberlin/edgyalpha.git
cd edgyalpha

# Dependencies installieren
npm install

# Build
npm run build

# Development-Modus
npm run dev

# Production
npm start
```

## Konfiguration

### Environment Variables (.env)

```env
# Server
NODE_ENV=production
PORT=3000

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ENABLED=true

# Trading (Polygon/USDC)
POLYGON_RPC_URL=https://polygon-rpc.com
WALLET_PRIVATE_KEY=your_private_key
WALLET_ADDRESS=your_wallet_address
MAX_BANKROLL_USDC=1000
MAX_BET_USDC=10
RISK_PER_TRADE_PERCENT=10
KELLY_FRACTION=0.25
TRADING_ENABLED=true
REQUIRE_CONFIRMATION=true

# Scanner
SCAN_INTERVAL_MS=300000
MIN_VOLUME_USD=10000
CATEGORIES=politics,economics

# Deutschland-Modul
GERMANY_MODE_ENABLED=true
GERMANY_AUTO_TRADE=false
GERMANY_MIN_EDGE=0.10
DAWUM_ENABLED=true
BUNDESTAG_ENABLED=true
DESTATIS_ENABLED=true
RSS_FEEDS_ENABLED=true

# Web Auth
WEB_AUTH_ENABLED=true
WEB_USERNAME=admin
WEB_PASSWORD_HASH=your_bcrypt_hash
```

### Kategorien

Verfügbare Kategorien für den Scanner:
- `politics` - Politik (Trump, Biden, Wahlen, Bundestag, etc.)
- `economics` - Wirtschaft (Fed, Inflation, GDP, S&P 500, etc.)
- `crypto` - Kryptowährungen (Bitcoin, Ethereum, etc.)
- `sports` - Sport (NFL, NBA, Bundesliga, etc.)
- `tech` - Technologie (AI, Apple, Tesla, SpaceX, etc.)
- `entertainment` - Unterhaltung (Oscars, Netflix, etc.)
- `geopolitics` - Geopolitik (Ukraine, NATO, Sanktionen, etc.)
- `weather` - Wetter/Klima
- `science` - Wissenschaft
- `society` - Gesellschaft

## Deployment

### VPS Deployment (GitHub Actions)

Das Repository enthält eine GitHub Actions Workflow für automatisches Deployment:

1. GitHub Secrets konfigurieren:
   - `VPS_SSH_KEY`: SSH Private Key
   - `VPS_HOST`: Server IP/Domain
   - `VPS_USER`: SSH User (z.B. root)

2. Bei jedem Push auf `main` wird automatisch deployed

### Manuelles Deployment

```bash
./deploy.sh
```

### PM2 Konfiguration

```bash
# Starten
pm2 start ecosystem.config.js --env production

# Status
pm2 status

# Logs
pm2 logs polymarket-scanner

# Restart
pm2 restart polymarket-scanner
```

## API Endpoints

### REST API

| Endpoint | Methode | Beschreibung |
|----------|---------|--------------|
| `/api/status` | GET | Server-Status |
| `/api/markets` | GET | Aktive Märkte |
| `/api/scan` | POST | Scan triggern |
| `/api/signals` | GET | Alpha-Signale |
| `/api/germany` | GET | DE-Daten |

### WebSocket Events

| Event | Richtung | Beschreibung |
|-------|----------|--------------|
| `scan_started` | Server→Client | Scan gestartet |
| `scan_completed` | Server→Client | Scan abgeschlossen mit Ergebnissen |
| `signal_found` | Server→Client | Neues Alpha-Signal |
| `trade_executed` | Server→Client | Trade ausgeführt |

## Telegram Bot

### Commands
- `/start` - Bot starten
- `/scan` - Manuellen Scan starten
- `/status` - System-Status
- `/markets` - Aktive Märkte
- `/config` - Konfiguration anzeigen
- `/balance` - Wallet-Balance

### Inline Buttons
- Trade ausführen mit einem Klick
- Bestätigung vor jeder Transaktion
- Signal-Details anzeigen

## Alpha-Score Berechnung

Der Alpha-Score (0-1) basiert auf:

1. **Markt-Metriken** (40%)
   - 24h Volume
   - Liquidität
   - Bid-Ask Spread

2. **Preisbewegung** (30%)
   - Momentum
   - Volatilität
   - Distanz zu 0.5

3. **Deutschland-Edge** (30%)
   - Dawum-Umfragen vs. aktuelle Preise
   - News-Timing Differenz
   - Bundestag-Aktivität

## Kelly-Kriterium

Position-Sizing nach Kelly-Formel:

```
f* = (p * b - q) / b
```

Wobei:
- `f*` = Anteil des Bankrolls
- `p` = Geschätzte Gewinnwahrscheinlichkeit
- `q` = 1 - p
- `b` = Potentieller Gewinn (Odds - 1)

Mit konfigurierbarem Kelly-Faktor (Standard: 0.25 = Quarter-Kelly).

## Projektstruktur

```
edgyalpha/
├── src/
│   ├── api/              # API-Clients (Polymarket, etc.)
│   ├── germany/          # Almanien-Modul (Dawum, Bundestag, RSS)
│   ├── scanner/          # Alpha-Scanner & Scoring
│   ├── telegram/         # Telegram Bot
│   ├── trading/          # Trading-Logik & Wallet
│   ├── types/            # TypeScript Types
│   ├── utils/            # Config, Logger, etc.
│   ├── web/              # Express Server & Frontend
│   └── index.ts          # Entry Point
├── tests/                # Vitest Tests
├── .github/workflows/    # CI/CD
├── ecosystem.config.js   # PM2 Config
└── package.json
```

## Development

```bash
# Tests ausführen
npm test

# Linting
npm run lint

# Type-Check
npm run typecheck

# Development mit Watch
npm run dev
```

## Lizenz

MIT

## Autor

Tobias Berlin - [@tobsiberlin](https://github.com/tobsiberlin)

---

**Hinweis**: Dieses Tool ist für Bildungs- und Unterhaltungszwecke. Trading mit echtem Geld erfolgt auf eigenes Risiko.
