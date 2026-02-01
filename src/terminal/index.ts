import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { scanner } from '../scanner/index.js';
import { germanySources } from '../germany/index.js';
import { config } from '../utils/config.js';
import { AlphaSignal, ScanResult } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════
//              POLYMARKET ALPHA SCANNER - TERMINAL UI
//                    Matrix-Ästhetik Dashboard
// ═══════════════════════════════════════════════════════════════

export function startTerminalUI(): void {
  // Screen erstellen
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Polymarket Alpha Scanner',
  });

  // Grid Layout
  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  // ═══════════════════════════════════════════════════════════════
  //                        HEADER
  // ═══════════════════════════════════════════════════════════════
  const _header = grid.set(0, 0, 1, 12, blessed.box, {
    content:
      '{center}{bold}{green-fg}⚡ POLYMARKET ALPHA SCANNER ⚡{/green-fg}{/bold}{/center}',
    tags: true,
    style: {
      fg: 'green',
      bg: 'black',
      border: { fg: 'green' },
    },
  });

  // ═══════════════════════════════════════════════════════════════
  //                      SIGNAL TABLE
  // ═══════════════════════════════════════════════════════════════
  const signalTable = grid.set(1, 0, 6, 8, contrib.table, {
    keys: true,
    fg: 'green',
    selectedFg: 'black',
    selectedBg: 'green',
    interactive: true,
    label: ' 🎯 Alpha Signale ',
    border: { type: 'line', fg: 'green' },
    columnSpacing: 2,
    columnWidth: [40, 10, 10, 8],
  });

  signalTable.setData({
    headers: ['Markt', 'Score', 'Edge', 'Richtung'],
    data: [['Warte auf Scan...', '--', '--', '--']],
  });

  // ═══════════════════════════════════════════════════════════════
  //                      STATUS BOX
  // ═══════════════════════════════════════════════════════════════
  const statusBox = grid.set(1, 8, 3, 4, blessed.box, {
    label: ' 📊 Status ',
    tags: true,
    border: { type: 'line', fg: 'green' },
    style: { fg: 'green', border: { fg: 'green' } },
  });

  function updateStatus(): void {
    const status = scanner.getStatus();
    const uptime = Math.floor(process.uptime());
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;

    statusBox.setContent(
      `{bold}Scanner:{/bold} ${status.isScanning ? '{yellow-fg}AKTIV{/yellow-fg}' : '{green-fg}BEREIT{/green-fg}'}\n` +
      `{bold}Uptime:{/bold} ${h}h ${m}m ${s}s\n` +
      `{bold}Scans:{/bold} ${status.totalScans}\n` +
      `{bold}Signale:{/bold} ${status.lastSignalsCount}\n` +
      `{bold}Intervall:{/bold} ${config.scanner.intervalMs / 1000}s`
    );
    screen.render();
  }

  // ═══════════════════════════════════════════════════════════════
  //                      GERMANY BOX
  // ═══════════════════════════════════════════════════════════════
  const germanyBox = grid.set(4, 8, 3, 4, blessed.box, {
    label: ' 🇩🇪 Deutschland ',
    tags: true,
    border: { type: 'line', fg: 'yellow' },
    style: { fg: 'yellow', border: { fg: 'yellow' } },
  });

  function updateGermany(): void {
    const polls = germanySources.getLatestPolls();
    const news = germanySources.getLatestNews();

    let content = `{bold}Umfragen:{/bold} ${polls.length}\n`;
    content += `{bold}News:{/bold} ${news.length}\n`;

    if (polls.length > 0) {
      const latest = polls[0];
      content += `\n{bold}Letzte Umfrage:{/bold}\n`;
      content += `${latest.institute}\n`;

      const top3 = Object.entries(latest.results)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .slice(0, 3);

      for (const [party, value] of top3) {
        content += `${party}: ${value}%\n`;
      }
    }

    germanyBox.setContent(content);
    screen.render();
  }

  // ═══════════════════════════════════════════════════════════════
  //                      LOG WINDOW
  // ═══════════════════════════════════════════════════════════════
  const logWindow = grid.set(7, 0, 5, 12, contrib.log, {
    fg: 'green',
    selectedFg: 'green',
    label: ' 📜 Konsole ',
    border: { type: 'line', fg: 'green' },
    style: { fg: 'green', border: { fg: 'green' } },
  });

  function log(message: string): void {
    const time = new Date().toLocaleTimeString('de-DE');
    logWindow.log(`[${time}] ${message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                      SCANNER EVENTS
  // ═══════════════════════════════════════════════════════════════
  scanner.on('scan_started', () => {
    log('🔍 Scan gestartet...');
    updateStatus();
  });

  scanner.on('scan_completed', (result: ScanResult) => {
    log(`✅ Scan abgeschlossen: ${result.marketsScanned} Märkte, ${result.signalsFound.length} Signale`);

    const tableData = result.signalsFound.slice(0, 10).map((signal: AlphaSignal) => [
      signal.market.question.substring(0, 38) + (signal.market.question.length > 38 ? '..' : ''),
      `${(signal.score * 100).toFixed(0)}%`,
      `+${(signal.edge * 100).toFixed(1)}%`,
      signal.direction,
    ]);

    if (tableData.length === 0) {
      tableData.push(['Keine Signale gefunden', '--', '--', '--']);
    }

    signalTable.setData({
      headers: ['Markt', 'Score', 'Edge', 'Richtung'],
      data: tableData,
    });

    updateStatus();
    updateGermany();
  });

  scanner.on('signal_found', (signal: AlphaSignal) => {
    const emoji = signal.germanSource ? '🇩🇪' : '📈';
    log(`${emoji} Signal: ${signal.market.question.substring(0, 50)}... | Score: ${(signal.score * 100).toFixed(0)}%`);
  });

  // ═══════════════════════════════════════════════════════════════
  //                      KEY BINDINGS
  // ═══════════════════════════════════════════════════════════════
  screen.key(['escape', 'q', 'C-c'], () => {
    log('Beende...');
    scanner.stop();
    setTimeout(() => process.exit(0), 500);
  });

  screen.key(['s'], async () => {
    log('Manueller Scan gestartet...');
    await scanner.scan();
  });

  screen.key(['r'], () => {
    updateStatus();
    updateGermany();
    log('UI aktualisiert');
  });

  // ═══════════════════════════════════════════════════════════════
  //                      HELP
  // ═══════════════════════════════════════════════════════════════
  log('═══════════════════════════════════════════════════════');
  log('⚡ POLYMARKET ALPHA SCANNER');
  log('═══════════════════════════════════════════════════════');
  log('Tasten: [S] Scan | [R] Refresh | [Q] Beenden');
  log('═══════════════════════════════════════════════════════');

  // Initial Updates
  updateStatus();
  updateGermany();

  // Status-Update alle 5 Sekunden
  setInterval(updateStatus, 5000);

  // Render
  screen.render();
}

// Direct Execution
if (process.argv[1]?.includes('terminal')) {
  startTerminalUI();
}

export default startTerminalUI;
