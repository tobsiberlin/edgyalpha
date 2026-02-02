import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// Typen für better-sqlite3
type BetterSqlite3 = typeof import('better-sqlite3');
type Database = import('better-sqlite3').Database;

// Lazy-loaded Database module
let Database: BetterSqlite3 | null = null;
let loadError: Error | null = null;

function loadSqliteModule(): BetterSqlite3 {
  if (Database) return Database;
  if (loadError) throw loadError;

  try {
    // Dynamic require für native Module
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Database = require('better-sqlite3') as BetterSqlite3;
    return Database;
  } catch (err) {
    loadError = new Error(
      'better-sqlite3 nicht verfügbar. ' +
      'Installiere Build-Tools auf dem Server:\n' +
      '  apt-get install python3 build-essential\n' +
      '  npm rebuild better-sqlite3\n' +
      `Original-Fehler: ${(err as Error).message}`
    );
    throw loadError;
  }
}

// Singleton-Instanz
let db: Database | null = null;

/**
 * Prüft ob SQLite verfügbar ist (ohne Fehler zu werfen)
 */
export function isSqliteAvailable(): boolean {
  try {
    loadSqliteModule();
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialisiert die Datenbank und führt Migrations aus
 */
export function initDatabase(): Database {
  if (db) {
    return db;
  }

  const SqliteDatabase = loadSqliteModule();
  const dbPath = config.sqlitePath;
  const dbDir = path.dirname(dbPath);

  // Erstelle data/ Verzeichnis falls nicht existiert
  if (!fs.existsSync(dbDir)) {
    logger.info(`Erstelle Verzeichnis: ${dbDir}`);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  logger.info(`Initialisiere SQLite Datenbank: ${dbPath}`);

  // Datenbank öffnen/erstellen
  db = new SqliteDatabase(dbPath, {
    verbose: process.env.NODE_ENV === 'development' ? (msg: unknown) => logger.debug(`SQL: ${msg}`) : undefined,
  });

  // WAL-Modus für bessere Performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Schema ausführen
  runMigrations(db);

  logger.info('SQLite Datenbank erfolgreich initialisiert');

  return db;
}

/**
 * Findet den Schema-Pfad (funktioniert in dev und prod)
 */
function findSchemaPath(): string {
  // Mögliche Pfade: src/ (dev) oder dist/ (prod)
  const possiblePaths = [
    path.resolve(process.cwd(), 'src', 'storage', 'schema.sql'),
    path.resolve(process.cwd(), 'dist', 'storage', 'schema.sql'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(`Schema-Datei nicht gefunden. Geprüfte Pfade: ${possiblePaths.join(', ')}`);
}

/**
 * Führt die Schema-Migration aus
 */
function runMigrations(database: Database): void {
  const schemaPath = findSchemaPath();

  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // Schema-Statements einzeln ausführen
  const statements = schema
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0 && !stmt.startsWith('--'));

  let successCount = 0;
  let skipCount = 0;

  for (const statement of statements) {
    try {
      database.exec(statement);
      successCount++;
    } catch (error) {
      // Ignoriere bekannte harmlose Fehler
      const msg = error instanceof Error ? error.message : '';
      const isHarmless =
        msg.includes('already exists') ||
        msg.includes('no such table') ||  // Index für nicht-existente Tabelle
        msg.includes('duplicate column');

      if (isHarmless) {
        skipCount++;
        logger.debug(`Migration übersprungen: ${msg.substring(0, 50)}`);
      } else {
        logger.warn(`Migration-Fehler (ignoriert): ${statement.substring(0, 80)}... → ${msg}`);
        skipCount++;
      }
    }
  }

  logger.info(`Schema-Migration: ${successCount} OK, ${skipCount} übersprungen`);
}

/**
 * Gibt die Datenbank-Instanz zurück
 * @throws Error wenn Datenbank nicht initialisiert
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error('Datenbank nicht initialisiert. Rufe zuerst initDatabase() auf.');
  }
  return db;
}

/**
 * Schließt die Datenbankverbindung
 */
export function closeDatabase(): void {
  if (db) {
    logger.info('Schließe SQLite Datenbank');
    db.close();
    db = null;
  }
}

/**
 * Prüft ob die Datenbank initialisiert ist
 */
export function isDatabaseInitialized(): boolean {
  return db !== null;
}

// Cleanup bei Prozess-Ende
process.on('exit', () => {
  closeDatabase();
});

process.on('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDatabase();
  process.exit(0);
});
