#!/usr/bin/env node

import { config, NODE_ENV } from './utils/config.js';
import logger from './utils/logger.js';
import { scanner } from './scanner/index.js';
import { telegramBot } from './telegram/index.js';
import { startWebServer } from './web/server.js';
import { germanySources } from './germany/index.js';
import { initDatabase, isSqliteAvailable } from './storage/db.js';
import { syncPositionsToRiskState } from './runtime/positionSync.js';

// ═══════════════════════════════════════════════════════════════
//                    POLYMARKET ALPHA SCANNER
//                      Main Entry Point
// ═══════════════════════════════════════════════════════════════

const BANNER = `
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     ⚡ POLYMARKET ALPHA SCANNER ⚡                            ║
║                                                               ║
║     🎯 Prediction Markets Scanner                             ║
║     🇩🇪 Deutschland Information Edge                          ║
║     📱 Telegram Alerts + 1-Click Trading                      ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`;

async function main(): Promise<void> {
  console.log('\x1b[32m' + BANNER + '\x1b[0m');

  logger.info('═══════════════════════════════════════════════════════');
  logger.info('  Polymarket Alpha Scanner wird gestartet...');
  logger.info('═══════════════════════════════════════════════════════');

  // 0. Datenbank initialisieren (MUSS zuerst passieren!)
  if (isSqliteAvailable()) {
    try {
      initDatabase();
      logger.info('  SQLite Datenbank: ✅ Initialisiert');
    } catch (err) {
      logger.error(`  SQLite Datenbank: ❌ ${(err as Error).message}`);
    }
  } else {
    logger.warn('  SQLite: Nicht verfügbar (Rate-Limiting deaktiviert)');
  }

  // 0.5. Position-Tracking mit Polymarket synchronisieren (KRITISCH nach Restart!)
  logger.info('Synchronisiere Positionen mit Polymarket...');
  try {
    const syncResult = await syncPositionsToRiskState();
    if (syncResult.synced) {
      logger.info(`  Positionen synchronisiert: ${syncResult.openPositions} offen, ${syncResult.totalExposure.toFixed(2)} USDC Exposure`);
    } else {
      logger.warn(`  Position-Sync übersprungen: ${syncResult.reason}`);
    }
  } catch (err) {
    logger.warn(`  Position-Sync Fehler (non-fatal): ${(err as Error).message}`);
  }
  logger.info(`  Environment: ${NODE_ENV}`);
  logger.info(`  Scan-Intervall: ${config.scanner.intervalMs / 1000}s`);
  logger.info(`  Min. Volume: $${config.scanner.minVolumeUsd.toLocaleString()}`);
  logger.info(`  Kategorien: ${config.scanner.categories.join(', ')}`);
  logger.info(`  Deutschland-Modus: ${config.germany.enabled ? 'Aktiv' : 'Inaktiv'}`);
  logger.info(`  Trading: ${config.trading.enabled ? 'Aktiv' : 'Inaktiv'}`);
  logger.info(`  Telegram: ${config.telegram.enabled ? 'Aktiv' : 'Inaktiv'}`);
  logger.info('═══════════════════════════════════════════════════════');

  try {
    // 1. Web-Server SOFORT starten (kritisch für Health-Checks)
    logger.info('Starte Web-Server...');
    startWebServer();

    // 2. Telegram Bot starten (falls aktiviert)
    if (config.telegram.enabled) {
      logger.info('Starte Telegram Bot...');
      telegramBot.start().catch(err => {
        logger.error(`Telegram Bot Fehler: ${err.message}`);
      });
    }

    // 3. Deutschland-Quellen parallel laden (non-blocking)
    if (config.germany.enabled) {
      logger.info('Lade Deutschland-Datenquellen (async)...');
      germanySources.fetchAll().then(() => {
        logger.info('Deutschland-Datenquellen geladen');
      }).catch(err => {
        logger.warn(`Deutschland-Daten Fehler (non-fatal): ${err.message}`);
      });
    }

    // 4. Scanner starten
    logger.info('Starte Alpha Scanner...');
    await scanner.start();

    logger.info('═══════════════════════════════════════════════════════');
    logger.info('  ✅ Alle Systeme ONLINE');
    logger.info('═══════════════════════════════════════════════════════');

    // Graceful Shutdown
    setupGracefulShutdown();

  } catch (err) {
    const error = err as Error;
    logger.error(`Startup-Fehler: ${error.message}`);
    logger.error(error.stack || '');
    process.exit(1);
  }
}

function setupGracefulShutdown(): void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} empfangen, fahre herunter...`);

    try {
      scanner.stop();
      logger.info('Scanner gestoppt');
    } catch (err) {
      logger.error(`Shutdown-Fehler: ${(err as Error).message}`);
    }

    logger.info('Auf Wiedersehen! 👋');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Unhandled Errors
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.message}`);
    logger.error(err.stack || '');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    process.exit(1);
  });
}

// Start
main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
