import TelegramBot, { InlineKeyboardButton, InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { config, WALLET_PRIVATE_KEY } from '../utils/config.js';
import logger from '../utils/logger.js';
import { AlphaSignal, TradeRecommendation, ScanResult } from '../types/index.js';
import { scanner } from '../scanner/index.js';
import { tradingClient } from '../api/trading.js';
import { germanySources, BreakingNewsEvent } from '../germany/index.js';
import { newsTicker, TickerEvent } from '../ticker/index.js';
import { EventEmitter } from 'events';
import {
  AlphaSignalV2,
  Decision,
  CombinedSignal,
  formatTopFeatures,
  formatRiskGates,
  formatRiskGatesDetailed,
  getPolymarketUrl,
  buildTelegramAlert,
} from '../alpha/index.js';

// ═══════════════════════════════════════════════════════════════
//           EDGY ALPHA SCANNER - TELEGRAM BOT
//         Mit Almanien-Vorsprung | Kein Gelaber, nur Alpha
// ═══════════════════════════════════════════════════════════════

// Runtime-Settings (änderbar via Telegram)
const runtimeSettings = {
  maxBet: 10,
  risk: 10,
  minEdge: 5,
  minAlpha: 15,
  minVolume: 5000,
};

export class TelegramAlertBot extends EventEmitter {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private pendingTrades: Map<string, TradeRecommendation> = new Map();
  private editingField: string | null = null; // Welches Feld wird gerade bearbeitet?

  constructor() {
    super();
    this.chatId = config.telegram.chatId;
  }

  // ═══════════════════════════════════════════════════════════════
  //                      PROGRESS BAR HELPERS
  // ═══════════════════════════════════════════════════════════════

  private progressBar(value: number, max: number = 100, length: number = 10): string {
    const filled = Math.round((value / max) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  private scoreBar(score: number): string {
    const pct = Math.round(score * 100);
    return `${this.progressBar(pct, 100, 10)} ${pct}%`;
  }

  // ═══════════════════════════════════════════════════════════════
  //                      ASCII ART
  // ═══════════════════════════════════════════════════════════════

  private get HEADER(): string {
    return `
\`\`\`
╔══════════════════════════════════╗
║      🔥 EDGY ALPHA 🔥            ║
║   Almanien-Vorsprung aktiviert   ║
╚══════════════════════════════════╝
\`\`\``;
  }

  private get DIVIDER(): string {
    return `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\``;
  }

  // ═══════════════════════════════════════════════════════════════
  //                      START BOT
  // ═══════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    if (!config.telegram.enabled || !config.telegram.botToken) {
      logger.info('Telegram Bot deaktiviert');
      return;
    }

    try {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
      this.setupCommands();
      this.setupCallbackHandlers();
      this.setupScannerEvents();

      logger.info('Telegram Bot gestartet');
      await this.sendWelcome();
    } catch (err) {
      const error = err as Error;
      logger.error(`Telegram Bot Fehler: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      WELCOME MESSAGE
  // ═══════════════════════════════════════════════════════════════

  private async sendWelcome(): Promise<void> {
    const message = `${this.HEADER}

🟢 *Maschine läuft. Almanien-Vorsprung aktiviert.*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  KAMPFKONFIGURATION             │
├─────────────────────────────────┤
│  Scan:     alle 5 Min           │
│  Ziele:    Politik, Wirtschaft  │
│  Almanien: Scharf geschaltet    │
│  Trading:  Ein Klick zum Geld   │
└─────────────────────────────────┘
\`\`\`

*Was soll's sein, Chef?*`;

    const keyboard = this.getMainMenu();
    await this.sendMessageWithKeyboard(message, keyboard);
  }

  // ═══════════════════════════════════════════════════════════════
  //                      KEYBOARDS
  // ═══════════════════════════════════════════════════════════════

  private getMainMenu(): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: '🔥 ALPHA JAGEN', callback_data: 'action:scan' },
          { text: '📊 Status', callback_data: 'action:status' },
        ],
        [
          { text: '🎯 Signale', callback_data: 'action:signals' },
          { text: '💰 Kriegskasse', callback_data: 'action:wallet' },
        ],
        [
          { text: '📡 LIVE TICKER', callback_data: 'action:ticker' },
          { text: '📰 Almanien News', callback_data: 'action:news' },
        ],
        [
          { text: '🇩🇪 Sonntagsfrage', callback_data: 'action:polls' },
          { text: '⚙️ Einstellungen', callback_data: 'action:settings' },
        ],
      ],
    };
  }

  private getBackButton(): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [{ text: '◀️ Zurück zum Menü', callback_data: 'action:menu' }],
      ],
    };
  }

  private getSignalKeyboard(signalId: string): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: '🚀 JA BALLERN', callback_data: `trade:yes:${signalId}` },
          { text: '💀 NEIN BALLERN', callback_data: `trade:no:${signalId}` },
        ],
        [
          { text: '📊 Details', callback_data: `details:${signalId}` },
          { text: '🔬 Deep Dive', callback_data: `research:${signalId}` },
        ],
        [
          { text: '⏭️ Skip', callback_data: `skip:${signalId}` },
        ],
      ],
    };
  }

  private getConfirmTradeKeyboard(signalId: string, direction: string): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: '✅ Bestätigen', callback_data: `confirm:${direction}:${signalId}` },
          { text: '❌ Abbrechen', callback_data: `cancel:${signalId}` },
        ],
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //                      COMMANDS
  // ═══════════════════════════════════════════════════════════════

  private setupCommands(): void {
    if (!this.bot) return;

    this.bot.onText(/\/start/, async (msg) => {
      this.chatId = msg.chat.id.toString();
      await this.sendWelcome();
    });

    this.bot.onText(/\/menu/, async (msg) => {
      await this.sendMainMenu(msg.chat.id.toString());
    });

    // /scan - Starte einen Scan
    this.bot.onText(/\/scan/, async (msg) => {
      const chatId = msg.chat.id.toString();
      await this.sendMessage('🔥 *Starte Scan...*\n\n_Die Maschine rattert..._', chatId);

      try {
        const result = await scanner.scan();
        await this.sendScanResult(result, chatId);
      } catch (err) {
        await this.sendMessage('❌ Scan fehlgeschlagen. Deutsche Infrastruktur halt.', chatId);
      }
    });

    // /status - System Status
    this.bot.onText(/\/status/, async (msg) => {
      await this.handleStatus(msg.chat.id.toString());
    });

    // /wallet - Wallet Balance
    this.bot.onText(/\/wallet/, async (msg) => {
      await this.handleWallet(msg.chat.id.toString());
    });

    // /polls - Aktuelle Umfragen
    this.bot.onText(/\/polls/, async (msg) => {
      await this.handlePolls(msg.chat.id.toString());
    });

    // /news - Deutsche News
    this.bot.onText(/\/news/, async (msg) => {
      await this.handleNews(msg.chat.id.toString());
    });

    // /signals - Aktuelle Signale
    this.bot.onText(/\/signals/, async (msg) => {
      await this.handleSignals(msg.chat.id.toString());
    });

    // Text-Input für Einstellungen
    this.bot.on('message', async (msg) => {
      // Ignoriere Commands
      if (msg.text?.startsWith('/')) return;
      // Nur wenn wir im Edit-Modus sind
      if (this.editingField && msg.text) {
        await this.handleTextInput(msg.text, msg.chat.id.toString());
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //                      CALLBACK HANDLERS
  // ═══════════════════════════════════════════════════════════════

  private setupCallbackHandlers(): void {
    if (!this.bot) return;

    this.bot.on('callback_query', async (query) => {
      if (!query.data) return;

      const [action, ...params] = query.data.split(':');
      const chatId = query.message?.chat.id.toString() || this.chatId;

      try {
        await this.bot?.answerCallbackQuery(query.id);

        switch (action) {
          case 'action':
            await this.handleAction(params[0], chatId, query.message?.message_id);
            break;
          case 'trade':
            await this.handleTrade(params[0], params[1], chatId, query.message?.message_id);
            break;
          case 'confirm':
            await this.handleConfirm(params[0], params[1], chatId, query.message?.message_id);
            break;
          case 'cancel':
            await this.handleCancel(params[0], chatId, query.message?.message_id);
            break;
          case 'skip':
            await this.handleSkip(params[0], chatId, query.message?.message_id);
            break;
          case 'details':
            await this.handleDetails(params[0], chatId);
            break;
          case 'research':
            await this.handleResearch(params[0], chatId);
            break;
          case 'setting':
            await this.handleSettingChange(params[0], chatId, query.message?.message_id);
            break;
          case 'setval':
            await this.handleSetValue(params[0], params[1], chatId, query.message?.message_id);
            break;
          case 'edit':
            await this.handleEdit(params[0], chatId, query.message?.message_id);
            break;
          case 'noop':
            // Nichts tun - dekorative Buttons
            break;
        }
      } catch (err) {
        const error = err as Error;
        logger.error(`Callback Fehler: ${error.message}`);
      }
    });
  }

  private async handleAction(action: string, chatId: string, messageId?: number): Promise<void> {
    switch (action) {
      case 'menu':
        await this.sendMainMenu(chatId, messageId);
        break;
      case 'scan':
        await this.handleScan(chatId, messageId);
        break;
      case 'status':
        await this.handleStatus(chatId, messageId);
        break;
      case 'signals':
        await this.handleSignals(chatId, messageId);
        break;
      case 'wallet':
        await this.handleWallet(chatId, messageId);
        break;
      case 'polls':
        await this.handlePolls(chatId, messageId);
        break;
      case 'news':
        await this.handleNews(chatId, messageId);
        break;
      case 'ticker':
        await this.handleTicker(chatId, messageId);
        break;
      case 'settings':
        await this.handleSettings(chatId, messageId);
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      ACTION HANDLERS
  // ═══════════════════════════════════════════════════════════════

  private async sendMainMenu(chatId: string, messageId?: number): Promise<void> {
    const message = `${this.HEADER}

Wähle eine Aktion:`;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getMainMenu());
    } else {
      await this.sendMessageWithKeyboard(message, this.getMainMenu(), chatId);
    }
  }

  private async handleScan(chatId: string, messageId?: number): Promise<void> {
    // Scanning animation
    const scanningMsg = `${this.HEADER}

🔥 *Jage Alpha...*

\`\`\`
${this.progressBar(0)} 0%
\`\`\`

_Die Maschine rattert..._`;

    if (messageId) {
      await this.editMessage(chatId, messageId, scanningMsg);
    }

    // Progress updates
    const phases = ['Polymarket wird durchsucht...', 'Almanien-Daten laden...', 'Dawum-Umfragen checken...', 'Edge berechnen...', 'Alpha identifizieren...'];
    for (let i = 1; i <= 5; i++) {
      await this.sleep(400);
      const pct = i * 20;
      const progressMsg = `${this.HEADER}

🔥 *Jage Alpha...*

\`\`\`
${this.progressBar(pct)} ${pct}%
\`\`\`

_${phases[i - 1]}_`;

      if (messageId) {
        await this.editMessage(chatId, messageId, progressMsg);
      }
    }

    // Actual scan
    const result = await scanner.scan();
    await this.sendScanResult(result, chatId, messageId);
  }

  private async handleStatus(chatId: string, messageId?: number): Promise<void> {
    const status = scanner.getStatus();
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);

    const lastScanTime = status.lastScan
      ? new Date(status.lastScan).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
      : '--:--';

    const message = `${this.HEADER}

📊 *SYSTEM STATUS*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  SCANNER                        │
├─────────────────────────────────┤
│  Status:    ${status.isScanning ? '🟡 Scannt' : '🟢 Bereit'}            │
│  Uptime:    ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}               │
│  Scans:     ${String(status.totalScans).padStart(4, ' ')}                  │
│  Letzter:   ${lastScanTime}                 │
│  Signale:   ${String(status.lastSignalsCount).padStart(4, ' ')}                  │
└─────────────────────────────────┘
\`\`\`

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  PERFORMANCE                    │
├─────────────────────────────────┤
│  CPU:    ${this.progressBar(15, 100, 8)} 15%    │
│  RAM:    ${this.progressBar(35, 100, 8)} 35%    │
└─────────────────────────────────┘
\`\`\``;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    } else {
      await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
    }
  }

  private async handleSignals(chatId: string, messageId?: number): Promise<void> {
    const result = scanner.getLastResult();

    if (!result || result.signalsFound.length === 0) {
      const message = `${this.HEADER}

📭 *Keine Signale*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│                                 │
│    Keine aktiven Signale        │
│    Starte einen Scan            │
│                                 │
└─────────────────────────────────┘
\`\`\``;

      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: '🔍 Jetzt scannen', callback_data: 'action:scan' }],
          [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
        ],
      };

      if (messageId) {
        await this.editMessage(chatId, messageId, message, keyboard);
      } else {
        await this.sendMessageWithKeyboard(message, keyboard, chatId);
      }
      return;
    }

    // Show top signals
    let signalsList = '';
    const signals = result.signalsFound.slice(0, 5);

    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      const emoji = s.germanSource ? '🇩🇪' : '🎯';
      const scoreBar = this.progressBar(s.score * 100, 100, 6);

      signalsList += `
${emoji} *#${i + 1}* ${s.direction}
\`${s.market.question.substring(0, 30)}...\`
\`Score: ${scoreBar} ${(s.score * 100).toFixed(0)}%\`
\`Edge:  +${(s.edge * 100).toFixed(1)}%\`
`;
    }

    const message = `${this.HEADER}

🎯 *TOP ${signals.length} SIGNALE*

${this.DIVIDER}
${signalsList}
${this.DIVIDER}

Tippe auf ein Signal für Details:`;

    const signalButtons: InlineKeyboardButton[][] = signals.map((s, i) => [
      { text: `${s.germanSource ? '🇩🇪' : '📊'} Signal #${i + 1}: ${s.direction}`, callback_data: `details:${s.id}` },
    ]);
    signalButtons.push([{ text: '◀️ Zurück', callback_data: 'action:menu' }]);

    if (messageId) {
      await this.editMessage(chatId, messageId, message, { inline_keyboard: signalButtons });
    } else {
      await this.sendMessageWithKeyboard(message, { inline_keyboard: signalButtons }, chatId);
    }
  }

  private async handleWallet(chatId: string, messageId?: number): Promise<void> {
    // Live Balance holen
    const balance = await tradingClient.getWalletBalance();
    const walletAddr = tradingClient.getWalletAddress();

    let statusEmoji = '🟢';
    let statusText = 'Verbunden';
    let shortAddr = 'Nicht konfiguriert';

    if (!walletAddr) {
      statusEmoji = '🔴';
      statusText = 'Offline';
    } else {
      shortAddr = `${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}`;
      if (balance.usdc === 0 && balance.matic === 0) {
        statusEmoji = '🟡';
        statusText = 'Leer';
      }
    }

    const message = `${this.HEADER}

💰 *KRIEGSKASSE*

${this.DIVIDER}

\`\`\`
┌──────────────────────────┐
│ ${statusEmoji} ${statusText.padEnd(22)}│
├──────────────────────────┤
│ USDC:  $${balance.usdc.toFixed(2).padStart(10)}    │
│ MATIC: ${balance.matic.toFixed(4).padStart(11)}    │
├──────────────────────────┤
│ ${shortAddr.padEnd(24)}│
└──────────────────────────┘
\`\`\`

${this.DIVIDER}

\`\`\`
┌──────────────────────────┐
│ TRADING CONFIG           │
├──────────────────────────┤
│ Max Bet:  $${String(config.trading.maxBetUsdc).padStart(6)}       │
│ Risiko:   ${String(config.trading.riskPerTradePercent).padStart(5)}%       │
│ Kelly:    ${(config.trading.kellyFraction * 100).toFixed(0).padStart(5)}%       │
└──────────────────────────┘
\`\`\``;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: '🔄 Aktualisieren', callback_data: 'action:wallet' }],
        [
          { text: '💵 Max Bet', callback_data: 'setting:maxbet' },
          { text: '📊 Risiko', callback_data: 'setting:risk' },
        ],
        [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  private async handlePolls(chatId: string, messageId?: number): Promise<void> {
    const { germanySources } = await import('../germany/index.js');
    const polls = germanySources.getLatestPolls();

    if (polls.length === 0) {
      const message = `${this.HEADER}

📊 *Keine Umfragen verfügbar*`;

      if (messageId) {
        await this.editMessage(chatId, messageId, message, this.getBackButton());
      }
      return;
    }

    const latestPoll = polls[0];
    const sortedParties = Object.entries(latestPoll.results)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 7);

    let pollBars = '';
    for (const [party, value] of sortedParties) {
      const val = value as number;
      const bar = this.progressBar(val, 50, 10);
      pollBars += `│  ${party.padEnd(6, ' ')} ${bar} ${String(val).padStart(2, ' ')}%  │\n`;
    }

    const message = `${this.HEADER}

🇩🇪 *WAHLUMFRAGE*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  ${latestPoll.institute.substring(0, 20).padEnd(20, ' ')}            │
│  ${latestPoll.date}                       │
├─────────────────────────────────┤
${pollBars}└─────────────────────────────────┘
\`\`\``;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    } else {
      await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
    }
  }

  private async handleNews(chatId: string, messageId?: number): Promise<void> {
    const { germanySources } = await import('../germany/index.js');
    const news = germanySources.getLatestNews().slice(0, 5);

    let newsList = '';
    for (const item of news) {
      const source = (item.data.source as string || 'News').substring(0, 12);
      newsList += `
📰 *${source}*
\`${item.title.substring(0, 45)}...\`
`;
    }

    const message = `${this.HEADER}

📰 *DEUTSCHE NEWS*

${this.DIVIDER}
${newsList}
${this.DIVIDER}`;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    } else {
      await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                    LIVE TICKER - DAUERFEUER
  // ═══════════════════════════════════════════════════════════════

  private async handleTicker(chatId: string, messageId?: number): Promise<void> {
    const stats = newsTicker.getStats();
    const recentTicks = newsTicker.getRecentTicks(10);

    // ASCII-Art Ticker formatieren
    const tickerDisplay = newsTicker.formatTelegramTicker(recentTicks);

    // Stats-Balken
    const matchRate = stats.newsProcessed > 0
      ? Math.round((stats.matchesFound / stats.newsProcessed) * 100)
      : 0;
    const matchBar = '█'.repeat(Math.round(matchRate / 10)) + '░'.repeat(10 - Math.round(matchRate / 10));

    const message = `${this.HEADER}

📡 *LIVE TICKER - DAUERFEUER*

${tickerDisplay}

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  STATISTIKEN                    │
├─────────────────────────────────┤
│  News verarbeitet: ${String(stats.newsProcessed).padStart(6)}     │
│  Matches gefunden: ${String(stats.matchesFound).padStart(6)}     │
│  Alpha Signale:    ${String(stats.alphaSignals).padStart(6)}     │
├─────────────────────────────────┤
│  Match-Rate: ${matchBar} ${matchRate}% │
│  Ø Latenz:   ${String(Math.round(stats.avgMatchTime)).padStart(4)}ms             │
│  Märkte im Cache: ${String(newsTicker.getMarketCount()).padStart(6)}     │
└─────────────────────────────────┘
\`\`\`

_Auto-Update alle 60 Sekunden_`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '🔄 Aktualisieren', callback_data: 'action:ticker' },
        ],
        [
          { text: '◀️ Zurück zum Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  private async handleSettings(chatId: string, messageId?: number): Promise<void> {
    this.editingField = null; // Reset editing mode

    const message = `${this.HEADER}

⚙️ *EINSTELLUNGEN*

Tippe ✏️ um einen Wert zu ändern:`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: `💵 Max Bet`, callback_data: 'noop' },
          { text: `$${runtimeSettings.maxBet}`, callback_data: 'noop' },
          { text: `✏️`, callback_data: 'edit:maxBet' },
        ],
        [
          { text: `📊 Risiko`, callback_data: 'noop' },
          { text: `${runtimeSettings.risk}%`, callback_data: 'noop' },
          { text: `✏️`, callback_data: 'edit:risk' },
        ],
        [
          { text: `📉 Min Edge`, callback_data: 'noop' },
          { text: `${runtimeSettings.minEdge}%`, callback_data: 'noop' },
          { text: `✏️`, callback_data: 'edit:minEdge' },
        ],
        [
          { text: `🎯 Min Alpha`, callback_data: 'noop' },
          { text: `${runtimeSettings.minAlpha}%`, callback_data: 'noop' },
          { text: `✏️`, callback_data: 'edit:minAlpha' },
        ],
        [
          { text: `💰 Min Volume`, callback_data: 'noop' },
          { text: `$${runtimeSettings.minVolume}`, callback_data: 'noop' },
          { text: `✏️`, callback_data: 'edit:minVolume' },
        ],
        [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  private async handleEdit(field: string, chatId: string, messageId?: number): Promise<void> {
    this.editingField = field;

    const labels: Record<string, string> = {
      maxBet: '💵 Max Bet ($)',
      risk: '📊 Risiko (%)',
      minEdge: '📉 Min Edge (%)',
      minAlpha: '🎯 Min Alpha (%)',
      minVolume: '💰 Min Volume ($)',
    };

    const current = runtimeSettings[field as keyof typeof runtimeSettings];

    const message = `${this.HEADER}

✏️ *${labels[field]}*

Aktueller Wert: *${current}*

_Tippe den neuen Wert ein:_`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: '❌ Abbrechen', callback_data: 'action:settings' }],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  // Fallback für alte Callback-Daten
  private async handleSetValue(_setting: string, _value: string, chatId: string, _messageId?: number): Promise<void> {
    await this.handleSettings(chatId);
  }

  private async handleSettingChange(_setting: string, chatId: string, _messageId?: number): Promise<void> {
    await this.handleSettings(chatId);
  }

  private async handleTextInput(text: string, chatId: string): Promise<void> {
    if (!this.editingField) return;

    const numValue = parseFloat(text.replace(/[^0-9.]/g, ''));

    if (isNaN(numValue) || numValue <= 0) {
      await this.sendMessage('❌ Ungültiger Wert. Bitte eine Zahl eingeben.', chatId);
      return;
    }

    // Wert setzen
    (runtimeSettings as Record<string, number>)[this.editingField] = numValue;

    // Config auch updaten
    switch (this.editingField) {
      case 'maxBet':
        config.trading.maxBetUsdc = numValue;
        break;
      case 'risk':
        config.trading.riskPerTradePercent = numValue;
        break;
      case 'minEdge':
        config.germany.minEdge = numValue / 100;
        break;
      case 'minAlpha':
        config.trading.minAlphaForTrade = numValue / 100;
        break;
      case 'minVolume':
        config.scanner.minVolumeUsd = numValue;
        break;
    }

    this.editingField = null;

    const message = `✅ Gespeichert!`;
    await this.sendMessage(message, chatId);

    // Zurück zu Settings
    await this.handleSettings(chatId);
  }

  // ═══════════════════════════════════════════════════════════════
  //                      TRADE HANDLERS
  // ═══════════════════════════════════════════════════════════════

  private async handleTrade(direction: string, signalId: string, chatId: string, messageId?: number): Promise<void> {
    const recommendation = this.pendingTrades.get(signalId);

    if (!recommendation) {
      await this.sendMessage('⚠️ Signal nicht mehr verfügbar', chatId);
      return;
    }

    const dir = direction.toUpperCase();
    const message = `${this.HEADER}

⚠️ *TRADE BESTÄTIGEN*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  ORDER                          │
├─────────────────────────────────┤
│  Richtung:    ${dir.padEnd(10, ' ')}        │
│  Betrag:      $${String(recommendation.positionSize).padStart(8, ' ')}        │
│  Edge:        +${(recommendation.signal.edge * 100).toFixed(1).padStart(6, ' ')}%        │
│  Max Loss:    $${recommendation.maxLoss.toFixed(2).padStart(8, ' ')}        │
└─────────────────────────────────┘
\`\`\`

\`${recommendation.signal.market.question.substring(0, 40)}...\`

Möchtest du diesen Trade ausführen?`;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getConfirmTradeKeyboard(signalId, dir));
    }
  }

  private async handleConfirm(direction: string, signalId: string, chatId: string, messageId?: number): Promise<void> {
    const recommendation = this.pendingTrades.get(signalId);

    if (!recommendation) {
      return;
    }

    this.emit('trade_confirmed', {
      signal: recommendation.signal,
      recommendation,
      direction,
    });

    this.pendingTrades.delete(signalId);

    const message = `${this.HEADER}

✅ *TRADE AUSGEFÜHRT*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  BESTÄTIGT                      │
├─────────────────────────────────┤
│  Richtung:    ${direction.padEnd(10, ' ')}        │
│  Betrag:      $${String(recommendation.positionSize).padStart(8, ' ')}        │
│  Status:      Ausgeführt        │
└─────────────────────────────────┘
\`\`\`

_Trade wird verarbeitet..._`;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    }
  }

  private async handleCancel(signalId: string, chatId: string, messageId?: number): Promise<void> {
    this.pendingTrades.delete(signalId);

    const message = `${this.HEADER}

❌ *TRADE ABGEBROCHEN*

_Zurück zum Hauptmenü_`;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    }
  }

  private async handleSkip(signalId: string, chatId: string, messageId?: number): Promise<void> {
    this.pendingTrades.delete(signalId);

    const message = `${this.HEADER}

⏭️ *SIGNAL ÜBERSPRUNGEN*`;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    }
  }

  private async handleDetails(signalId: string, chatId: string): Promise<void> {
    const result = scanner.getLastResult();
    const signal = result?.signalsFound.find((s) => s.id === signalId);

    if (!signal) {
      await this.sendMessage('Signal nicht gefunden', chatId);
      return;
    }

    // Store for trading
    const { createTradeRecommendation } = await import('../scanner/alpha.js');
    const recommendation = createTradeRecommendation(signal, config.trading.maxBankrollUsdc);
    this.pendingTrades.set(signal.id, recommendation);

    const message = `${this.HEADER}

🎯 *SIGNAL DETAILS*

${this.DIVIDER}

*${signal.market.question}*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  ANALYSE                        │
├─────────────────────────────────┤
│  Score:    ${this.progressBar(signal.score * 100, 100, 8)} ${(signal.score * 100).toFixed(0).padStart(3, ' ')}%│
│  Edge:     +${(signal.edge * 100).toFixed(1).padStart(5, ' ')}%               │
│  Signal:   ${signal.direction.padEnd(10, ' ')}           │
│  Konfid.:  ${(signal.confidence * 100).toFixed(0).padStart(3, ' ')}%                   │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  MONEY MANAGEMENT               │
├─────────────────────────────────┤
│  Position:  $${recommendation.positionSize.toFixed(2).padStart(8, ' ')}         │
│  Max Loss:  $${recommendation.maxLoss.toFixed(2).padStart(8, ' ')}         │
│  R/R Ratio: ${recommendation.riskRewardRatio.toFixed(2).padStart(8, ' ')}x        │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  MARKT                          │
├─────────────────────────────────┤
│  Volume:    $${(signal.market.volume24h / 1000).toFixed(0).padStart(6, ' ')}K          │
│  Liquidit.: $${(signal.market.liquidity / 1000).toFixed(0).padStart(6, ' ')}K          │
└─────────────────────────────────┘
\`\`\`

${signal.reasoning ? `💡 _${signal.reasoning}_` : ''}`;

    await this.sendMessageWithKeyboard(message, this.getSignalKeyboard(signalId), chatId);
  }

  private async handleResearch(_signalId: string, chatId: string): Promise<void> {
    const message = `${this.HEADER}

🔬 *RESEARCH*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│                                 │
│  KI-Research wird vorbereitet   │
│  Claude/Perplexity Integration  │
│  kommt in nächstem Update       │
│                                 │
└─────────────────────────────────┘
\`\`\``;

    await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
  }

  // ═══════════════════════════════════════════════════════════════
  //                      SCAN RESULT
  // ═══════════════════════════════════════════════════════════════

  private async sendScanResult(result: ScanResult, chatId: string, messageId?: number): Promise<void> {
    const signalCount = result.signalsFound.length;
    const hasSignals = signalCount > 0;
    const highAlpha = result.signalsFound.filter(s => s.score > 0.7).length;

    let signalPreview = '';
    if (hasSignals) {
      const top3 = result.signalsFound.slice(0, 3);
      for (const s of top3) {
        const emoji = s.germanSource ? '🇩🇪' : '🎯';
        signalPreview += `│  ${emoji} ${s.direction} ${this.progressBar(s.score * 100, 100, 5)} ${(s.score * 100).toFixed(0)}% │\n`;
      }
    }

    const headline = hasSignals
      ? (highAlpha > 0 ? `🔥 *ALPHA DETECTED!*` : `✅ *SCAN FERTIG*`)
      : `📭 *NICHTS GEFUNDEN*`;

    const message = `${this.HEADER}

${headline}

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  JAGDERGEBNIS                   │
├─────────────────────────────────┤
│  Gescannt:   ${String(result.marketsScanned).padStart(6, ' ')} Märkte     │
│  Treffer:    ${String(signalCount).padStart(6, ' ')} Signale    │
│  High Alpha: ${String(highAlpha).padStart(6, ' ')}             │
│  Dauer:      ${String(result.duration).padStart(5, ' ')}ms            │
└─────────────────────────────────┘
${hasSignals ? `
┌─────────────────────────────────┐
│  🎯 TOP TREFFER                 │
├─────────────────────────────────┤
${signalPreview}└─────────────────────────────────┘` : ''}
\`\`\`

${hasSignals
    ? (highAlpha > 0 ? `*${highAlpha} fette Gelegenheiten warten! Zuschlagen?*` : `${signalCount} Signale. Schau sie dir an.`)
    : `_Markt ist ruhig. Warten wir ab._`}`;

    const keyboard: InlineKeyboardMarkup = hasSignals
      ? {
          inline_keyboard: [
            [{ text: '🎯 SIGNALE CHECKEN', callback_data: 'action:signals' }],
            [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
          ],
        }
      : this.getBackButton();

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      BREAKING SIGNAL
  // ═══════════════════════════════════════════════════════════════

  async sendBreakingSignal(signal: AlphaSignal): Promise<void> {
    const { createTradeRecommendation } = await import('../scanner/alpha.js');
    const recommendation = createTradeRecommendation(signal, config.trading.maxBankrollUsdc);
    this.pendingTrades.set(signal.id, recommendation);

    const isGerman = signal.germanSource !== undefined;
    const prefix = isGerman ? '🇩🇪 ALMANIEN-VORSPRUNG!' : '🚨 ALPHA ALARM!';
    const subtext = isGerman ? '_Deutsche Daten zeigen Edge_' : '_Die Maschine hat was gefunden_';

    const message = `${this.HEADER}

*${prefix}*
${subtext}

${this.DIVIDER}

*${signal.market.question}*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  🎯 SIGNAL                      │
├─────────────────────────────────┤
│  Score: ${this.progressBar(signal.score * 100, 100, 8)} ${(signal.score * 100).toFixed(0).padStart(3, ' ')}% │
│  Edge:  +${(signal.edge * 100).toFixed(1).padStart(5, ' ')}%                │
│  Bet:   ${signal.direction.padEnd(10, ' ')}           │
│  Size:  $${recommendation.positionSize.toFixed(2).padStart(8, ' ')}            │
└─────────────────────────────────┘
\`\`\`

${signal.reasoning ? `💡 _${signal.reasoning}_` : ''}

*Bock? Ein Klick und das Ding läuft.*`;

    await this.sendMessageWithKeyboard(message, this.getSignalKeyboard(signal.id));
  }

  // ═══════════════════════════════════════════════════════════════
  //                   ALPHA SIGNAL V2 - NEUES FORMAT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Sende Alpha Signal V2 mit Decision - Neues erweitertes Format
   * Unterstuetzt sowohl AlphaSignalV2 als auch CombinedSignal
   */
  async sendAlphaSignalV2(
    signal: AlphaSignalV2 | CombinedSignal,
    decision: Decision,
    executionMode: 'paper' | 'shadow' | 'live' = 'paper'
  ): Promise<void> {
    // Bestimme ob Combined Signal
    const isCombined = 'sourceSignals' in signal;

    // Mode Emoji und Label
    const modeEmoji: Record<string, string> = {
      paper: '📝',
      shadow: '👻',
      live: '🚀',
    };

    const modeLabel = executionMode.toUpperCase();

    // Alpha-Type Display
    let alphaTypeDisplay: string;
    if (isCombined) {
      const combined = signal as CombinedSignal;
      const sources: string[] = [];
      if (combined.sourceSignals.timeDelay) sources.push('TimeDelay');
      if (combined.sourceSignals.mispricing) sources.push('Mispricing');
      alphaTypeDisplay = `Meta (${sources.join(' + ')})`;
    } else {
      alphaTypeDisplay = signal.alphaType === 'timeDelay' ? 'Time Delay' : 'Mispricing';
    }

    // Top Features
    const topFeatures = formatTopFeatures(signal);

    // Risk Gates
    const riskGatesSummary = formatRiskGates(decision.riskChecks);
    const riskGatesDetailed = formatRiskGatesDetailed(decision.riskChecks);

    // Polymarket URL (mit slug falls vorhanden)
    const polymarketUrl = getPolymarketUrl(signal.marketId);

    // Size Display
    const sizeDisplay = decision.sizeUsdc !== null ? `$${decision.sizeUsdc.toFixed(2)}` : 'N/A';

    // Question (gekuerzt)
    const questionDisplay = signal.question.length > 50
      ? signal.question.substring(0, 47) + '...'
      : signal.question;

    // Message zusammenbauen
    const message = `${this.HEADER}

${modeEmoji[executionMode]} *[${modeLabel}] SIGNAL*

${this.DIVIDER}

*${questionDisplay}*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  📊 SIGNAL-DETAILS              │
├─────────────────────────────────┤
│  Alpha-Type: ${alphaTypeDisplay.padEnd(17)}│
│  Direction:  ${signal.direction.toUpperCase().padEnd(17)}│
│  Size:       ${sizeDisplay.padEnd(17)}│
│  Edge:       ${((signal.predictedEdge * 100).toFixed(1) + '%').padEnd(17)}│
│  Confidence: ${((signal.confidence * 100).toFixed(0) + '%').padEnd(17)}│
└─────────────────────────────────┘
\`\`\`

${this.DIVIDER}

🔍 *Treiber:*
\`\`\`
  1. ${topFeatures[0] || 'N/A'}
  2. ${topFeatures[1] || 'N/A'}
  3. ${topFeatures[2] || 'N/A'}
\`\`\`

${this.DIVIDER}

✅ *Risk-Gates:* ${riskGatesSummary}
\`\`\`
${riskGatesDetailed.join('\n')}
\`\`\`

🔗 [Polymarket öffnen](${polymarketUrl})`;

    // Keyboard fuer V2 Signal
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '🚀 JA TRADEN', callback_data: `tradev2:yes:${signal.signalId}` },
          { text: '💀 NEIN TRADEN', callback_data: `tradev2:no:${signal.signalId}` },
        ],
        [
          { text: '👀 Nur beobachten', callback_data: `watchv2:${signal.signalId}` },
          { text: '⏭️ Skip', callback_data: `skipv2:${signal.signalId}` },
        ],
        [
          { text: '◀️ Zurück zum Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    // Rejection-Warnung falls vorhanden
    let finalMessage = message;
    if (decision.rationale.rejectionReasons && decision.rationale.rejectionReasons.length > 0) {
      const rejectionText = decision.rationale.rejectionReasons
        .map(r => `  ⚠️ ${r}`)
        .join('\n');
      finalMessage += `\n\n*Einschränkungen:*\n${rejectionText}`;
    }

    await this.sendMessageWithKeyboard(finalMessage, keyboard);

    // Logge das Signal
    logger.info(`[TELEGRAM] Alpha Signal V2 gesendet: ${signal.signalId.slice(0, 8)}...`, {
      alphaType: signal.alphaType,
      direction: signal.direction,
      edge: signal.predictedEdge,
      action: decision.action,
      mode: executionMode,
    });
  }

  /**
   * Sende kompakten V2 Alert (fuer Batch-Signale)
   */
  async sendAlphaSignalV2Compact(
    signal: AlphaSignalV2 | CombinedSignal,
    decision: Decision,
    executionMode: 'paper' | 'shadow' | 'live' = 'paper'
  ): Promise<void> {
    const modeEmoji: Record<string, string> = {
      paper: '📝',
      shadow: '👻',
      live: '🚀',
    };

    // Kompaktes Format
    const edge = (signal.predictedEdge * 100).toFixed(1);
    const conf = (signal.confidence * 100).toFixed(0);
    const size = decision.sizeUsdc !== null ? `$${decision.sizeUsdc.toFixed(0)}` : '-';
    const riskGates = formatRiskGates(decision.riskChecks);

    const message = `${modeEmoji[executionMode]} *${signal.direction.toUpperCase()}* | Edge: ${edge}% | Conf: ${conf}% | ${size}
${signal.question.substring(0, 60)}${signal.question.length > 60 ? '...' : ''}
${riskGates}`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '👁️ Details', callback_data: `detailsv2:${signal.signalId}` },
          { text: '🚀 Trade', callback_data: `tradev2:${signal.direction}:${signal.signalId}` },
        ],
      ],
    };

    await this.sendMessageWithKeyboard(message, keyboard);
  }

  // ═══════════════════════════════════════════════════════════════
  //                      SCANNER EVENTS
  // ═══════════════════════════════════════════════════════════════

  private setupScannerEvents(): void {
    // Alpha Scanner Events
    scanner.on('signal_found', async (signal: AlphaSignal) => {
      if (signal.score > 0.6) {
        await this.sendBreakingSignal(signal);
      }
    });

    // ═══════════════════════════════════════════════════════════════
    // ALMAN SCANNER EVENT-LISTENER
    // Reagiert auf Breaking News mit Zeitvorsprung
    // ═══════════════════════════════════════════════════════════════
    germanySources.on('breaking_news', async (news: BreakingNewsEvent) => {
      await this.sendBreakingNewsAlert(news);
    });

    logger.info('Scanner Events registriert (Alpha + Alman)');
  }

  // ═══════════════════════════════════════════════════════════════
  //                   BREAKING NEWS ALERT
  // ═══════════════════════════════════════════════════════════════

  private async sendBreakingNewsAlert(news: BreakingNewsEvent): Promise<void> {
    const categoryEmoji: Record<string, string> = {
      politics: '🏛️',
      economics: '📈',
      sports: '⚽',
      geopolitics: '🌍',
      tech: '💻',
      crypto: '₿',
    };

    const emoji = categoryEmoji[news.category] || '📰';
    const timeDiff = Math.round((news.detectedAt.getTime() - news.publishedAt.getTime()) / 1000 / 60);

    const message = `
🚨 *BREAKING NEWS DETECTED* 🚨

${this.DIVIDER}

${emoji} *${news.source}*
\`\`\`
${news.title.substring(0, 100)}${news.title.length > 100 ? '...' : ''}
\`\`\`

${this.DIVIDER}

📍 *Keywords:* ${news.keywords.slice(0, 5).join(', ')}
⏱️ *Zeitvorsprung:* ~${timeDiff > 0 ? timeDiff : '<1'} Min
🏷️ *Kategorie:* ${news.category}

${news.url ? `🔗 [Quelle öffnen](${news.url})` : ''}

_Suche jetzt nach passenden Polymarket-Wetten..._`;

    await this.sendMessageWithKeyboard(message, {
      inline_keyboard: [
        [
          { text: '🔥 PASSENDE WETTEN FINDEN', callback_data: `news:find:${news.id}` },
        ],
        [
          { text: '❌ Ignorieren', callback_data: 'action:menu' },
        ],
      ],
    });

    // Automatisch nach passenden Märkten suchen
    this.emit('news_alert', news);
  }

  // ═══════════════════════════════════════════════════════════════
  //                      HELPERS
  // ═══════════════════════════════════════════════════════════════

  private async sendMessage(text: string, chatId?: string): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.sendMessage(chatId || this.chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err) {
      logger.error(`Telegram Nachricht Fehler: ${(err as Error).message}`);
    }
  }

  private async sendMessageWithKeyboard(
    text: string,
    keyboard: InlineKeyboardMarkup,
    chatId?: string
  ): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.sendMessage(chatId || this.chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    } catch (err) {
      logger.error(`Telegram Nachricht Fehler: ${(err as Error).message}`);
    }
  }

  private async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboardMarkup
  ): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    } catch (err) {
      // Ignore "message not modified" errors
      const error = err as Error;
      if (!error.message.includes('message is not modified')) {
        logger.debug(`Edit Fehler: ${error.message}`);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const telegramBot = new TelegramAlertBot();
export default telegramBot;
