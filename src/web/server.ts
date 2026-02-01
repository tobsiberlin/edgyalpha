import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { join } from 'path';
import { config, PORT, WEB_USERNAME, WEB_PASSWORD_HASH } from '../utils/config.js';
import logger from '../utils/logger.js';
import { scanner } from '../scanner/index.js';
import { germanySources } from '../germany/index.js';
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
app.use(express.static(publicPath));

// Basic Auth Middleware (für geschützte Routen)
const basicAuth = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Alpha Scanner"');
    res.status(401).json({ error: 'Authentifizierung erforderlich' });
    return;
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const [username, password] = credentials.split(':');

  // Einfache Passwort-Prüfung (in Produktion bcrypt verwenden)
  if (username === WEB_USERNAME && password === (WEB_PASSWORD_HASH || 'admin')) {
    next();
    return;
  }

  res.status(401).json({ error: 'Ungültige Zugangsdaten' });
};

// ═══════════════════════════════════════════════════════════════
//                        PUBLIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Health Check (ohne Auth)
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════
//                        PROTECTED ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Dashboard HTML
app.get('/', (_req: Request, res: Response) => {
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
app.get('/api/status', basicAuth, (_req: Request, res: Response) => {
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
app.get('/api/signals', basicAuth, (_req: Request, res: Response) => {
  const result = scanner.getLastResult();
  res.json(result?.signalsFound || []);
});

// API: Märkte
app.get('/api/markets', basicAuth, (_req: Request, res: Response) => {
  const result = scanner.getLastResult();
  const markets = result?.signalsFound.map((s) => s.market) || [];
  res.json(markets);
});

// API: Manuellen Scan starten
app.post('/api/scan', basicAuth, async (_req: Request, res: Response) => {
  try {
    const result = await scanner.scan();
    res.json(result);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// API: Deutschland-Daten
app.get('/api/germany/polls', basicAuth, (_req: Request, res: Response) => {
  res.json(germanySources.getLatestPolls());
});

app.get('/api/germany/news', basicAuth, (_req: Request, res: Response) => {
  res.json(germanySources.getLatestNews());
});

app.get('/api/germany/bundestag', basicAuth, (_req: Request, res: Response) => {
  res.json(germanySources.getBundestagItems());
});

// API: Konfiguration
app.get('/api/config', basicAuth, (_req: Request, res: Response) => {
  res.json({
    scanner: config.scanner,
    trading: {
      enabled: config.trading.enabled,
      requireConfirmation: config.trading.requireConfirmation,
      maxBetUsdc: config.trading.maxBetUsdc,
      riskPerTradePercent: config.trading.riskPerTradePercent,
    },
    germany: config.germany,
  });
});

// API: Trade bestätigen
app.post('/api/trade/:signalId', basicAuth, async (req: Request, res: Response) => {
  const { signalId } = req.params;
  const { direction } = req.body;

  // TODO: Echte Trade-Ausführung implementieren
  logger.info(`Trade bestätigt: ${signalId} -> ${direction}`);

  res.json({
    success: true,
    message: `Trade ${direction} für Signal ${signalId} wird ausgeführt`,
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
