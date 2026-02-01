import TelegramBot, { InlineKeyboardButton, InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';
import { AlphaSignal, TradeRecommendation, ScanResult, GermanSource } from '../types/index.js';
import { scanner } from '../scanner/index.js';
import { EventEmitter } from 'events';

export class TelegramAlertBot extends EventEmitter {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private pendingTrades: Map<string, TradeRecommendation> = new Map();

  constructor() {
    super();
    this.chatId = config.telegram.chatId;
  }

  async start(): Promise<void> {
    if (!config.telegram.enabled || !config.telegram.botToken) {
      logger.info('Telegram Bot deaktiviert');
      return;
    }

    try {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: true });

      // Command Handlers
      this.setupCommands();

      // Callback Query Handler (für Inline Buttons)
      this.setupCallbackHandlers();

      // Scanner Events abonnieren
      this.setupScannerEvents();

      logger.info('Telegram Bot gestartet');

      // Willkommensnachricht
      await this.sendMessage(
        '🟢 *ALPHA SCANNER ONLINE*\n\n' +
        '• Scan-Intervall: 5 Min\n' +
        '• Kategorien: Politik, Wirtschaft\n' +
        '• Deutschland-Modus: Aktiv\n\n' +
        'Befehle:\n' +
        '/scan - Manuellen Scan starten\n' +
        '/status - System-Status\n' +
        '/signals - Letzte Signale\n' +
        '/wallet - Wallet-Status\n' +
        '/help - Alle Befehle'
      );
    } catch (err) {
      const error = err as Error;
      logger.error(`Telegram Bot Fehler: ${error.message}`);
    }
  }

  private setupCommands(): void {
    if (!this.bot) return;

    // /start - Begrüßung
    this.bot.onText(/\/start/, async (msg) => {
      await this.sendMessage(
        '🎯 *Willkommen beim Polymarket Alpha Scanner!*\n\n' +
        'Ich finde Alpha-Opportunities auf Polymarket und ' +
        'nutze deutsche Informationsquellen für einen Informationsvorsprung.\n\n' +
        'Tippe /help für alle Befehle.',
        msg.chat.id.toString()
      );
    });

    // /help - Hilfe
    this.bot.onText(/\/help/, async (msg) => {
      await this.sendMessage(
        '📖 *BEFEHLE*\n\n' +
        '*Scanner:*\n' +
        '/scan - Manuellen Scan starten\n' +
        '/signals - Letzte Alpha-Signale\n' +
        '/markets - Top-Märkte anzeigen\n\n' +
        '*Trading:*\n' +
        '/wallet - Wallet-Status\n' +
        '/positions - Offene Positionen\n' +
        '/pnl - Profit & Loss\n\n' +
        '*System:*\n' +
        '/status - System-Status\n' +
        '/settings - Einstellungen\n' +
        '/pause - Scanner pausieren\n' +
        '/resume - Scanner fortsetzen\n\n' +
        '*Deutschland:*\n' +
        '/polls - Aktuelle Wahlumfragen\n' +
        '/news - Deutsche News\n' +
        '/bundestag - Bundestag-Aktivität',
        msg.chat.id.toString()
      );
    });

    // /scan - Manuellen Scan starten
    this.bot.onText(/\/scan/, async (msg) => {
      await this.sendMessage('🔍 *Starte manuellen Scan...*', msg.chat.id.toString());

      try {
        const result = await scanner.scan();
        await this.sendScanResult(result, msg.chat.id.toString());
      } catch (err) {
        const error = err as Error;
        await this.sendMessage(`❌ Scan-Fehler: ${error.message}`, msg.chat.id.toString());
      }
    });

    // /status - System-Status
    this.bot.onText(/\/status/, async (msg) => {
      const status = scanner.getStatus();
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);

      await this.sendMessage(
        '📊 *SYSTEM STATUS*\n\n' +
        `🟢 Scanner: ${status.isScanning ? 'Läuft' : 'Bereit'}\n` +
        `⏱ Uptime: ${hours}h ${minutes}m\n` +
        `🔄 Scans gesamt: ${status.totalScans}\n` +
        `📡 Letzter Scan: ${status.lastScan ? this.formatTime(status.lastScan) : 'Noch nicht'}\n` +
        `📈 Signale (letzter Scan): ${status.lastSignalsCount}\n\n` +
        `⚙️ Einstellungen:\n` +
        `• Intervall: ${config.scanner.intervalMs / 1000}s\n` +
        `• Min. Volume: $${config.scanner.minVolumeUsd.toLocaleString()}\n` +
        `• Kategorien: ${config.scanner.categories.join(', ')}\n` +
        `• DE-Modus: ${config.germany.enabled ? '✅' : '❌'}\n` +
        `• Trading: ${config.trading.enabled ? '✅' : '❌'}`,
        msg.chat.id.toString()
      );
    });

    // /signals - Letzte Signale
    this.bot.onText(/\/signals/, async (msg) => {
      const result = scanner.getLastResult();

      if (!result || result.signalsFound.length === 0) {
        await this.sendMessage(
          '📭 *Keine aktuellen Signale*\n\nStarte einen Scan mit /scan',
          msg.chat.id.toString()
        );
        return;
      }

      const signals = result.signalsFound.slice(0, 5);
      let message = `🎯 *TOP ${signals.length} ALPHA SIGNALE*\n\n`;

      for (const signal of signals) {
        message += this.formatSignalShort(signal) + '\n\n';
      }

      await this.sendMessage(message, msg.chat.id.toString());
    });

    // /polls - Wahlumfragen
    this.bot.onText(/\/polls/, async (msg) => {
      const { germanySources } = await import('../germany/index.js');
      const polls = germanySources.getLatestPolls();

      if (polls.length === 0) {
        await this.sendMessage('📊 Keine Umfragen verfügbar', msg.chat.id.toString());
        return;
      }

      const latestPoll = polls[0];
      let message = `📊 *AKTUELLE WAHLUMFRAGE*\n\n`;
      message += `📅 ${latestPoll.date}\n`;
      message += `🏛 ${latestPoll.institute}\n\n`;

      const sortedParties = Object.entries(latestPoll.results)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8);

      for (const [party, value] of sortedParties) {
        const bar = '█'.repeat(Math.round(value / 3));
        message += `${party}: ${value}% ${bar}\n`;
      }

      await this.sendMessage(message, msg.chat.id.toString());
    });

    // /news - Deutsche News
    this.bot.onText(/\/news/, async (msg) => {
      const { germanySources } = await import('../germany/index.js');
      const news = germanySources.getLatestNews().slice(0, 5);

      if (news.length === 0) {
        await this.sendMessage('📰 Keine News verfügbar', msg.chat.id.toString());
        return;
      }

      let message = `📰 *DEUTSCHE NEWS*\n\n`;

      for (const item of news) {
        const source = (item.data.source as string) || 'News';
        message += `*${source}*\n`;
        message += `${item.title}\n`;
        if (item.url) {
          message += `[Link](${item.url})\n`;
        }
        message += '\n';
      }

      await this.sendMessage(message, msg.chat.id.toString());
    });

    // /wallet - Wallet-Status
    this.bot.onText(/\/wallet/, async (msg) => {
      // Vereinfachte Version - echte Wallet-Abfrage kommt später
      await this.sendMessage(
        '💰 *WALLET STATUS*\n\n' +
        `Adresse: \`${config.trading.maxBankrollUsdc ? '0x...' : 'Nicht konfiguriert'}\`\n` +
        `Max. Bankroll: $${config.trading.maxBankrollUsdc}\n` +
        `Max. Einsatz: $${config.trading.maxBetUsdc}\n` +
        `Risiko/Trade: ${config.trading.riskPerTradePercent}%`,
        msg.chat.id.toString()
      );
    });
  }

  private setupCallbackHandlers(): void {
    if (!this.bot) return;

    this.bot.on('callback_query', async (query) => {
      if (!query.data) return;

      const [action, signalId] = query.data.split(':');

      try {
        switch (action) {
          case 'trade_yes':
            await this.handleTradeConfirm(signalId, 'YES', query);
            break;
          case 'trade_no':
            await this.handleTradeConfirm(signalId, 'NO', query);
            break;
          case 'trade_skip':
            await this.handleTradeSkip(signalId, query);
            break;
          case 'details':
            await this.handleShowDetails(signalId, query);
            break;
          case 'research':
            await this.handleResearch(signalId, query);
            break;
          default:
            logger.debug(`Unbekannte Callback-Aktion: ${action}`);
        }
      } catch (err) {
        const error = err as Error;
        logger.error(`Callback Handler Fehler: ${error.message}`);
        await this.bot?.answerCallbackQuery(query.id, {
          text: `Fehler: ${error.message}`,
          show_alert: true,
        });
      }
    });
  }

  private async handleTradeConfirm(
    signalId: string,
    direction: 'YES' | 'NO',
    query: TelegramBot.CallbackQuery
  ): Promise<void> {
    const recommendation = this.pendingTrades.get(signalId);

    if (!recommendation) {
      await this.bot?.answerCallbackQuery(query.id, {
        text: '⚠️ Trade nicht mehr verfügbar',
        show_alert: true,
      });
      return;
    }

    // Trade-Ausführung emittieren
    this.emit('trade_confirmed', {
      signal: recommendation.signal,
      recommendation,
      direction,
    });

    this.pendingTrades.delete(signalId);

    await this.bot?.answerCallbackQuery(query.id, {
      text: `✅ Trade ${direction} bestätigt! Positionsgröße: $${recommendation.positionSize}`,
      show_alert: true,
    });

    // Nachricht aktualisieren
    if (query.message) {
      await this.bot?.editMessageText(
        `✅ *TRADE AUSGEFÜHRT*\n\n` +
        `${recommendation.signal.market.question}\n\n` +
        `Richtung: ${direction}\n` +
        `Einsatz: $${recommendation.positionSize}\n` +
        `Edge: ${(recommendation.signal.edge * 100).toFixed(1)}%`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
        }
      );
    }
  }

  private async handleTradeSkip(
    signalId: string,
    query: TelegramBot.CallbackQuery
  ): Promise<void> {
    this.pendingTrades.delete(signalId);

    await this.bot?.answerCallbackQuery(query.id, {
      text: '⏭ Trade übersprungen',
    });

    if (query.message) {
      await this.bot?.editMessageText(
        `⏭ *TRADE ÜBERSPRUNGEN*\n\n` +
        `Signal ID: ${signalId.substring(0, 8)}...`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
        }
      );
    }
  }

  private async handleShowDetails(
    signalId: string,
    query: TelegramBot.CallbackQuery
  ): Promise<void> {
    const recommendation = this.pendingTrades.get(signalId);

    if (!recommendation) {
      await this.bot?.answerCallbackQuery(query.id, {
        text: 'Details nicht verfügbar',
      });
      return;
    }

    const signal = recommendation.signal;

    await this.bot?.answerCallbackQuery(query.id);
    await this.sendMessage(
      `📊 *SIGNAL DETAILS*\n\n` +
      `*Markt:*\n${signal.market.question}\n\n` +
      `*Analyse:*\n${signal.reasoning}\n\n` +
      `*Metriken:*\n` +
      `• Alpha Score: ${(signal.score * 100).toFixed(0)}%\n` +
      `• Edge: ${(signal.edge * 100).toFixed(1)}%\n` +
      `• Konfidenz: ${(signal.confidence * 100).toFixed(0)}%\n` +
      `• Empfehlung: ${signal.direction}\n\n` +
      `*Money Management:*\n` +
      `• Positionsgröße: $${recommendation.positionSize}\n` +
      `• Max. Verlust: $${recommendation.maxLoss.toFixed(2)}\n` +
      `• Risk/Reward: ${recommendation.riskRewardRatio.toFixed(2)}x\n` +
      `• Kelly: ${(recommendation.kellyFraction * 100).toFixed(0)}%\n\n` +
      `*Markt-Daten:*\n` +
      `• Volume 24h: $${signal.market.volume24h.toLocaleString()}\n` +
      `• Liquidität: $${signal.market.liquidity.toLocaleString()}\n` +
      `• Endet: ${signal.market.endDate || 'Unbekannt'}`
    );
  }

  private async handleResearch(
    _signalId: string,
    query: TelegramBot.CallbackQuery
  ): Promise<void> {
    await this.bot?.answerCallbackQuery(query.id, {
      text: '🔬 Research wird gestartet...',
    });

    // Hier könnte später Claude/Perplexity Research getriggert werden
    await this.sendMessage(
      '🔬 *Research-Funktion*\n\n' +
      'Diese Funktion nutzt Claude/Perplexity für tiefere Analyse.\n' +
      'Wird nach Session-Setup aktiviert.'
    );
  }

  private setupScannerEvents(): void {
    // Neues Signal gefunden
    scanner.on('signal_found', async (signal: AlphaSignal) => {
      // Nur starke Signale senden (Score > 0.6)
      if (signal.score > 0.6) {
        await this.sendBreakingSignal(signal);
      }
    });

    // Scan abgeschlossen
    scanner.on('scan_completed', async (result: ScanResult) => {
      // Nur bei Fehlern oder vielen Signalen benachrichtigen
      if (result.errors.length > 0) {
        await this.sendMessage(
          `⚠️ *Scan-Fehler*\n\n${result.errors.join('\n')}`
        );
      }

      if (result.signalsFound.length >= 3) {
        await this.sendMessage(
          `📈 *${result.signalsFound.length} neue Signale!*\n\n` +
          `Tippe /signals für Details`
        );
      }
    });
  }

  async sendBreakingSignal(signal: AlphaSignal): Promise<void> {
    const message = this.formatBreakingSignal(signal);
    const keyboard = this.createTradeKeyboard(signal);

    // Für Trade-Buttons speichern
    const recommendation = await import('./index.js').then(async () => {
      const { createTradeRecommendation } = await import('../scanner/alpha.js');
      return createTradeRecommendation(signal, config.trading.maxBankrollUsdc);
    });

    this.pendingTrades.set(signal.id, recommendation);

    await this.sendMessageWithKeyboard(message, keyboard);
  }

  private formatBreakingSignal(signal: AlphaSignal): string {
    const isGerman = signal.germanSource !== undefined;
    const prefix = isGerman ? '🇩🇪 *DEUTSCHLAND ALPHA*' : '🚨 *BREAKING SIGNAL*';

    let message = `${prefix}\n\n`;
    message += `*${signal.market.question}*\n\n`;

    // Score-Anzeige mit Balken
    const scoreBar = '█'.repeat(Math.round(signal.score * 10));
    const emptyBar = '░'.repeat(10 - Math.round(signal.score * 10));
    message += `📊 Score: ${scoreBar}${emptyBar} ${(signal.score * 100).toFixed(0)}%\n`;

    message += `📈 Edge: +${(signal.edge * 100).toFixed(1)}%\n`;
    message += `🎯 Empfehlung: *${signal.direction}*\n\n`;

    message += `💡 ${signal.reasoning}\n\n`;

    if (isGerman && signal.germanSource) {
      message += `📰 Quelle: ${signal.germanSource.title}\n`;
    }

    message += `💰 Volume: $${signal.market.volume24h.toLocaleString()}`;

    return message;
  }

  private formatSignalShort(signal: AlphaSignal): string {
    const emoji = signal.score > 0.7 ? '🔥' : signal.score > 0.5 ? '📈' : '📊';
    const deFlag = signal.germanSource ? '🇩🇪 ' : '';

    return (
      `${emoji} ${deFlag}*${signal.direction}* @ ${(signal.score * 100).toFixed(0)}%\n` +
      `${signal.market.question.substring(0, 60)}...\n` +
      `Edge: +${(signal.edge * 100).toFixed(1)}% | Vol: $${(signal.market.volume24h / 1000).toFixed(0)}K`
    );
  }

  private createTradeKeyboard(signal: AlphaSignal): InlineKeyboardMarkup {
    const buttons: InlineKeyboardButton[][] = [
      [
        { text: '✅ YES kaufen', callback_data: `trade_yes:${signal.id}` },
        { text: '❌ NO kaufen', callback_data: `trade_no:${signal.id}` },
      ],
      [
        { text: '📊 Details', callback_data: `details:${signal.id}` },
        { text: '🔬 Research', callback_data: `research:${signal.id}` },
      ],
      [{ text: '⏭ Überspringen', callback_data: `trade_skip:${signal.id}` }],
    ];

    return { inline_keyboard: buttons };
  }

  async sendScanResult(result: ScanResult, chatId?: string): Promise<void> {
    let message = `✅ *SCAN ABGESCHLOSSEN*\n\n`;
    message += `📊 Märkte gescannt: ${result.marketsScanned}\n`;
    message += `🎯 Signale gefunden: ${result.signalsFound.length}\n`;
    message += `⏱ Dauer: ${result.duration}ms\n`;

    if (result.errors.length > 0) {
      message += `\n⚠️ Fehler: ${result.errors.length}`;
    }

    if (result.signalsFound.length > 0) {
      message += `\n\n*Top Signale:*\n`;
      for (const signal of result.signalsFound.slice(0, 3)) {
        message += `\n${this.formatSignalShort(signal)}\n`;
      }
    }

    await this.sendMessage(message, chatId);
  }

  async sendBreakingNews(source: GermanSource): Promise<void> {
    const message =
      `📰 *BREAKING NEWS*\n\n` +
      `*${source.title}*\n\n` +
      `Quelle: ${source.data.source || 'DE'}\n` +
      `${source.url ? `[Artikel lesen](${source.url})` : ''}\n\n` +
      `🔍 Prüfe auf Trading-Opportunities...`;

    await this.sendMessage(message);
  }

  private async sendMessage(text: string, chatId?: string): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.sendMessage(chatId || this.chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err) {
      const error = err as Error;
      logger.error(`Telegram Nachricht Fehler: ${error.message}`);
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
      const error = err as Error;
      logger.error(`Telegram Nachricht Fehler: ${error.message}`);
    }
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

export const telegramBot = new TelegramAlertBot();
export default telegramBot;
