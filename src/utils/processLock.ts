// ═══════════════════════════════════════════════════════════════
//                    PROCESS LOCK
//   Verhindert mehrere Instanzen des Servers gleichzeitig
//   MUSS als erstes Modul importiert werden!
// ═══════════════════════════════════════════════════════════════
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOCK_FILE = join(process.cwd(), 'data', '.scanner.lock');

// Diese Funktion wird beim Import automatisch ausgeführt
function initLock(): void {
  try {
    // Stelle sicher dass data/ existiert
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    if (existsSync(LOCK_FILE)) {
      const content = readFileSync(LOCK_FILE, 'utf-8');
      const pid = parseInt(content, 10);

      // Prüfe ob der Prozess noch läuft
      try {
        process.kill(pid, 0); // Signal 0 = prüft nur ob Prozess existiert
        // Prozess läuft noch - SOFORT abbrechen
        console.error(`\n❌ FEHLER: Eine andere Instanz läuft bereits (PID: ${pid})`);
        console.error(`   Falls das nicht stimmt, lösche: ${LOCK_FILE}\n`);
        process.exit(1);
      } catch {
        // Prozess läuft nicht mehr - altes Lock File, überschreiben
        console.log(`[LOCK] Stale lock file (PID ${pid} tot), überschreibe...`);
      }
    }

    // Lock erwerben
    writeFileSync(LOCK_FILE, String(process.pid));
    console.log(`[LOCK] Process Lock erworben (PID: ${process.pid})`);
  } catch (err) {
    console.error(`[LOCK] Fehler: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Sofort beim Import ausführen
initLock();

export function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
      console.log('[LOCK] Process Lock freigegeben');
    }
  } catch (err) {
    console.error(`[LOCK] Freigabe Fehler: ${(err as Error).message}`);
  }
}

export const PROCESS_LOCK_FILE = LOCK_FILE;
