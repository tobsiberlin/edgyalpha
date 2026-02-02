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
import { PolymarketClient } from '../api/polymarket.js';

const polymarketClient = new PolymarketClient();
import { newsTicker, TickerEvent } from '../ticker/index.js';
import { AlphaSignal, ScanResult, SystemStatus, ExecutionMode } from '../types/index.js';
import { runtimeState, StateChangeEvent } from '../runtime/state.js';
import { runBacktest, BacktestOptions, generateJsonReport, generateMarkdownReport } from '../backtest/index.js';
import { BacktestResult } from '../alpha/types.js';
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
        timestamp: Date.now(), // TODO: Echten Timestamp aus Log extrahieren
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
