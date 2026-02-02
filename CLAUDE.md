# CLAUDE.md - Polymarket Alpha Scanner

## Projekt-Kontext

**Zweck:** Polymarket Prediction Markets Scanner mit KI-Research und ALMANIEN-EUSSR-Tracker

**Features:**
- Echtzeit-Scanning von Polymarket Märkten
- Alpha-Scoring und Trade-Empfehlungen
- EUSSR-Tracker: Dawum Umfragen, Bundestag API, RSS Feeds
- Telegram Bot mit 1-Klick Trading
- Mobile-First Web-Interface
- Automatisiertes Deployment via GitHub Actions

## Tech Stack

- **Runtime:** Node.js 20 LTS
- **Sprache:** TypeScript (strict mode)
- **Web:** Express.js + Socket.io
- **UI:** Vanilla JS + CSS Grid (Mobile-First)
- **Trading:** ethers.js (Polygon)
- **Process Manager:** PM2
- **Deployment:** GitHub Actions → VPS (fluessiger.de)

## Projektstruktur

```
src/
├── api/
│   ├── polymarket.ts    # Polymarket API Client
│   └── trading.ts       # Wallet & Trading
├── scanner/
│   ├── index.ts         # Scanner Hauptlogik
│   └── alpha.ts         # Alpha Scoring & Kelly Criterion
├── germany/
│   └── index.ts         # Deutsche Quellen (Dawum, Bundestag, RSS)
├── telegram/
│   └── index.ts         # Telegram Bot mit Buttons
├── web/
│   ├── server.ts        # Express + Socket.io
│   └── public/          # Frontend Assets
├── utils/
│   ├── config.ts        # Konfiguration
│   └── logger.ts        # Winston Logger
├── types/
│   └── index.ts         # TypeScript Interfaces
└── index.ts             # Entry Point
```

## Code-Konventionen

- TypeScript strict mode
- ESLint + Prettier
- Alle UI-Texte auf Deutsch
- Logging mit Timestamps: `[YYYY-MM-DD HH:mm:ss]`
- Async/Await bevorzugen
- Error Handling mit try/catch

## Bekannte Fehler & Lösungen

### Rate Limiting
- Polymarket API hat Rate Limits
- Lösung: p-limit mit max 10 parallelen Requests

### Session-Cookies
- Claude/Perplexity Sessions laufen ab
- Lösung: Manuelle Erneuerung oder MCP Server

## API-Notizen

### Polymarket
- CLOB API: `https://clob.polymarket.com`
- Gamma API: `https://gamma-api.polymarket.com`
- Keine API-Key nötig für öffentliche Daten

### Deutschland-Quellen
- Dawum: `https://api.dawum.de/`
- Bundestag: `https://search.dip.bundestag.de/api/v1/`

## Deployment

### GitHub Secrets
```
VPS_HOST=fluessiger.de
VPS_USER=deployer
VPS_SSH_KEY=<private-key>
```

### Lokale Secrets auf VPS
```
/var/www/polymarket-scanner/.env.local
```

## Wichtige Befehle

```bash
# Development
npm run dev          # Scanner starten
npm run dev:web      # Nur Web-Server

# Build
npm run build        # TypeScript kompilieren
npm run lint         # ESLint
npm run type-check   # Type-Check

# Production (auf VPS)
pm2 start ecosystem.config.cjs --env production
pm2 logs polymarket-scanner
pm2 restart polymarket-scanner
```

## @.claude Tags

- `@.claude/security` - Security-relevante Änderungen
- `@.claude/api` - API-Integrationen
- `@.claude/ui` - UI-Komponenten
- `@.claude/trading` - Trading-Logik
