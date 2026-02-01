import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { join } from 'path';
import cookieSession from 'cookie-session';
import { config, PORT, WEB_USERNAME, WEB_PASSWORD_HASH, WALLET_PRIVATE_KEY, WALLET_ADDRESS } from '../utils/config.js';
import logger from '../utils/logger.js';
import { scanner } from '../scanner/index.js';
import { germanySources } from '../germany/index.js';
import { tradingClient } from '../api/trading.js';
import { AlphaSignal, ScanResult, SystemStatus } from '../types/index.js';

// Use process.cwd() for paths (works with both ESM and CJS)
const publicPath = join(process.cwd(), 'src', 'web', 'public');

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Middleware
app.use(cookieSession({
  name: 'edgyalpha_session',
  keys: [WEB_PASSWORD_HASH || 'edgy-alpha-secret-key-2026'],
  maxAge: 24 * 60 * 60 * 1000, // 24 Stunden
  httpOnly: true,
  sameSite: 'lax',
}));

// Session Auth Middleware
const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
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

// Health Check (ohne Auth)
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    version: '1.7.0',
    timestamp: new Date().toISOString(),
  });
});

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

// Login verarbeiten
app.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (username === WEB_USERNAME && password === (WEB_PASSWORD_HASH || 'admin')) {
    if (req.session) {
      req.session.authenticated = true;
      req.session.username = username;
    }
    logger.info(`Login erfolgreich: ${username}`);
    res.redirect('/');
    return;
  }

  logger.warn(`Login fehlgeschlagen: ${username}`);
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

  const status: SystemStatus = {
    uptime: process.uptime(),
    lastScan: scannerStatus.lastScan,
    totalScans: scannerStatus.totalScans,
    signalsToday: lastResult?.signalsFound.length || 0,
    tradesToday: 0, // TODO: Implementieren
    pnlToday: 0, // TODO: Implementieren
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

// API: Trade bestätigen
app.post('/api/trade/:signalId', requireAuth, async (req: Request, res: Response) => {
  const { signalId } = req.params;
  const { direction } = req.body;

  // 1. Prüfe ob Trading aktiviert
  if (!config.trading.enabled) {
    res.json({
      success: false,
      error: 'Trading ist deaktiviert. Aktiviere TRADING_ENABLED=true in .env',
    });
    return;
  }

  // 2. Prüfe ob Wallet konfiguriert
  if (!WALLET_PRIVATE_KEY || !WALLET_ADDRESS) {
    res.json({
      success: false,
      error: 'Wallet nicht konfiguriert. Setze WALLET_PRIVATE_KEY und WALLET_ADDRESS in .env',
    });
    return;
  }

  // 3. Prüfe Balance
  try {
    const balance = await tradingClient.getWalletBalance();
    if (balance.usdc < 1) {
      res.json({
        success: false,
        error: `Nicht genug USDC. Verfügbar: $${balance.usdc.toFixed(2)}. Minimum: $1.00`,
      });
      return;
    }

    // 4. Trade loggen (echte CLOB Integration kommt später)
    logger.info(`Trade bestätigt: ${signalId} -> ${direction}`);
    logger.info(`Balance: $${balance.usdc.toFixed(2)} USDC`);

    res.json({
      success: true,
      message: `Trade ${direction} für Signal ${signalId} vorbereitet`,
      note: 'CLOB API Integration kommt im nächsten Update. Trade wurde geloggt.',
      balance: balance.usdc,
    });
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
  });
}

export { app, httpServer, io };
export default startWebServer;
