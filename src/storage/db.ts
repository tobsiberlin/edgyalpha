import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// Singleton-Instanz
let db: Database.Database | null = null;

/**
 * Initialisiert die Datenbank und führt Migrations aus
 */
export function initDatabase(): Database.Database {
  if (db) {
    return db;
  }

  const dbPath = config.sqlitePath;
  const dbDir = path.dirname(dbPath);

  // Erstelle data/ Verzeichnis falls nicht existiert
  if (!fs.existsSync(dbDir)) {
    logger.info(`Erstelle Verzeichnis: ${dbDir}`);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  logger.info(`Initialisiere SQLite Datenbank: ${dbPath}`);

  // Datenbank öffnen/erstellen
  db = new Database(dbPath, {
    verbose: process.env.NODE_ENV === 'development' ? (msg) => logger.debug(`SQL: ${msg}`) : undefined,
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
function runMigrations(database: Database.Database): void {
  const schemaPath = findSchemaPath();

  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // Schema-Statements einzeln ausführen
  const statements = schema
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0 && !stmt.startsWith('--'));

  for (const statement of statements) {
    try {
      database.exec(statement);
    } catch (error) {
      // Ignoriere "already exists" Fehler bei CREATE INDEX IF NOT EXISTS
      if (error instanceof Error && !error.message.includes('already exists')) {
        logger.error(`Migration-Fehler bei Statement: ${statement.substring(0, 100)}...`);
        throw error;
      }
    }
  }

  logger.info(`${statements.length} Schema-Statements ausgeführt`);
}

/**
 * Gibt die Datenbank-Instanz zurück
 * @throws Error wenn Datenbank nicht initialisiert
 */
export function getDatabase(): Database.Database {
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
