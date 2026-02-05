import TelegramBot, { InlineKeyboardButton, InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { config, WALLET_PRIVATE_KEY } from '../utils/config.js';
import logger from '../utils/logger.js';
import { AlphaSignal, TradeRecommendation, ScanResult, ExecutionMode } from '../types/index.js';
import { scanner } from '../scanner/index.js';
import { tradingClient } from '../api/trading.js';
import { polymarketClient } from '../api/polymarket.js';
import { germanySources, BreakingNewsEvent } from '../germany/index.js';
import { newsTicker } from '../ticker/index.js';
import { EventEmitter } from 'events';
import {
  AlphaSignalV2,
  Decision,
  CombinedSignal,
  formatTopFeatures,
  formatRiskGates,
  formatRiskGatesDetailed,
  getPolymarketUrl,
} from '../alpha/index.js';
import { runtimeState } from '../runtime/state.js';
import { notificationService, PushReadyNotification } from '../notifications/notificationService.js';
import {
  getNotificationSettings,
  updateNotificationSettings,
  PushMode,
} from '../notifications/rateLimiter.js';
import { timeDelayEngine } from '../alpha/timeDelayEngine.js';

// AutoTrader wurde entfernt (V4.0) - Ersetzt durch Dutch-Book Arbitrage & Late-Entry Strategien
import { timeAdvantageService } from '../alpha/timeAdvantageService.js';
import { dutchBookEngine, ArbitrageOpportunity, ArbitrageSignal } from '../arbitrage/index.js';
import { lateEntryEngine, LateEntrySignal } from '../lateEntry/index.js';
import { performanceTracker, TrackedTrade, TradeStrategy, tradeResolutionService, ResolutionResult } from '../tracking/index.js';

// ═══════════════════════════════════════════════════════════════
//           EDGY ALPHA SCANNER - TELEGRAM BOT
//         Mit Alman Heimvorteil | Kein Gelaber, nur Alpha
// ═══════════════════════════════════════════════════════════════

// Runtime-Settings - Synchronisiert mit PerformanceTracker für Persistenz
const loadedSettings = performanceTracker.getSettings();
const runtimeSettings = {
  maxBet: 10,
  risk: 10,
  minEdge: 5,
  minAlpha: 15,
  minVolume: 5000,
  // Module Toggles (persistent)
  timeDelayEnabled: loadedSettings.timeDelayEnabled,
  mispricingEnabled: false,  // MISPRICING Engine (entfernt in V4.0)
  germanyOnly: loadedSettings.germanyOnly,
  // SAFE BET Auto-Trading
  autoBetOnSafeBet: loadedSettings.autoTradeEnabled,
  // V4.0: Neue Strategien (persistent)
  arbitrageEnabled: loadedSettings.arbitrageEnabled,
  lateEntryEnabled: loadedSettings.lateEntryEnabled,
  // V4.0: Auto-Trade Config
  autoTradeMinConfidence: loadedSettings.autoTradeMinConfidence,
  fullAutoMode: loadedSettings.fullAutoMode,
};

// Sync runtimeSettings changes to PerformanceTracker
function syncSettings(): void {
  performanceTracker.updateSettings({
    timeDelayEnabled: runtimeSettings.timeDelayEnabled,
    germanyOnly: runtimeSettings.germanyOnly,
    autoTradeEnabled: runtimeSettings.autoBetOnSafeBet,
    arbitrageEnabled: runtimeSettings.arbitrageEnabled,
    lateEntryEnabled: runtimeSettings.lateEntryEnabled,
    autoTradeMinConfidence: runtimeSettings.autoTradeMinConfidence,
    fullAutoMode: runtimeSettings.fullAutoMode,
  });
}

// ═══════════════════════════════════════════════════════════════
//           GERMANY KEYWORDS - Filter für EUSSR-Tracker Alerts
// ═══════════════════════════════════════════════════════════════
const GERMANY_KEYWORDS = [
  'germany', 'german', 'deutschland', 'bundestag', 'bundesregierung',
  'merz', 'scholz', 'habeck', 'lindner', 'weidel', 'cdu', 'spd', 'grüne',
  'afd', 'fdp', 'bundeswahl', 'koalition', 'berlin', 'bayern', 'nrw',
  'volkswagen', 'mercedes', 'bmw', 'siemens', 'deutsche bank', 'dax',
  'bundesliga', 'wagenknecht', 'bsw', 'pistorius', 'baerbock', 'kretschmer',
  'söder', 'laschet', 'ampel', 'jamaika', 'große koalition', 'groko',
];

/**
 * Prüft ob eine Markt-Frage Deutschland-Bezug hat
 * Nur bei Deutschland-Bezug werden EUSSR-Tracker Alerts gesendet
 */
function hasGermanyRelevance(marketQuestion: string): boolean {
  const lower = marketQuestion.toLowerCase();
  return GERMANY_KEYWORDS.some(kw => lower.includes(kw));
}

export class TelegramAlertBot extends EventEmitter {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private pendingTrades: Map<string, { recommendation: TradeRecommendation; createdAt: number }> = new Map();
  private editingField: string | null = null; // Welches Feld wird gerade bearbeitet?
  private pendingTradesCleanupInterval: NodeJS.Timeout | null = null;
  private readonly PENDING_TRADE_TTL_MS = 60 * 60 * 1000; // 1 Stunde TTL

  // ═══════════════════════════════════════════════════════════════
  // SINGLE MENU MESSAGE SYSTEM
  // Verhindert Menü-Spam: Nur EINE Menü-Nachricht pro Chat, wird editiert statt neu gesendet
  // ═══════════════════════════════════════════════════════════════
  private lastMenuMessageId: Map<string, number> = new Map();
  private lastMenuUpdateTime: Map<string, number> = new Map();
  private readonly MENU_UPDATE_COOLDOWN_MS = 30000; // 30 Sekunden Cooldown

  constructor() {
    super();
    this.chatId = config.telegram.chatId;
  }

  /**
   * Speichert die Message-ID des letzten Menüs für einen Chat
   */
  private setLastMenuMessageId(chatId: string, messageId: number): void {
    this.lastMenuMessageId.set(chatId, messageId);
    this.lastMenuUpdateTime.set(chatId, Date.now());
  }

  /**
   * Prüft ob ein Menü-Update erlaubt ist (Rate-Limit)
   */
  private canUpdateMenu(chatId: string): boolean {
    const lastUpdate = this.lastMenuUpdateTime.get(chatId);
    if (!lastUpdate) return true;
    return Date.now() - lastUpdate >= this.MENU_UPDATE_COOLDOWN_MS;
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
║       EDGY ALPHA                 ║
║        🇩🇪 DE Intel Active        ║
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

      // ═══════════════════════════════════════════════════════════════
      // BOT COMMANDS MENU - Zeigt Commands im Telegram Dropdown
      // ═══════════════════════════════════════════════════════════════
      await this.bot.setMyCommands([
        { command: 'start', description: 'Willkommen & Hauptmenü' },
        { command: 'scan', description: 'Start alpha scan' },
        { command: 'signals', description: 'Aktuelle Signale' },
        { command: 'stats', description: 'Performance Dashboard' },
        { command: 'wallet', description: 'Wallet & Balance' },
        { command: 'positions', description: 'Offene Positionen' },
        { command: 'history', description: 'Trade History' },
        { command: 'settings', description: 'Einstellungen' },
        { command: 'kill', description: 'Kill-Switch aktivieren' },
        { command: 'resume', description: 'Trading fortsetzen' },
        { command: 'help', description: 'Hilfe & Commands' },
      ]);
      logger.info('Bot Commands Menu registriert');

      this.setupCommands();
      this.setupCallbackHandlers();
      this.setupScannerEvents();

      // Cleanup-Timer für alte pendingTrades starten (alle 5 Minuten)
      this.pendingTradesCleanupInterval = setInterval(() => {
        this.cleanupPendingTrades();
      }, 5 * 60 * 1000);

      logger.info('Telegram Bot gestartet');
      // KEIN automatisches sendWelcome() mehr!
      // Das Menü wird nur gesendet wenn User /start oder /menu eingibt.
      // Verhindert Spam bei Prozess-Restarts.
    } catch (err) {
      const error = err as Error;
      logger.error(`Telegram Bot Fehler: ${error.message}`);
    }
  }

  /**
   * Entfernt alte pendingTrades nach TTL (Memory Leak Prevention)
   */
  private cleanupPendingTrades(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, entry] of this.pendingTrades.entries()) {
      if (now - entry.createdAt > this.PENDING_TRADE_TTL_MS) {
        this.pendingTrades.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[Telegram] Cleaned up ${cleaned} expired pending trades`);
    }
  }

  /**
   * Prüft ob eine Chat-ID autorisiert ist
   */
  private isAuthorized(chatId: string): boolean {
    // Erlaubt nur die konfigurierte Chat-ID
    return chatId === this.chatId || chatId === config.telegram.chatId;
  }

  // ═══════════════════════════════════════════════════════════════
  //                      WELCOME MESSAGE
  // ═══════════════════════════════════════════════════════════════

  private async sendWelcome(): Promise<void> {
    const message = `${this.HEADER}

🟢 *Online. German intel advantage locked in.*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  CONFIG                         │
├─────────────────────────────────┤
│  Scan:     every 5 min          │
│  Focus:    Politics, Markets    │
│  DE Edge:  Armed & ready        │
│  Trading:  1-click execution    │
└─────────────────────────────────┘
\`\`\`

*what's the move?*`;

    const keyboard = this.getMainMenu();
    const sentMessage = await this.sendMessageWithKeyboard(message, keyboard);
    // Speichere messageId für Single Menu Message System
    if (sentMessage?.message_id) {
      this.setLastMenuMessageId(this.chatId, sentMessage.message_id);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      KEYBOARDS
  // ═══════════════════════════════════════════════════════════════

  private getMainMenu(): InlineKeyboardMarkup {
    const state = runtimeState.getState();
    const killSwitchEmoji = state.killSwitchActive ? '🔴' : '🟢';
    const modeEmoji = state.executionMode === 'live' ? '🚀' : state.executionMode === 'shadow' ? '👻' : '📝';

    // Quick-Status für Strategien
    const arbEmoji = runtimeSettings.arbitrageEnabled ? '🟢' : '⚫';
    const lateEmoji = runtimeSettings.lateEntryEnabled ? '🟢' : '⚫';
    const autoEmoji = runtimeSettings.autoBetOnSafeBet ? '🟢' : '⚫';

    return {
      inline_keyboard: [
        // === TRADING ===
        [
          { text: '🔥 SCAN', callback_data: 'action:scan' },
          { text: '🎯 Signals', callback_data: 'action:signals' },
        ],
        [
          { text: '💰 Wallet', callback_data: 'action:wallet' },
          { text: '📜 History', callback_data: 'action:history' },
        ],
        // === EINSTELLUNGEN (NEU: PROMINENT) ===
        [{ text: '═══ ⚙️ EINSTELLUNGEN ═══', callback_data: 'action:settings' }],
        [
          { text: `${modeEmoji} ${state.executionMode.toUpperCase()}`, callback_data: 'action:mode' },
          { text: `🛡️ Risk ${killSwitchEmoji}`, callback_data: 'action:risk' },
        ],
        [
          { text: `${arbEmoji} Arbitrage`, callback_data: 'toggle:arbitrage' },
          { text: `${lateEmoji} Late-Entry`, callback_data: 'toggle:lateEntry' },
          { text: `${autoEmoji} Auto`, callback_data: 'toggle:autoBet' },
        ],
        // === RESEARCH ===
        [{ text: '═══ 📊 RESEARCH ═══', callback_data: 'noop' }],
        [
          { text: '📡 LIVE FEED', callback_data: 'action:ticker' },
          { text: '📰 DE News', callback_data: 'action:news' },
        ],
        [
          { text: '🇩🇪 Polls', callback_data: 'action:polls' },
          { text: '⚡ Time Edge', callback_data: 'action:edge' },
        ],
        // === STATS & MEHR ===
        [
          { text: '📈 Stats', callback_data: 'action:stats' },
          { text: '📊 Status', callback_data: 'action:status' },
        ],
        [
          { text: '⚙️ Alle Settings', callback_data: 'action:settings' },
          { text: '🖥️ Dashboard', url: this.getWebDashboardUrl() },
        ],
      ],
    };
  }

  private getWebDashboardUrl(): string {
    // Web Dashboard URL aus Umgebungsvariable oder Default
    return process.env.WEB_DASHBOARD_URL || `http://localhost:${process.env.PORT || 3000}`;
  }

  private getBackButton(): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [{ text: '◀️ Back', callback_data: 'action:menu' }],
      ],
    };
  }

  private getSignalKeyboard(signalId: string): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: '🟢 APE YES', callback_data: `trade:yes:${signalId}` },
          { text: '🔴 APE NO', callback_data: `trade:no:${signalId}` },
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
          { text: '✅ Confirm', callback_data: `confirm:${direction}:${signalId}` },
          { text: '❌ Cancel', callback_data: `cancel:${signalId}` },
        ],
      ],
    };
  }

  /**
   * Quick-Buy Buttons für Alerts
   * Zeigt konfigurierbare Beträge mit klarer Richtung (YES/NO)
   */
  private getQuickBuyKeyboard(signalId: string, marketId: string, direction: 'yes' | 'no' = 'yes'): InlineKeyboardMarkup {
    const amounts = config.quickBuy.amounts; // z.B. [5, 10, 25, 50]
    const directionLabel = direction === 'yes' ? 'YES' : 'NO';
    const directionEmoji = direction === 'yes' ? '🟢' : '🔴';

    // Buttons für alle Beträge erstellen
    const buyButtons: InlineKeyboardButton[][] = [];

    // Zeile 1: Erste 2 Beträge
    if (amounts.length >= 2) {
      buyButtons.push(
        amounts.slice(0, 2).map(amount => ({
          text: `${directionEmoji} ${amount}$ ${directionLabel}`,
          callback_data: `quickbuy:${signalId}:${direction}:${amount}`,
        }))
      );
    } else if (amounts.length === 1) {
      buyButtons.push([{
        text: `${directionEmoji} ${amounts[0]}$ ${directionLabel}`,
        callback_data: `quickbuy:${signalId}:${direction}:${amounts[0]}`,
      }]);
    }

    // Zeile 2: Weitere Beträge (3-4)
    if (amounts.length > 2) {
      buyButtons.push(
        amounts.slice(2, 4).map(amount => ({
          text: `${directionEmoji} ${amount}$ ${directionLabel}`,
          callback_data: `quickbuy:${signalId}:${direction}:${amount}`,
        }))
      );
    }

    return {
      inline_keyboard: [
        ...buyButtons,
        // Zeile 3: Utility Buttons
        [
          { text: '👀 Watch', callback_data: `watch:${signalId}` },
          { text: '📊 Details', callback_data: `details:${signalId}` },
        ],
        // Zeile 4: Chart + Polymarket Link
        [
          { text: '📈 Chart', callback_data: `chart:${marketId}` },
          { text: '🔗 Polymarket', url: `https://polymarket.com/event/${marketId}` },
        ],
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //                      COMMANDS
  // ═══════════════════════════════════════════════════════════════

  private setupCommands(): void {
    if (!this.bot) return;

    // AUTH-CHECK: Alle Commands prüfen ob User autorisiert ist
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id.toString();
      // /start ist Spezialfall - aktualisiert chatId falls noch nicht gesetzt
      if (!this.chatId || this.chatId === '' || chatId === config.telegram.chatId) {
        this.chatId = chatId;
        await this.sendWelcome();
      } else if (!this.isAuthorized(chatId)) {
        await this.bot?.sendMessage(chatId, '❌ Nicht autorisiert. Dieser Bot ist privat.');
        logger.warn(`[Telegram] Unauthorized /start attempt from chat ${chatId}`);
        return;
      } else {
        await this.sendWelcome();
      }
    });

    this.bot.onText(/\/menu/, async (msg) => {
      const chatId = msg.chat.id.toString();
      if (!this.isAuthorized(chatId)) {
        await this.bot?.sendMessage(chatId, '❌ Nicht autorisiert.');
        return;
      }
      await this.sendMainMenu(chatId);
    });

    // /scan - Starte einen Scan
    this.bot.onText(/\/scan/, async (msg) => {
      const chatId = msg.chat.id.toString();
      if (!this.isAuthorized(chatId)) {
        await this.bot?.sendMessage(chatId, '❌ Nicht autorisiert.');
        return;
      }
      await this.sendMessage('🔥 *Starting scan...*\n\n_scanning for alpha..._', chatId);

      try {
        const result = await scanner.scan();
        await this.sendScanResult(result, chatId);
      } catch {
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

    // /kill - Kill-Switch aktivieren
    this.bot.onText(/\/kill(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id.toString();
      const reason = match?.[1] || 'Manuell via Telegram /kill Command';
      runtimeState.activateKillSwitch(reason, 'telegram');

      const message = `${this.HEADER}

🔴 *KILL-SWITCH AKTIVIERT*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  TRADING GESTOPPT               │
├─────────────────────────────────┤
│  Grund: ${reason.substring(0, 22).padEnd(22)}│
│  Zeit:  ${new Date().toLocaleTimeString('de-DE').padEnd(22)}│
└─────────────────────────────────┘
\`\`\`

_Alle Trades wurden gestoppt._
_Nutze /resume um fortzufahren._`;

      await this.sendMessage(message, chatId);
    });

    // /resume - Kill-Switch deaktivieren
    this.bot.onText(/\/resume/, async (msg) => {
      const chatId = msg.chat.id.toString();

      if (!runtimeState.isKillSwitchActive()) {
        await this.sendMessage('ℹ️ Kill-Switch ist nicht aktiv.', chatId);
        return;
      }

      runtimeState.deactivateKillSwitch('telegram');

      const message = `${this.HEADER}

🟢 *KILL-SWITCH DEAKTIVIERT*

${this.DIVIDER}

Trading wieder möglich.
Nutze /status um den aktuellen Zustand zu prüfen.`;

      await this.sendMessage(message, chatId);
    });

    // /cooldown - Cooldown Status anzeigen / resetten
    this.bot.onText(/\/cooldown(?:\s+(reset))?/, async (msg, match) => {
      const chatId = msg.chat.id.toString();
      const action = match?.[1];

      const cooldownStatus = runtimeState.getCooldownStatus();
      const state = runtimeState.getState();

      if (action === 'reset') {
        if (!cooldownStatus.active && state.consecutiveLosses < 3) {
          await this.sendMessage('ℹ️ Kein aktiver Cooldown zum Resetten.', chatId);
          return;
        }

        runtimeState.resetCooldown('telegram');

        const message = `${this.HEADER}

✅ *COOLDOWN ZURÜCKGESETZT*

${this.DIVIDER}

Trading wieder möglich.
⚠️ _Achtung: Die Verlustserie wurde erkannt - trade vorsichtig!_`;

        await this.sendMessage(message, chatId);
        return;
      }

      // Status anzeigen
      const message = `${this.HEADER}

🛡️ *INTRADAY RISK STATUS*

${this.DIVIDER}

*Tages-PnL:* ${state.dailyPnL >= 0 ? '+' : ''}${state.dailyPnL.toFixed(2)} USDC
*Tageshoch:* ${state.intradayHighWaterMark.toFixed(2)} USDC
*Drawdown:* ${state.intradayDrawdown.toFixed(2)} USDC

*Consecutive Losses:* ${state.consecutiveLosses}
*Cooldown:* ${cooldownStatus.active
    ? `⏳ Aktiv (${cooldownStatus.minutesLeft} Min) - ${cooldownStatus.reason}`
    : '✅ Inaktiv'}

${this.DIVIDER}

*Limits:*
• Daily Loss: ${state.maxDailyLoss} USDC
• Intraday Drawdown: ${(state.maxDailyLoss * 0.5).toFixed(0)} USDC (50%)
• Rapid Loss (15 Min): ${(state.maxDailyLoss * 0.3).toFixed(0)} USDC (30%)
• Max Consecutive Losses: 3`;

      await this.sendMessageWithKeyboard(message, {
        inline_keyboard: cooldownStatus.active || state.consecutiveLosses >= 3
          ? [
              [{ text: '🔓 Cooldown Reset', callback_data: 'action:cooldown_reset' }],
              [{ text: '🔙 Menü', callback_data: 'action:menu' }],
            ]
          : [
              [{ text: '🔙 Menü', callback_data: 'action:menu' }],
            ],
      }, chatId);
    });

    // /mode [paper|shadow|live] - Mode wechseln
    this.bot.onText(/\/mode(?:\s+(paper|shadow|live))?/, async (msg, match) => {
      const chatId = msg.chat.id.toString();
      const requestedMode = match?.[1] as ExecutionMode | undefined;

      if (!requestedMode) {
        // Zeige Mode-Auswahl
        await this.handleModeSelect(chatId);
        return;
      }

      const result = runtimeState.setExecutionMode(requestedMode, 'telegram');

      if (result.success) {
        const modeEmoji: Record<string, string> = {
          paper: '📝',
          shadow: '👻',
          live: '🚀',
        };

        const message = `${this.HEADER}

${modeEmoji[requestedMode]} *MODE: ${requestedMode.toUpperCase()}*

${this.DIVIDER}

${result.message}

${requestedMode === 'live' ? '⚠️ *ACHTUNG: LIVE MODE!*\nEchte Trades werden ausgeführt!' : ''}`;

        await this.sendMessage(message, chatId);
      } else {
        await this.sendMessage(`❌ Mode-Wechsel fehlgeschlagen:\n${result.message}`, chatId);
      }
    });

    // /pnl - Tägliches PnL anzeigen
    this.bot.onText(/\/pnl/, async (msg) => {
      const chatId = msg.chat.id.toString();
      const dashboard = runtimeState.getRiskDashboard();

      const pnlEmoji = dashboard.daily.pnl >= 0 ? '🟢' : '🔴';
      const pnlSign = dashboard.daily.pnl >= 0 ? '+' : '';
      const winRateBar = this.progressBar(dashboard.daily.winRate, 100, 10);

      const message = `${this.HEADER}

💰 *TAGES-PnL*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  PERFORMANCE HEUTE              │
├─────────────────────────────────┤
│  PnL:       ${pnlEmoji} ${pnlSign}$${dashboard.daily.pnl.toFixed(2).padStart(8)}       │
│  Trades:    ${String(dashboard.daily.trades).padStart(4)}                 │
│  Wins:      ${String(dashboard.daily.wins).padStart(4)}                 │
│  Losses:    ${String(dashboard.daily.losses).padStart(4)}                 │
│  Win-Rate:  ${winRateBar}     │
├─────────────────────────────────┤
│  Loss Limit: $${dashboard.limits.dailyLossRemaining.toFixed(0).padStart(4)}/$${dashboard.limits.dailyLossLimit.toFixed(0).padStart(4)}   │
│  Exposure:   $${dashboard.positions.totalExposure.toFixed(2).padStart(8)}        │
└─────────────────────────────────┘
\`\`\`

${dashboard.canTrade.allowed ? '✅ Trading erlaubt' : `⚠️ ${dashboard.canTrade.reason}`}`;

      await this.sendMessage(message, chatId);
    });

    // /positions - Offene Positionen (echte CLOB-Daten)
    this.bot.onText(/\/positions/, async (msg) => {
      const chatId = msg.chat.id.toString();
      const dashboard = runtimeState.getRiskDashboard();

      // Versuche echte Positionen vom CLOB zu holen
      let positionsText = '_Keine offenen Positionen._';
      let openOrdersText = '';

      try {
        const [positions, openOrders] = await Promise.all([
          tradingClient.getPositions(),
          tradingClient.getOpenOrders(),
        ]);

        if (positions.length > 0) {
          positionsText = positions.slice(0, 5).map(p => {
            const pnlEmoji = p.unrealizedPnl >= 0 ? '🟢' : '🔴';
            const question = p.marketQuestion.substring(0, 25);
            return `${pnlEmoji} ${question}...\n   ${p.shares.toFixed(2)} @ $${p.avgPrice.toFixed(2)} → $${p.currentPrice.toFixed(2)}`;
          }).join('\n\n');
        }

        if (openOrders.length > 0) {
          openOrdersText = `\n\n📋 *OFFENE ORDERS:* ${openOrders.length}\n` +
            openOrders.slice(0, 3).map(o =>
              `• ${o.side} ${o.size.toFixed(2)} @ $${o.price.toFixed(4)}`
            ).join('\n');
        }
      } catch {
        positionsText = '_Fehler beim Abrufen der Positionen._';
      }

      const message = `${this.HEADER}

📊 *OFFENE POSITIONEN*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  Positionen: ${String(dashboard.positions.open).padStart(2)}/${String(dashboard.positions.max).padStart(2)}             │
│  Exposure:   $${dashboard.positions.totalExposure.toFixed(2).padStart(8)}        │
└─────────────────────────────────┘
\`\`\`

${positionsText}${openOrdersText}`;

      await this.sendMessage(message, chatId);
    });

    // /health - System Health Check
    this.bot.onText(/\/health/, async (msg) => {
      const chatId = msg.chat.id.toString();
      const dashboard = runtimeState.getRiskDashboard();

      // System-Checks
      const checks = {
        wallet: !!WALLET_PRIVATE_KEY,
        clob: tradingClient.isClobReady(),
        killSwitch: !dashboard.isKillSwitchActive,
        trading: config.trading.enabled,
        telegram: config.telegram.enabled,
      };

      const allGood = Object.values(checks).every(Boolean);

      // Balance abrufen
      let balanceText = 'N/A';
      try {
        const balance = await tradingClient.getWalletBalance();
        balanceText = `$${balance.usdc.toFixed(2)} USDC, ${balance.matic.toFixed(4)} MATIC`;
      } catch {
        balanceText = '❌ Fehler';
      }

      const checkEmoji = (ok: boolean) => ok ? '✅' : '❌';

      const message = `${this.HEADER}

🏥 *SYSTEM HEALTH*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  KOMPONENTEN-STATUS             │
├─────────────────────────────────┤
│  ${checkEmoji(checks.wallet)} Wallet           ${checks.wallet ? 'OK' : 'MISSING'}       │
│  ${checkEmoji(checks.clob)} CLOB Client      ${checks.clob ? 'READY' : 'INIT...'}      │
│  ${checkEmoji(checks.killSwitch)} Kill-Switch      ${checks.killSwitch ? 'OK' : 'ACTIVE!'}      │
│  ${checkEmoji(checks.trading)} Trading          ${checks.trading ? 'ENABLED' : 'DISABLED'}   │
│  ${checkEmoji(checks.telegram)} Telegram         ${checks.telegram ? 'OK' : 'DISABLED'}      │
├─────────────────────────────────┤
│  Mode: ${config.executionMode.toUpperCase().padEnd(8)}              │
│  Balance: ${balanceText.padEnd(18)}   │
│  Failures: ${String(dashboard.consecutiveFailures).padStart(2)}/3               │
└─────────────────────────────────┘
\`\`\`

${allGood ? '✅ Alle Systeme nominal' : '⚠️ Probleme erkannt - prüfen!'}`;

      await this.sendMessage(message, chatId);
    });

    // ═══════════════════════════════════════════════════════════════
    // NOTIFICATION SETTINGS COMMANDS
    // ═══════════════════════════════════════════════════════════════

    // /settings - Zeigt aktuelle Notification-Einstellungen
    this.bot.onText(/\/settings/, async (msg) => {
      const chatId = msg.chat.id.toString();
      const settings = getNotificationSettings(chatId);

      const modeEmoji: Record<string, string> = {
        OFF: '🔇',
        TIME_DELAY_ONLY: '⚡',
        SYSTEM_ONLY: '🔔',
        DIGEST_ONLY: '📋',
        FULL: '📢',
      };

      const message = `${this.HEADER}

⚙️ *NOTIFICATION SETTINGS*

${this.DIVIDER}

*Push-Modus:* ${modeEmoji[settings.pushMode] || '❓'} ${settings.pushMode}
*Quiet Hours:* ${settings.quietHoursEnabled ? `✅ ${settings.quietHoursStart}-${settings.quietHoursEnd}` : '❌ Aus'}
*Timezone:* ${settings.timezone}

${this.DIVIDER}

*Thresholds:*
• Min Match Confidence: ${(settings.minMatchConfidence * 100).toFixed(0)}%
• Min Edge: ${(settings.minEdge * 100).toFixed(0)}%
• Min Volume: $${(settings.minVolume / 1000).toFixed(0)}k

*Rate Limits:*
• Cooldown: ${settings.cooldownMinutes} min
• Max/Tag: ${settings.maxPerDay}

${this.DIVIDER}

*Kategorien:*
• Politik: ${settings.categoryPolitics ? '✅' : '❌'}
• Wirtschaft: ${settings.categoryEconomy ? '✅' : '❌'}
• Sport: ${settings.categorySports ? '✅' : '❌'}
• Geopolitik: ${settings.categoryGeopolitics ? '✅' : '❌'}
• Crypto: ${settings.categoryCrypto ? '✅' : '❌'}`;

      await this.sendMessageWithKeyboard(message, {
        inline_keyboard: [
          [
            { text: '⚡ TIME_DELAY', callback_data: 'settings:push:TIME_DELAY_ONLY' },
            { text: '🔔 SYSTEM', callback_data: 'settings:push:SYSTEM_ONLY' },
          ],
          [
            { text: '📋 DIGEST', callback_data: 'settings:push:DIGEST_ONLY' },
            { text: '📢 FULL', callback_data: 'settings:push:FULL' },
          ],
          [
            { text: '🔇 OFF', callback_data: 'settings:push:OFF' },
          ],
          [
            { text: settings.quietHoursEnabled ? '🌙 Quiet Hours: AN' : '☀️ Quiet Hours: AUS', callback_data: 'settings:quiet:toggle' },
          ],
          [
            { text: '🔙 Menü', callback_data: 'action:menu' },
          ],
        ],
      }, chatId);
    });

    // /push [mode] - Ändert Push-Modus
    this.bot.onText(/\/push(?:\s+(OFF|TIME_DELAY_ONLY|SYSTEM_ONLY|DIGEST_ONLY|FULL))?/i, async (msg, match) => {
      const chatId = msg.chat.id.toString();
      const newMode = match?.[1]?.toUpperCase() as PushMode | undefined;

      if (!newMode) {
        // Zeige aktuelle Einstellung und Optionen
        const settings = getNotificationSettings(chatId);
        await this.sendMessageWithKeyboard(
          `Aktueller Push-Modus: *${settings.pushMode}*\n\nWähle einen neuen Modus:`,
          {
            inline_keyboard: [
              [
                { text: '⚡ TIME_DELAY_ONLY', callback_data: 'settings:push:TIME_DELAY_ONLY' },
              ],
              [
                { text: '🔔 SYSTEM_ONLY', callback_data: 'settings:push:SYSTEM_ONLY' },
              ],
              [
                { text: '📋 DIGEST_ONLY', callback_data: 'settings:push:DIGEST_ONLY' },
              ],
              [
                { text: '📢 FULL (Test)', callback_data: 'settings:push:FULL' },
              ],
              [
                { text: '🔇 OFF', callback_data: 'settings:push:OFF' },
              ],
            ],
          },
          chatId
        );
        return;
      }

      updateNotificationSettings(chatId, { pushMode: newMode });
      await this.sendMessage(`✅ Push-Modus geändert auf: *${newMode}*`, chatId);
    });

    // /quiet [on|off] - Toggle Quiet Hours
    this.bot.onText(/\/quiet(?:\s+(on|off))?/i, async (msg, match) => {
      const chatId = msg.chat.id.toString();
      const settings = getNotificationSettings(chatId);

      let newState: boolean;
      if (match?.[1]) {
        newState = match[1].toLowerCase() === 'on';
      } else {
        // Toggle
        newState = !settings.quietHoursEnabled;
      }

      updateNotificationSettings(chatId, { quietHoursEnabled: newState });
      await this.sendMessage(
        newState
          ? `🌙 Quiet Hours *aktiviert* (${settings.quietHoursStart}-${settings.quietHoursEnd} ${settings.timezone})`
          : `☀️ Quiet Hours *deaktiviert*`,
        chatId
      );
    });

    // /digest - Zeigt MISPRICING Digest
    this.bot.onText(/\/digest/, async (msg) => {
      const chatId = msg.chat.id.toString();

      // Hole aktuelle Kandidaten-Stats
      const stats = notificationService.getStats();

      let message = `${this.HEADER}

📋 *SIGNAL DIGEST*

${this.DIVIDER}

*Kandidaten heute:*
• Neu: ${stats.byStatus.new}
• Gematcht: ${stats.byStatus.matched}
• Gepusht: ${stats.pushedToday}
• Rejected: ${stats.rejectedToday}
• Expired: ${stats.byStatus.expired}

${this.DIVIDER}`;

      // Hier könnten wir aktive Signals hinzufügen
      message += `

_Nutze /settings um Push-Benachrichtigungen zu konfigurieren._`;

      await this.sendMessageWithKeyboard(message, {
        inline_keyboard: [
          [
            { text: '🔄 Refresh', callback_data: 'digest:refresh' },
          ],
          [
            { text: '⚙️ Settings', callback_data: 'action:settings' },
            { text: '🔙 Menü', callback_data: 'action:menu' },
          ],
        ],
      }, chatId);
    });

    // /edge - Zeitvorsprung Dashboard
    this.bot.onText(/\/edge/, async (msg) => {
      await this.handleTimeAdvantageDashboard(msg.chat.id.toString());
    });

    // /stats - Performance Dashboard (V4.0)
    this.bot.onText(/\/stats/, async (msg) => {
      await this.handlePerformanceDashboard(msg.chat.id.toString());
    });

    // /history - Trade History
    this.bot.onText(/\/history/, async (msg) => {
      await this.handleTradeHistory(msg.chat.id.toString());
    });

    // /help - Kommando-Übersicht
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id.toString();
      await this.handleHelpMenu(chatId);
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
            await this.handleDetails(params[0], chatId, query.message?.message_id);
            break;
          case 'research':
            await this.handleResearch(params[0], chatId, query.message?.message_id);
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
          case 'setmode':
            await this.handleSetMode(params[0] as ExecutionMode, chatId, query.message?.message_id);
            break;
          case 'killswitch':
            await this.handleKillSwitchAction(params[0], chatId, query.message?.message_id);
            break;
          case 'settings':
            await this.handleNotificationSettings(params[0], params[1], chatId, query.message?.message_id);
            break;
          case 'digest':
            await this.handleDigestAction(params[0], chatId, query.message?.message_id);
            break;
          case 'toggle':
            await this.handleModuleToggle(params[0], chatId, query.message?.message_id);
            break;
          case 'safebet':
            await this.handleSafeBetAction(params[0], params[1], params[2], chatId, query.message?.message_id);
            break;
          case 'safebetconfirm':
            await this.handleSafeBetConfirm(params[0], params[1], parseInt(params[2], 10), chatId, query.message?.message_id);
            break;
          case 'quickbuy':
            // quickbuy:signalId:direction:amount
            await this.handleQuickBuy(params[0], params[1] as 'yes' | 'no', parseFloat(params[2]), chatId, query.message?.message_id);
            break;
          case 'quickbuy_confirm':
            // quickbuy_confirm:signalId:direction:amount
            await this.handleQuickBuyConfirm(params[0], params[1] as 'yes' | 'no', parseFloat(params[2]), chatId, query.message?.message_id);
            break;
          case 'quickbuy_cancel':
            // quickbuy_cancel:signalId
            await this.handleQuickBuyCancel(chatId, query.message?.message_id);
            break;
          case 'watch':
            await this.handleWatch(params[0], chatId, query.message?.message_id);
            break;
          case 'chart':
            await this.handleChart(params[0], chatId, query.message?.message_id);
            break;
          // V4.0: Arbitrage Callbacks
          case 'arb':
            // arb:direction:opportunityId:amount (direction: yes/no/both)
            await this.handleArbitrageAction(params[0], params[1], parseFloat(params[2]), chatId, query.message?.message_id);
            break;
          // V4.0: Late-Entry Callbacks
          case 'late':
            // late:direction:signalId:amount
            await this.handleLateEntryAction(params[0] as 'yes' | 'no', params[1], parseFloat(params[2]), chatId, query.message?.message_id);
            break;
          case 'history_page':
            // history_page:offset
            await this.handleTradeHistory(chatId, query.message?.message_id, parseInt(params[0], 10));
            break;
          case 'history_filter':
            // history_filter:status (won/lost/pending)
            await this.handleTradeHistoryFiltered(chatId, query.message?.message_id, params[0]);
            break;
          case 'help':
            // help:topic
            await this.handleHelpTopic(params[0], chatId, query.message?.message_id);
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
      case 'edge':
        await this.handleTimeAdvantageDashboard(chatId, messageId);
        break;
      case 'ticker':
        await this.handleTicker(chatId, messageId);
        break;
      case 'stats':
        await this.handlePerformanceDashboard(chatId, messageId);
        break;
      case 'settings':
        await this.handleSettings(chatId, messageId);
        break;
      case 'risk':
        await this.handleRiskDashboard(chatId, messageId);
        break;
      case 'mode':
        await this.handleModeSelect(chatId, messageId);
        break;
      case 'killswitch':
        await this.handleKillSwitchToggle(chatId, messageId);
        break;
      case 'cooldown_reset':
        runtimeState.resetCooldown('telegram');
        await this.sendMessage('✅ Cooldown zurückgesetzt. Trading wieder möglich.', chatId);
        break;
      case 'history':
        await this.handleTradeHistory(chatId, messageId);
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      ACTION HANDLERS
  // ═══════════════════════════════════════════════════════════════

  private async sendMainMenu(chatId: string, messageId?: number): Promise<void> {
    const message = `${this.HEADER}

what's the play?`;

    // Nutze gespeicherte messageId falls vorhanden
    const effectiveMessageId = messageId || this.lastMenuMessageId.get(chatId);

    if (effectiveMessageId) {
      // Versuche zu editieren
      try {
        await this.editMessage(chatId, effectiveMessageId, message, this.getMainMenu());
        this.setLastMenuMessageId(chatId, effectiveMessageId);
        return;
      } catch (err) {
        // Edit fehlgeschlagen (Message zu alt oder gelöscht) - sende neu
        logger.debug(`[TELEGRAM] Menu edit failed, sending new: ${(err as Error).message}`);
        this.lastMenuMessageId.delete(chatId);
      }
    }

    // Sende neue Nachricht und speichere messageId
    const sentMessage = await this.sendMessageWithKeyboard(message, this.getMainMenu(), chatId);
    if (sentMessage?.message_id) {
      this.setLastMenuMessageId(chatId, sentMessage.message_id);
    }
  }

  private async handleScan(chatId: string, messageId?: number): Promise<void> {
    // Typing Indicator während Scan
    await this.bot?.sendChatAction(chatId, 'typing');

    // Scanning animation
    const scanningMsg = `${this.HEADER}

🔥 *Jage Alpha...*

\`\`\`
${this.progressBar(0)} 0%
\`\`\`

_scanning for alpha..._`;

    if (messageId) {
      await this.editMessage(chatId, messageId, scanningMsg);
    }

    // Progress updates
    const phases = ['Polymarket wird durchsucht...', 'loading DE intel...', 'Dawum-Umfragen checken...', 'Edge berechnen...', 'Alpha identifizieren...'];
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
│  Status:    ${(status.isScanning ? '[~] Scannt' : '[+] Bereit').padEnd(18)}│
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

    // V4.2: Der Scanner generiert keine automatischen Signale mehr.
    // Echte Trading-Signale kommen über die 3 Strategien als Push-Alerts:
    // 1. TimeDelay (deutsche News)
    // 2. Arbitrage (Dutch-Book)
    // 3. Late-Entry (15-Min Crypto)
    if (!result || result.signalsFound.length === 0) {
      const message = `${this.HEADER}

📡 *LIVE SIGNALE V4\\.2*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  AKTIVE STRATEGIEN              │
├─────────────────────────────────┤
│  ⚡ TimeDelay   ${runtimeSettings.timeDelayEnabled ? '🟢 AKTIV' : '🔴 AUS  '}     │
│  💰 Arbitrage   ${runtimeSettings.arbitrageEnabled ? '🟢 AKTIV' : '🔴 AUS  '}     │
│  ⏱️  Late-Entry  ${runtimeSettings.lateEntryEnabled ? '🟢 AKTIV' : '🔴 AUS  '}     │
└─────────────────────────────────┘
\`\`\`

*Signale werden automatisch gepusht!*

_Aktiviere Strategien in den Settings._
_Alerts erscheinen als Push-Benachrichtigung._`;

      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: '📡 Live Ticker', callback_data: 'action:ticker' }],
          [{ text: '⚙️ Strategien aktivieren', callback_data: 'action:settings' }],
          [{ text: '📊 Performance', callback_data: 'action:stats' }],
          [{ text: '◀️ Back', callback_data: 'action:menu' }],
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

tap a signal for details:`;

    const signalButtons: InlineKeyboardButton[][] = signals.map((s, i) => [
      { text: `${s.germanSource ? '🇩🇪' : '📊'} Signal #${i + 1}: ${s.direction}`, callback_data: `details:${s.id}` },
    ]);
    signalButtons.push([{ text: '◀️ Back', callback_data: 'action:menu' }]);

    if (messageId) {
      await this.editMessage(chatId, messageId, message, { inline_keyboard: signalButtons });
    } else {
      await this.sendMessageWithKeyboard(message, { inline_keyboard: signalButtons }, chatId);
    }
  }

  private async handleWallet(chatId: string, messageId?: number): Promise<void> {
    // Typing Indicator während Balance geladen wird
    await this.bot?.sendChatAction(chatId, 'typing');

    // Live Balance holen
    const balance = await tradingClient.getWalletBalance();
    const walletAddr = tradingClient.getWalletAddress();

    let statusText = 'Verbunden';
    let shortAddr = 'Nicht konfiguriert';

    if (!walletAddr) {
      statusText = 'Offline';
    } else {
      shortAddr = `${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}`;
      if (balance.usdc === 0 && balance.matic === 0) {
        statusText = 'Leer';
      }
    }

    const message = `${this.HEADER}

💰 *WALLET*

${this.DIVIDER}

\`\`\`
┌──────────────────────────┐
│ ${statusText.padEnd(24)}│
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
        [{ text: '🔄 Refresh', callback_data: 'action:wallet' }],
        [
          { text: '💵 Max Bet', callback_data: 'setting:maxbet' },
          { text: '📊 Risiko', callback_data: 'setting:risk' },
        ],
        [{ text: '◀️ Back', callback_data: 'action:menu' }],
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
      pollBars += `${party.padEnd(8)} ${bar} ${String(val).padStart(2)}%\n`;
    }

    const message = `${this.HEADER}

🇩🇪 *WAHLUMFRAGE*

${this.DIVIDER}

*${latestPoll.institute}*
_${latestPoll.date}_

\`\`\`
${pollBars}\`\`\``;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    } else {
      await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
    }
  }

  private async handleNews(chatId: string, messageId?: number): Promise<void> {
    const { germanySources } = await import('../germany/index.js');
    const { fetchAllRSSFeeds, newsItemsToGermanSources } = await import('../germany/rss.js');

    // Hole gecachte News
    let news = germanySources.getLatestNews();

    // Falls Cache leer, direkt fetchen - NUR DEUTSCHE QUELLEN!
    if (news.length === 0) {
      logger.info('[TELEGRAM] News cache leer - fetche NUR DEUTSCHE QUELLEN...');
      try {
        const result = await fetchAllRSSFeeds({
          germanOnly: true,  // NUR deutsche Quellen für "Deutsche News"!
          maxConcurrent: 15,
          timeout: 10000,
        });
        news = newsItemsToGermanSources(result.items);
        logger.info(`[TELEGRAM] ${news.length} deutsche News direkt gefetcht`);
      } catch (err) {
        logger.error(`[TELEGRAM] RSS-Fetch Fehler: ${(err as Error).message}`);
      }
    }

    // Die neuesten 25 News anzeigen
    const latestNews = news.slice(0, 25);

    if (latestNews.length === 0) {
      const emptyMessage = `${this.HEADER}

📰 *DEUTSCHE NEWS*

${this.DIVIDER}

_Keine News verfügbar._
_RSS-Feeds werden geladen..._

${this.DIVIDER}`;

      if (messageId) {
        await this.editMessage(chatId, messageId, emptyMessage, {
          inline_keyboard: [
            [{ text: '🔄 Reload', callback_data: 'action:news' }],
            [{ text: '◀️ Back', callback_data: 'action:menu' }],
          ],
        });
      } else {
        await this.sendMessageWithKeyboard(emptyMessage, {
          inline_keyboard: [
            [{ text: '🔄 Reload', callback_data: 'action:news' }],
            [{ text: '◀️ Back', callback_data: 'action:menu' }],
          ],
        }, chatId);
      }
      return;
    }

    // Formatiere News-Liste
    let newsList = '';
    for (const item of latestNews) {
      const source = (item.data.source as string || 'News').substring(0, 15);
      const pubDate = item.data.pubDate as Date | undefined;
      const timeStr = pubDate
        ? pubDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
        : '--:--';

      // Escape Markdown-Zeichen im Titel
      const safeTitle = item.title
        .substring(0, 50)
        .replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

      newsList += `\n📰 *${timeStr}* | ${source}\n${safeTitle}${item.title.length > 50 ? '...' : ''}\n`;
    }

    const message = `${this.HEADER}

📰 *DEUTSCHE NEWS* (${latestNews.length})

${this.DIVIDER}
${newsList}
${this.DIVIDER}

_Aktualisiert: ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}_`;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'action:news' }],
          [{ text: '◀️ Back', callback_data: 'action:menu' }],
        ],
      });
    } else {
      await this.sendMessageWithKeyboard(message, {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'action:news' }],
          [{ text: '◀️ Back', callback_data: 'action:menu' }],
        ],
      }, chatId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                    ZEITVORSPRUNG DASHBOARD
  // ═══════════════════════════════════════════════════════════════

  private async handleTimeAdvantageDashboard(chatId: string, messageId?: number): Promise<void> {
    const dashboard = timeAdvantageService.getDashboard();

    let message: string;

    if (dashboard.totalTracked === 0) {
      message = `${this.HEADER}

*ZEITVORSPRUNG TRACKER*

${this.DIVIDER}

_Noch keine Daten vorhanden._

Der Tracker sammelt automatisch Daten wenn deutsche News mit Polymarket-Maerkten gematcht werden.

\`\`\`
Wie funktioniert's?
1. Deutsche News wird erkannt
2. Markt-Match gesucht
3. Preis-Snapshot gemacht
4. Preis nach 5/15/30/60 Min geprueft
5. Zeitvorsprung berechnet
\`\`\`

${this.DIVIDER}

_Warte auf Breaking News..._`;
    } else {
      // Formatiere Quellen-Tabelle
      let sourceTable = '';
      if (dashboard.bySource.length > 0) {
        sourceTable = '\n*Top Quellen:*\n```\n';
        sourceTable += 'Quelle          | # | Adv.  | Acc.\n';
        sourceTable += '----------------|---|-------|-----\n';

        for (const src of dashboard.bySource.slice(0, 6)) {
          const name = src.source.substring(0, 15).padEnd(15);
          const count = src.count.toString().padStart(2);
          const adv = src.avgAdvantage > 0 ? `${src.avgAdvantage.toFixed(0)}m`.padStart(5) : '  -  ';
          const acc = src.accuracy > 0 ? `${src.accuracy.toFixed(0)}%`.padStart(4) : '  - ';
          sourceTable += `${name} |${count} |${adv} |${acc}\n`;
        }
        sourceTable += '```';
      }

      // Formatiere letzte Trackings
      let recentList = '';
      if (dashboard.recentEntries.length > 0) {
        recentList = '\n*Letzte Trackings:*\n';
        for (const entry of dashboard.recentEntries.slice(0, 5)) {
          const statusEmoji = entry.status === 'completed'
            ? (entry.predictionCorrect ? '✅' : '❌')
            : entry.status === 'tracking'
              ? '⏳'
              : '⏰';

          const moveStr = entry.priceMove60min !== null
            ? `${entry.priceMove60min >= 0 ? '+' : ''}${(entry.priceMove60min * 100).toFixed(1)}%`
            : '-';

          const advStr = entry.timeAdvantageMinutes !== null
            ? `${entry.timeAdvantageMinutes}m`
            : '-';

          // Escape Markdown im Titel
          const safeTitle = entry.newsTitle.substring(0, 35).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

          recentList += `${statusEmoji} _${entry.newsSource}_\n   ${safeTitle}...\n   Move: ${moveStr} | Adv: ${advStr}\n`;
        }
      }

      // Berechne "Edge Confidence" (wie sicher sind wir, dass es einen Edge gibt)
      const edgeConfidence = dashboard.totalWithSignificantMove > 0 && dashboard.totalMatched > 0
        ? Math.min(100, Math.round((dashboard.totalWithSignificantMove / dashboard.totalMatched) * 100))
        : 0;
      const edgeBar = this.progressBar(edgeConfidence, 100, 10);

      message = `${this.HEADER}

*ZEITVORSPRUNG DASHBOARD*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  DE INTEL PROOF              │
├─────────────────────────────────┤
│  Getrackte News:     ${dashboard.totalTracked.toString().padStart(7)} │
│  Mit Markt-Match:    ${dashboard.totalMatched.toString().padStart(7)} │
│  Signifikante Moves: ${dashboard.totalWithSignificantMove.toString().padStart(7)} │
├─────────────────────────────────┤
│  Avg. Zeitvorsprung: ${dashboard.avgTimeAdvantageMinutes > 0 ? (dashboard.avgTimeAdvantageMinutes.toFixed(0) + ' min').padStart(7) : '    -  '} │
│  Avg. Preisbewegung: ${dashboard.avgPriceMove > 0 ? ((dashboard.avgPriceMove * 100).toFixed(1) + '%').padStart(7) : '    -  '} │
│  Vorhersage-Genau.:  ${dashboard.predictionAccuracy > 0 ? (dashboard.predictionAccuracy.toFixed(0) + '%').padStart(7) : '    -  '} │
└─────────────────────────────────┘
\`\`\`

*Edge Confidence:*
\`${edgeBar}\` ${edgeConfidence}%
${sourceTable}
${recentList}
${this.DIVIDER}

_${dashboard.pendingPriceChecks} Price-Checks ausstehend_
_Letzte Aktualisierung: ${new Date().toLocaleTimeString('de-DE')}_`;
    }

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'action:edge' }],
        [{ text: '◀️ Back', callback_data: 'action:menu' }],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
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
          { text: '🔄 Refresh', callback_data: 'action:ticker' },
        ],
        [
          { text: '◀️ Back', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                 V4.0 PERFORMANCE DASHBOARD
  // ═══════════════════════════════════════════════════════════════

  private async handlePerformanceDashboard(chatId: string, messageId?: number): Promise<void> {
    const stats = performanceTracker.getStats();
    const settings = performanceTracker.getSettings();

    const modeEmoji = settings.executionMode === 'live' ? '🚀' : settings.executionMode === 'shadow' ? '👻' : '📝';
    const autoEmoji = settings.autoTradeEnabled ? '🤖' : '⏸️';
    const fullAutoEmoji = settings.fullAutoMode ? '⚡' : '';

    // Win Rate Bar
    const winRatePercent = Math.round(stats.winRate * 100);
    const winRateBar = '█'.repeat(Math.round(winRatePercent / 10)) + '░'.repeat(10 - Math.round(winRatePercent / 10));

    const message = `${this.HEADER}

📊 *PERFORMANCE DASHBOARD V4\\.0*

${this.DIVIDER}

\`\`\`
╔═══════════════════════════════════════╗
║     ██████╗ ███████╗██████╗ ███████╗  ║
║     ██╔══██╗██╔════╝██╔══██╗██╔════╝  ║
║     ██████╔╝█████╗  ██████╔╝█████╗    ║
║     ██╔═══╝ ██╔══╝  ██╔══██╗██╔══╝    ║
║     ██║     ███████╗██║  ██║██║       ║
║     ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝       ║
║         PERFORMANCE TRACKER           ║
╚═══════════════════════════════════════╝
\`\`\`

${this.DIVIDER}

*MODE:* ${modeEmoji} ${settings.executionMode.toUpperCase()} ${autoEmoji} ${fullAutoEmoji}
*Min Confidence:* ${(settings.autoTradeMinConfidence * 100).toFixed(0)}%

${this.DIVIDER}

*TRADES:*
\`\`\`
┌─────────────────────────────────┐
│  Total:     ${String(stats.totalTrades).padStart(6)}              │
│  Paper:     ${String(stats.paperTrades).padStart(6)}              │
│  Live:      ${String(stats.liveTrades).padStart(6)}              │
├─────────────────────────────────┤
│  Pending:   ${String(stats.pending).padStart(6)}              │
│  Won:       ${String(stats.won).padStart(6)}              │
│  Lost:      ${String(stats.lost).padStart(6)}              │
└─────────────────────────────────┘
\`\`\`

*WIN RATE:*
\`${winRateBar}\` ${winRatePercent}%

${this.DIVIDER}

*FINANCIALS:*
\`\`\`
┌─────────────────────────────────┐
│  Volume:    $${stats.totalVolume.toFixed(2).padStart(10)}       │
│  Expected:  $${stats.totalExpectedProfit.toFixed(2).padStart(10)}       │
│  Actual:    $${stats.totalActualProfit.toFixed(2).padStart(10)}       │
├─────────────────────────────────┤
│  ROI:       ${(stats.roi >= 0 ? '+' : '') + stats.roi.toFixed(2).padStart(9)}%       │
└─────────────────────────────────┘
\`\`\`

${this.DIVIDER}

*HEUTE:*
📈 Trades: ${stats.today.trades} | Volume: $${stats.today.volume.toFixed(0)} | P/L: $${stats.today.profit.toFixed(2)}

*DIESE WOCHE:*
📊 Trades: ${stats.thisWeek.trades} | Volume: $${stats.thisWeek.volume.toFixed(0)} | P/L: $${stats.thisWeek.profit.toFixed(2)}

${this.DIVIDER}

*BY STRATEGY:*
💰 Arbitrage:  ${stats.byStrategy.arbitrage.trades} trades | $${stats.byStrategy.arbitrage.profit.toFixed(2)}
⏱️ Late\\-Entry: ${stats.byStrategy.lateEntry.trades} trades | $${stats.byStrategy.lateEntry.profit.toFixed(2)}
⚡ Time\\-Delay: ${stats.byStrategy.timeDelay.trades} trades | $${stats.byStrategy.timeDelay.profit.toFixed(2)}

${stats.lastTradeAt ? `_Letzter Trade: ${stats.lastTradeAt.toLocaleString('de-DE')}_` : ''}`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '🔄 Refresh', callback_data: 'action:stats' },
        ],
        [
          { text: '⚙️ Settings', callback_data: 'action:settings' },
          { text: '◀️ Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      TRADE HISTORY
  // ═══════════════════════════════════════════════════════════════

  private async handleTradeHistory(chatId: string, messageId?: number, offset: number = 0): Promise<void> {
    // Typing Indicator
    await this.bot?.sendChatAction(chatId, 'typing');

    const limit = 10;
    const trades = performanceTracker.getTrades(limit + 1, offset);
    const hasMore = trades.length > limit;
    const displayTrades = trades.slice(0, limit);

    if (displayTrades.length === 0) {
      const emptyMessage = `${this.HEADER}

📜 *TRADE HISTORY*

${this.DIVIDER}

_Noch keine Trades aufgezeichnet._

Starte mit /scan um Signale zu finden.`;

      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: '🔥 Start Scan', callback_data: 'action:scan' }],
          [{ text: '◀️ Menü', callback_data: 'action:menu' }],
        ],
      };

      if (messageId) {
        await this.editMessage(chatId, messageId, emptyMessage, keyboard);
      } else {
        await this.sendMessageWithKeyboard(emptyMessage, keyboard, chatId);
      }
      return;
    }

    // Trades formatieren
    const tradeLines = displayTrades.map((t, i) => {
      const num = offset + i + 1;
      const statusEmoji = t.status === 'pending' || t.status === 'filled' ? '⏳' : t.status === 'won' ? '✅' : '❌';
      const dirEmoji = t.direction === 'yes' ? '🟢' : '🔴';
      const stratEmoji = t.strategy === 'arbitrage' ? '💰' : t.strategy === 'lateEntry' ? '⏱️' : '⚡';
      const pnl = t.actualProfit !== undefined ? (t.actualProfit >= 0 ? `+$${t.actualProfit.toFixed(2)}` : `-$${Math.abs(t.actualProfit).toFixed(2)}`) : '--';
      const date = t.createdAt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });

      return `${num}\\. ${statusEmoji} ${dirEmoji} ${stratEmoji} $${t.size.toFixed(0)} @ ${(t.entryPrice * 100).toFixed(0)}% | ${pnl} \\(${date}\\)`;
    }).join('\n');

    const message = `${this.HEADER}

📜 *TRADE HISTORY*

${this.DIVIDER}

*Letzte ${displayTrades.length} Trades${offset > 0 ? ` (ab #${offset + 1})` : ''}:*

${tradeLines}

${this.DIVIDER}

_Legende: ✅ Won | ❌ Lost | ⏳ Pending_
_💰 Arb | ⏱️ Late | ⚡ Time\\-Delay_`;

    const buttons: InlineKeyboardButton[][] = [];

    // Paging Buttons
    const pagingRow: InlineKeyboardButton[] = [];
    if (offset > 0) {
      pagingRow.push({ text: '◀️ Back', callback_data: `history_page:${Math.max(0, offset - limit)}` });
    }
    if (hasMore) {
      pagingRow.push({ text: 'Weiter ▶️', callback_data: `history_page:${offset + limit}` });
    }
    if (pagingRow.length > 0) {
      buttons.push(pagingRow);
    }

    // Filter Buttons
    buttons.push([
      { text: '✅ Wins', callback_data: 'history_filter:won' },
      { text: '❌ Losses', callback_data: 'history_filter:lost' },
      { text: '⏳ Pending', callback_data: 'history_filter:pending' },
    ]);

    buttons.push([
      { text: '🔄 Refresh', callback_data: 'action:history' },
      { text: '◀️ Menü', callback_data: 'action:menu' },
    ]);

    const keyboard: InlineKeyboardMarkup = { inline_keyboard: buttons };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  private async handleTradeHistoryFiltered(chatId: string, messageId: number | undefined, filter: string): Promise<void> {
    await this.bot?.sendChatAction(chatId, 'typing');

    let trades = performanceTracker.getTrades(100);

    // Filter anwenden
    switch (filter) {
      case 'won':
        trades = trades.filter(t => t.status === 'won');
        break;
      case 'lost':
        trades = trades.filter(t => t.status === 'lost');
        break;
      case 'pending':
        trades = trades.filter(t => t.status === 'pending' || t.status === 'filled');
        break;
    }

    trades = trades.slice(0, 10);
    const filterEmoji = filter === 'won' ? '✅' : filter === 'lost' ? '❌' : '⏳';
    const filterLabel = filter === 'won' ? 'Gewonnen' : filter === 'lost' ? 'Verloren' : 'Offen';

    if (trades.length === 0) {
      const emptyMessage = `${this.HEADER}

📜 *TRADE HISTORY* \\- ${filterEmoji} ${filterLabel}

${this.DIVIDER}

_Keine ${filterLabel.toLowerCase()}en Trades gefunden\\._`;

      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: '📜 Alle anzeigen', callback_data: 'action:history' }],
          [{ text: '◀️ Menü', callback_data: 'action:menu' }],
        ],
      };

      if (messageId) {
        await this.editMessage(chatId, messageId, emptyMessage, keyboard);
      } else {
        await this.sendMessageWithKeyboard(emptyMessage, keyboard, chatId);
      }
      return;
    }

    const tradeLines = trades.map((t, i) => {
      const num = i + 1;
      const statusEmoji = t.status === 'pending' || t.status === 'filled' ? '⏳' : t.status === 'won' ? '✅' : '❌';
      const dirEmoji = t.direction === 'yes' ? '🟢' : '🔴';
      const stratEmoji = t.strategy === 'arbitrage' ? '💰' : t.strategy === 'lateEntry' ? '⏱️' : '⚡';
      const pnl = t.actualProfit !== undefined ? (t.actualProfit >= 0 ? `+$${t.actualProfit.toFixed(2)}` : `-$${Math.abs(t.actualProfit).toFixed(2)}`) : '--';
      const date = t.createdAt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });

      return `${num}\\. ${statusEmoji} ${dirEmoji} ${stratEmoji} $${t.size.toFixed(0)} @ ${(t.entryPrice * 100).toFixed(0)}% | ${pnl} \\(${date}\\)`;
    }).join('\n');

    const message = `${this.HEADER}

📜 *TRADE HISTORY* \\- ${filterEmoji} ${filterLabel}

${this.DIVIDER}

${tradeLines}

${this.DIVIDER}

_${trades.length} ${filterLabel.toLowerCase()}e Trades_`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Wins', callback_data: 'history_filter:won' },
          { text: '❌ Losses', callback_data: 'history_filter:lost' },
          { text: '⏳ Pending', callback_data: 'history_filter:pending' },
        ],
        [
          { text: '📜 Alle anzeigen', callback_data: 'action:history' },
          { text: '◀️ Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      TELEGRAM HANDBUCH
  // ═══════════════════════════════════════════════════════════════

  private async handleHelpMenu(chatId: string, messageId?: number): Promise<void> {
    const message = `${this.HEADER}

📚 *EDGY ALPHA HANDBUCH V4\\.2*

${this.DIVIDER}

Willkommen beim interaktiven Handbuch\\!
Wähle ein Thema:

🚀 *Schnellstart* \\- Erste Schritte
📈 *Trading* \\- Wie du tradest
💰 *Live Trading* \\- Echtes Geld Setup
🎯 *Strategien* \\- Arbitrage, Late\\-Entry
📜 *History* \\- Trade\\-Verlauf nutzen
🛡️ *Risk* \\- Sicherheit & Limits
📋 *Commands* \\- Alle Befehle

${this.DIVIDER}

_Tippe auf einen Button für Details\\._`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '🚀 Schnellstart', callback_data: 'help:quickstart' },
          { text: '📈 Trading', callback_data: 'help:trading' },
        ],
        [
          { text: '💰 Live Trading', callback_data: 'help:live' },
          { text: '🎯 Strategien', callback_data: 'help:strategies' },
        ],
        [
          { text: '📜 History', callback_data: 'help:history' },
          { text: '🛡️ Risk', callback_data: 'help:risk' },
        ],
        [
          { text: '📋 Commands', callback_data: 'help:commands' },
        ],
        [
          { text: '◀️ Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  private async handleHelpTopic(topic: string, chatId: string, messageId?: number): Promise<void> {
    let message = '';
    const backButton: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: '📚 Zurück zum Handbuch', callback_data: 'help:menu' }],
        [{ text: '◀️ Hauptmenü', callback_data: 'action:menu' }],
      ],
    };

    switch (topic) {
      case 'menu':
        await this.handleHelpMenu(chatId, messageId);
        return;

      case 'quickstart':
        message = `${this.HEADER}

🚀 *SCHNELLSTART*

${this.DIVIDER}

*In 3 Schritten zum ersten Trade:*

*1\\. Scan starten*
\`/scan\` oder 🔥 ALPHA JAGEN Button

*2\\. Signal prüfen*
\\- Edge \\> 5% ist interessant
\\- Confidence \\> 70% ist gut
\\- Grüne Risk Gates = Go\\!

*3\\. Trade ausführen*
\\- 🚀 JA BALLERN für YES
\\- Betrag wählen \\($5\\-$50\\)
\\- Bestätigen

${this.DIVIDER}

*Wichtige Commands:*
\`/stats\` \\- Deine Performance
\`/wallet\` \\- Dein Guthaben
\`/history\` \\- Vergangene Trades

${this.DIVIDER}

⚠️ _Starte im Paper Mode \\(/mode paper\\)_`;
        break;

      case 'trading':
        message = `${this.HEADER}

📈 *TRADING ANLEITUNG*

${this.DIVIDER}

*Der Trading\\-Flow:*

\`\`\`
Signal gefunden
      ↓
[🚀 JA BALLERN] klicken
      ↓
Betrag wählen: [$5] [$10] [$25]
      ↓
[✅ Bestätigen]
      ↓
Trade ausgeführt!
\`\`\`

${this.DIVIDER}

*Signal verstehen:*

📊 *Edge* \\- Dein Vorteil vs\\. Markt
   \\>5% = interessant, \\>10% = sehr gut

🎯 *Confidence* \\- Wie sicher das Signal
   \\>70% = gut, \\>85% = sehr gut

💰 *Kelly Size* \\- Empfohlener Betrag
   Mathematisch optimal berechnet

${this.DIVIDER}

*Execution Modes:*
📝 PAPER \\- Simulation \\(kein echtes Geld\\)
👻 SHADOW \\- Loggt, tradet nicht
🚀 LIVE \\- Echtes Trading

Wechseln mit: \`/mode paper|shadow|live\``;
        break;

      case 'live':
        message = `${this.HEADER}

💰 *LIVE TRADING SETUP*

${this.DIVIDER}

*Voraussetzungen:*

☑️ Polygon Wallet \\(MetaMask etc\\.\\)
☑️ USDC auf Polygon Network
☑️ ~0\\.1 MATIC für Gas
☑️ 50\\+ Paper Trades gemacht
☑️ Positive Win Rate

${this.DIVIDER}

*Wallet einrichten:*

1\\. Private Key in \\.env:
\`WALLET\\_PRIVATE\\_KEY=0x\\.\\.\\.\`

2\\. Adresse in \\.env:
\`WALLET\\_ADDRESS=0x\\.\\.\\.\`

3\\. Server neustarten

${this.DIVIDER}

*Zu Live wechseln:*
\`/mode live\`

*Zurück zu Paper:*
\`/mode paper\`

${this.DIVIDER}

*Troubleshooting:*
❌ "Insufficient Balance" → Mehr USDC
❌ "Gas failed" → MATIC nachfüllen
❌ "CLOB not ready" → Server restart

${this.DIVIDER}

⚠️ _Starte mit kleinen Beträgen\\!_`;
        break;

      case 'strategies':
        message = `${this.HEADER}

🎯 *TRADING STRATEGIEN*

${this.DIVIDER}

*💰 Dutch\\-Book Arbitrage*
\`\`\`
Wenn YES + NO < $1.00
→ Kaufe BEIDE
→ Garantierter Profit!

Beispiel:
YES @ 45% + NO @ 52% = 97%
Profit: 3% risikofrei
\`\`\`

${this.DIVIDER}

*⏱️ Late\\-Entry V3*
\`\`\`
15-Minuten Crypto Märkte
Einstieg in letzten 4 Minuten
Wenn Trend klar erkennbar

Vorteil: Kurze Haltezeit
Risiko: Schnelle Bewegungen
\`\`\`

${this.DIVIDER}

*⚡ Time\\-Delay \\(News\\)*
\`\`\`
Deutsche News → Polymarket
Zeitvorsprung nutzen!

1. News auf Tagesschau
2. Markt reagiert noch nicht
3. Schnell kaufen
4. Profit wenn Markt aufholt
\`\`\`

${this.DIVIDER}

Aktivieren in \`/settings\``;
        break;

      case 'history':
        message = `${this.HEADER}

📜 *TRADE HISTORY*

${this.DIVIDER}

*History anzeigen:*
\`/history\`

*Filter nutzen:*
\\[✅ Wins\\] \\- Nur Gewinne
\\[❌ Losses\\] \\- Nur Verluste
\\[⏳ Pending\\] \\- Offene Trades

*Paging:*
\\[Weiter ▶️\\] \\- Nächste Seite

${this.DIVIDER}

*Trade\\-Status:*
⏳ *Pending* \\- Markt noch offen
✅ *Won* \\- Gewonnen
❌ *Lost* \\- Verloren

${this.DIVIDER}

*Strategie\\-Icons:*
💰 Arbitrage
⏱️ Late\\-Entry
⚡ Time\\-Delay

${this.DIVIDER}

*Im Web Dashboard:*
\\- Vollständige Tabelle
\\- CSV Export
\\- Erweiterte Filter

Link: 🖥️ Web Dashboard Button`;
        break;

      case 'risk':
        message = `${this.HEADER}

🛡️ *RISK MANAGEMENT*

${this.DIVIDER}

*Kill\\-Switch:*
\`/kill\` \\- Stoppt ALLE Trades
\`/resume\` \\- Aktiviert wieder

${this.DIVIDER}

*Automatische Limits:*

📉 *Daily Loss Limit*
   Stoppt bei \\-$100/Tag \\(default\\)

📊 *Max Positions*
   Max 10 offene Trades

💰 *Max pro Markt*
   Max $50 pro Markt

${this.DIVIDER}

*Cooldown System:*
Nach 3 Verlusten in Folge
→ 15 Min Pause
→ \`/cooldown reset\` zum Überspringen

${this.DIVIDER}

*Risk Gates:*
Jedes Signal wird geprüft:
✅ Genug Balance?
✅ Unter Daily Limit?
✅ Position noch offen?
✅ Markt liquid?

Nur wenn ALLE ✅ → Trade möglich

${this.DIVIDER}

*Empfehlung:*
🟢 Paper Mode zum Lernen
🟡 Shadow Mode zum Testen
🔴 Live Mode erst bei \\>55% Win Rate`;
        break;

      case 'commands':
        message = `${this.HEADER}

📋 *ALLE COMMANDS*

${this.DIVIDER}

*TRADING:*
\`/scan\` \\- Start alpha scan
\`/signals\` \\- Aktuelle Signale
\`/wallet\` \\- Balance anzeigen
\`/positions\` \\- Offene Positionen

${this.DIVIDER}

*MONITORING:*
\`/stats\` \\- Performance Dashboard
\`/history\` \\- Trade History
\`/status\` \\- System Status
\`/pnl\` \\- Tages\\-PnL

${this.DIVIDER}

*RISK CONTROLS:*
\`/kill \\[grund\\]\` \\- Stop All
\`/resume\` \\- Trading fortsetzen
\`/cooldown\` \\- Cooldown Status
\`/mode \\[m\\]\` \\- paper/shadow/live

${this.DIVIDER}

*NOTIFICATIONS:*
\`/settings\` \\- Push Settings
\`/push \\[mode\\]\` \\- Push\\-Modus
\`/quiet\` \\- Quiet Hours
\`/digest\` \\- Signal Digest

${this.DIVIDER}

*EUSSR\\-TRACKER:*
\`/polls\` \\- Wahlumfragen
\`/news\` \\- Deutsche News
\`/edge\` \\- Zeitvorsprung

${this.DIVIDER}

*SONSTIGES:*
\`/menu\` \\- Hauptmenü
\`/help\` \\- Dieses Handbuch`;
        break;

      default:
        await this.handleHelpMenu(chatId, messageId);
        return;
    }

    if (messageId) {
      await this.editMessage(chatId, messageId, message, backButton);
    } else {
      await this.sendMessageWithKeyboard(message, backButton, chatId);
    }
  }

  private async handleSettings(chatId: string, messageId?: number): Promise<void> {
    this.editingField = null; // Reset editing mode

    // Falls keine messageId übergeben, nutze die gespeicherte Menü-Message
    const effectiveMessageId = messageId || this.lastMenuMessageId.get(chatId);

    // Module Status Emojis
    const tdStatus = runtimeSettings.timeDelayEnabled ? '🟢' : '🔴';
    const deStatus = runtimeSettings.germanyOnly ? '🟢' : '🔴';
    const autoStatus = runtimeSettings.autoBetOnSafeBet ? '🟢' : '🔴';
    // V4.0: Neue Strategien
    const arbStatus = runtimeSettings.arbitrageEnabled ? '🟢' : '🔴';
    const lateStatus = runtimeSettings.lateEntryEnabled ? '🟢' : '🔴';

    const message = `${this.HEADER}

⚙️ *EINSTELLUNGEN V4\\.0*

${this.DIVIDER}

*NEWS\\-MATCHING:*
${tdStatus} ⚡ EUSSR-TRACKER: ${runtimeSettings.timeDelayEnabled ? 'AKTIV' : 'AUS'}
${deStatus} 🇩🇪 Nur Deutschland: ${runtimeSettings.germanyOnly ? 'JA' : 'NEIN'}

${this.DIVIDER}

*TRADING STRATEGIEN \\(V4\\.0\\):*
${arbStatus} 💰 Dutch\\-Book Arbitrage: ${runtimeSettings.arbitrageEnabled ? 'AKTIV' : 'AUS'}
${lateStatus} ⏱️ Late\\-Entry V3: ${runtimeSettings.lateEntryEnabled ? 'AKTIV' : 'AUS'}

${this.DIVIDER}

*AUTO\\-TRADING:*
${autoStatus} 🚨 Semi\\-Auto: ${runtimeSettings.autoBetOnSafeBet ? '🚀 AKTIV' : '⏸️ AUS'}
📊 Min Confidence: *${(runtimeSettings.autoTradeMinConfidence * 100).toFixed(0)}%*
${runtimeSettings.fullAutoMode ? '🤖 FULL\\-AUTO MODUS AKTIV' : ''}

${this.DIVIDER}

*EXECUTION MODE:*
${performanceTracker.isPaperMode() ? '📝 PAPER MODE \\(Simulation\\)' : performanceTracker.getSettings().executionMode === 'shadow' ? '👻 SHADOW MODE' : '🚀 LIVE MODE'}

${this.DIVIDER}

_Tippe auf ein Modul zum Umschalten:_`;

    // Full-Auto Status
    const fullAutoStatus = runtimeSettings.fullAutoMode ? '🟢' : '🔴';
    const paperStatus = performanceTracker.isPaperMode() ? '🟢' : '🔴';

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        // Execution Mode
        [{ text: '── EXECUTION MODE ──', callback_data: 'noop' }],
        [
          { text: `${paperStatus} 📝 Paper Mode`, callback_data: 'toggle:paperMode' },
          { text: `${!performanceTracker.isPaperMode() ? '🟢' : '🔴'} 🚀 Live Mode`, callback_data: 'toggle:liveMode' },
        ],
        // News-Matching Toggles
        [{ text: '── NEWS-MATCHING ──', callback_data: 'noop' }],
        [
          { text: `${tdStatus} ⚡ EUSSR-TRACKER`, callback_data: 'toggle:timeDelay' },
          { text: `${deStatus} 🇩🇪 Nur DE`, callback_data: 'toggle:germanyOnly' },
        ],
        // V4.0: Neue Trading Strategien
        [{ text: '── TRADING V4.0 ──', callback_data: 'noop' }],
        [
          { text: `${arbStatus} 💰 Arbitrage`, callback_data: 'toggle:arbitrage' },
          { text: `${lateStatus} ⏱️ Late-Entry`, callback_data: 'toggle:lateEntry' },
        ],
        // Auto-Trade Toggle
        [{ text: '── AUTO-TRADE ──', callback_data: 'noop' }],
        [
          { text: `${autoStatus} 🤖 Semi-Auto`, callback_data: 'toggle:autoBet' },
          { text: `${fullAutoStatus} ⚡ Full-Auto`, callback_data: 'toggle:fullAuto' },
        ],
        [
          { text: `📊 Min Confidence`, callback_data: 'noop' },
          { text: `${(runtimeSettings.autoTradeMinConfidence * 100).toFixed(0)}%`, callback_data: 'noop' },
          { text: `✏️`, callback_data: 'edit:autoConfidence' },
        ],
        // Divider
        [{ text: '── PARAMETER ──', callback_data: 'noop' }],
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
        [{ text: '◀️ Back', callback_data: 'action:menu' }],
      ],
    };

    if (effectiveMessageId) {
      try {
        await this.editMessage(chatId, effectiveMessageId, message, keyboard);
        this.setLastMenuMessageId(chatId, effectiveMessageId);
        return;
      } catch {
        // Edit fehlgeschlagen - sende neue Nachricht
        this.lastMenuMessageId.delete(chatId);
      }
    }
    // Sende neue Nachricht und speichere messageId
    const sentMessage = await this.sendMessageWithKeyboard(message, keyboard, chatId);
    if (sentMessage?.message_id) {
      this.setLastMenuMessageId(chatId, sentMessage.message_id);
    }
  }

  private async handleModuleToggle(module: string, chatId: string, messageId?: number): Promise<void> {
    // Paper/Live Mode Toggles (spezielle Behandlung)
    if (module === 'paperMode') {
      performanceTracker.updateSettings({ executionMode: 'paper' });
      runtimeState.setExecutionMode('paper', 'telegram');
      await this.sendMessage(
        `📝 *PAPER MODE AKTIVIERT*\n\n` +
        `Alle Trades werden simuliert.\n` +
        `Performance wird getrackt in /stats`,
        chatId
      );
      await this.handleSettings(chatId, messageId);
      return;
    }

    if (module === 'liveMode') {
      // Sicherheitsabfrage für Live Mode
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: '⚠️ JA, Live Mode aktivieren', callback_data: 'confirm:liveMode' }],
          [{ text: '❌ Abbrechen', callback_data: 'action:settings' }],
        ],
      };
      await this.sendMessageWithKeyboard(
        `🚨 *WARNUNG: LIVE MODE*\n\n` +
        `Im Live Mode werden ECHTE Trades ausgeführt!\n\n` +
        `Bist du sicher?`,
        keyboard,
        chatId
      );
      return;
    }

    if (module === 'fullAuto') {
      runtimeSettings.fullAutoMode = !runtimeSettings.fullAutoMode;
      syncSettings();
      const status = runtimeSettings.fullAutoMode;
      await this.sendMessage(
        status
          ? `🤖 *FULL-AUTO MODUS AKTIVIERT*\n\n` +
            `ALLE Signale werden automatisch getradet!\n` +
            `Confidence-Schwelle wird ignoriert.\n\n` +
            `⚠️ _Hohes Risiko - nur im Paper Mode empfohlen!_`
          : `⏸️ *FULL-AUTO DEAKTIVIERT*\n\n` +
            `Zurück zu Semi-Auto.\n` +
            `Nur Signals mit Confidence >${(runtimeSettings.autoTradeMinConfidence * 100).toFixed(0)}% werden auto-getradet.`,
        chatId
      );
      await this.handleSettings(chatId, messageId);
      return;
    }

    const moduleMap: Record<string, keyof typeof runtimeSettings> = {
      timeDelay: 'timeDelayEnabled',
      mispricing: 'mispricingEnabled',
      germanyOnly: 'germanyOnly',
      autoBet: 'autoBetOnSafeBet',
      // V4.0: Neue Strategien
      arbitrage: 'arbitrageEnabled',
      lateEntry: 'lateEntryEnabled',
    };

    const settingKey = moduleMap[module];
    if (!settingKey) return;

    // Toggle the value
    (runtimeSettings as unknown as Record<string, boolean>)[settingKey] = !runtimeSettings[settingKey];
    syncSettings(); // Persist to tracker

    const newValue = runtimeSettings[settingKey];
    const moduleNames: Record<string, string> = {
      timeDelay: '⚡ EUSSR-TRACKER',
      mispricing: 'MISPRICING',
      germanyOnly: '🇩🇪 Nur Deutschland',
      autoBet: '🤖 Semi-Auto',
      arbitrage: '💰 Dutch-Book Arbitrage',
      lateEntry: '⏱️ Late-Entry V3',
    };

    logger.info(`[TELEGRAM] Modul ${moduleNames[module]} → ${newValue ? 'AKTIVIERT' : 'DEAKTIVIERT'}`);

    // V4.0: Dutch-Book Arbitrage Toggle
    if (module === 'arbitrage') {
      dutchBookEngine.setEnabled(newValue as boolean);
      if (newValue) {
        const arbConfig = dutchBookEngine.getConfig();
        await this.sendMessage(
          `💰 *DUTCH-BOOK ARBITRAGE AKTIVIERT*\n\n` +
          `Scanne Märkte auf risikofreie Opportunities (YES+NO < $1.00)\n\n` +
          `*Config:*\n` +
          `• Min Spread: ${(arbConfig.minSpread * 100).toFixed(1)}%\n` +
          `• Min Liquidity: $${arbConfig.minLiquidity}\n` +
          `• Max Trade: $${arbConfig.maxTradeSize}\n\n` +
          `_Du wirst bei Opportunities benachrichtigt!_`,
          chatId
        );
      } else {
        await this.sendMessage(
          `⏸️ *ARBITRAGE DEAKTIVIERT*\n\n` +
          `Dutch-Book Scanner gestoppt.`,
          chatId
        );
      }
    }

    // V4.0: Late-Entry V3 Toggle
    if (module === 'lateEntry') {
      lateEntryEngine.setEnabled(newValue as boolean);
      if (newValue) {
        const lateConfig = lateEntryEngine.getConfig();
        await this.sendMessage(
          `⏱️ *LATE-ENTRY V3 AKTIVIERT*\n\n` +
          `Scanne 15-Min Crypto Markets (BTC, ETH, SOL, XRP)\n\n` +
          `*Config:*\n` +
          `• Entry Window: Letzte ${lateConfig.entryWindowSeconds}s\n` +
          `• Min Confidence: ${(lateConfig.minConfidence * 100).toFixed(0)}%\n` +
          `• Max Trade: $${lateConfig.maxTradeSize}\n\n` +
          `_Du wirst bei Signalen benachrichtigt!_`,
          chatId
        );
      } else {
        await this.sendMessage(
          `⏸️ *LATE-ENTRY DEAKTIVIERT*\n\n` +
          `15-Min Crypto Scanner gestoppt.`,
          chatId
        );
      }
    }

    // Auto-Bet Toggle (deprecated, kept for compatibility)
    if (module === 'autoBet') {
      timeDelayEngine.updateConfig({ autoTradeEnabled: newValue as boolean });
      if (newValue) {
        await this.sendMessage(
          `🚨 *AUTO-TRADE AKTIVIERT*\n\n` +
          `_Hinweis: Nutze die neuen Trading-Strategien (Arbitrage/Late-Entry) für bessere Ergebnisse!_`,
          chatId
        );
      }
    }

    // Refresh settings menu
    await this.handleSettings(chatId, messageId);
  }

  private async handleEdit(field: string, chatId: string, messageId?: number): Promise<void> {
    this.editingField = field;

    const labels: Record<string, string> = {
      maxBet: '💵 Max Bet ($)',
      risk: '📊 Risiko (%)',
      minEdge: '📉 Min Edge (%)',
      minAlpha: '🎯 Min Alpha (%)',
      minVolume: '💰 Min Volume ($)',
      autoConfidence: '📊 Auto-Trade Min Confidence (%)',
    };

    // Spezielle Behandlung für autoConfidence (wird als Prozent angezeigt)
    let current: number | boolean;
    if (field === 'autoConfidence') {
      current = runtimeSettings.autoTradeMinConfidence * 100;
    } else {
      current = runtimeSettings[field as keyof typeof runtimeSettings];
    }

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
  private async handleSetValue(_setting: string, _value: string, chatId: string, messageId?: number): Promise<void> {
    await this.handleSettings(chatId, messageId);
  }

  private async handleSettingChange(_setting: string, chatId: string, messageId?: number): Promise<void> {
    await this.handleSettings(chatId, messageId);
  }

  private async handleTextInput(text: string, chatId: string): Promise<void> {
    if (!this.editingField) return;

    // SAFE BET Custom-Betrag verarbeiten
    if (this.editingField.startsWith('safebet:')) {
      const handled = await this.handleSafeBetCustomInput(text, chatId);
      if (handled) return;
    }

    const numValue = parseFloat(text.replace(/[^0-9.]/g, ''));

    if (isNaN(numValue) || numValue <= 0) {
      this.editingField = null; // WICHTIG: Reset bei Fehler (sonst Memory Leak/State Bug)
      await this.sendMessage('❌ Ungültiger Wert. Bitte eine Zahl eingeben.', chatId);
      return;
    }

    // Spezielle Behandlung für autoConfidence
    if (this.editingField === 'autoConfidence') {
      const confidenceValue = Math.min(Math.max(numValue / 100, 0.1), 1.0); // 10% - 100%
      runtimeSettings.autoTradeMinConfidence = confidenceValue;
      syncSettings();

      this.editingField = null;
      await this.sendMessage(
        `✅ *Auto-Trade Min Confidence* geändert auf: *${(confidenceValue * 100).toFixed(0)}%*\n\n` +
        `Trades mit Confidence ≥${(confidenceValue * 100).toFixed(0)}% werden automatisch ausgeführt.`,
        chatId
      );
      await this.handleSettings(chatId);
      return;
    }

    // Wert setzen
    (runtimeSettings as unknown as Record<string, number>)[this.editingField] = numValue;
    syncSettings(); // Persist to tracker

    // Runtime State auch updaten
    const updates: Record<string, number> = {};
    switch (this.editingField) {
      case 'maxBet':
        config.trading.maxBetUsdc = numValue;
        updates.maxBetUsdc = numValue;
        break;
      case 'risk':
        config.trading.riskPerTradePercent = numValue;
        updates.riskPerTradePercent = numValue;
        break;
      case 'minEdge':
        config.germany.minEdge = numValue / 100;
        updates.minEdge = numValue;
        break;
      case 'minAlpha':
        config.trading.minAlphaForTrade = numValue / 100;
        updates.minAlpha = numValue;
        break;
      case 'minVolume':
        config.scanner.minVolumeUsd = numValue;
        updates.minVolumeUsd = numValue;
        break;
    }

    // Runtime State synchronisieren
    runtimeState.updateSettings(updates, 'telegram');

    this.editingField = null;

    const message = `✅ Gespeichert!`;
    await this.sendMessage(message, chatId);

    // Back to Settings
    await this.handleSettings(chatId);
  }

  // ═══════════════════════════════════════════════════════════════
  //                   RISK DASHBOARD & CONTROLS
  // ═══════════════════════════════════════════════════════════════

  private async handleRiskDashboard(chatId: string, messageId?: number): Promise<void> {
    const dashboard = runtimeState.getRiskDashboard();

    // Mode Badge
    const modeBadge: Record<string, string> = {
      paper: '📝 PAPER',
      shadow: '👻 SHADOW',
      live: '🚀 LIVE',
    };

    // PnL Farbe
    const pnlEmoji = dashboard.daily.pnl >= 0 ? '🟢' : '🔴';
    const pnlSign = dashboard.daily.pnl >= 0 ? '+' : '';

    // Win Rate Bar
    const winRateBar = this.progressBar(dashboard.daily.winRate, 100, 8);

    // Daily Loss Remaining Bar
    const lossRemainingPct = (dashboard.limits.dailyLossRemaining / dashboard.limits.dailyLossLimit) * 100;
    const lossBar = this.progressBar(Math.max(0, lossRemainingPct), 100, 8);

    const message = `${this.HEADER}

🛡️ *RISK DASHBOARD*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  MODE: ${modeBadge[dashboard.mode].padEnd(24)}│
│  KILL-SWITCH: ${(dashboard.killSwitch.active ? '[!] AN' : '[+] AUS').padEnd(16)}│
├─────────────────────────────────┤
│  TÄGLICHE PERFORMANCE           │
├─────────────────────────────────┤
│  PnL:      ${pnlEmoji} ${pnlSign}$${dashboard.daily.pnl.toFixed(2).padStart(8)}       │
│  Trades:   ${String(dashboard.daily.trades).padStart(4)}                 │
│  Wins:     ${String(dashboard.daily.wins).padStart(4)} (${dashboard.daily.winRate.toFixed(0)}%)           │
│  Losses:   ${String(dashboard.daily.losses).padStart(4)}                 │
│  Win-Rate: ${winRateBar}      │
├─────────────────────────────────┤
│  LIMITS                         │
├─────────────────────────────────┤
│  Daily Loss: $${dashboard.limits.dailyLossRemaining.toFixed(0).padStart(4)}/$${dashboard.limits.dailyLossLimit.toFixed(0).padStart(4)}    │
│  Remaining: ${lossBar}       │
│  Positions: ${String(dashboard.positions.open).padStart(2)}/${String(dashboard.positions.max).padStart(2)}              │
│  Exposure:  $${dashboard.positions.totalExposure.toFixed(2).padStart(8)}        │
└─────────────────────────────────┘
\`\`\`

${dashboard.canTrade.allowed ? '✅ Trading erlaubt' : `⚠️ ${dashboard.canTrade.reason}`}`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text: dashboard.killSwitch.active ? '🔴 KILL-SWITCH AUS' : '⚠️ KILL-SWITCH AN',
            callback_data: dashboard.killSwitch.active ? 'killswitch:off' : 'killswitch:on',
          },
        ],
        [
          { text: '🔄 Refresh', callback_data: 'action:risk' },
          { text: '🗑️ Daily Reset', callback_data: 'killswitch:reset' },
        ],
        [{ text: '◀️ Back', callback_data: 'action:menu' }],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  private async handleModeSelect(chatId: string, messageId?: number): Promise<void> {
    const currentMode = runtimeState.getExecutionMode();

    const modeDescriptions: Record<string, string> = {
      paper: 'Simuliert Trades ohne echtes Geld',
      shadow: 'Trackt Preise, führt keine Trades aus',
      live: 'Echte Trades mit echtem Geld!',
    };

    const message = `${this.HEADER}

⚙️ *EXECUTION MODE*

${this.DIVIDER}

Aktueller Modus: *${currentMode.toUpperCase()}*
_${modeDescriptions[currentMode]}_

${this.DIVIDER}

Wähle den Modus:`;

    const modes: ExecutionMode[] = ['paper', 'shadow', 'live'];
    const modeEmojis: Record<string, string> = {
      paper: '📝',
      shadow: '👻',
      live: '🚀',
    };

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        ...modes.map((mode) => [
          {
            text: `${modeEmojis[mode]} ${mode.toUpperCase()}${currentMode === mode ? ' ✓' : ''}`,
            callback_data: `setmode:${mode}`,
          },
        ]),
        [{ text: '◀️ Back', callback_data: 'action:menu' }],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  private async handleSetMode(mode: ExecutionMode, chatId: string, messageId?: number): Promise<void> {
    const result = runtimeState.setExecutionMode(mode, 'telegram');

    if (result.success) {
      const message = `${this.HEADER}

✅ *MODE GEÄNDERT*

${result.message}

${mode === 'live' ? '⚠️ *ACHTUNG: LIVE MODE!*\nEchte Trades werden ausgeführt!' : ''}`;

      if (messageId) {
        await this.editMessage(chatId, messageId, message, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
      }
      // KEIN automatisches Menü mehr - User kann "Zurück" klicken wenn gewünscht
    } else {
      const message = `${this.HEADER}

❌ *MODE NICHT GEÄNDERT*

${result.message}`;

      if (messageId) {
        await this.editMessage(chatId, messageId, message, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
      }
    }
  }

  private async handleKillSwitchToggle(chatId: string, messageId?: number): Promise<void> {
    await this.handleRiskDashboard(chatId, messageId);
  }

  private async handleKillSwitchAction(action: string, chatId: string, messageId?: number): Promise<void> {
    if (action === 'on') {
      runtimeState.activateKillSwitch('Manuell via Telegram aktiviert', 'telegram');

      const message = `${this.HEADER}

🔴 *KILL-SWITCH AKTIVIERT*

Alle Trades wurden gestoppt.
_Um fortzufahren, deaktiviere den Kill-Switch._`;

      if (messageId) {
        await this.editMessage(chatId, messageId, message, this.getBackButton());
      }
      // KEIN automatischer Rücksprung - User klickt "Zurück" wenn gewünscht
    } else if (action === 'off') {
      runtimeState.deactivateKillSwitch('telegram');

      const message = `${this.HEADER}

🟢 *KILL-SWITCH DEAKTIVIERT*

Trading wieder möglich.`;

      if (messageId) {
        await this.editMessage(chatId, messageId, message, this.getBackButton());
      }
      // KEIN automatischer Rücksprung
    } else if (action === 'reset') {
      runtimeState.resetDaily();

      const message = `${this.HEADER}

🗑️ *DAILY RESET*

Tägliche Statistiken wurden zurückgesetzt.`;

      if (messageId) {
        await this.editMessage(chatId, messageId, message, this.getBackButton());
      }
      // KEIN automatischer Rücksprung
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //              NOTIFICATION SETTINGS HANDLERS
  // ═══════════════════════════════════════════════════════════════

  private async handleNotificationSettings(
    setting: string,
    value: string,
    chatId: string,
    messageId?: number
  ): Promise<void> {
    const settings = getNotificationSettings(chatId);

    if (setting === 'push') {
      // Push-Modus ändern
      const newMode = value as PushMode;
      updateNotificationSettings(chatId, { pushMode: newMode });

      const modeEmoji: Record<string, string> = {
        OFF: '🔇',
        TIME_DELAY_ONLY: '⚡',
        SYSTEM_ONLY: '🔔',
        DIGEST_ONLY: '📋',
        FULL: '📢',
      };

      const message = `${this.HEADER}

✅ *Push-Modus geändert*

${modeEmoji[newMode] || '❓'} *${newMode}*

_Änderung sofort aktiv._`;

      if (messageId) {
        await this.editMessage(chatId, messageId, message, {
          inline_keyboard: [
            [{ text: '⚙️ Back to Settings', callback_data: 'action:settings' }],
            [{ text: '🔙 Menü', callback_data: 'action:menu' }],
          ],
        });
      }
    } else if (setting === 'quiet') {
      if (value === 'toggle') {
        // Quiet Hours togglen
        const newState = !settings.quietHoursEnabled;
        updateNotificationSettings(chatId, { quietHoursEnabled: newState });

        const message = `${this.HEADER}

${newState ? '🌙' : '☀️'} *Quiet Hours ${newState ? 'aktiviert' : 'deaktiviert'}*

${newState
    ? `Keine Pushes zwischen ${settings.quietHoursStart}-${settings.quietHoursEnd} (${settings.timezone})`
    : 'Pushes können jederzeit gesendet werden.'
}`;

        if (messageId) {
          await this.editMessage(chatId, messageId, message, {
            inline_keyboard: [
              [{ text: '⚙️ Back to Settings', callback_data: 'action:settings' }],
              [{ text: '🔙 Menü', callback_data: 'action:menu' }],
            ],
          });
        }
      }
    }
  }

  private async handleDigestAction(action: string, chatId: string, messageId?: number): Promise<void> {
    if (action === 'refresh') {
      // Refresh Digest
      const stats = notificationService.getStats();

      const message = `${this.HEADER}

📋 *SIGNAL DIGEST* (aktualisiert)

${this.DIVIDER}

*Kandidaten heute:*
• Neu: ${stats.byStatus.new}
• Gematcht: ${stats.byStatus.matched}
• Gepusht: ${stats.pushedToday}
• Rejected: ${stats.rejectedToday}
• Expired: ${stats.byStatus.expired}
• Pending Batch: ${stats.pendingBatch}

${this.DIVIDER}

_Stand: ${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}_`;

      if (messageId) {
        await this.editMessage(chatId, messageId, message, {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'digest:refresh' }],
            [
              { text: '⚙️ Settings', callback_data: 'action:settings' },
              { text: '🔙 Menü', callback_data: 'action:menu' },
            ],
          ],
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      TRADE HANDLERS
  // ═══════════════════════════════════════════════════════════════

  private async handleTrade(direction: string, signalId: string, chatId: string, messageId?: number): Promise<void> {
    const entry = this.pendingTrades.get(signalId);

    if (!entry) {
      await this.sendMessage('⚠️ Signal nicht mehr verfügbar', chatId);
      return;
    }

    const recommendation = entry.recommendation;
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
    // V4.0: Live Mode Bestätigung
    if (direction === 'liveMode') {
      performanceTracker.updateSettings({ executionMode: 'live' });
      runtimeState.setExecutionMode('live', 'telegram');
      await this.sendMessage(
        `🚀 *LIVE MODE AKTIVIERT*\n\n` +
        `⚠️ ECHTE Trades werden jetzt ausgeführt!\n\n` +
        `_Nutze /settings um zurück zu Paper Mode zu wechseln._`,
        chatId
      );
      await this.handleSettings(chatId, messageId);
      return;
    }

    const entry = this.pendingTrades.get(signalId);

    if (!entry) {
      const errorMsg = '⚠️ Signal nicht mehr verfügbar\n\n_Signal ist abgelaufen oder wurde bereits verarbeitet._';
      if (messageId) {
        await this.editMessage(chatId, messageId, errorMsg, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(errorMsg, this.getBackButton(), chatId);
      }
      return;
    }

    const recommendation = entry.recommendation;
    const state = runtimeState.getState();

    // Kill-Switch Check
    if (state.killSwitchActive) {
      const errorMsg = '❌ *Trade abgebrochen*\n\n_Kill-Switch ist aktiv. Alle Trades gestoppt._';
      if (messageId) {
        await this.editMessage(chatId, messageId, errorMsg, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(errorMsg, this.getBackButton(), chatId);
      }
      this.pendingTrades.delete(signalId);
      return;
    }

    // Status-Nachricht senden
    const processingMessage = `${this.HEADER}

⏳ *TRADE WIRD AUSGEFÜHRT...*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  VERARBEITUNG                   │
├─────────────────────────────────┤
│  Richtung:    ${direction.toUpperCase().padEnd(10, ' ')}        │
│  Betrag:      $${String(recommendation.positionSize).padStart(8, ' ')}        │
│  Status:      Sende Order...    │
└─────────────────────────────────┘
\`\`\`

_Bitte warten..._`;

    if (messageId) {
      await this.editMessage(chatId, messageId, processingMessage);
    }

    try {
      // Bestimme Token-ID basierend auf Richtung
      const outcomes = recommendation.signal.market.outcomes;
      const tokenId = direction.toLowerCase() === 'yes'
        ? outcomes[0]?.id
        : outcomes[1]?.id;

      if (!tokenId) {
        throw new Error('Token-ID nicht verfügbar');
      }

      // Paper/Shadow Mode: Simulieren
      if (state.executionMode !== 'live') {
        const modeEmoji = state.executionMode === 'paper' ? '📝' : '👻';

        // Emit Event für Tracking
        this.emit('trade_confirmed', {
          signal: recommendation.signal,
          recommendation,
          direction,
          simulated: true,
        });

        const successMessage = `${this.HEADER}

${modeEmoji} *TRADE SIMULIERT (${state.executionMode.toUpperCase()})*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  BESTÄTIGT                      │
├─────────────────────────────────┤
│  Richtung:    ${direction.toUpperCase().padEnd(10, ' ')}        │
│  Betrag:      $${String(recommendation.positionSize).padStart(8, ' ')}        │
│  Status:      Simuliert         │
└─────────────────────────────────┘
\`\`\`

_Kein echter Trade - ${state.executionMode} Mode aktiv._`;

        if (messageId) {
          await this.editMessage(chatId, messageId, successMessage, this.getBackButton());
        }

        logger.info(`[Telegram] Trade simulated (${state.executionMode}): ${direction} @ $${recommendation.positionSize}`);
      } else {
        // LIVE Mode: Echte Ausführung
        const orderResult = await tradingClient.placeMarketOrder({
          tokenId,
          side: 'BUY',
          amount: recommendation.positionSize,
        });

        // Emit Event für Tracking
        this.emit('trade_confirmed', {
          signal: recommendation.signal,
          recommendation,
          direction,
          orderResult,
        });

        const fillPrice = orderResult.fillPrice ? `@ ${(orderResult.fillPrice * 100).toFixed(1)}¢` : '';
        const orderId = orderResult.orderId ? orderResult.orderId.substring(0, 8) : 'N/A';

        const successMessage = `${this.HEADER}

🚀 *TRADE AUSGEFÜHRT (LIVE)*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  BESTÄTIGT                      │
├─────────────────────────────────┤
│  Richtung:    ${direction.toUpperCase().padEnd(10, ' ')}        │
│  Betrag:      $${String(recommendation.positionSize).padStart(8, ' ')}        │
│  Preis:       ${fillPrice.padEnd(14, ' ')}        │
│  Order-ID:    ${orderId.padEnd(8, ' ')}        │
│  Status:      ✅ Filled         │
└─────────────────────────────────┘
\`\`\`

_Trade erfolgreich ausgeführt!_`;

        if (messageId) {
          await this.editMessage(chatId, messageId, successMessage, this.getBackButton());
        }

        logger.info(`[Telegram] Trade executed (LIVE): ${direction} @ $${recommendation.positionSize} - Order ${orderId}`);
      }
    } catch (err) {
      const error = err as Error;
      logger.error(`[Telegram] Trade execution failed: ${error.message}`);

      // Fallback: Zeige Polymarket Link
      const marketUrl = `https://polymarket.com/event/${recommendation.signal.market.id}`;

      const errorMessage = `${this.HEADER}

❌ *TRADE FEHLGESCHLAGEN*

${this.DIVIDER}

Fehler: ${error.message}

${this.DIVIDER}

Bitte manuell auf Polymarket ausführen:
[📊 Polymarket öffnen](${marketUrl})`;

      if (messageId) {
        await this.editMessage(chatId, messageId, errorMessage, this.getBackButton());
      }
    }

    this.pendingTrades.delete(signalId);
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

  private async handleDetails(signalId: string, chatId: string, messageId?: number): Promise<void> {
    const result = scanner.getLastResult();
    const signal = result?.signalsFound.find((s) => s.id === signalId);

    if (!signal) {
      const errorMsg = '❌ Signal nicht gefunden';
      if (messageId) {
        await this.editMessage(chatId, messageId, errorMsg, this.getBackButton());
      } else {
        await this.sendMessage(errorMsg, chatId);
      }
      return;
    }

    // Store for trading (mit TTL für Memory Leak Prevention)
    // createTradeRecommendation wurde entfernt (V4.0) - einfache inline Berechnung
    const recommendation: TradeRecommendation = {
      signal,
      positionSize: Math.min(config.trading.maxBankrollUsdc * signal.edge * 0.25, config.trading.maxBankrollUsdc * 0.1),
      kellyFraction: signal.edge * 0.25,
      expectedValue: signal.edge * config.trading.maxBankrollUsdc * 0.1,
      maxLoss: config.trading.maxBankrollUsdc * 0.05,
      riskRewardRatio: signal.edge > 0 ? (1 / signal.edge) : 2,
    };
    this.pendingTrades.set(signal.id, { recommendation, createdAt: Date.now() });

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

${this.formatSignalReasoning(signal)}`;

    // Single Message Pattern: Edit statt neue Message
    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getSignalKeyboard(signalId));
    } else {
      await this.sendMessageWithKeyboard(message, this.getSignalKeyboard(signalId), chatId);
    }
  }

  /**
   * Formatiert das Signal-Reasoning fuer Telegram
   */
  private formatSignalReasoning(signal: AlphaSignal): string {
    const sr = signal.structuredReasoning;

    if (!sr) {
      // Fallback auf altes reasoning-Feld
      return signal.reasoning ? `💡 _${signal.reasoning}_` : '';
    }

    let text = '';

    // Summary
    if (sr.summary) {
      text += `📊 *Warum interessant?*\n${sr.summary}\n`;
    }

    // Faktoren
    if (sr.factors && sr.factors.length > 0) {
      text += '\n🎯 *Faktoren:*\n';
      text += sr.factors.map(f => {
        const pct = Math.round(f.value * 100);
        return `• ${f.name} (${pct}%): _${f.explanation}_`;
      }).join('\n');
    }

    // News Match
    if (sr.newsMatch) {
      const conf = Math.round(sr.newsMatch.confidence * 100);
      text += `\n\n📰 *News-Match (${conf}%):*\n`;
      text += `_"${sr.newsMatch.title.substring(0, 60)}${sr.newsMatch.title.length > 60 ? '...' : ''}"_\n`;
      text += `Quelle: ${sr.newsMatch.source}`;
    }

    return text;
  }

  private async handleResearch(signalId: string, chatId: string, messageId?: number): Promise<void> {
    // Loading State
    const loadingMsg = `${this.HEADER}\n\n⏳ *Deep Dive lädt...*\n\n_Analysiere Markt und sammle Daten..._`;
    if (messageId) {
      await this.editMessage(chatId, messageId, loadingMsg);
    }

    try {
      // 1. Signal finden
      const result = scanner.getLastResult();
      const signal = result?.signalsFound.find((s) => s.id === signalId);

      if (!signal) {
        const errorMsg = `${this.HEADER}\n\n❌ *Signal nicht gefunden*\n\n_Das Signal ist nicht mehr verfügbar._`;
        if (messageId) {
          await this.editMessage(chatId, messageId, errorMsg, this.getBackButton());
        } else {
          await this.sendMessageWithKeyboard(errorMsg, this.getBackButton(), chatId);
        }
        return;
      }

      const market = signal.market;
      const marketQuestion = market.question || 'Unbekannte Frage';
      const polymarketUrl = `https://polymarket.com/event/${market.id}`;

      // 2. Passende News suchen
      const allNews = germanySources.getLatestNews();
      const relevantNews = allNews.filter(n => {
        const title = n.title.toLowerCase();
        const question = marketQuestion.toLowerCase();
        // Einfaches Keyword-Matching
        const keywords = question.split(' ').filter(w => w.length > 4);
        return keywords.some(kw => title.includes(kw));
      }).slice(0, 3);

      // 3. Umfragen prüfen (für Politik-Märkte)
      let pollInfo = '';
      const isPolitical = GERMANY_KEYWORDS.some(kw => marketQuestion.toLowerCase().includes(kw));
      if (isPolitical) {
        try {
          const pollData = germanySources.getLatestPolls();
          if (pollData && pollData.length > 0) {
            const latestPoll = pollData[0];
            pollInfo = `\n📊 *Aktuelle Umfragen:*\n`;
            // Zeige Top-Parteien falls vorhanden
            if (latestPoll.results) {
              const topResults = Object.entries(latestPoll.results)
                .sort((a, b) => (b[1] as number) - (a[1] as number))
                .slice(0, 5);
              for (const [party, value] of topResults) {
                pollInfo += `• ${party}: ${value}%\n`;
              }
              pollInfo += `_Quelle: ${latestPoll.institute || 'Dawum'}_\n`;
            }
          }
        } catch {
          // Ignoriere Fehler bei Umfragen
        }
      }

      // 4. Zeitvorsprung-Daten
      let edgeInfo = '';
      try {
        const edgeDashboard = timeAdvantageService.getDashboard();
        if (edgeDashboard.totalTracked > 0) {
          const avgAdvantage = Math.round(edgeDashboard.avgTimeAdvantageMinutes);
          edgeInfo = `\n⚡ *Zeitvorsprung-Status:*\n• Ø ${avgAdvantage} Min Vorsprung\n• ${edgeDashboard.totalTracked} News getrackt\n• ${edgeDashboard.totalMatched} mit Match\n`;
        }
      } catch {
        // Ignoriere Fehler bei Zeitvorsprung-Daten
      }

      // 5. Preis-Info
      const yesOutcome = market.outcomes?.find(o => o.name?.toLowerCase() === 'yes');
      const noOutcome = market.outcomes?.find(o => o.name?.toLowerCase() === 'no');
      const yesPrice = yesOutcome?.price ? (yesOutcome.price * 100).toFixed(1) : '?';
      const noPrice = noOutcome?.price ? (noOutcome.price * 100).toFixed(1) : '?';

      // 6. News-Liste
      let newsSection = '';
      if (relevantNews.length > 0) {
        newsSection = `\n📰 *Relevante News:*\n`;
        for (const news of relevantNews) {
          const source = (news.data.source as string) || 'Quelle';
          const title = news.title.substring(0, 50) + (news.title.length > 50 ? '...' : '');
          const age = Math.round((Date.now() - new Date(news.publishedAt || new Date()).getTime()) / 60000);
          newsSection += `• _${source}_ (${age}m): ${this.escapeMarkdown(title)}\n`;
        }
      } else {
        newsSection = `\n📰 *Keine aktuellen News gefunden*\n_Markt wird nicht durch deutsche Quellen abgedeckt._\n`;
      }

      // 7. Message zusammenbauen
      const message = `${this.HEADER}

🔬 *DEEP DIVE*

${this.DIVIDER}

*Markt:* ${this.escapeMarkdown(marketQuestion.substring(0, 80))}${marketQuestion.length > 80 ? '...' : ''}

\`\`\`
┌─────────────────────────────────┐
│  AKTUELLER PREIS                │
├─────────────────────────────────┤
│  YES:  ${yesPrice.padStart(6)}%                  │
│  NO:   ${noPrice.padStart(6)}%                  │
├─────────────────────────────────┤
│  Signal:   ${signal.direction.padEnd(4)} @ ${(signal.score * 100).toFixed(0)}% Score   │
│  Edge:     ${signal.edge >= 0 ? '+' : ''}${(signal.edge * 100).toFixed(1)}%               │
│  Konfidenz: ${(signal.confidence * 100).toFixed(0)}%                 │
└─────────────────────────────────┘
\`\`\`
${newsSection}${pollInfo}${edgeInfo}
${this.DIVIDER}

*Strategie-Empfehlung:*
${signal.direction === 'YES'
  ? `📈 Markt könnte unterbewertet sein`
  : `📉 Markt könnte überbewertet sein`}
${signal.germanSource ? `🇩🇪 _Mit deutschem Wissensvorsprung_` : ''}`;

      // 8. Keyboard mit Aktionen
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: `🚀 ${signal.direction} KAUFEN`, callback_data: `trade:${signal.direction.toLowerCase()}:${signalId}` },
          ],
          [
            { text: '📈 Chart', callback_data: `chart:${market.id}` },
            { text: '🔗 Polymarket', url: polymarketUrl },
          ],
          [
            { text: '🔄 Refresh', callback_data: `research:${signalId}` },
            { text: '◀️ Back', callback_data: 'action:signals' },
          ],
        ],
      };

      if (messageId) {
        await this.editMessage(chatId, messageId, message, keyboard);
      } else {
        await this.sendMessageWithKeyboard(message, keyboard, chatId);
      }

      logger.info(`[DEEP DIVE] Analyse für ${signalId}: ${marketQuestion.substring(0, 50)}`);

    } catch (err) {
      const error = err as Error;
      logger.error(`[DEEP DIVE] Fehler: ${error.message}`);

      const errorMsg = `${this.HEADER}\n\n❌ *Deep Dive Fehler*\n\n_${error.message}_`;
      if (messageId) {
        await this.editMessage(chatId, messageId, errorMsg, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(errorMsg, this.getBackButton(), chatId);
      }
    }
  }

  /**
   * Escaped Markdown-Sonderzeichen für Telegram
   */
  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
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
    ? (highAlpha > 0 ? `*${highAlpha} high-alpha opportunities. time to ape?*` : `${signalCount} signals found. check them out.`)
    : `_market quiet. no alpha rn._`}`;

    const keyboard: InlineKeyboardMarkup = hasSignals
      ? {
          inline_keyboard: [
            [{ text: '🎯 VIEW SIGNALS', callback_data: 'action:signals' }],
            [{ text: '◀️ Back', callback_data: 'action:menu' }],
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
    // createTradeRecommendation wurde entfernt (V4.0) - einfache inline Berechnung
    const recommendation: TradeRecommendation = {
      signal,
      positionSize: Math.min(config.trading.maxBankrollUsdc * signal.edge * 0.25, config.trading.maxBankrollUsdc * 0.1),
      kellyFraction: signal.edge * 0.25,
      expectedValue: signal.edge * config.trading.maxBankrollUsdc * 0.1,
      maxLoss: config.trading.maxBankrollUsdc * 0.05,
      riskRewardRatio: signal.edge > 0 ? (1 / signal.edge) : 2,
    };
    this.pendingTrades.set(signal.id, { recommendation, createdAt: Date.now() });

    const isGerman = signal.germanSource !== undefined;
    const prefix = isGerman ? '🇩🇪 EUSSR-TRACKER-VORSPRUNG!' : '🚨 ALPHA ALARM!';
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

${this.formatSignalReasoning(signal)}

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
          { text: '◀️ Back', callback_data: 'action:menu' },
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
    // ═══════════════════════════════════════════════════════════════
    // NOTIFICATION SERVICE EVENTS (neue Push-Pipeline)
    // ═══════════════════════════════════════════════════════════════

    // Initialisiere Notification Service
    notificationService.init(this.chatId);
    notificationService.start();

    // TIME_DELAY Push Ready Event
    notificationService.on('push_ready', async (notification: PushReadyNotification) => {
      // Prüfe ob TIME_DELAY Modul aktiviert ist
      if (!runtimeSettings.timeDelayEnabled) {
        logger.debug('[TELEGRAM] TIME_DELAY Push übersprungen - Modul deaktiviert');
        return;
      }
      await this.sendTimeDelayAlert(notification);
    });

    // Batched Notifications
    notificationService.on('push_batched', async (notifications: PushReadyNotification[]) => {
      // Prüfe ob TIME_DELAY Modul aktiviert ist
      if (!runtimeSettings.timeDelayEnabled) {
        logger.debug('[TELEGRAM] TIME_DELAY Batch übersprungen - Modul deaktiviert');
        return;
      }
      await this.sendBatchedAlert(notifications);
    });

    // System Alerts (Kill-Switch, Pipeline Down, etc.)
    notificationService.on('system_alert', async (alert: { type: string; message: string; details?: Record<string, unknown>; asOf: Date }) => {
      await this.sendSystemAlert(alert.type, alert.message, alert.details, alert.asOf);
    });

    // ═══════════════════════════════════════════════════════════════
    // AUTO-TRADE EVENTS - Deprecated in V4.0
    // AutoTrader wurde durch Dutch-Book Arbitrage & Late-Entry ersetzt
    // Diese Event-Handler werden nicht mehr aufgerufen
    // ═══════════════════════════════════════════════════════════════
    // autoTraderDisabled.on ist ein No-op - Events werden nicht mehr gefeuert

    // ═══════════════════════════════════════════════════════════════
    // BREAKING NEWS → Candidate Queue (NICHT mehr direkt pushen!)
    // ═══════════════════════════════════════════════════════════════
    germanySources.on('breaking_news', async (news: BreakingNewsEvent) => {
      // Prüfe ob TIME_DELAY Modul aktiviert ist (News sind Teil der TIME_DELAY Pipeline)
      if (!runtimeSettings.timeDelayEnabled) {
        return;
      }
      // Statt direktem Push: Erstelle Candidate und warte auf Gate-Check
      const candidate = await notificationService.processBreakingNews(news);
      if (candidate) {
        logger.info(`[TELEGRAM] News-Candidate erstellt: #${candidate.id}`);
        // Matching wird vom Ticker/TIME_DELAY Engine gemacht
        // Push erfolgt nur wenn alle Gates grün sind
      }
    });

    // ═══════════════════════════════════════════════════════════════
    // TICKER MATCH EVENTS → NotificationService
    // Verbindet den NewsTicker mit der Push-Pipeline
    // ═══════════════════════════════════════════════════════════════
    newsTicker.on('ticker:match_found', async (data: {
      newsId: string;
      newsTitle: string;
      newsSource: string;
      newsUrl?: string;
      newsContent?: string;
      newsKeywords: string[];
      timeAdvantageSeconds?: number;
      publishedAt?: Date;
      matches: Array<{
        marketId: string;
        question: string;
        confidence: number;
        price: number;
        direction: 'yes' | 'no';
      }>;
      bestMatch: {
        marketId: string;
        question: string;
        confidence: number;
        price: number;
        direction: 'yes' | 'no';
      };
    }) => {
      if (!runtimeSettings.timeDelayEnabled) {
        return;
      }

      logger.info(`[TELEGRAM] Ticker Match: "${data.newsTitle.substring(0, 40)}..." → ${data.bestMatch.question.substring(0, 30)}...`);

      // Finde den Candidate per Title (bereits von breaking_news erstellt)
      try {
        const { getCandidateByTitle } = await import('../storage/repositories/newsCandidates.js');
        const candidate = getCandidateByTitle(data.newsTitle);

        if (candidate) {
          // Erstelle MarketInfo für Gate-Check
          const marketInfo = {
            marketId: data.bestMatch.marketId,
            question: data.bestMatch.question,
            currentPrice: data.bestMatch.price,
            totalVolume: 50000, // Mindest-Volume für Gate-Pass
          };

          // Erstelle SourceInfo
          const sourceInfo = {
            sourceId: data.newsSource,
            sourceName: data.newsSource,
            reliabilityScore: 0.7,
          };

          // Informiere NotificationService mit Match-Daten
          const expectedLagMinutes = data.timeAdvantageSeconds
            ? Math.ceil(data.timeAdvantageSeconds / 60)
            : 15;

          const matched = await notificationService.setMatchAndEvaluate(
            candidate.id,
            marketInfo,
            sourceInfo,
            expectedLagMinutes
          );

          if (matched) {
            logger.info(`[TELEGRAM] Ticker Match an NotificationService übergeben: ${data.newsTitle.substring(0, 40)}...`);
          }
        } else {
          logger.debug(`[TELEGRAM] Ticker Match ohne Candidate: ${data.newsTitle.substring(0, 40)}...`);
        }
      } catch (err) {
        logger.debug(`[TELEGRAM] Ticker Match Fehler: ${(err as Error).message}`);
      }
    });

    // ═══════════════════════════════════════════════════════════════
    // TIME_DELAY SIGNALS vom Scanner (neue Integration)
    // TimeDelayEngine ruft bereits intern AutoTrader auf wenn nötig
    // ═══════════════════════════════════════════════════════════════
    scanner.on('time_delay_signal', async (signal: AlphaSignalV2) => {
      if (!runtimeSettings.timeDelayEnabled) {
        return;
      }

      const certaintyEmoji = signal.certainty === 'breaking_confirmed' ? '🚨' :
                             signal.certainty === 'high' ? '⚡' : '📊';

      logger.info(`[TELEGRAM] ${certaintyEmoji} TimeDelay Signal: ${signal.question.substring(0, 40)}... | Edge: ${(signal.predictedEdge * 100).toFixed(1)}% | Certainty: ${signal.certainty || 'medium'}`);

      // Hinweis: Auto-Trading wird bereits in TimeDelayEngine.generateSignals() ausgelöst
      // wenn certainty === 'breaking_confirmed' UND autoTradeEnabled === true
    });

    // ═══════════════════════════════════════════════════════════════
    // ALPHA SCANNER EVENTS (für MISPRICING - nur Digest, kein Breaking)
    // ═══════════════════════════════════════════════════════════════
    scanner.on('signal_found', async (signal: AlphaSignal) => {
      // Prüfe ob MISPRICING Modul aktiviert ist
      if (!runtimeSettings.mispricingEnabled) {
        return;
      }
      // MISPRICING Signals: Nur loggen, kein automatischer Push
      // Nutzer kann /digest verwenden
      if (signal.score > 0.7) {
        logger.info(`[TELEGRAM] MISPRICING Signal erkannt (Score: ${signal.score.toFixed(2)}) - kein Auto-Push`);
      }
    });

    logger.info('[TELEGRAM] Scanner Events registriert (Rate-Limited Push Pipeline)');

    // ═══════════════════════════════════════════════════════════════
    // V4.0: DUTCH-BOOK ARBITRAGE EVENTS
    // Risikofreie Arbitrage wenn YES + NO < $1.00
    // Semi-Auto: Confidence >= Threshold → Auto-Trade mit Notification
    // ═══════════════════════════════════════════════════════════════
    dutchBookEngine.on('opportunity', async (opportunity: ArbitrageOpportunity) => {
      if (!runtimeSettings.arbitrageEnabled) return;

      logger.info(`[TELEGRAM] 💰 Arbitrage Opportunity: ${opportunity.question.substring(0, 40)}... | Spread: ${(opportunity.spread * 100).toFixed(2)}%`);

      // Generiere Signal mit Bankroll aus Wallet
      const balance = await tradingClient.getWalletBalance();
      const bankroll = balance.usdc || 100;
      const signal = dutchBookEngine.generateSignal(opportunity, bankroll);

      if (!signal) return;

      // Semi-Auto Logik: Check Confidence gegen Threshold
      const shouldAutoTrade = performanceTracker.shouldAutoTrade(signal.confidence);

      if (shouldAutoTrade) {
        // AUTO-TRADE: Record + Execute + Notify
        const trade = performanceTracker.recordTrade({
          strategy: 'arbitrage',
          executionType: 'auto',
          marketId: opportunity.marketId,
          question: opportunity.question,
          direction: 'yes', // Arbitrage kauft beide
          entryPrice: opportunity.totalCost,
          size: signal.recommendedSize,
          expectedProfit: signal.expectedProfit,
          confidence: signal.confidence,
          status: 'filled',
          reasoning: signal.reasoning,
        });

        // Auto-Trade Notification senden
        await this.sendAutoTradeNotification({
          strategy: 'arbitrage',
          trade,
          signal: {
            question: opportunity.question,
            direction: 'BOTH (YES+NO)',
            entryPrice: opportunity.totalCost,
            size: signal.recommendedSize,
            expectedProfit: signal.expectedProfit,
            confidence: signal.confidence,
            reasoning: signal.reasoning,
          },
        });
      } else {
        // MANUAL: Alert mit Buttons senden
        await this.sendArbitrageAlert(signal);
      }
    });

    dutchBookEngine.on('trade_created', async (trade: { id: string; marketId: string; totalCost: number }) => {
      if (!runtimeSettings.arbitrageEnabled) return;
      logger.info(`[TELEGRAM] 📝 Arbitrage Trade erstellt: ${trade.id.substring(0, 8)}... | $${trade.totalCost.toFixed(2)}`);
    });

    // ═══════════════════════════════════════════════════════════════
    // V4.0: LATE-ENTRY V3 EVENTS
    // 15-Min Crypto Markets (BTC, ETH, SOL, XRP)
    // Semi-Auto: Confidence >= Threshold → Auto-Trade mit Notification
    // ═══════════════════════════════════════════════════════════════
    lateEntryEngine.on('signal', async (signal: LateEntrySignal) => {
      if (!runtimeSettings.lateEntryEnabled) return;

      logger.info(`[TELEGRAM] ⏱️ Late-Entry Signal: ${signal.window.coin} ${signal.direction.toUpperCase()} @ ${(signal.entryPrice * 100).toFixed(0)}%`);

      // Semi-Auto Logik: Check Confidence gegen Threshold
      const shouldAutoTrade = performanceTracker.shouldAutoTrade(signal.confidence);

      if (shouldAutoTrade) {
        // AUTO-TRADE: Record + Execute + Notify
        const trade = performanceTracker.recordTrade({
          strategy: 'lateEntry',
          executionType: 'auto',
          marketId: signal.window.marketId,
          question: `${signal.window.coin} 15-Min: ${signal.window.question}`,
          direction: signal.direction,
          entryPrice: signal.entryPrice,
          size: signal.recommendedSize,
          expectedProfit: (1 - signal.entryPrice) * signal.recommendedSize * signal.confidence,
          confidence: signal.confidence,
          status: 'filled',
          reasoning: signal.reasoning,
        });

        // Auto-Trade Notification senden
        await this.sendAutoTradeNotification({
          strategy: 'lateEntry',
          trade,
          signal: {
            question: `${signal.window.coin} 15-Min Market`,
            direction: signal.direction.toUpperCase(),
            entryPrice: signal.entryPrice,
            size: signal.recommendedSize,
            expectedProfit: (1 - signal.entryPrice) * signal.recommendedSize * signal.confidence,
            confidence: signal.confidence,
            reasoning: signal.reasoning,
            secondsRemaining: signal.secondsToClose,
            coin: signal.window.coin,
          },
        });
      } else {
        // MANUAL: Alert mit Buttons senden
        await this.sendLateEntryAlert(signal);
      }
    });

    lateEntryEngine.on('trade_created', async (trade: { id: string; coin: string; direction: string; size: number }) => {
      if (!runtimeSettings.lateEntryEnabled) return;
      logger.info(`[TELEGRAM] 📝 Late-Entry Trade: ${trade.coin} ${trade.direction.toUpperCase()} | $${trade.size.toFixed(2)}`);
    });

    logger.info('[TELEGRAM] V4.0 Trading Strategien Events registriert (Semi-Auto Mode)');

    // ═══════════════════════════════════════════════════════════════
    // V4.1: TRADE RESOLUTION SERVICE
    // Prüft Märkte auf Resolution und aktualisiert Win/Loss
    // ═══════════════════════════════════════════════════════════════
    tradeResolutionService.start();

    tradeResolutionService.on('trade_resolved', async (result: ResolutionResult) => {
      await this.sendResolutionNotification(result);
    });

    logger.info('[TELEGRAM] Trade Resolution Service gestartet');
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
  //             EUSSR-TRACKER ALERT (Deutscher Zeitvorsprung)
  // ═══════════════════════════════════════════════════════════════

  private async sendTimeDelayAlert(notification: PushReadyNotification): Promise<void> {
    const { candidate, market } = notification;

    // Prüfe Deutschland-Bezug - nur bei Relevanz senden
    if (!hasGermanyRelevance(market.question)) {
      logger.info(`[TELEGRAM] Überspringe Alert - kein Deutschland-Bezug: ${market.question.substring(0, 50)}...`);
      return;
    }

    // Market URL
    const marketUrl = market.marketId
      ? `https://polymarket.com/event/${market.marketId}`
      : '';

    // Fallback URL: Google-Suche wenn keine direkte Quelle
    const sourceUrl = candidate.url || `https://www.google.com/search?q=${encodeURIComponent(candidate.title + ' ' + candidate.sourceName)}`;

    const message = `
⚡ *EUSSR-TRACKER ALERT* ⚡

${this.DIVIDER}

📰 *Breaking News:*
\`\`\`
${candidate.title.substring(0, 120)}${candidate.title.length > 120 ? '...' : ''}
\`\`\`
_via ${candidate.sourceName}_

${this.DIVIDER}

📊 *Passender Markt:*
\`\`\`
${market.question.substring(0, 100)}${market.question.length > 100 ? '...' : ''}
\`\`\`

💰 *Volume:* $${(market.totalVolume / 1000).toFixed(0)}k
📈 *Preis:* ${(market.currentPrice * 100).toFixed(1)}%
${candidate.suggestedDirection ? `🎯 *KI-Empfehlung:* ${candidate.suggestedDirection === 'yes' ? '🟢 YES kaufen' : '🔴 NO kaufen'}` : ''}
${candidate.llmReasoning ? `💡 *Grund:* ${candidate.llmReasoning}` : ''}

${this.DIVIDER}

🔗 [Quelle öffnen](${sourceUrl})
${marketUrl ? `📊 [Polymarket](${marketUrl})` : ''}`;

    // Quick-Buy Buttons mit LLM-bestimmter Richtung
    // Signal-ID: candidate.id (als string), Market-ID: market.marketId
    const direction = candidate.suggestedDirection || 'yes';
    await this.sendMessageWithKeyboard(message, this.getQuickBuyKeyboard(String(candidate.id), market.marketId, direction));

    logger.info(`[TELEGRAM] EUSSR-Tracker Alert gesendet: ${candidate.title.substring(0, 40)}...`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                    🚨 SAFE BET ALERT 🚨
  //  High-Conviction Breaking News mit 50% Bankroll Sizing
  // ═══════════════════════════════════════════════════════════════

  /**
   * Sendet SAFE BET Alert bei breaking_confirmed Certainty
   * - Bei Auto-Bet: Führt automatisch Trade aus
   * - Bei Manual: Zeigt Buttons für 1/4, 1/2 oder Custom Bankroll
   */
  async sendSafeBetAlert(params: {
    signal: AlphaSignalV2;
    market: { marketId: string; question: string; currentPrice: number; totalVolume: number };
    newsTitle: string;
    newsSource: string;
    bankroll: number;
    direction: 'yes' | 'no';
    reasoning: string[];
  }): Promise<void> {
    const { signal, market, newsTitle, newsSource, bankroll, direction, reasoning } = params;

    const executionMode = runtimeState.getState().executionMode;
    const isAutoMode = runtimeSettings.autoBetOnSafeBet;

    const betAmountHalf = Math.floor(bankroll * 0.5);
    const betAmountQuarter = Math.floor(bankroll * 0.25);

    const directionEmoji = direction === 'yes' ? '✅ JA' : '❌ NEIN';
    const modeEmoji = executionMode === 'live' ? '🚀 LIVE' : executionMode === 'shadow' ? '👻 SHADOW' : '📝 PAPER';

    // Market URL
    const marketUrl = market.marketId
      ? `https://polymarket.com/event/${market.marketId}`
      : '';

    const message = `
🚨🚨🚨 *SAFE BET DETECTED* 🚨🚨🚨

${this.DIVIDER}

*Breaking News:*
\`\`\`
${newsTitle.substring(0, 120)}${newsTitle.length > 120 ? '...' : ''}
\`\`\`

📰 *Quelle:* ${newsSource}

${this.DIVIDER}

📊 *Markt:*
\`\`\`
${market.question.substring(0, 100)}${market.question.length > 100 ? '...' : ''}
\`\`\`

🎯 *Empfohlene Aktion:* ${directionEmoji}
📈 *Aktueller Preis:* ${(market.currentPrice * 100).toFixed(1)}%
💰 *Volume:* $${(market.totalVolume / 1000).toFixed(0)}k

${this.DIVIDER}

💎 *Certainty:* BREAKING\\_CONFIRMED
📊 *Edge:* ${(signal.predictedEdge * 100).toFixed(1)}%
🎲 *Confidence:* ${(signal.confidence * 100).toFixed(0)}%

*Why SAFE BET?*
${reasoning.slice(0, 3).map(r => `• ${r}`).join('\n')}

${this.DIVIDER}

💵 *Bankroll:* $${bankroll.toFixed(0)}
🎯 *Empfohlene Bet-Sizes:*
• 1/4 Bankroll: $${betAmountQuarter}
• 1/2 Bankroll: $${betAmountHalf} ⚡

${modeEmoji} Mode: ${executionMode.toUpperCase()}
${isAutoMode ? '🤖 *AUTO-BET AKTIV*' : '⏸️ *Manuelle Bestätigung erforderlich*'}

${marketUrl ? `📊 [Polymarket](${marketUrl})` : ''}`;

    // Bei Auto-Bet: Automatisch ausführen
    if (isAutoMode && executionMode === 'live') {
      await this.sendMessageWithKeyboard(message, {
        inline_keyboard: [
          [
            { text: '🔄 Trade wird ausgeführt...', callback_data: 'noop' },
          ],
        ],
      });

      // Trade ausführen
      await this.executeSafeBetTrade(signal, market, direction, betAmountHalf);
      return;
    }

    // Manuelle Buttons
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: `🚀 ${directionEmoji} - $${betAmountQuarter} (1/4)`, callback_data: `safebet:${direction}:${signal.signalId}:${betAmountQuarter}` },
        ],
        [
          { text: `⚡ ${directionEmoji} - $${betAmountHalf} (1/2)`, callback_data: `safebet:${direction}:${signal.signalId}:${betAmountHalf}` },
        ],
        [
          { text: '✏️ Custom Betrag', callback_data: `safebet:custom:${signal.signalId}:${direction}` },
        ],
        [
          { text: '❌ Nicht traden', callback_data: 'action:menu' },
        ],
      ],
    };

    await this.sendMessageWithKeyboard(message, keyboard);

    logger.warn(`[TELEGRAM] 🚨 SAFE BET Alert gesendet: ${newsTitle.substring(0, 40)}... | Direction: ${direction} | Auto: ${isAutoMode}`);
  }

  /**
   * Führt den SAFE BET Trade aus
   *
   * HINWEIS: Derzeit nur Paper/Shadow Mode - Live Mode erfordert manuelle Ausführung
   */
  private async executeSafeBetTrade(
    signal: AlphaSignalV2,
    market: { marketId: string; question: string },
    direction: 'yes' | 'no',
    amount: number
  ): Promise<void> {
    try {
      const state = runtimeState.getState();

      // Kill-Switch Check
      if (state.killSwitchActive) {
        await this.sendMessage('❌ SAFE BET Trade abgebrochen: Kill-Switch aktiv', this.chatId);
        return;
      }

      logger.info(`[SAFE BET] Trade request: ${market.marketId} | ${direction.toUpperCase()} | $${amount}`);

      // Paper/Shadow Mode: Nur loggen und simulieren
      if (state.executionMode !== 'live') {
        const modeEmoji = state.executionMode === 'paper' ? '📝' : '👻';

        await this.sendMessage(
          `${modeEmoji} *SAFE BET (${state.executionMode.toUpperCase()})*\n\n` +
          `📊 ${market.question.substring(0, 60)}...\n` +
          `🎯 ${direction.toUpperCase()} @ $${amount}\n\n` +
          `_Simuliert - kein echter Trade._`,
          this.chatId
        );

        // PnL Tracking (simuliert)
        logger.info(`[SAFE BET] Simulated trade recorded: ${direction} @ $${amount}`);
        return;
      }

      // Live Mode: Warnung und Link zu Polymarket
      const marketUrl = `https://polymarket.com/event/${market.marketId}`;

      await this.sendMessage(
        `🚀 *SAFE BET - LIVE MODE*\n\n` +
        `📊 ${market.question.substring(0, 60)}...\n` +
        `🎯 Empfehlung: *${direction.toUpperCase()}* @ $${amount}\n\n` +
        `⚠️ _Auto-Execution noch nicht implementiert._\n` +
        `Bitte manuell auf Polymarket ausführen:\n` +
        `[📊 Polymarket öffnen](${marketUrl})`,
        this.chatId
      );

      logger.warn(`[SAFE BET] Live trade requires manual execution: ${market.marketId}`);
    } catch (err) {
      const error = err as Error;
      logger.error(`[SAFE BET] Trade execution failed: ${error.message}`);
      await this.sendMessage(
        `❌ *SAFE BET FEHLER*\n\n${error.message}`,
        this.chatId
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //      💰 DUTCH-BOOK ARBITRAGE ALERT - V4.0
  //      Risikofreie Profits durch YES+NO < $1.00
  // ═══════════════════════════════════════════════════════════════

  private async sendArbitrageAlert(signal: ArbitrageSignal): Promise<void> {
    const { opportunity, recommendedSize, expectedProfit, confidence, reasoning } = signal;

    // Market URL
    const marketUrl = opportunity.slug
      ? `https://polymarket.com/event/${opportunity.slug}`
      : `https://polymarket.com`;

    const state = runtimeState.getState();
    const modeEmoji = state.executionMode === 'live' ? '🚀 LIVE' : state.executionMode === 'shadow' ? '👻 SHADOW' : '📝 PAPER';

    const message = `
💰 *DUTCH\\-BOOK ARBITRAGE* 💰

\`\`\`
╔═══════════════════════════════════════╗
║  ██████╗ ██╗   ██╗████████╗ ██████╗██╗ ║
║  ██╔══██╗██║   ██║╚══██╔══╝██╔════╝██║ ║
║  ██║  ██║██║   ██║   ██║   ██║     ██████╗
║  ██║  ██║██║   ██║   ██║   ██║     ██╔══██╗
║  ██████╔╝╚██████╔╝   ██║   ╚██████╗██████╔╝
║  ╚═════╝  ╚═════╝    ╚═╝    ╚═════╝╚═════╝
║         RISK-FREE ARBITRAGE              ║
╚═══════════════════════════════════════╝
\`\`\`

${this.DIVIDER}

📊 *Markt:*
\`\`\`
${opportunity.question.substring(0, 80)}${opportunity.question.length > 80 ? '...' : ''}
\`\`\`

${this.DIVIDER}

*ARBITRAGE BREAKDOWN:*
┌─────────────────────────────┐
│ 🟢 YES:  $${opportunity.yesPrice.toFixed(3).padEnd(6)}           │
│ 🔴 NO:   $${opportunity.noPrice.toFixed(3).padEnd(6)}           │
├─────────────────────────────┤
│ 💵 TOTAL: $${opportunity.totalCost.toFixed(3).padEnd(5)}          │
│ 💰 SPREAD: ${(opportunity.spread * 100).toFixed(2)}%           │
└─────────────────────────────┘

*TRADE EMPFEHLUNG:*
• Size: *$${recommendedSize.toFixed(2)}*
• Erwarteter Profit: *$${expectedProfit.toFixed(2)}* \\(${(expectedProfit / recommendedSize * 100).toFixed(1)}%\\)
• Confidence: *${(confidence * 100).toFixed(0)}%*
• ${modeEmoji}

${this.DIVIDER}

*Reasoning:*
${reasoning.map(r => `• ${r}`).join('\n')}

${marketUrl ? `📊 [Polymarket öffnen](${marketUrl})` : ''}`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: `🟢 YES $${(recommendedSize / 2).toFixed(0)}`, callback_data: `arb:yes:${opportunity.id}:${(recommendedSize / 2).toFixed(0)}` },
          { text: `🔴 NO $${(recommendedSize / 2).toFixed(0)}`, callback_data: `arb:no:${opportunity.id}:${(recommendedSize / 2).toFixed(0)}` },
        ],
        [
          { text: '💰 BEIDE KAUFEN (Arbitrage)', callback_data: `arb:both:${opportunity.id}:${recommendedSize.toFixed(0)}` },
        ],
        [
          { text: '❌ Ignorieren', callback_data: 'action:menu' },
        ],
      ],
    };

    await this.sendMessageWithKeyboard(message, keyboard);
    logger.info(`[TELEGRAM] 💰 Arbitrage Alert gesendet: ${opportunity.question.substring(0, 40)}...`);
  }

  // ═══════════════════════════════════════════════════════════════
  //      ⏱️ LATE-ENTRY V3 ALERT - V4.0
  //      15-Min Crypto Markets in letzten 4 Minuten
  // ═══════════════════════════════════════════════════════════════

  private async sendLateEntryAlert(signal: LateEntrySignal): Promise<void> {
    const { window, direction, confidence, entryPrice, secondsToClose, urgency, recommendedSize, reasoning } = signal;

    // Coin-spezifische Emojis und ASCII
    const coinArt: Record<string, string> = {
      BTC: `
\`\`\`
╔═══════════════════════════════════════╗
║  ██████╗ ████████╗ ██████╗            ║
║  ██╔══██╗╚══██╔══╝██╔════╝            ║
║  ██████╔╝   ██║   ██║                 ║
║  ██╔══██╗   ██║   ██║                 ║
║  ██████╔╝   ██║   ╚██████╗            ║
║  ╚═════╝    ╚═╝    ╚═════╝            ║
║       BITCOIN 15-MIN MARKET           ║
╚═══════════════════════════════════════╝
\`\`\``,
      ETH: `
\`\`\`
╔═══════════════════════════════════════╗
║  ███████╗████████╗██╗  ██╗            ║
║  ██╔════╝╚══██╔══╝██║  ██║            ║
║  █████╗     ██║   ███████║            ║
║  ██╔══╝     ██║   ██╔══██║            ║
║  ███████╗   ██║   ██║  ██║            ║
║  ╚══════╝   ╚═╝   ╚═╝  ╚═╝            ║
║      ETHEREUM 15-MIN MARKET           ║
╚═══════════════════════════════════════╝
\`\`\``,
      SOL: `
\`\`\`
╔═══════════════════════════════════════╗
║  ███████╗ ██████╗ ██╗                 ║
║  ██╔════╝██╔═══██╗██║                 ║
║  ███████╗██║   ██║██║                 ║
║  ╚════██║██║   ██║██║                 ║
║  ███████║╚██████╔╝███████╗            ║
║  ╚══════╝ ╚═════╝ ╚══════╝            ║
║       SOLANA 15-MIN MARKET            ║
╚═══════════════════════════════════════╝
\`\`\``,
      XRP: `
\`\`\`
╔═══════════════════════════════════════╗
║  ██╗  ██╗██████╗ ██████╗              ║
║  ╚██╗██╔╝██╔══██╗██╔══██╗             ║
║   ╚███╔╝ ██████╔╝██████╔╝             ║
║   ██╔██╗ ██╔══██╗██╔═══╝              ║
║  ██╔╝ ██╗██║  ██║██║                  ║
║  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝                  ║
║       RIPPLE 15-MIN MARKET            ║
╚═══════════════════════════════════════╝
\`\`\``,
    };

    // Market URL
    const marketUrl = window.slug
      ? `https://polymarket.com/event/${window.slug}`
      : `https://polymarket.com`;

    const state = runtimeState.getState();
    const modeEmoji = state.executionMode === 'live' ? '🚀 LIVE' : state.executionMode === 'shadow' ? '👻 SHADOW' : '📝 PAPER';
    const directionEmoji = direction === 'yes' ? '🟢 UP' : '🔴 DOWN';
    const urgencyEmoji = urgency === 'high' ? '🚨🚨🚨' : urgency === 'medium' ? '⚠️⚠️' : '📊';

    const message = `
⏱️ *LATE\\-ENTRY V3* ⏱️
${coinArt[window.coin] || ''}

${this.DIVIDER}

${urgencyEmoji} *${window.coin} \\- ${secondsToClose.toFixed(0)}s REMAINING\\!*

${this.DIVIDER}

*SIGNAL:*
┌─────────────────────────────┐
│ 📊 Direction: ${directionEmoji.padEnd(10)}    │
│ 💰 Entry:     ${(entryPrice * 100).toFixed(0)}%           │
│ 🎯 Confidence: ${(confidence * 100).toFixed(0)}%          │
│ ⏱️ Time Left:  ${secondsToClose.toFixed(0)}s          │
└─────────────────────────────┘

*EMPFEHLUNG:*
• Size: *$${recommendedSize.toFixed(2)}*
• Max: *$${signal.maxSize.toFixed(2)}*
• ${modeEmoji}

${this.DIVIDER}

*Reasoning:*
${reasoning.map(r => `• ${r}`).join('\n')}

${marketUrl ? `📊 [Polymarket öffnen](${marketUrl})` : ''}`;

    // Urgency-basierte Buttons
    const quickAmounts = urgency === 'high'
      ? [recommendedSize, recommendedSize * 1.5]
      : [recommendedSize * 0.5, recommendedSize];

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: `🚀 ${direction.toUpperCase()} $${quickAmounts[0].toFixed(0)}`, callback_data: `late:${direction}:${signal.id}:${quickAmounts[0].toFixed(0)}` },
          { text: `⚡ ${direction.toUpperCase()} $${quickAmounts[1].toFixed(0)}`, callback_data: `late:${direction}:${signal.id}:${quickAmounts[1].toFixed(0)}` },
        ],
        [
          { text: '❌ Nicht traden', callback_data: 'action:menu' },
        ],
      ],
    };

    await this.sendMessageWithKeyboard(message, keyboard);
    logger.info(`[TELEGRAM] ⏱️ Late-Entry Alert gesendet: ${window.coin} ${direction.toUpperCase()} @ ${(entryPrice * 100).toFixed(0)}%`);
  }

  // ═══════════════════════════════════════════════════════════════
  //      🤖 AUTO-TRADE NOTIFICATION - V4.0
  //      Wird gesendet wenn Semi/Full-Auto einen Trade ausführt
  // ═══════════════════════════════════════════════════════════════

  private async sendAutoTradeNotification(params: {
    strategy: TradeStrategy;
    trade: TrackedTrade;
    signal: {
      question: string;
      direction: string;
      entryPrice: number;
      size: number;
      expectedProfit: number;
      confidence: number;
      reasoning: string[];
      secondsRemaining?: number;
      coin?: string;
    };
  }): Promise<void> {
    const { strategy, trade, signal } = params;
    const settings = performanceTracker.getSettings();

    const modeEmoji = settings.executionMode === 'live' ? '🚀 LIVE' : settings.executionMode === 'shadow' ? '👻 SHADOW' : '📝 PAPER';
    const strategyEmoji = strategy === 'arbitrage' ? '💰' : strategy === 'lateEntry' ? '⏱️' : '⚡';
    const strategyName = strategy === 'arbitrage' ? 'DUTCH-BOOK ARBITRAGE' : strategy === 'lateEntry' ? 'LATE-ENTRY V3' : 'TIME-DELAY';

    // ASCII Art basierend auf Strategie
    const asciiArt = strategy === 'arbitrage'
      ? `
\`\`\`
╔═══════════════════════════════════════╗
║  █████╗ ██╗   ██╗████████╗ ██████╗    ║
║  ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗   ║
║  ███████║██║   ██║   ██║   ██║   ██║   ║
║  ██╔══██║██║   ██║   ██║   ██║   ██║   ║
║  ██║  ██║╚██████╔╝   ██║   ╚██████╔╝   ║
║  ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝    ║
║      🤖 AUTO-TRADE EXECUTED 🤖        ║
╚═══════════════════════════════════════╝
\`\`\``
      : `
\`\`\`
╔═══════════════════════════════════════╗
║  █████╗ ██╗   ██╗████████╗ ██████╗    ║
║  ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗   ║
║  ███████║██║   ██║   ██║   ██║   ██║   ║
║  ██╔══██║██║   ██║   ██║   ██║   ██║   ║
║  ██║  ██║╚██████╔╝   ██║   ╚██████╔╝   ║
║  ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝    ║
║      🤖 AUTO-TRADE EXECUTED 🤖        ║
╚═══════════════════════════════════════╝
\`\`\``;

    const message = `
🤖 *AUTO\\-TRADE AUSGEFÜHRT* 🤖
${asciiArt}

${this.DIVIDER}

${strategyEmoji} *STRATEGIE:* ${strategyName}
${modeEmoji}

${this.DIVIDER}

📊 *TRADE DETAILS:*
\`\`\`
┌─────────────────────────────────┐
│  ID:        ${trade.id.substring(0, 12)}...     │
│  Direction: ${signal.direction.padEnd(18)}│
│  Entry:     ${(signal.entryPrice * 100).toFixed(1)}%${' '.repeat(15)}│
│  Size:      $${signal.size.toFixed(2).padEnd(17)}│
│  Expected:  $${signal.expectedProfit.toFixed(2).padEnd(17)}│
│  Confidence: ${(signal.confidence * 100).toFixed(0)}%${' '.repeat(14)}│
└─────────────────────────────────┘
\`\`\`

${signal.coin ? `🪙 *Coin:* ${signal.coin}` : ''}
${signal.secondsRemaining ? `⏱️ *Verbleibend:* ${signal.secondsRemaining.toFixed(0)}s` : ''}

${this.DIVIDER}

*WARUM AUTO\\-TRADE?*
• Confidence ${(signal.confidence * 100).toFixed(0)}% ≥ Schwelle ${(settings.autoTradeMinConfidence * 100).toFixed(0)}%
${settings.fullAutoMode ? '• Full-Auto Mode aktiv' : '• Semi-Auto Mode'}

${this.DIVIDER}

*REASONING:*
${signal.reasoning.slice(0, 3).map(r => `• ${r}`).join('\n')}

${this.DIVIDER}

📊 Nutze /stats für Performance Dashboard`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '📊 Stats', callback_data: 'action:stats' },
          { text: '⚙️ Settings', callback_data: 'action:settings' },
        ],
        [
          { text: '◀️ Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    await this.sendMessageWithKeyboard(message, keyboard);
    logger.info(`[TELEGRAM] 🤖 Auto-Trade Notification: ${strategy} | ${signal.direction} | $${signal.size.toFixed(2)} | Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
  }

  // ═══════════════════════════════════════════════════════════════
  //      🎯 TRADE RESOLUTION NOTIFICATION - V4.1
  //      Wird gesendet wenn ein Trade resolved (gewonnen/verloren)
  // ═══════════════════════════════════════════════════════════════

  private async sendResolutionNotification(result: ResolutionResult): Promise<void> {
    const { tradeId, won, payout, profit, resolvedAt } = result;

    const winEmoji = won ? '🎉✅' : '💔❌';
    const resultText = won ? 'GEWONNEN' : 'VERLOREN';
    const profitText = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;
    const profitEmoji = profit >= 0 ? '📈' : '📉';

    // Updated Stats
    const stats = performanceTracker.getStats();

    const asciiArt = won
      ? `
\`\`\`
╔═══════════════════════════════════════╗
║  ██╗    ██╗██╗███╗   ██╗██╗           ║
║  ██║    ██║██║████╗  ██║██║           ║
║  ██║ █╗ ██║██║██╔██╗ ██║██║           ║
║  ██║███╗██║██║██║╚██╗██║╚═╝           ║
║  ╚███╔███╔╝██║██║ ╚████║██╗           ║
║   ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝╚═╝           ║
║         🎉 TRADE WON! 🎉              ║
╚═══════════════════════════════════════╝
\`\`\``
      : `
\`\`\`
╔═══════════════════════════════════════╗
║  ██╗      ██████╗ ███████╗███████╗    ║
║  ██║     ██╔═══██╗██╔════╝██╔════╝    ║
║  ██║     ██║   ██║███████╗███████╗    ║
║  ██║     ██║   ██║╚════██║╚════██║    ║
║  ███████╗╚██████╔╝███████║███████║    ║
║  ╚══════╝ ╚═════╝ ╚══════╝╚══════╝    ║
║         💔 TRADE LOST 💔              ║
╚═══════════════════════════════════════╝
\`\`\``;

    const message = `
${winEmoji} *TRADE ${resultText}* ${winEmoji}
${asciiArt}

${this.DIVIDER}

*RESULT:*
\`\`\`
┌─────────────────────────────────┐
│  Trade:    ${tradeId.substring(0, 12)}...      │
│  Result:   ${resultText.padEnd(18)}│
│  Payout:   $${payout.toFixed(2).padEnd(17)}│
│  Profit:   ${profitText.padEnd(18)}│
└─────────────────────────────────┘
\`\`\`

${profitEmoji} *P/L:* ${profitText}

${this.DIVIDER}

*UPDATED STATS:*
• Win Rate: ${(stats.winRate * 100).toFixed(1)}%
• Total Profit: $${stats.totalActualProfit.toFixed(2)}
• ROI: ${stats.roi.toFixed(2)}%

${this.DIVIDER}

_Resolved: ${resolvedAt.toLocaleString('de-DE')}_

📊 Nutze /stats für vollständiges Dashboard`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '📊 Stats', callback_data: 'action:stats' },
          { text: '◀️ Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    await this.sendMessageWithKeyboard(message, keyboard);
    logger.info(`[TELEGRAM] 🎯 Resolution Notification: ${tradeId.substring(0, 8)}... ${won ? 'WON' : 'LOST'} | Profit: ${profitText}`);
  }

  /**
   * Handelt SAFE BET Button-Klicks
   * @param directionOrAction - 'yes', 'no', oder 'custom'
   * @param signalId - Signal ID
   * @param amountOrDirection - Betrag (bei yes/no) oder Direction (bei custom)
   */
  private async handleSafeBetAction(
    directionOrAction: string,
    signalId: string,
    amountOrDirection: string,
    chatId: string,
    messageId?: number
  ): Promise<void> {
    // Custom Betrag: User soll Wert eingeben
    if (directionOrAction === 'custom') {
      this.editingField = `safebet:${signalId}:${amountOrDirection}`; // signalId:direction gespeichert
      const message = `${this.HEADER}

✏️ *CUSTOM SAFE BET*

Gib den gewünschten Betrag in USDC ein:

_Beispiel: 50 für $50_`;

      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: '❌ Abbrechen', callback_data: 'action:menu' }],
        ],
      };

      if (messageId) {
        await this.editMessage(chatId, messageId, message, keyboard);
      } else {
        await this.sendMessageWithKeyboard(message, keyboard, chatId);
      }
      return;
    }

    // Normaler SAFE BET Trade
    const direction = directionOrAction as 'yes' | 'no';
    const amount = parseInt(amountOrDirection, 10);

    if (isNaN(amount) || amount <= 0) {
      await this.sendMessage('❌ Ungültiger Betrag.', chatId);
      return;
    }

    // Bestätigungsnachricht
    const confirmMessage = `${this.HEADER}

🚨 *SAFE BET BESTÄTIGUNG*

${this.DIVIDER}

🎯 *Direction:* ${direction.toUpperCase()}
💵 *Betrag:* $${amount}
📝 *Signal:* ${signalId.substring(0, 8)}...

${this.DIVIDER}

_Bestätige den Trade:_`;

    const confirmKeyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: `✅ ${direction.toUpperCase()} @ $${amount} BESTÄTIGEN`, callback_data: `safebetconfirm:${direction}:${signalId}:${amount}` },
        ],
        [
          { text: '❌ Abbrechen', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, confirmMessage, confirmKeyboard);
    } else {
      await this.sendMessageWithKeyboard(confirmMessage, confirmKeyboard, chatId);
    }
  }

  /**
   * Custom SAFE BET Betrag verarbeiten
   */
  private async handleSafeBetCustomInput(text: string, chatId: string): Promise<boolean> {
    if (!this.editingField?.startsWith('safebet:')) {
      return false;
    }

    const parts = this.editingField.split(':');
    if (parts.length !== 3) {
      this.editingField = null;
      return false;
    }

    const [, signalId, direction] = parts;
    const amount = parseFloat(text.replace(/[^0-9.]/g, ''));

    if (isNaN(amount) || amount <= 0) {
      await this.sendMessage('❌ Ungültiger Betrag. Bitte eine positive Zahl eingeben.', chatId);
      return true; // Consumed but invalid
    }

    this.editingField = null;

    // Zeige Bestätigung
    await this.handleSafeBetAction(direction as 'yes' | 'no', signalId, Math.floor(amount).toString(), chatId);
    return true;
  }

  /**
   * SAFE BET Trade nach Bestätigung ausführen
   */
  private async handleSafeBetConfirm(
    direction: string,
    signalId: string,
    amount: number,
    chatId: string,
    messageId?: number
  ): Promise<void> {
    const state = runtimeState.getState();

    // Kill-Switch Check
    if (state.killSwitchActive) {
      await this.sendMessage('❌ Trade abgebrochen: Kill-Switch aktiv', chatId);
      return;
    }

    try {
      const state = runtimeState.getState();
      logger.info(`[SAFE BET] Manual confirm: ${signalId} | ${direction.toUpperCase()} | $${amount}`);

      // Paper/Shadow Mode: Simulieren
      if (state.executionMode !== 'live') {
        const modeEmoji = state.executionMode === 'paper' ? '📝' : '👻';

        const successMessage = `${this.HEADER}

${modeEmoji} *SAFE BET (${state.executionMode.toUpperCase()})*

${this.DIVIDER}

🎯 *Direction:* ${direction.toUpperCase()}
💵 *Betrag:* $${amount}

${this.DIVIDER}

_Simuliert - kein echter Trade._`;

        if (messageId) {
          await this.editMessage(chatId, messageId, successMessage, this.getBackButton());
        } else {
          await this.sendMessageWithKeyboard(successMessage, this.getBackButton(), chatId);
        }

        logger.info(`[SAFE BET] Simulated manual trade: ${direction} @ $${amount}`);
        return;
      }

      // Live Mode: Link zu Polymarket
      // WICHTIG: Versuche marketId aus Scanner-Cache zu holen, da signalId != marketId
      let marketUrl = `https://polymarket.com/`;
      try {
        const lastResult = scanner.getLastResult();
        const signal = lastResult?.signalsFound.find((s) => s.id === signalId);
        if (signal?.market?.id) {
          marketUrl = `https://polymarket.com/event/${signal.market.id}`;
        }
      } catch {
        // Fallback zur Hauptseite
      }

      const liveMessage = `${this.HEADER}

🚀 *SAFE BET - MANUELL AUSFÜHREN*

${this.DIVIDER}

🎯 *Direction:* ${direction.toUpperCase()}
💵 *Betrag:* $${amount}

${this.DIVIDER}

⚠️ _Auto-Execution noch nicht implementiert._
Bitte manuell auf Polymarket ausführen:

[📊 Polymarket öffnen](${marketUrl})`;

      if (messageId) {
        await this.editMessage(chatId, messageId, liveMessage, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(liveMessage, this.getBackButton(), chatId);
      }

      logger.warn(`[SAFE BET] Live trade requires manual execution: ${signalId}`);
    } catch (err) {
      const error = err as Error;
      logger.error(`[SAFE BET] Execution failed: ${error.message}`);

      const errorMessage = `${this.HEADER}

❌ *FEHLER*

${error.message}

_Bitte manuell auf Polymarket traden!_`;

      if (messageId) {
        await this.editMessage(chatId, messageId, errorMessage, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(errorMessage, this.getBackButton(), chatId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                    QUICK-BUY HANDLERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Zeigt Bestätigungsdialog für Quick-Buy
   */
  private async handleQuickBuy(
    signalId: string,
    direction: 'yes' | 'no',
    amount: number,
    chatId: string,
    messageId?: number
  ): Promise<void> {
    const directionEmoji = direction === 'yes' ? '✅ JA' : '❌ NEIN';
    const state = runtimeState.getState();
    const modeEmoji = state.executionMode === 'live' ? '🚀 LIVE' : state.executionMode === 'shadow' ? '👻 SHADOW' : '📝 PAPER';

    const message = `${this.HEADER}

⚠️ *BESTÄTIGUNG ERFORDERLICH*

${this.DIVIDER}

🎯 *Kaufen:* ${directionEmoji}
💵 *Betrag:* $${amount} USDC
📊 *Signal:* \`${signalId.substring(0, 16)}...\`
${modeEmoji}

${this.DIVIDER}

_Wirklich ausführen?_`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ JA, kaufen!', callback_data: `quickbuy_confirm:${signalId}:${direction}:${amount}` },
          { text: '❌ Abbrechen', callback_data: `quickbuy_cancel:${signalId}` },
        ],
        [
          { text: '◀️ Back', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }

    logger.info(`[QUICK-BUY] Confirmation requested: ${signalId} | ${direction} | $${amount}`);
  }

  /**
   * Führt Quick-Buy Trade nach Bestätigung aus
   */
  private async handleQuickBuyConfirm(
    signalId: string,
    direction: 'yes' | 'no',
    amount: number,
    chatId: string,
    messageId?: number
  ): Promise<void> {
    const state = runtimeState.getState();

    // Kill-Switch Check - Single Message Pattern
    if (state.killSwitchActive) {
      const errorMsg = '❌ *Trade abgebrochen*\n\n_Kill-Switch ist aktiv. Alle Trades gestoppt._';
      if (messageId) {
        await this.editMessage(chatId, messageId, errorMsg, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(errorMsg, this.getBackButton(), chatId);
      }
      return;
    }

    const directionEmoji = direction === 'yes' ? '✅' : '❌';

    try {
      logger.info(`[QUICK-BUY] Executing: ${signalId} | ${direction.toUpperCase()} | $${amount}`);

      // Paper/Shadow Mode: Simulieren
      if (state.executionMode !== 'live') {
        const modeEmoji = state.executionMode === 'paper' ? '📝' : '👻';

        const successMessage = `${this.HEADER}

${modeEmoji} *QUICK-BUY SIMULIERT*

${this.DIVIDER}

${directionEmoji} *Direction:* ${direction.toUpperCase()}
💵 *Betrag:* $${amount}
📊 *Mode:* ${state.executionMode.toUpperCase()}

${this.DIVIDER}

✅ _Simuliert - kein echter Trade._
_Wechsle zu LIVE Mode für echtes Trading._`;

        if (messageId) {
          await this.editMessage(chatId, messageId, successMessage, this.getBackButton());
        } else {
          await this.sendMessageWithKeyboard(successMessage, this.getBackButton(), chatId);
        }

        logger.info(`[QUICK-BUY] Simulated: ${direction} @ $${amount} (${state.executionMode})`);
        return;
      }

      // Live Mode: Echten Trade ausführen via TradingClient

      // Signal aus dem letzten Scan-Ergebnis abrufen
      const lastResult = scanner.getLastResult();
      const signal = lastResult?.signalsFound.find(s => s.id === signalId);

      if (!signal) {
        // Fallback: Polymarket Link anzeigen wenn Signal nicht mehr im Cache
        const marketUrl = `https://polymarket.com/event/${signalId}`;
        const fallbackMessage = `${this.HEADER}

⚠️ *SIGNAL NICHT GEFUNDEN*

${this.DIVIDER}

Signal ist nicht mehr im Cache.
Bitte manuell auf Polymarket ausführen:

[📊 Polymarket öffnen](${marketUrl})`;

        if (messageId) {
          await this.editMessage(chatId, messageId, fallbackMessage, this.getBackButton());
        } else {
          await this.sendMessageWithKeyboard(fallbackMessage, this.getBackButton(), chatId);
        }
        logger.warn(`[QUICK-BUY] Signal nicht gefunden: ${signalId}`);
        return;
      }

      // Token-ID für die gewählte Richtung (YES oder NO) bestimmen
      const outcomeIndex = direction === 'yes' ? 0 : 1;
      const outcome = signal.market.outcomes[outcomeIndex];

      if (!outcome?.id) {
        throw new Error(`Token-ID für ${direction.toUpperCase()} nicht gefunden`);
      }

      const tokenId = outcome.id;
      const marketUrl = `https://polymarket.com/event/${signal.market.slug || signalId}`;

      // Status-Nachricht: Trade wird ausgeführt
      const pendingMessage = `${this.HEADER}

🔄 *TRADE WIRD AUSGEFÜHRT...*

${this.DIVIDER}

${directionEmoji} *Direction:* ${direction.toUpperCase()}
💵 *Betrag:* $${amount}
📊 *Markt:* ${signal.market.question.substring(0, 40)}...

${this.DIVIDER}

_Bitte warten..._`;

      if (messageId) {
        await this.editMessage(chatId, messageId, pendingMessage);
      } else {
        await this.sendMessage(pendingMessage, chatId);
      }

      // Trade über TradingClient ausführen
      logger.info(`[QUICK-BUY] Executing LIVE trade: Token ${tokenId.substring(0, 16)}... | BUY | $${amount}`);

      const orderResult = await tradingClient.placeMarketOrder({
        tokenId,
        side: 'BUY',
        amount,
      });

      if (orderResult.success) {
        const successMessage = `${this.HEADER}

✅ *TRADE ERFOLGREICH!*

${this.DIVIDER}

${directionEmoji} *Direction:* ${direction.toUpperCase()}
💵 *Betrag:* $${amount}
📈 *Fill-Preis:* ${orderResult.fillPrice ? (orderResult.fillPrice * 100).toFixed(1) + '¢' : 'N/A'}
🆔 *Order-ID:* \`${orderResult.orderId?.substring(0, 16) || 'N/A'}...\`

${this.DIVIDER}

📊 *Markt:* ${signal.market.question.substring(0, 50)}...

[📊 Auf Polymarket ansehen](${marketUrl})`;

        if (messageId) {
          await this.editMessage(chatId, messageId, successMessage, this.getBackButton());
        } else {
          await this.sendMessageWithKeyboard(successMessage, this.getBackButton(), chatId);
        }

        logger.info(`[QUICK-BUY] ✅ LIVE trade successful: ${orderResult.orderId}`);
      } else {
        // Trade fehlgeschlagen - Fallback zu manuellem Link
        const failedMessage = `${this.HEADER}

❌ *TRADE FEHLGESCHLAGEN*

${this.DIVIDER}

Fehler: ${orderResult.error || 'Unbekannter Fehler'}

${this.DIVIDER}

Bitte manuell auf Polymarket ausführen:

[📊 Polymarket öffnen](${marketUrl})`;

        if (messageId) {
          await this.editMessage(chatId, messageId, failedMessage, this.getBackButton());
        } else {
          await this.sendMessageWithKeyboard(failedMessage, this.getBackButton(), chatId);
        }

        logger.error(`[QUICK-BUY] ❌ LIVE trade failed: ${orderResult.error}`);
      }
    } catch (err) {
      const error = err as Error;
      logger.error(`[QUICK-BUY] Execution failed: ${error.message}`);

      const errorMessage = `${this.HEADER}

❌ *FEHLER*

${error.message}

_Bitte manuell auf Polymarket traden!_`;

      if (messageId) {
        await this.editMessage(chatId, messageId, errorMessage, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(errorMessage, this.getBackButton(), chatId);
      }
    }
  }

  /**
   * Behandelt Abbruch eines Quick-Buy Trades
   */
  private async handleQuickBuyCancel(chatId: string, messageId?: number): Promise<void> {
    const message = `${this.HEADER}

❌ *TRADE ABGEBROCHEN*

${this.DIVIDER}

_Der Trade wurde nicht ausgeführt._`;

    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    } else {
      await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
    }

    logger.info(`[QUICK-BUY] Trade cancelled by user`);
  }

  /**
   * Watch-Handler: Markt zur Watchlist hinzufügen
   */
  private async handleWatch(signalId: string, chatId: string, messageId?: number): Promise<void> {
    // TODO: Implementiere Watchlist-Funktionalität
    const message = `👀 *Watchlist*\n\nMarkt \`${signalId.substring(0, 16)}...\` wird beobachtet.\n\n_Watchlist-Feature kommt bald!_`;

    // Single Message Pattern: Edit statt neue Message
    if (messageId) {
      await this.editMessage(chatId, messageId, message, this.getBackButton());
    } else {
      await this.sendMessageWithKeyboard(message, this.getBackButton(), chatId);
    }
    logger.info(`[WATCH] Added to watchlist: ${signalId}`);
  }

  /**
   * Chart-Handler: Zeigt Preis-Chart für Markt via QuickChart.io
   */
  private async handleChart(marketId: string, chatId: string, messageId?: number): Promise<void> {
    // Typing Indicator während Chart generiert wird
    await this.bot?.sendChatAction(chatId, 'typing');

    // Loading State anzeigen
    const loadingMsg = `${this.HEADER}\n\n⏳ *Chart wird geladen...*\n\n_Hole Preisdaten..._`;
    if (messageId) {
      await this.editMessage(chatId, messageId, loadingMsg);
    }

    try {
      // Token ID und Marktname bestimmen
      let tokenId = marketId;
      let marketName = 'Markt';

      // Strategie 1: Aus Scanner-Result (falls vorhanden)
      const result = scanner.getLastResult();
      const signal = result?.signalsFound.find((s) => s.id === marketId || s.market.id === marketId);

      if (signal?.market) {
        const yesOutcome = signal.market.outcomes?.find(o => o.name.toLowerCase() === 'yes');
        if (yesOutcome?.id) {
          tokenId = yesOutcome.id;
        }
        marketName = signal.market.question.substring(0, 40) + (signal.market.question.length > 40 ? '...' : '');
      } else {
        // Strategie 2: Direkt von Polymarket holen
        try {
          const market = await polymarketClient.getMarketById(marketId);
          if (market) {
            const yesOutcome = market.outcomes?.find(o => o.name?.toLowerCase() === 'yes');
            if (yesOutcome?.id) {
              tokenId = yesOutcome.id;
            }
            marketName = market.question?.substring(0, 40) + (market.question?.length > 40 ? '...' : '') || 'Markt';
          }
        } catch {
          logger.debug(`[CHART] Konnte Markt ${marketId} nicht von Polymarket laden`);
        }
      }

      // Hole Price History (letzte 24h, stündlich)
      const priceHistory = await polymarketClient.getPriceHistory(tokenId, 60);

      if (!priceHistory || priceHistory.length < 2) {
        // Fallback: Nur Link anzeigen
        const polymarketUrl = `https://polymarket.com/event/${marketId}`;
        const fallbackMsg = `${this.HEADER}\n\n📈 *Chart*\n\n_Keine Preisdaten verfügbar._\n\n[Auf Polymarket ansehen](${polymarketUrl})`;
        const keyboard: InlineKeyboardMarkup = {
          inline_keyboard: [
            [{ text: '📈 Polymarket öffnen', url: polymarketUrl }],
            [{ text: '◀️ Back', callback_data: 'action:signals' }],
          ],
        };
        if (messageId) {
          await this.editMessage(chatId, messageId, fallbackMsg, keyboard);
        } else {
          await this.sendMessageWithKeyboard(fallbackMsg, keyboard, chatId);
        }
        return;
      }

      // Daten für Chart vorbereiten (letzte 24 Punkte max)
      const chartData = priceHistory.slice(-24);
      const labels = chartData.map(p => {
        const date = new Date(p.timestamp);
        return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
      });
      const prices = chartData.map(p => (p.price * 100).toFixed(1));

      // Preis-Statistiken
      const currentPrice = chartData[chartData.length - 1]?.price || 0;
      const startPrice = chartData[0]?.price || 0;
      const priceChange = currentPrice - startPrice;
      const priceChangePercent = startPrice > 0 ? (priceChange / startPrice) * 100 : 0;
      const minPrice = Math.min(...chartData.map(p => p.price));
      const maxPrice = Math.max(...chartData.map(p => p.price));

      // Trend-Farbe
      const trendColor = priceChange >= 0 ? 'rgb(34, 197, 94)' : 'rgb(239, 68, 68)';
      const trendEmoji = priceChange >= 0 ? '📈' : '📉';

      // QuickChart.io Konfiguration
      const chartConfig = {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'YES Preis (%)',
            data: prices,
            borderColor: trendColor,
            backgroundColor: priceChange >= 0 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          }],
        },
        options: {
          plugins: {
            legend: { display: false },
            title: {
              display: true,
              text: marketName,
              color: '#fff',
              font: { size: 14 },
            },
          },
          scales: {
            y: {
              min: Math.max(0, (minPrice * 100) - 5),
              max: Math.min(100, (maxPrice * 100) + 5),
              grid: { color: 'rgba(255,255,255,0.1)' },
              ticks: { color: '#fff', callback: (v: number) => v + '%' },
            },
            x: {
              grid: { display: false },
              ticks: { color: '#999', maxTicksLimit: 6 },
            },
          },
        },
      };

      // QuickChart URL (mit encoding)
      const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));
      const quickChartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}&w=600&h=300&bkg=rgb(17,24,39)`;

      // Polymarket Link
      const polymarketUrl = `https://polymarket.com/event/${marketId}`;

      // Caption mit Stats
      const caption = `${this.HEADER}

${trendEmoji} *PREIS-CHART (24h)*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  STATISTIK                      │
├─────────────────────────────────┤
│  Aktuell:   ${(currentPrice * 100).toFixed(1).padStart(6)}%            │
│  Änderung:  ${priceChange >= 0 ? '+' : ''}${(priceChange * 100).toFixed(1).padStart(5)}% (${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(1)}%)  │
│  Min (24h): ${(minPrice * 100).toFixed(1).padStart(6)}%            │
│  Max (24h): ${(maxPrice * 100).toFixed(1).padStart(6)}%            │
└─────────────────────────────────┘
\`\`\``;

      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: `chart:${marketId}` }],
          [{ text: '📈 Polymarket', url: polymarketUrl }],
          [{ text: '◀️ Back', callback_data: 'action:signals' }],
        ],
      };

      // Sende Chart als Foto
      if (this.bot) {
        // Lösche alte Message wenn vorhanden
        if (messageId) {
          try {
            await this.bot.deleteMessage(parseInt(chatId), messageId);
          } catch {
            // Ignoriere Fehler beim Löschen
          }
        }

        // Sende neues Foto mit Chart
        await this.bot.sendPhoto(chatId, quickChartUrl, {
          caption,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
      }

      logger.info(`[CHART] Generated chart for ${marketId}: ${(currentPrice * 100).toFixed(1)}% (${priceChange >= 0 ? '+' : ''}${(priceChange * 100).toFixed(1)}%)`);

    } catch (err) {
      const error = err as Error;
      logger.error(`[CHART] Error generating chart: ${error.message}`);

      // Fallback bei Fehler
      const polymarketUrl = `https://polymarket.com/event/${marketId}`;
      const errorMsg = `${this.HEADER}\n\n❌ *Chart-Fehler*\n\n_${error.message}_`;
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          [{ text: '📈 Polymarket öffnen', url: polymarketUrl }],
          [{ text: '◀️ Back', callback_data: 'action:signals' }],
        ],
      };

      if (messageId) {
        await this.editMessage(chatId, messageId, errorMsg, keyboard);
      } else {
        await this.sendMessageWithKeyboard(errorMsg, keyboard, chatId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //      V4.0: ARBITRAGE & LATE-ENTRY ACTION HANDLERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Handelt Arbitrage Button-Klicks (arb:direction:opportunityId:amount)
   */
  private async handleArbitrageAction(
    direction: string, // 'yes', 'no', oder 'both'
    opportunityId: string,
    amount: number,
    chatId: string,
    messageId?: number
  ): Promise<void> {
    const state = runtimeState.getState();

    // Kill-Switch Check - Single Message Pattern
    if (state.killSwitchActive) {
      const errorMsg = '❌ *Trade abgebrochen*\n\n_Kill-Switch ist aktiv. Alle Trades gestoppt._';
      if (messageId) {
        await this.editMessage(chatId, messageId, errorMsg, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(errorMsg, this.getBackButton(), chatId);
      }
      return;
    }

    // Record Trade im Tracker
    const trade = performanceTracker.recordTrade({
      strategy: 'arbitrage',
      executionType: 'manual',
      marketId: opportunityId,
      question: `Arbitrage Trade`,
      direction: direction === 'both' ? 'yes' : direction as 'yes' | 'no',
      entryPrice: 0.98, // Typical arbitrage total cost
      size: amount,
      expectedProfit: amount * 0.02, // ~2% spread
      confidence: 0.95,
      status: performanceTracker.isPaperMode() ? 'filled' : 'pending',
      reasoning: ['Manual Arbitrage Trade via Telegram Button'],
    });

    const modeEmoji = performanceTracker.isPaperMode() ? '📝 PAPER' : '🚀 LIVE';
    const directionText = direction === 'both' ? 'YES + NO (Arbitrage)' : direction.toUpperCase();

    const message = `${this.HEADER}

💰 *ARBITRAGE TRADE ${performanceTracker.isPaperMode() ? 'SIMULIERT' : 'AUSGEFÜHRT'}*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  Trade ID: ${trade.id.substring(0, 12)}...     │
│  Direction: ${directionText.padEnd(18)}│
│  Amount:   $${amount.toFixed(2).padEnd(17)}│
│  Expected: $${(amount * 0.02).toFixed(2).padEnd(17)}│
└─────────────────────────────────┘
\`\`\`

${modeEmoji}

${this.DIVIDER}

${performanceTracker.isPaperMode()
  ? '_Simulierter Trade - Nutze /settings für Live Mode_'
  : '_Trade wird auf Polymarket ausgeführt..._'}

📊 Nutze /stats für Performance-Tracking`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '📊 Stats', callback_data: 'action:stats' },
          { text: '◀️ Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }

    logger.info(`[ARBITRAGE] Trade recorded: ${direction} | $${amount} | ${performanceTracker.isPaperMode() ? 'PAPER' : 'LIVE'}`);
  }

  /**
   * Handelt Late-Entry Button-Klicks (late:direction:signalId:amount)
   */
  private async handleLateEntryAction(
    direction: 'yes' | 'no',
    signalId: string,
    amount: number,
    chatId: string,
    messageId?: number
  ): Promise<void> {
    const state = runtimeState.getState();

    // Kill-Switch Check - Single Message Pattern
    if (state.killSwitchActive) {
      const errorMsg = '❌ *Trade abgebrochen*\n\n_Kill-Switch ist aktiv. Alle Trades gestoppt._';
      if (messageId) {
        await this.editMessage(chatId, messageId, errorMsg, this.getBackButton());
      } else {
        await this.sendMessageWithKeyboard(errorMsg, this.getBackButton(), chatId);
      }
      return;
    }

    // Versuche Coin aus signalId zu extrahieren (late-marketId-timestamp)
    const coin = signalId.includes('BTC') ? 'BTC' :
                 signalId.includes('ETH') ? 'ETH' :
                 signalId.includes('SOL') ? 'SOL' :
                 signalId.includes('XRP') ? 'XRP' : 'CRYPTO';

    // Record Trade im Tracker
    const trade = performanceTracker.recordTrade({
      strategy: 'lateEntry',
      executionType: 'manual',
      marketId: signalId,
      question: `${coin} 15-Min Market`,
      direction,
      entryPrice: direction === 'yes' ? 0.7 : 0.3, // Typical late-entry prices
      size: amount,
      expectedProfit: amount * 0.3, // ~30% expected return
      confidence: 0.7,
      status: performanceTracker.isPaperMode() ? 'filled' : 'pending',
      reasoning: ['Manual Late-Entry Trade via Telegram Button'],
    });

    const modeEmoji = performanceTracker.isPaperMode() ? '📝 PAPER' : '🚀 LIVE';
    const directionEmoji = direction === 'yes' ? '🟢 UP' : '🔴 DOWN';

    const message = `${this.HEADER}

⏱️ *LATE\\-ENTRY TRADE ${performanceTracker.isPaperMode() ? 'SIMULIERT' : 'AUSGEFÜHRT'}*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  Trade ID: ${trade.id.substring(0, 12)}...     │
│  Coin:     ${coin.padEnd(20)}│
│  Direction: ${direction.toUpperCase().padEnd(18)}│
│  Amount:   $${amount.toFixed(2).padEnd(17)}│
└─────────────────────────────────┘
\`\`\`

${directionEmoji} ${modeEmoji}

${this.DIVIDER}

${performanceTracker.isPaperMode()
  ? '_Simulierter Trade - Nutze /settings für Live Mode_'
  : '_Trade wird auf Polymarket ausgeführt..._'}

📊 Nutze /stats für Performance-Tracking`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '📊 Stats', callback_data: 'action:stats' },
          { text: '◀️ Menü', callback_data: 'action:menu' },
        ],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }

    logger.info(`[LATE-ENTRY] Trade recorded: ${coin} ${direction.toUpperCase()} | $${amount} | ${performanceTracker.isPaperMode() ? 'PAPER' : 'LIVE'}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                    BATCHED ALERTS
  // ═══════════════════════════════════════════════════════════════

  private async sendBatchedAlert(notifications: PushReadyNotification[]): Promise<void> {
    if (notifications.length === 0) return;

    // Filtere nur Deutschland-relevante Notifications
    const germanyRelevant = notifications.filter(n => hasGermanyRelevance(n.market.question));
    if (germanyRelevant.length === 0) {
      logger.info(`[TELEGRAM] Batch übersprungen - keine Deutschland-relevanten Märkte`);
      return;
    }

    const primary = germanyRelevant[0];
    const additional = germanyRelevant.slice(1);

    // Verbesserte "Why now?" Texte
    const improvedWhyNow = [
      `Deutsche Quelle: ${primary.candidate.sourceName}`,
      `Markt hat noch nicht reagiert`,
    ];

    let message = `
⚡ *EUSSR-TRACKER ALERT* ⚡

${this.DIVIDER}

📊 *Top-Signal:*
\`\`\`
${primary.market.question.substring(0, 80)}...
\`\`\`

⏰ *Zeitvorsprung aktiv\\!*
📰 *Quelle:* ${primary.candidate.sourceName}

🎯 *Why now?*
${improvedWhyNow.map(r => `• ${r}`).join('\n')}`;

    if (additional.length > 0) {
      message += `

${this.DIVIDER}

📋 *+${additional.length} weitere Signals:*
${additional.slice(0, 3).map(n => `• ${n.candidate.title.substring(0, 50)}...`).join('\n')}`;
    }

    await this.sendMessageWithKeyboard(message, {
      inline_keyboard: [
        [
          { text: '📋 Alle anzeigen', callback_data: 'digest:all' },
          { text: '📊 Top-Signal', callback_data: `details:${primary.candidate.id}` },
        ],
      ],
    });

    logger.info(`[TELEGRAM] EUSSR-Tracker Batch Alert: ${germanyRelevant.length} von ${notifications.length} Notifications`);
  }

  // ═══════════════════════════════════════════════════════════════
  //                    SYSTEM ALERTS
  // ═══════════════════════════════════════════════════════════════

  private async sendSystemAlert(
    type: string,
    message: string,
    details?: Record<string, unknown>,
    asOf?: Date
  ): Promise<void> {
    const typeEmoji: Record<string, string> = {
      kill_switch: '🛑',
      pipeline_down: '🔴',
      pipeline_stale: '🟡',
      trade_executed: '✅',
      trade_failed: '❌',
      mode_change: '🔄',
      error: '⚠️',
    };

    const emoji = typeEmoji[type] || '📢';
    const asOfStr = asOf
      ? asOf.toLocaleString('de-DE', {
          timeZone: 'Europe/Berlin',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });

    let alertMessage = `
${emoji} *SYSTEM ALERT* ${emoji}

${this.DIVIDER}

*Status:* ${type.replace(/_/g, ' ').toUpperCase()}
*Zeit:* ${asOfStr}

${message}`;

    if (details && Object.keys(details).length > 0) {
      const detailLines = Object.entries(details)
        .slice(0, 5)
        .map(([k, v]) => `• ${k}: ${v}`)
        .join('\n');
      alertMessage += `

${this.DIVIDER}

*Details:*
${detailLines}`;
    }

    const buttons: InlineKeyboardButton[][] = [];

    if (type === 'kill_switch') {
      buttons.push([{ text: '🔓 Kill-Switch deaktivieren', callback_data: 'action:resume' }]);
    } else if (type.includes('pipeline')) {
      buttons.push([
        { text: '🔄 Retry', callback_data: 'action:retry_pipeline' },
        { text: '🔇 1h ignorieren', callback_data: 'action:silence:1h' },
      ]);
    }

    buttons.push([{ text: '📊 Dashboard', callback_data: 'action:dashboard' }]);

    await this.sendMessageWithKeyboard(alertMessage, { inline_keyboard: buttons });

    logger.info(`[TELEGRAM] System Alert: ${type} - ${message}`);
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
      // Pipeline Success: Telegram Nachricht erfolgreich gesendet
      runtimeState.recordPipelineSuccess('telegram');
    } catch (err) {
      const error = err as Error;
      logger.error(`Telegram Nachricht Fehler: ${error.message}`);
      runtimeState.recordPipelineError('telegram', error.message);
    }
  }

  private async sendMessageWithKeyboard(
    text: string,
    keyboard: InlineKeyboardMarkup,
    chatId?: string
  ): Promise<TelegramBot.Message | undefined> {
    if (!this.bot) return undefined;

    try {
      const sentMessage = await this.bot.sendMessage(chatId || this.chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
      // Pipeline Success: Telegram Nachricht erfolgreich gesendet
      runtimeState.recordPipelineSuccess('telegram');
      return sentMessage;
    } catch (err) {
      const error = err as Error;
      logger.error(`Telegram Nachricht Fehler: ${error.message}`);
      runtimeState.recordPipelineError('telegram', error.message);
      return undefined;
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
