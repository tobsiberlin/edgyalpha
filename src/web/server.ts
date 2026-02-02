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
import { newsTicker, TickerEvent } from '../ticker/index.js';
import { AlphaSignal, ScanResult, SystemStatus, ExecutionMode } from '../types/index.js';
import { runtimeState, StateChangeEvent } from '../runtime/state.js';

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
    version: '1.8.0',
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

// API: Runtime State (vollständig)
app.get('/api/runtime', requireAuth, (_req: Request, res: Response) => {
  res.json(runtimeState.toJSON());
});

// API: Pipeline Health
app.get('/api/pipelines/health', requireAuth, (_req: Request, res: Response) => {
  const state = runtimeState.getState();
  const now = new Date();

  // Stale-Berechnung (älter als 10 Minuten = stale)
  const staleThreshold = 10 * 60 * 1000;

  const pipelines = Object.entries(state.pipelineHealth).map(([name, health]) => {
    const lastSuccessAgo = health.lastSuccess
      ? now.getTime() - health.lastSuccess.getTime()
      : null;
    const isStale = lastSuccessAgo !== null && lastSuccessAgo > staleThreshold;

    return {
      name,
      healthy: health.healthy && !isStale,
      lastSuccess: health.lastSuccess,
      lastSuccessAgo: lastSuccessAgo ? Math.round(lastSuccessAgo / 1000) : null,
      errorCount: health.errorCount,
      status: isStale ? 'stale' : health.healthy ? 'ok' : 'error',
    };
  });

  res.json({
    pipelines,
    overall: pipelines.every(p => p.healthy),
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
//                    LIVE TICKER EVENTS
// ═══════════════════════════════════════════════════════════════

newsTicker.on('tick', (event: TickerEvent) => {
  io.emit('ticker', event);
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
