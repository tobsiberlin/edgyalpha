import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { join } from 'path';
import cookieSession from 'cookie-session';
import bcrypt from 'bcrypt';
import { config, PORT, NODE_ENV, WEB_USERNAME, WEB_PASSWORD_HASH, WEB_SESSION_SECRET, WEB_ALLOWED_ORIGINS, WEB_AUTH_ENABLED, WALLET_PRIVATE_KEY, WALLET_ADDRESS } from '../utils/config.js';
import logger from '../utils/logger.js';
import { scanner } from '../scanner/index.js';
import { germanySources } from '../germany/index.js';
import { tradingClient } from '../api/trading.js';
import { PolymarketClient } from '../api/polymarket.js';

const polymarketClient = new PolymarketClient();
import { newsTicker, TickerEvent } from '../ticker/index.js';
import { AlphaSignal, ScanResult, SystemStatus, ExecutionMode, GermanSource } from '../types/index.js';
import { runtimeState, StateChangeEvent } from '../runtime/state.js';
import { watchdog } from '../runtime/watchdog.js';
import { runBacktest, BacktestOptions, generateJsonReport, generateMarkdownReport } from '../backtest/index.js';
import { BacktestResult, SourceEvent } from '../alpha/types.js';
import { fuzzyMatch, MatchResult } from '../alpha/matching.js';
import { getStats } from '../storage/repositories/historical.js';
import { initDatabase } from '../storage/db.js';
import { getSystemHealthDashboard } from '../storage/repositories/pipelineHealth.js';
import { getAuditLog } from '../storage/repositories/riskState.js';
import { getSignalsByMarket } from '../storage/repositories/signals.js';

// Backtest State
interface BacktestState {
  running: boolean;
  progress: number;
  currentPhase: string;
  result: BacktestResult | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

let backtestState: BacktestState = {
  running: false,
  progress: 0,
  currentPhase: 'idle',
  result: null,
  error: null,
  startedAt: null,
  completedAt: null,
};

// ═══════════════════════════════════════════════════════════════
//                    SECURITY VALIDATION
// ═══════════════════════════════════════════════════════════════

// Validate required secrets when auth is enabled
// WARNUNG statt CRASH - damit der Server trotzdem startet
if (WEB_AUTH_ENABLED) {
  if (!WEB_PASSWORD_HASH) {
    logger.warn('⚠️ SECURITY WARNUNG: WEB_PASSWORD_HASH fehlt!');
    logger.warn('→ Fallback auf unsicheres Default-Passwort "admin"');
    logger.warn('→ Generiere einen Hash mit: node -e "console.log(require(\'bcrypt\').hashSync(\'deinPasswort\', 10))"');
  }
  if (!WEB_SESSION_SECRET || WEB_SESSION_SECRET.length < 32) {
    logger.warn('⚠️ SECURITY WARNUNG: WEB_SESSION_SECRET fehlt oder ist zu kurz!');
    logger.warn('→ Generiere ein Secret mit: openssl rand -hex 32');
  }
}

// Parse allowed origins for CORS
const allowedOrigins = WEB_ALLOWED_ORIGINS
  .split(',')
  .map(origin => origin.trim())
  .filter(origin => origin.length > 0);

logger.info(`CORS erlaubte Origins: ${allowedOrigins.join(', ')}`);

// ═══════════════════════════════════════════════════════════════
//                    RATE LIMITING
// ═══════════════════════════════════════════════════════════════

interface RateLimitEntry {
  attempts: number;
  firstAttempt: number;
  blockedUntil: number | null;
}

const loginRateLimits = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;  // 1 Minute
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 5 * 60 * 1000;  // 5 Minuten Block nach zu vielen Versuchen

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = loginRateLimits.get(ip);

  // Keine vorherigen Versuche
  if (!entry) {
    loginRateLimits.set(ip, { attempts: 1, firstAttempt: now, blockedUntil: null });
    return { allowed: true };
  }

  // Blockiert?
  if (entry.blockedUntil && now < entry.blockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
  }

  // Window abgelaufen? Reset
  if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    loginRateLimits.set(ip, { attempts: 1, firstAttempt: now, blockedUntil: null });
    return { allowed: true };
  }

  // Zu viele Versuche?
  if (entry.attempts >= MAX_LOGIN_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_DURATION_MS;
    logger.warn(`Login Rate Limit: IP ${ip} blockiert für ${BLOCK_DURATION_MS / 1000}s`);
    return { allowed: false, retryAfter: BLOCK_DURATION_MS / 1000 };
  }

  // Noch erlaubt, Zähler erhöhen
  entry.attempts++;
  return { allowed: true };
}

function resetLoginRateLimit(ip: string): void {
  loginRateLimits.delete(ip);
}

// Cleanup alte Einträge alle 5 Minuten
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginRateLimits.entries()) {
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS * 2 && (!entry.blockedUntil || now > entry.blockedUntil)) {
      loginRateLimits.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
//                    EXPRESS SETUP
// ═══════════════════════════════════════════════════════════════

// Use process.cwd() for paths (works with both ESM and CJS)
const publicPath = join(process.cwd(), 'src', 'web', 'public');

const app = express();
const httpServer = createServer(app);

// Socket.io mit CORS Allowlist (NICHT origin: '*')
const io = new SocketServer(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Erlaube Requests ohne Origin (z.B. mobile Apps, curl)
      if (!origin) {
        callback(null, true);
        return;
      }
      // Prüfe gegen Allowlist
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn(`Socket.io CORS blockiert Origin: ${origin}`);
        callback(new Error('CORS not allowed'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Middleware mit sicheren Cookie-Einstellungen
app.use(cookieSession({
  name: 'edgyalpha_session',
  keys: WEB_SESSION_SECRET ? [WEB_SESSION_SECRET] : ['dev-only-insecure-key'],
  maxAge: 24 * 60 * 60 * 1000, // 24 Stunden
  httpOnly: true,  // Kein JavaScript-Zugriff auf Cookie
  sameSite: 'strict',  // CSRF-Schutz: Cookie nur bei Same-Site Requests
  secure: NODE_ENV === 'production',  // HTTPS only in Production
}));

// Session Auth Middleware
const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  // Auth deaktiviert? Alle Requests durchlassen
  if (!WEB_AUTH_ENABLED) {
    next();
    return;
  }

  if (req.session?.authenticated) {
    next();
    return;
  }

  // API-Requests: JSON-Fehler
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Nicht eingeloggt' });
    return;
  }

  // Browser-Requests: Redirect zum Login
  res.redirect('/login');
};

// Static files NACH session middleware, aber VOR auth für login.html
app.use('/login', express.static(join(publicPath, 'login.html')));
app.use(express.static(publicPath));

// ═══════════════════════════════════════════════════════════════
//                        PUBLIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Health Check (ohne Auth) - auf beiden Pfaden für Kompatibilität
const healthCheckHandler = (_req: Request, res: Response) => {
  const scannerStatus = scanner.getStatus();
  const state = runtimeState.getState();

  // Detaillierter Health-Check
  const checks = {
    server: true,
    scanner: !scannerStatus.isScanning || scannerStatus.totalScans > 0,
    websocket: io.engine.clientsCount >= 0,
    database: true, // wird unten geprüft
  };

  try {
    // DB Check
    const { getDatabase } = require('../storage/db.js');
    getDatabase();
  } catch {
    checks.database = false;
  }

  const allHealthy = Object.values(checks).every(v => v);

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'degraded',
    uptime: process.uptime(),
    version: '1.8.0',
    timestamp: new Date().toISOString(),
    checks,
    scanner: {
      isScanning: scannerStatus.isScanning,
      totalScans: scannerStatus.totalScans,
      lastScan: scannerStatus.lastScan,
    },
    connections: io.engine.clientsCount,
    mode: state.executionMode,
    killSwitch: state.killSwitchActive,
  });
};

app.get('/health', healthCheckHandler);
app.get('/api/health', healthCheckHandler);

// ═══════════════════════════════════════════════════════════════
//                        LOGIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Login-Seite
app.get('/login', (req: Request, res: Response) => {
  // Bereits eingeloggt? -> Dashboard
  if (req.session?.authenticated) {
    res.redirect('/');
    return;
  }
  res.sendFile(join(publicPath, 'login.html'));
});

// Login verarbeiten (mit Rate Limiting und bcrypt)
app.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  const clientIp = getClientIp(req);

  // Rate Limit prüfen
  const rateLimitCheck = checkLoginRateLimit(clientIp);
  if (!rateLimitCheck.allowed) {
    logger.warn(`Login Rate Limit erreicht für IP: ${clientIp}`);
    res.status(429).redirect(`/login?error=ratelimit&retry=${rateLimitCheck.retryAfter}`);
    return;
  }

  // Username prüfen
  if (username !== WEB_USERNAME) {
    logger.warn(`Login fehlgeschlagen (falscher Username): ${username} von IP ${clientIp}`);
    res.redirect('/login?error=1');
    return;
  }

  // Passwort via bcrypt prüfen (wenn Hash vorhanden)
  let passwordValid = false;
  if (WEB_PASSWORD_HASH) {
    try {
      passwordValid = await bcrypt.compare(password, WEB_PASSWORD_HASH);
    } catch (err) {
      logger.error(`bcrypt Fehler: ${(err as Error).message}`);
      res.redirect('/login?error=1');
      return;
    }
  } else if (NODE_ENV !== 'production') {
    // Nur in Development: Fallback ohne Hash (NICHT in Production erlaubt)
    logger.warn('WARNUNG: Login ohne WEB_PASSWORD_HASH (nur in Development erlaubt)');
    passwordValid = password === 'admin';  // Default-Passwort nur für Dev
  }

  if (passwordValid) {
    // Erfolgreicher Login - Rate Limit zurücksetzen
    resetLoginRateLimit(clientIp);

    if (req.session) {
      req.session.authenticated = true;
      req.session.username = username;
    }
    logger.info(`Login erfolgreich: ${username} von IP ${clientIp}`);
    res.redirect('/');
    return;
  }

  logger.warn(`Login fehlgeschlagen (falsches Passwort): ${username} von IP ${clientIp}`);
  res.redirect('/login?error=1');
});

// Logout
app.get('/logout', (req: Request, res: Response) => {
  req.session = null;
  res.redirect('/login');
});

// ═══════════════════════════════════════════════════════════════
//                        PROTECTED ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Dashboard HTML (geschützt)
app.get('/', requireAuth, (_req: Request, res: Response) => {
  res.sendFile(join(publicPath, 'index.html'));
});

// PWA Manifest
app.get('/manifest.json', (_req: Request, res: Response) => {
  res.json({
    name: 'Polymarket Alpha Scanner',
    short_name: 'AlphaScanner',
    description: 'Polymarket Trading Scanner mit Deutschland Information Edge',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#00ff00',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
});

// API: System Status
app.get('/api/status', requireAuth, (_req: Request, res: Response) => {
  const scannerStatus = scanner.getStatus();
  const lastResult = scanner.getLastResult();
  const riskDashboard = runtimeState.getRiskDashboard();

  const status: SystemStatus = {
    uptime: process.uptime(),
    lastScan: scannerStatus.lastScan,
    totalScans: scannerStatus.totalScans,
    signalsToday: lastResult?.signalsFound.length || 0,
    tradesToday: riskDashboard.daily.trades,
    pnlToday: riskDashboard.daily.pnl,
    isScanning: scannerStatus.isScanning,
    errors: lastResult?.errors || [],
  };

  res.json(status);
});

// API: Alle Signale
app.get('/api/signals', requireAuth, (_req: Request, res: Response) => {
  const result = scanner.getLastResult();
  res.json(result?.signalsFound || []);
});

// API: Märkte
app.get('/api/markets', requireAuth, (_req: Request, res: Response) => {
  const result = scanner.getLastResult();
  const markets = result?.signalsFound.map((s) => s.market) || [];
  res.json(markets);
});

// API: Manuellen Scan starten
app.post('/api/scan', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await scanner.scan();
    res.json(result);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// API: Deutschland-Daten
app.get('/api/germany/polls', requireAuth, (_req: Request, res: Response) => {
  res.json(germanySources.getLatestPolls());
});

app.get('/api/germany/news', requireAuth, (_req: Request, res: Response) => {
  res.json(germanySources.getLatestNews());
});

app.get('/api/germany/bundestag', requireAuth, (_req: Request, res: Response) => {
  res.json(germanySources.getBundestagItems());
});

// API: Deutschland News mit Polymarket Matches (Almanien Intelligence)
app.get('/api/germany/matches', requireAuth, async (_req: Request, res: Response) => {
  try {
    // 1. Deutsche News holen
    const news = germanySources.getLatestNews();

    // 2. Aktuelle Polymarket-Märkte holen
    const scanResult = scanner.getLastResult();
    const markets = scanResult?.signalsFound.map(s => s.market) || [];

    // Falls keine Märkte aus dem Scanner, direkt von Polymarket holen
    let allMarkets = markets;
    if (allMarkets.length < 10) {
      try {
        const polymarketMarkets = await polymarketClient.getMarkets({ limit: 100, active: true });
        allMarkets = [...allMarkets, ...polymarketMarkets];
        // Duplikate entfernen
        const seen = new Set<string>();
        allMarkets = allMarkets.filter(m => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
      } catch (err) {
        logger.warn(`Konnte Polymarket-Märkte nicht laden: ${(err as Error).message}`);
      }
    }

    // WICHTIG: Für Almanien NUR echte Deutschland-Märkte!
    // Filtere US-Politik, UK-Politik etc. HERAUS
    const almanienMarkets = allMarkets.filter(m =>
      germanySources.isAlmanienRelevantMarket(m.question)
    );

    logger.info(`Almanien: ${almanienMarkets.length}/${allMarkets.length} Märkte haben echten Deutschland-Bezug`);

    // Verwende nur die gefilterten Märkte für Matching
    const marketsForMatching = almanienMarkets;

    // 3. News zu SourceEvents konvertieren für Matching
    const matches: Array<{
      news: {
        id: string;
        source: string;
        title: string;
        url?: string;
        category: string;
        publishedAt: string;
        content?: string;
      };
      marketMatches: Array<{
        marketId: string;
        question: string;
        slug: string;
        confidence: number;
        matchedKeywords: string[];
        matchedEntities: string[];
        reasoning: string;
        polymarketUrl: string;
        currentPrice?: number;
        timeAdvantageMinutes?: number;
      }>;
    }> = [];

    for (const newsItem of news.slice(0, 50)) {
      // News zu SourceEvent konvertieren
      const sourceEvent: SourceEvent = {
        eventHash: (newsItem.data.hash as string) || `${newsItem.data.source}:${newsItem.title}`.substring(0, 200),
        sourceId: (newsItem.data.source as string) || 'unknown',
        sourceName: (newsItem.data.source as string) || 'Deutsche Quelle',
        url: newsItem.url || null,
        title: newsItem.title,
        content: (newsItem.data.content as string) || null,
        category: (newsItem.data.category as string) || 'news',
        keywords: (newsItem.data.keywords as string[]) || [],
        publishedAt: newsItem.publishedAt,
        ingestedAt: new Date(),
        reliabilityScore: 0.8,
      };

      // Matching durchführen - NUR gegen Almanien-relevante Märkte
      const newsMatches = fuzzyMatch(sourceEvent, marketsForMatching);

      if (newsMatches.length > 0) {
        // Zeitvorsprung berechnen (geschätzt)
        const newsAge = newsItem.publishedAt
          ? Math.floor((Date.now() - new Date(newsItem.publishedAt).getTime()) / (1000 * 60))
          : undefined;

        matches.push({
          news: {
            id: sourceEvent.eventHash,
            source: (newsItem.data.source as string) || 'Unbekannt',
            title: newsItem.title,
            url: newsItem.url,
            category: (newsItem.data.category as string) || 'news',
            publishedAt: newsItem.publishedAt?.toISOString() || new Date().toISOString(),
            content: (newsItem.data.content as string)?.substring(0, 200),
          },
          marketMatches: newsMatches.slice(0, 3).map(match => {
            const market = marketsForMatching.find(m => m.id === match.marketId);
            return {
              marketId: match.marketId,
              question: market?.question || 'Unbekannt',
              slug: market?.slug || match.marketId,
              confidence: match.confidence,
              matchedKeywords: match.matchedKeywords,
              matchedEntities: match.matchedEntities,
              reasoning: match.reasoning,
              polymarketUrl: `https://polymarket.com/event/${market?.slug || match.marketId}`,
              currentPrice: market?.outcomes?.[0]?.price,
              timeAdvantageMinutes: newsAge,
            };
          }),
        });
      }
    }

    // Nach bester Match-Confidence sortieren
    matches.sort((a, b) => {
      const maxA = Math.max(...a.marketMatches.map(m => m.confidence));
      const maxB = Math.max(...b.marketMatches.map(m => m.confidence));
      return maxB - maxA;
    });

    res.json({
      matches,
      totalNews: news.length,
      matchedNews: matches.length,
      marketsChecked: marketsForMatching.length,
      totalMarketsAvailable: allMarkets.length,
      almanienRelevantMarkets: almanienMarkets.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const error = err as Error;
    logger.error(`Germany Matches Fehler: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//                    POLYMARKET API
// ═══════════════════════════════════════════════════════════════

// API: Market Details
app.get('/api/polymarket/market/:marketId', requireAuth, async (req: Request, res: Response) => {
  const { marketId } = req.params;
  try {
    const market = await polymarketClient.getMarketById(marketId);
    if (!market) {
      res.status(404).json({ error: 'Markt nicht gefunden' });
      return;
    }
    res.json(market);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// API: Price History für Charts
app.get('/api/polymarket/prices/:tokenId', requireAuth, async (req: Request, res: Response) => {
  const { tokenId } = req.params;
  const fidelity = parseInt(String(req.query?.fidelity || '60'), 10);

  try {
    const history = await polymarketClient.getPriceHistory(tokenId, fidelity);
    res.json({
      tokenId,
      fidelity,
      points: history,
      count: history.length,
    });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// API: Signals für einen Markt (für Chart-Marker)
app.get('/api/signals/market/:marketId', requireAuth, (req: Request, res: Response) => {
  const { marketId } = req.params;
  try {
    const signals = getSignalsByMarket(marketId);
    // Nur die relevanten Felder für Marker zurückgeben
    const markers = signals.map(s => ({
      signalId: s.signalId,
      alphaType: s.alphaType,
      direction: s.direction,
      predictedEdge: s.predictedEdge,
      confidence: s.confidence,
      createdAt: s.createdAt,
    }));
    res.json({ marketId, signals: markers });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//                    LIVE TICKER API
// ═══════════════════════════════════════════════════════════════

app.get('/api/ticker/stats', requireAuth, (_req: Request, res: Response) => {
  res.json(newsTicker.getStats());
});

app.get('/api/ticker/recent', requireAuth, (req: Request, res: Response) => {
  const limit = parseInt(String(req.query?.limit || '20'), 10);
  res.json(newsTicker.getRecentTicks(limit));
});

app.get('/api/ticker/markets', requireAuth, (_req: Request, res: Response) => {
  res.json({ count: newsTicker.getMarketCount() });
});

// API: Konfiguration
app.get('/api/config', requireAuth, (_req: Request, res: Response) => {
  res.json({
    scanner: config.scanner,
    trading: {
      enabled: config.trading.enabled,
      requireConfirmation: config.trading.requireConfirmation,
      maxBetUsdc: config.trading.maxBetUsdc,
      maxBankrollUsdc: config.trading.maxBankrollUsdc,
      riskPerTradePercent: config.trading.riskPerTradePercent,
    },
    germany: config.germany,
    wallet: {
      configured: !!(WALLET_PRIVATE_KEY && WALLET_ADDRESS),
      address: WALLET_ADDRESS ? `${WALLET_ADDRESS.substring(0, 6)}...${WALLET_ADDRESS.substring(38)}` : null,
    },
  });
});

// API: Wallet Balance
app.get('/api/wallet', requireAuth, async (_req: Request, res: Response) => {
  // Wallet nicht konfiguriert
  if (!WALLET_PRIVATE_KEY || !WALLET_ADDRESS) {
    res.json({
      configured: false,
      error: 'Wallet nicht konfiguriert. Setze WALLET_PRIVATE_KEY und WALLET_ADDRESS in .env',
      usdc: 0,
      matic: 0,
    });
    return;
  }

  try {
    const balance = await tradingClient.getWalletBalance();
    res.json({
      configured: true,
      address: `${WALLET_ADDRESS.substring(0, 6)}...${WALLET_ADDRESS.substring(38)}`,
      usdc: balance.usdc,
      matic: balance.matic,
    });
  } catch (err) {
    const error = err as Error;
    logger.error(`Wallet Balance Fehler: ${error.message}`);
    res.json({
      configured: true,
      error: 'Balance konnte nicht geladen werden',
      usdc: 0,
      matic: 0,
    });
  }
});

// API: Trade bestätigen und ausführen
app.post('/api/trade/:signalId', requireAuth, async (req: Request, res: Response) => {
  const { signalId } = req.params;
  const { direction, amount } = req.body;
  const tradeAmount = amount || config.trading.maxBetUsdc;

  // 1. Execution Mode und Kill-Switch prüfen
  const state = runtimeState.getState();
  const canTradeCheck = runtimeState.canTrade();

  if (!canTradeCheck.allowed) {
    res.json({
      success: false,
      error: canTradeCheck.reason,
    });
    return;
  }

  // 2. Signal finden
  const lastResult = scanner.getLastResult();
  const signal = lastResult?.signalsFound.find(s => s.id === signalId);

  if (!signal) {
    res.json({
      success: false,
      error: 'Signal nicht gefunden. Möglicherweise veraltet - bitte Scan neu starten.',
    });
    return;
  }

  // 3. Token-ID aus Market extrahieren
  const outcomeLabel = direction === 'YES' ? 'Yes' : 'No';
  const outcome = signal.market.outcomes.find(o => o.name.toLowerCase() === outcomeLabel.toLowerCase());
  const tokenId = outcome?.id;

  if (!tokenId || tokenId.startsWith('outcome-')) {
    res.json({
      success: false,
      error: `Keine gültige Token-ID für ${outcomeLabel}. Markt möglicherweise nicht handelbar.`,
    });
    return;
  }

  // 4. Execution basierend auf Mode
  try {
    const executionMode = state.executionMode;

    // PAPER MODE: Nur simulieren
    if (executionMode === 'paper') {
      logger.info(`[PAPER] Web Trade: ${direction} $${tradeAmount} auf ${signal.market.question.substring(0, 50)}...`);

      // Paper Trade im Risk State tracken (Position öffnen)
      runtimeState.openPosition(
        signal.market.id,
        tradeAmount,
        direction.toLowerCase() as 'yes' | 'no',
        outcome?.price || 0.5
      );

      // WebSocket Event
      io.emit('trade_executed', {
        mode: 'paper',
        direction,
        amount: tradeAmount,
        market: signal.market.question.substring(0, 50),
      });

      res.json({
        success: true,
        mode: 'paper',
        message: 'Paper Trade simuliert',
        direction,
        amount: tradeAmount,
        price: outcome?.price,
      });
      return;
    }

    // SHADOW MODE: Simulieren + Quote holen
    if (executionMode === 'shadow') {
      logger.info(`[SHADOW] Web Trade: ${direction} $${tradeAmount} auf ${signal.market.question.substring(0, 50)}...`);

      // Versuche echtes Orderbook zu holen für realistische Simulation
      let fillPrice = outcome?.price || 0.5;
      if (tradingClient.isClobReady()) {
        const orderbook = await tradingClient.getOrderbook(tokenId);
        if (orderbook && orderbook.asks.length > 0) {
          fillPrice = orderbook.asks[0].price;
        }
      }

      runtimeState.openPosition(
        signal.market.id,
        tradeAmount,
        direction.toLowerCase() as 'yes' | 'no',
        fillPrice
      );

      io.emit('trade_executed', {
        mode: 'shadow',
        direction,
        amount: tradeAmount,
        market: signal.market.question.substring(0, 50),
        fillPrice,
      });

      res.json({
        success: true,
        mode: 'shadow',
        message: 'Shadow Trade simuliert (mit echtem Quote)',
        direction,
        amount: tradeAmount,
        fillPrice,
      });
      return;
    }

    // LIVE MODE: Echter Trade
    // Zusätzliche Checks für Live
    if (!config.trading.enabled) {
      res.json({
        success: false,
        error: 'Trading ist deaktiviert. Aktiviere TRADING_ENABLED=true in .env',
      });
      return;
    }

    if (!WALLET_PRIVATE_KEY || !WALLET_ADDRESS) {
      res.json({
        success: false,
        error: 'Wallet nicht konfiguriert für Live-Trading.',
      });
      return;
    }

    if (!tradingClient.isClobReady()) {
      res.json({
        success: false,
        error: 'CLOB Client nicht bereit. Bitte warten oder Server neu starten.',
      });
      return;
    }

    // Balance prüfen
    const balance = await tradingClient.getWalletBalance();
    if (balance.usdc < tradeAmount) {
      res.json({
        success: false,
        error: `Nicht genug USDC. Verfügbar: $${balance.usdc.toFixed(2)}, benötigt: $${tradeAmount}`,
      });
      return;
    }

    logger.info(`[LIVE] Web Trade: ${direction} $${tradeAmount} auf ${signal.market.question.substring(0, 50)}...`);

    // Echte Order platzieren
    const orderResult = await tradingClient.placeMarketOrder({
      tokenId,
      side: 'BUY',
      amount: tradeAmount,
    });

    if (orderResult.success) {
      // Risk State updaten (Position öffnen)
      runtimeState.openPosition(
        signal.market.id,
        tradeAmount,
        direction.toLowerCase() as 'yes' | 'no',
        orderResult.fillPrice || outcome?.price || 0.5
      );

      io.emit('trade_executed', {
        mode: 'live',
        direction,
        amount: tradeAmount,
        market: signal.market.question.substring(0, 50),
        orderId: orderResult.orderId,
        fillPrice: orderResult.fillPrice,
      });

      res.json({
        success: true,
        mode: 'live',
        message: 'Trade erfolgreich ausgeführt!',
        orderId: orderResult.orderId,
        fillPrice: orderResult.fillPrice,
        amount: tradeAmount,
        direction,
      });
    } else {
      res.json({
        success: false,
        error: orderResult.error || 'Order fehlgeschlagen',
      });
    }

  } catch (err) {
    const error = err as Error;
    logger.error(`Trade Fehler: ${error.message}`);
    res.json({
      success: false,
      error: `Trade fehlgeschlagen: ${error.message}`,
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//                    RUNTIME CONTROL API
// ═══════════════════════════════════════════════════════════════

// API: Risk Dashboard (Daily PnL, Positions, Limits, Kill-Switch)
app.get('/api/risk/dashboard', requireAuth, (_req: Request, res: Response) => {
  res.json(runtimeState.getRiskDashboard());
});

// API: Kill-Switch Toggle
app.post('/api/risk/killswitch', requireAuth, (req: Request, res: Response) => {
  const { action, reason } = req.body;

  if (action === 'activate') {
    runtimeState.activateKillSwitch(reason || 'Manuell via Web aktiviert', 'web');
    res.json({
      success: true,
      killSwitchActive: true,
      message: 'Kill-Switch aktiviert. Alle Trades gestoppt.',
    });
  } else if (action === 'deactivate') {
    runtimeState.deactivateKillSwitch('web');
    res.json({
      success: true,
      killSwitchActive: false,
      message: 'Kill-Switch deaktiviert. Trading wieder möglich.',
    });
  } else if (action === 'toggle') {
    const newState = runtimeState.toggleKillSwitch('web');
    res.json({
      success: true,
      killSwitchActive: newState,
      message: newState ? 'Kill-Switch aktiviert' : 'Kill-Switch deaktiviert',
    });
  } else {
    res.status(400).json({ error: 'action muss "activate", "deactivate" oder "toggle" sein' });
  }
});

// API: Execution Mode ändern (paper/shadow/live)
app.post('/api/execution/mode', requireAuth, (req: Request, res: Response) => {
  const { mode } = req.body as { mode: ExecutionMode };

  if (!['paper', 'shadow', 'live'].includes(mode)) {
    res.status(400).json({ error: 'mode muss "paper", "shadow" oder "live" sein' });
    return;
  }

  const result = runtimeState.setExecutionMode(mode, 'web');

  if (result.success) {
    res.json({
      success: true,
      mode: runtimeState.getExecutionMode(),
      message: result.message,
    });
  } else {
    res.status(400).json({
      success: false,
      mode: runtimeState.getExecutionMode(),
      error: result.message,
    });
  }
});

// API: Aktuellen Execution Mode abrufen
app.get('/api/execution/mode', requireAuth, (_req: Request, res: Response) => {
  const canTrade = runtimeState.canTrade();
  res.json({
    mode: runtimeState.getExecutionMode(),
    canTrade: canTrade.allowed,
    reason: canTrade.reason,
  });
});

// API: Runtime Settings ändern
app.post('/api/settings', requireAuth, (req: Request, res: Response) => {
  const {
    maxBetUsdc,
    riskPerTradePercent,
    minEdge,
    minAlpha,
    minVolumeUsd,
    maxDailyLoss,
    maxPositions,
    maxPerMarket,
  } = req.body;

  const updates: Record<string, number> = {};

  if (maxBetUsdc !== undefined) updates.maxBetUsdc = Number(maxBetUsdc);
  if (riskPerTradePercent !== undefined) updates.riskPerTradePercent = Number(riskPerTradePercent);
  if (minEdge !== undefined) updates.minEdge = Number(minEdge);
  if (minAlpha !== undefined) updates.minAlpha = Number(minAlpha);
  if (minVolumeUsd !== undefined) updates.minVolumeUsd = Number(minVolumeUsd);
  if (maxDailyLoss !== undefined) updates.maxDailyLoss = Number(maxDailyLoss);
  if (maxPositions !== undefined) updates.maxPositions = Number(maxPositions);
  if (maxPerMarket !== undefined) updates.maxPerMarket = Number(maxPerMarket);

  runtimeState.updateSettings(updates, 'web');

  res.json({
    success: true,
    message: 'Einstellungen aktualisiert',
    settings: runtimeState.getState(),
  });
});

// API: Alle Settings abrufen (fuer Settings-Seite)
app.get('/api/settings/all', requireAuth, (_req: Request, res: Response) => {
  const state = runtimeState.getState();

  res.json({
    trading: {
      maxDailyLoss: state.maxDailyLoss,
      maxPositions: state.maxPositions,
      maxPerMarket: state.maxPerMarket,
      maxBetUsdc: state.maxBetUsdc,
      riskPerTradePercent: state.riskPerTradePercent,
      kellyFraction: config.trading.kellyFraction,
      bankroll: config.trading.maxBankrollUsdc,
      executionMode: state.executionMode,
    },
    signals: {
      minAlpha: state.minAlpha,
      minEdge: state.minEdge,
      minVolumeUsd: state.minVolumeUsd,
    },
    germany: config.germany,
    telegram: {
      enabled: config.telegram.enabled,
      configured: !!(config.telegram.botToken && config.telegram.chatId),
    },
  });
});

// API: Runtime State (vollständig)
app.get('/api/runtime', requireAuth, (_req: Request, res: Response) => {
  res.json(runtimeState.toJSON());
});

// API: Pipeline Health - Ehrliches Reporting
app.get('/api/pipelines/health', requireAuth, (_req: Request, res: Response) => {
  const state = runtimeState.getState();
  const now = new Date();

  // Stale-Berechnung (älter als 10 Minuten = stale)
  const staleThreshold = 10 * 60 * 1000;

  type PipelineName = keyof typeof state.pipelineHealth;
  const pipelineNames: PipelineName[] = ['polymarket', 'rss', 'dawum', 'telegram'];

  const pipelines = pipelineNames.map((name) => {
    const health = state.pipelineHealth[name];
    const lastSuccessAgo = health.lastSuccess
      ? now.getTime() - health.lastSuccess.getTime()
      : null;

    // Ehrlicher Status:
    // - 'unknown': Nie erfolgreich gelaufen (lastSuccess === null)
    // - 'error': 3+ aufeinanderfolgende Fehler
    // - 'stale': lastSuccess > 10 Minuten alt
    // - 'ok': Alles gut
    let status: 'ok' | 'stale' | 'error' | 'unknown';

    if (!health.lastSuccess) {
      status = 'unknown';
    } else if (health.errorCount >= 3) {
      status = 'error';
    } else if (lastSuccessAgo !== null && lastSuccessAgo > staleThreshold) {
      status = 'stale';
    } else {
      status = 'ok';
    }

    // healthy nur wenn status === 'ok'
    const healthy = status === 'ok';

    return {
      name,
      healthy,
      lastSuccess: health.lastSuccess,
      lastSuccessAgo: lastSuccessAgo ? Math.round(lastSuccessAgo / 1000) : null,
      errorCount: health.errorCount,
      status,
    };
  });

  // Overall: Nur healthy wenn ALLE Pipelines 'ok' sind
  const overallHealthy = pipelines.every(p => p.status === 'ok');
  const hasUnknown = pipelines.some(p => p.status === 'unknown');
  const hasErrors = pipelines.some(p => p.status === 'error');

  res.json({
    pipelines,
    overall: overallHealthy,
    overallStatus: hasErrors ? 'error' : hasUnknown ? 'unknown' : overallHealthy ? 'healthy' : 'degraded',
    lastScan: state.lastScanAt,
    lastSignal: state.lastSignalAt,
  });
});

// API: Daily Reset (manuell)
app.post('/api/risk/reset', requireAuth, (_req: Request, res: Response) => {
  runtimeState.resetDaily();
  res.json({
    success: true,
    message: 'Täglicher Risk-Reset durchgeführt',
    dashboard: runtimeState.getRiskDashboard(),
  });
});

// API: Watchdog Status (Selbstheilungs-Service)
app.get('/api/watchdog', requireAuth, (_req: Request, res: Response) => {
  res.json(watchdog.getStats());
});

// API: Watchdog manuell triggern
app.post('/api/watchdog/check', requireAuth, async (_req: Request, res: Response) => {
  try {
    const healthy = await watchdog.runChecks();
    res.json({
      success: true,
      healthy,
      stats: watchdog.getStats(),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: (err as Error).message,
    });
  }
});

// API: System Health Dashboard (erweitert mit Stale-Data Detection)
app.get('/api/system/health', requireAuth, (_req: Request, res: Response) => {
  try {
    const dashboard = getSystemHealthDashboard();
    res.json(dashboard);
  } catch (err) {
    // Fallback wenn DB nicht verfügbar
    const state = runtimeState.getState();
    res.json({
      overall: 'degraded',
      pipelines: Object.entries(state.pipelineHealth).map(([name, health]) => ({
        pipelineName: name,
        lastSuccessAt: health.lastSuccess,
        consecutiveErrors: health.errorCount,
        isHealthy: health.healthy,
        isStale: false,
      })),
      freshness: [],
      staleAlerts: ['Pipeline Health DB nicht verfügbar'],
      timestamp: new Date(),
    });
  }
});

// API: Audit Log (letzte Einträge)
app.get('/api/audit', requireAuth, (req: Request, res: Response) => {
  const limit = parseInt(String(req.query?.limit || '50'), 10);
  try {
    const logs = getAuditLog(limit);
    res.json({
      entries: logs,
      count: logs.length,
      limit,
    });
  } catch (err) {
    res.json({
      entries: [],
      count: 0,
      limit,
      error: (err as Error).message,
    });
  }
});

// API: Execution Quality Metrics
app.get('/api/execution/quality', requireAuth, (_req: Request, res: Response) => {
  try {
    // Import dynamisch da das Modul noch neu ist
    import('../alpha/executionQuality.js').then(({ executionQualityMonitor }) => {
      res.json(executionQualityMonitor.toJSON());
    }).catch(err => {
      res.json({
        metrics: null,
        error: 'Execution Quality Monitor nicht verfügbar',
        message: (err as Error).message,
      });
    });
  } catch (err) {
    res.json({
      metrics: null,
      error: (err as Error).message,
    });
  }
});

// API: Notification Stats (Push-Policy Monitoring)
app.get('/api/notifications/stats', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { getNotificationState, getNotificationSettings } = await import('../notifications/rateLimiter.js');
    const { getCandidateStats } = await import('../storage/repositories/newsCandidates.js');

    const state = getNotificationState();
    const settings = getNotificationSettings(process.env.TELEGRAM_CHAT_ID || '');
    const candidateStats = getCandidateStats();

    // Push-Log Statistiken aus DB
    const db = (await import('../storage/db.js')).getDatabase();
    const today = new Date().toISOString().split('T')[0];
    const hour = new Date();
    hour.setHours(hour.getHours() - 1);

    const pushesTodayRow = db.prepare(`
      SELECT COUNT(*) as count FROM notification_push_log
      WHERE DATE(sent_at) = ? AND suppressed = 0
    `).get(today) as { count: number } | undefined;

    const pushesLastHourRow = db.prepare(`
      SELECT COUNT(*) as count FROM notification_push_log
      WHERE sent_at > ? AND suppressed = 0
    `).get(hour.toISOString()) as { count: number } | undefined;

    const suppressedTodayRow = db.prepare(`
      SELECT COUNT(*) as count, suppression_reason FROM notification_push_log
      WHERE DATE(sent_at) = ? AND suppressed = 1
      GROUP BY suppression_reason
    `).all(today) as Array<{ count: number; suppression_reason: string }>;

    res.json({
      currentState: {
        lastPushAt: state.lastPushAt,
        pushesToday: state.pushesToday,
        maxPerDay: settings.maxPerDay,
        cooldownMinutes: settings.cooldownMinutes,
        pushMode: settings.pushMode,
        quietHoursEnabled: settings.quietHoursEnabled,
        quietHours: `${settings.quietHoursStart}-${settings.quietHoursEnd}`,
      },
      stats: {
        pushesLastHour: pushesLastHourRow?.count || 0,
        pushesToday: pushesTodayRow?.count || 0,
        suppressedToday: suppressedTodayRow.reduce((sum, r) => sum + r.count, 0),
        suppressionReasons: suppressedTodayRow,
      },
      candidates: candidateStats,
      quietHoursQueue: state.quietHoursQueue.length,
    });
  } catch (err) {
    res.json({
      error: (err as Error).message,
      currentState: null,
      stats: null,
    });
  }
});

// API: Equity Curve (kumuliertes PnL über Zeit)
app.get('/api/stats/equity', requireAuth, (_req: Request, res: Response) => {
  try {
    // Hole alle Trade-Events aus dem Audit Log
    const allLogs = getAuditLog(1000);
    const tradeLogs = allLogs
      .filter(log => log.eventType === 'trade' && log.pnlImpact !== undefined)
      .reverse(); // Älteste zuerst

    // Kumuliere PnL
    let cumulativePnl = 0;
    const equityPoints: { timestamp: number; pnl: number; cumulative: number }[] = [];

    for (const log of tradeLogs) {
      cumulativePnl += log.pnlImpact || 0;
      equityPoints.push({
        timestamp: log.createdAt || Date.now(), // Echten Timestamp aus Audit-Log verwenden
        pnl: log.pnlImpact || 0,
        cumulative: cumulativePnl,
      });
    }

    // Aktueller Risk State
    const dashboard = runtimeState.getRiskDashboard();

    res.json({
      equityCurve: equityPoints,
      current: {
        dailyPnL: dashboard.daily.pnl,
        dailyTrades: dashboard.daily.trades,
        dailyWins: dashboard.daily.wins,
        dailyLosses: dashboard.daily.losses,
        winRate: dashboard.daily.winRate,
      },
      totalTrades: tradeLogs.length,
      totalPnL: cumulativePnl,
    });
  } catch (err) {
    res.json({
      equityCurve: [],
      current: runtimeState.getRiskDashboard().daily,
      totalTrades: 0,
      totalPnL: 0,
      error: (err as Error).message,
    });
  }
});

// API: Trading Stats (Win/Loss, Edge Capture)
app.get('/api/stats/trading', requireAuth, (_req: Request, res: Response) => {
  const dashboard = runtimeState.getRiskDashboard();

  res.json({
    daily: {
      pnl: dashboard.daily.pnl,
      trades: dashboard.daily.trades,
      wins: dashboard.daily.wins,
      losses: dashboard.daily.losses,
      winRate: dashboard.daily.winRate,
    },
    positions: {
      open: dashboard.positions.open,
      max: dashboard.positions.max,
      totalExposure: dashboard.positions.totalExposure,
    },
    limits: {
      dailyLossLimit: dashboard.limits.dailyLossLimit,
      dailyLossRemaining: dashboard.limits.dailyLossRemaining,
    },
    mode: dashboard.mode,
    killSwitch: dashboard.killSwitch,
  });
});

// ═══════════════════════════════════════════════════════════════
//                    BACKTEST API
// ═══════════════════════════════════════════════════════════════

// API: Historische Daten Stats
app.get('/api/backtest/data', requireAuth, (_req: Request, res: Response) => {
  try {
    initDatabase();
    const stats = getStats();
    res.json({
      available: stats.tradeCount > 0,
      tradeCount: stats.tradeCount,
      marketCount: stats.marketCount,
      resolvedCount: stats.resolvedCount,
      dateRange: stats.dateRange,
    });
  } catch (err) {
    const error = err as Error;
    res.json({
      available: false,
      error: error.message,
      hint: 'Importiere Daten mit: npm run import:polydata',
    });
  }
});

// API: Backtest Status
app.get('/api/backtest/status', requireAuth, (_req: Request, res: Response) => {
  res.json({
    running: backtestState.running,
    progress: backtestState.progress,
    currentPhase: backtestState.currentPhase,
    hasResult: backtestState.result !== null,
    error: backtestState.error,
    startedAt: backtestState.startedAt,
    completedAt: backtestState.completedAt,
  });
});

// API: Backtest Results
app.get('/api/backtest/results', requireAuth, (req: Request, res: Response) => {
  if (!backtestState.result) {
    res.status(404).json({ error: 'Kein Backtest-Ergebnis verfügbar' });
    return;
  }

  const { format } = req.query;

  if (format === 'markdown') {
    const md = generateMarkdownReport(backtestState.result);
    res.type('text/markdown').send(md);
  } else if (format === 'json-file') {
    const json = generateJsonReport(backtestState.result);
    res.type('application/json').send(json);
  } else if (format === 'csv') {
    // CSV Export
    const { trades } = backtestState.result;
    const header = 'signalId,marketId,direction,entryPrice,exitPrice,size,pnl,predictedEdge,actualEdge,slippage\n';
    const rows = trades.map(t =>
      `${t.signalId},${t.marketId},${t.direction},${t.entryPrice},${t.exitPrice ?? ''},${t.size},${t.pnl ?? ''},${t.predictedEdge},${t.actualEdge ?? ''},${t.slippage}`
    ).join('\n');
    res.type('text/csv').attachment('backtest_trades.csv').send(header + rows);
  } else {
    // Standard: Zusammenfassung für UI mit Equity Curve
    const { engine, period, metrics, calibration, trades } = backtestState.result;

    // Equity Curve berechnen
    const initialBankroll = backtestState.result.trades.length > 0 ? 1000 : 0;
    let cumulative = initialBankroll;
    let peak = initialBankroll;
    const equityCurve: { index: number; equity: number; pnl: number; drawdown: number }[] = [];

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      if (t.pnl !== null) {
        cumulative += t.pnl;
        if (cumulative > peak) peak = cumulative;
        const drawdown = peak > 0 ? (peak - cumulative) / peak : 0;
        equityCurve.push({
          index: i,
          equity: cumulative,
          pnl: t.pnl,
          drawdown,
        });
      }
    }

    // Erweiterte Metriken
    const completedTrades = trades.filter(t => t.pnl !== null);
    const wins = completedTrades.filter(t => (t.pnl ?? 0) > 0);
    const losses = completedTrades.filter(t => (t.pnl ?? 0) < 0);

    const grossProfit = wins.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    res.json({
      engine,
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      metrics: {
        ...metrics,
        profitFactor,
        avgWin,
        avgLoss,
        grossProfit,
        grossLoss,
        winCount: wins.length,
        lossCount: losses.length,
      },
      calibration,
      tradeCount: trades.length,
      equityCurve,
      topTrades: trades
        .filter(t => t.pnl !== null)
        .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
        .slice(0, 10)
        .map(t => ({
          marketId: t.marketId,
          direction: t.direction,
          entryPrice: t.entryPrice,
          pnl: t.pnl,
          predictedEdge: t.predictedEdge,
          actualEdge: t.actualEdge,
        })),
      worstTrades: trades
        .filter(t => t.pnl !== null)
        .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
        .slice(0, 10)
        .map(t => ({
          marketId: t.marketId,
          direction: t.direction,
          entryPrice: t.entryPrice,
          pnl: t.pnl,
          predictedEdge: t.predictedEdge,
          actualEdge: t.actualEdge,
        })),
    });
  }
});

// API: Backtest starten
app.post('/api/backtest', requireAuth, async (req: Request, res: Response) => {
  // Bereits laufend?
  if (backtestState.running) {
    res.status(409).json({
      error: 'Backtest läuft bereits',
      progress: backtestState.progress,
      currentPhase: backtestState.currentPhase,
    });
    return;
  }

  const { engine, from, to, bankroll, slippage } = req.body;

  // Validierung
  if (!['timeDelay', 'mispricing', 'meta'].includes(engine)) {
    res.status(400).json({ error: 'engine muss "timeDelay", "mispricing" oder "meta" sein' });
    return;
  }

  // State reset
  backtestState = {
    running: true,
    progress: 0,
    currentPhase: 'Initialisiere...',
    result: null,
    error: null,
    startedAt: new Date(),
    completedAt: null,
  };

  // Emit start event
  io.emit('backtest_started', {
    engine,
    from,
    to,
    bankroll: bankroll || 1000,
  });

  // Respond immediately
  res.json({
    success: true,
    message: 'Backtest gestartet',
    engine,
  });

  // Run backtest in background
  try {
    // Progress updates
    backtestState.currentPhase = 'Lade historische Daten...';
    backtestState.progress = 10;
    io.emit('backtest_progress', { progress: 10, phase: backtestState.currentPhase });

    const options: BacktestOptions = {
      engine: engine as 'timeDelay' | 'mispricing' | 'meta',
      from: from ? new Date(from) : new Date('2024-01-01'),
      to: to ? new Date(to) : new Date(),
      initialBankroll: bankroll || 1000,
      slippageEnabled: slippage !== false,
    };

    backtestState.currentPhase = 'Simuliere Trades...';
    backtestState.progress = 30;
    io.emit('backtest_progress', { progress: 30, phase: backtestState.currentPhase });

    const result = await runBacktest(options);

    backtestState.currentPhase = 'Berechne Metriken...';
    backtestState.progress = 80;
    io.emit('backtest_progress', { progress: 80, phase: backtestState.currentPhase });

    // Done
    backtestState.running = false;
    backtestState.progress = 100;
    backtestState.currentPhase = 'Fertig';
    backtestState.result = result;
    backtestState.completedAt = new Date();

    io.emit('backtest_completed', {
      success: true,
      engine: result.engine,
      tradeCount: result.trades.length,
      totalPnl: result.metrics.totalPnl,
      winRate: result.metrics.winRate,
      sharpeRatio: result.metrics.sharpeRatio,
    });

    logger.info(`Backtest abgeschlossen: ${result.trades.length} Trades, PnL=$${result.metrics.totalPnl.toFixed(2)}`);
  } catch (err) {
    const error = err as Error;
    backtestState.running = false;
    backtestState.error = error.message;
    backtestState.currentPhase = 'Fehler';

    io.emit('backtest_error', { error: error.message });
    logger.error(`Backtest Fehler: ${error.message}`);
  }
});

// API: Backtest abbrechen
app.post('/api/backtest/cancel', requireAuth, (_req: Request, res: Response) => {
  if (!backtestState.running) {
    res.status(400).json({ error: 'Kein Backtest läuft' });
    return;
  }

  // TODO: Implement cancellation (needs backtest engine support)
  res.json({
    success: false,
    message: 'Abbrechen wird noch nicht unterstützt',
  });
});

// ═══════════════════════════════════════════════════════════════
//                        WEBSOCKET
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  logger.debug(`WebSocket Client verbunden: ${socket.id}`);

  // Initial Status senden
  const status = scanner.getStatus();
  socket.emit('status', status);

  // Letzte Signale senden
  const lastResult = scanner.getLastResult();
  if (lastResult) {
    socket.emit('scan_completed', lastResult);
  }

  socket.on('disconnect', () => {
    logger.debug(`WebSocket Client getrennt: ${socket.id}`);
  });

  // Manuellen Scan anfordern
  socket.on('request_scan', async () => {
    try {
      const result = await scanner.scan();
      socket.emit('scan_completed', result);
    } catch (err) {
      const error = err as Error;
      socket.emit('error', { message: error.message });
    }
  });
});

// Scanner Events an WebSocket weiterleiten
scanner.on('scan_started', () => {
  io.emit('scan_started');
});

scanner.on('scan_completed', (result: ScanResult) => {
  io.emit('scan_completed', result);
});

scanner.on('signal_found', (signal: AlphaSignal) => {
  io.emit('signal_found', signal);
});

// TimeDelayEngine Signals
scanner.on('time_delay_signal', (signal: unknown) => {
  io.emit('time_delay_signal', signal);
});

// ═══════════════════════════════════════════════════════════════
//                    LIVE TICKER EVENTS
// ═══════════════════════════════════════════════════════════════

newsTicker.on('tick', (event: TickerEvent) => {
  io.emit('ticker', event);
});

// Ticker Match Events für Dashboard
newsTicker.on('ticker:match_found', (data: {
  newsId: string;
  newsTitle: string;
  newsSource: string;
  bestMatch: { marketId: string; question: string; confidence: number; price: number; direction: string };
}) => {
  io.emit('ticker_match', {
    newsTitle: data.newsTitle,
    newsSource: data.newsSource,
    marketId: data.bestMatch.marketId,
    question: data.bestMatch.question,
    confidence: data.bestMatch.confidence,
    direction: data.bestMatch.direction,
    price: data.bestMatch.price,
    timestamp: new Date(),
  });
});

// Ticker starten wenn Server startet
newsTicker.start().catch(err => {
  logger.error(`Ticker Start Fehler: ${err.message}`);
});

// ═══════════════════════════════════════════════════════════════
//                    RUNTIME STATE EVENTS
// ═══════════════════════════════════════════════════════════════

// State-Changes an alle Clients broadcasten
runtimeState.on('stateChange', (event: StateChangeEvent) => {
  io.emit('runtime_state_change', event);
});

runtimeState.on('killSwitchActivated', (data: { reason: string; source: string }) => {
  io.emit('kill_switch', { active: true, ...data });
});

runtimeState.on('killSwitchDeactivated', (data: { previousReason: string; source: string }) => {
  io.emit('kill_switch', { active: false, ...data });
});

runtimeState.on('tradeRecorded', (data: { pnl: number; marketId: string; dailyPnL: number }) => {
  io.emit('trade_recorded', data);
  io.emit('risk_update', runtimeState.getRiskDashboard());
});

runtimeState.on('dailyReset', () => {
  io.emit('daily_reset', runtimeState.getRiskDashboard());
});

runtimeState.on('pipelineUnhealthy', (data: { pipeline: string; errorCount: number }) => {
  io.emit('pipeline_alert', data);
  // Browser Notification: Pipeline Error
  io.emit('browser_notification', {
    type: 'pipeline_error',
    title: 'Pipeline Fehler',
    body: `${data.pipeline} hat ${data.errorCount} Fehler`,
    icon: 'warning',
    urgency: 'high',
  });
});

// ═══════════════════════════════════════════════════════════════
//                    BROWSER NOTIFICATION EVENTS
// ═══════════════════════════════════════════════════════════════

// High-Alpha Signal gefunden (edge > 20%)
scanner.on('signal_found', (signal: AlphaSignal) => {
  if (signal.edge > 0.20) {
    io.emit('browser_notification', {
      type: 'high_alpha',
      title: 'HIGH ALPHA SIGNAL',
      body: `${signal.market?.question?.substring(0, 60) || 'Signal'} | Edge: ${(signal.edge * 100).toFixed(1)}%`,
      icon: 'alpha',
      urgency: 'high',
      data: { signalId: signal.id, edge: signal.edge },
    });
  }
});

// Kill-Switch aktiviert - Browser Notification
runtimeState.on('killSwitchActivated', (data: { reason: string; source: string }) => {
  io.emit('browser_notification', {
    type: 'risk_warning',
    title: 'KILL-SWITCH AKTIVIERT',
    body: data.reason,
    icon: 'danger',
    urgency: 'critical',
  });
});

// Trade ausgeführt + Daily Loss Limit Warnung
runtimeState.on('tradeRecorded', (data: { pnl: number; marketId: string; dailyPnL: number }) => {
  const dashboard = runtimeState.getRiskDashboard();
  const usedPercent = 1 - (dashboard.limits.dailyLossRemaining / dashboard.limits.dailyLossLimit);

  // Trade ausgeführt Notification
  io.emit('browser_notification', {
    type: 'trade_executed',
    title: 'TRADE AUSGEFÜHRT',
    body: `PnL: ${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)} | Daily: ${data.dailyPnL >= 0 ? '+' : ''}$${data.dailyPnL.toFixed(2)}`,
    icon: data.pnl >= 0 ? 'profit' : 'loss',
    urgency: 'medium',
    data: { marketId: data.marketId, pnl: data.pnl },
  });

  // Risk Warning wenn >80% des Daily Loss Limits verbraucht
  if (usedPercent > 0.8 && data.pnl < 0) {
    io.emit('browser_notification', {
      type: 'risk_warning',
      title: 'DAILY LIMIT WARNUNG',
      body: `${(usedPercent * 100).toFixed(0)}% des Tages-Limits verbraucht`,
      icon: 'warning',
      urgency: 'high',
    });
  }
});

// Almanien Zeitvorsprung gefunden (via Ticker)
newsTicker.on('tick', (event: TickerEvent) => {
  if (event.type === 'match_found' && event.matchResult?.found && event.matchResult.markets.length > 0) {
    const topMatch = event.matchResult.markets[0];
    io.emit('browser_notification', {
      type: 'almanien_edge',
      title: 'ALMANIEN ZEITVORSPRUNG',
      body: `${event.title?.substring(0, 50) || 'News'} -> ${topMatch.question?.substring(0, 30) || 'Markt'}`,
      icon: 'germany',
      urgency: 'high',
      data: { matchScore: topMatch.matchScore },
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//                    PERPLEXITY LLM ENGINE API
// ═══════════════════════════════════════════════════════════════

// API: LLM Engine Status
app.get('/api/llm/status', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { perplexityEngine } = await import('../alpha/perplexityEngine.js');
    res.json({
      active: perplexityEngine.isActive(),
      stats: perplexityEngine.getStats(),
    });
  } catch (err) {
    res.json({
      active: false,
      error: 'Perplexity Engine nicht verfügbar',
      message: (err as Error).message,
    });
  }
});

// API: LLM Engine Stats
app.get('/api/llm/stats', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { perplexityEngine } = await import('../alpha/perplexityEngine.js');
    res.json(perplexityEngine.toJSON());
  } catch (err) {
    res.json({
      stats: null,
      error: (err as Error).message,
    });
  }
});

// API: Recent LLM Signals
app.get('/api/llm/signals', requireAuth, async (req: Request, res: Response) => {
  const limit = parseInt(String(req.query?.limit || '20'), 10);
  try {
    const { perplexityEngine } = await import('../alpha/perplexityEngine.js');
    const signals = perplexityEngine.getSignals(limit);
    res.json({
      signals,
      count: signals.length,
      limit,
    });
  } catch (err) {
    res.json({
      signals: [],
      count: 0,
      error: (err as Error).message,
    });
  }
});

// API: Strong LLM Signals only
app.get('/api/llm/signals/strong', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { perplexityEngine } = await import('../alpha/perplexityEngine.js');
    const signals = perplexityEngine.getStrongSignals();
    res.json({
      signals,
      count: signals.length,
    });
  } catch (err) {
    res.json({
      signals: [],
      count: 0,
      error: (err as Error).message,
    });
  }
});

// API: Initialize LLM Engine
app.post('/api/llm/init', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { perplexityEngine } = await import('../alpha/perplexityEngine.js');

    if (perplexityEngine.isActive()) {
      res.json({
        success: false,
        message: 'Engine bereits aktiv',
        active: true,
      });
      return;
    }

    const success = await perplexityEngine.initialize();
    res.json({
      success,
      message: success ? 'Engine erfolgreich gestartet' : 'Initialisierung fehlgeschlagen',
      active: perplexityEngine.isActive(),
    });
  } catch (err) {
    res.json({
      success: false,
      error: (err as Error).message,
    });
  }
});

// API: Shutdown LLM Engine
app.post('/api/llm/shutdown', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { perplexityEngine } = await import('../alpha/perplexityEngine.js');
    await perplexityEngine.shutdown();
    res.json({
      success: true,
      message: 'Engine heruntergefahren',
      active: false,
    });
  } catch (err) {
    res.json({
      success: false,
      error: (err as Error).message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//                        ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(`Server Error: ${err.message}`);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

// ═══════════════════════════════════════════════════════════════
//                        SERVER START
// ═══════════════════════════════════════════════════════════════

export function startWebServer(): void {
  httpServer.listen(PORT, () => {
    logger.info(`Web-Server läuft auf Port ${PORT}`);
    logger.info(`Dashboard: http://localhost:${PORT}`);
    logger.info(`Health Check: http://localhost:${PORT}/health`);

    // Watchdog Service starten für automatische Selbstheilung
    watchdog.start();
    logger.info('Watchdog Service gestartet');

    // Watchdog Events loggen
    watchdog.on('checkFailed', (data: { name: string; critical: boolean }) => {
      logger.error(`[Watchdog] Check "${data.name}" fehlgeschlagen (critical: ${data.critical})`);
      io.emit('watchdog_alert', { type: 'check_failed', ...data });
    });

    watchdog.on('healAttempt', (data: { name: string }) => {
      logger.warn(`[Watchdog] Selbstheilung gestartet für: ${data.name}`);
      io.emit('watchdog_alert', { type: 'heal_attempt', ...data });
    });
  });
}

export { app, httpServer, io };
export default startWebServer;
