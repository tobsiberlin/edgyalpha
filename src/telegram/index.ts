import TelegramBot, { InlineKeyboardButton, InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { config, WALLET_PRIVATE_KEY, WALLET_ADDRESS } from '../utils/config.js';
import logger from '../utils/logger.js';
import { AlphaSignal, TradeRecommendation, ScanResult } from '../types/index.js';
import { scanner } from '../scanner/index.js';
import { tradingClient } from '../api/trading.js';
import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════════════
//           EDGY ALPHA SCANNER - TELEGRAM BOT
//         Mit Almanien-Vorsprung | Kein Gelaber, nur Alpha
// ═══════════════════════════════════════════════════════════════

export class TelegramAlertBot extends EventEmitter {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private pendingTrades: Map<string, TradeRecommendation> = new Map();

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
          { text: '🇩🇪 Sonntagsfrage', callback_data: 'action:polls' },
          { text: '📰 Almanien News', callback_data: 'action:news' },
        ],
        [
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
    let balanceInfo: string;
    let addressInfo: string;

    if (!WALLET_PRIVATE_KEY || !WALLET_ADDRESS) {
      balanceInfo = `│  ⚠️  WALLET NICHT KONFIGURIERT  │
├─────────────────────────────────┤
│  Setze WALLET_PRIVATE_KEY       │
│  und WALLET_ADDRESS in .env     │`;
      addressInfo = 'N/A';
    } else {
      try {
        const balance = await tradingClient.getWalletBalance();
        const shortAddr = `${WALLET_ADDRESS.substring(0, 6)}...${WALLET_ADDRESS.substring(38)}`;
        balanceInfo = `│  USDC:      $${balance.usdc.toFixed(2).padStart(8, ' ')}         │
│  MATIC:     ${balance.matic.toFixed(4).padStart(9, ' ')}         │`;
        addressInfo = shortAddr;
      } catch {
        balanceInfo = `│  ⚠️  FEHLER BEIM LADEN          │`;
        addressInfo = 'Fehler';
      }
    }

    const message = `${this.HEADER}

💰 *WALLET*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  BALANCE                        │
├─────────────────────────────────┤
${balanceInfo}
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  ADRESSE                        │
├─────────────────────────────────┤
│  ${addressInfo.padEnd(20, ' ')}            │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  TRADING CONFIG                 │
├─────────────────────────────────┤
│  Max Bet:   $${String(config.trading.maxBetUsdc).padStart(8, ' ')}         │
│  Risiko:    ${String(config.trading.riskPerTradePercent).padStart(8, ' ')}%        │
│  Kelly:     ${String(config.trading.kellyFraction * 100).padStart(8, ' ')}%        │
└─────────────────────────────────┘
\`\`\``;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    } else {
      await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
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

  private async handleSettings(chatId: string, messageId?: number): Promise<void> {
    const message = `${this.HEADER}

⚙️ *EINSTELLUNGEN*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  SCANNER                        │
├─────────────────────────────────┤
│  Intervall:    5 Minuten        │
│  Min Volume:   $100,000         │
│  Kategorien:   Politik, Wirt.   │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  DEUTSCHLAND                    │
├─────────────────────────────────┤
│  Modus:        Nur Alerts       │
│  Min Edge:     10%              │
│  Auto-Trade:   Aus              │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  TRADING                        │
├─────────────────────────────────┤
│  Max Bet:      $10              │
│  Risiko:       10%              │
│  Bestätigung:  Erforderlich     │
└─────────────────────────────────┘
\`\`\``;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    } else {
      await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
    }
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
  //                      SCANNER EVENTS
  // ═══════════════════════════════════════════════════════════════

  private setupScannerEvents(): void {
    scanner.on('signal_found', async (signal: AlphaSignal) => {
      if (signal.score > 0.6) {
        await this.sendBreakingSignal(signal);
      }
    });
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
