import TelegramBot, { InlineKeyboardButton, InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { config, WALLET_PRIVATE_KEY } from '../utils/config.js';
import logger from '../utils/logger.js';
import { AlphaSignal, TradeRecommendation, ScanResult, ExecutionMode } from '../types/index.js';
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
import { runtimeState } from '../runtime/state.js';
import { notificationService, PushReadyNotification } from '../notifications/notificationService.js';
import {
  canPush,
  getNotificationSettings,
  updateNotificationSettings,
  PushMode,
} from '../notifications/rateLimiter.js';
import { autoTrader, AutoTradeResult } from '../alpha/autoTrader.js';
import { timeDelayEngine } from '../alpha/timeDelayEngine.js';
import { timeAdvantageService } from '../alpha/timeAdvantageService.js';

// ═══════════════════════════════════════════════════════════════
//           EDGY ALPHA SCANNER - TELEGRAM BOT
//         Mit Alman Heimvorteil | Kein Gelaber, nur Alpha
// ═══════════════════════════════════════════════════════════════

// Runtime-Settings (änderbar via Telegram)
const runtimeSettings = {
  maxBet: 10,
  risk: 10,
  minEdge: 5,
  minAlpha: 15,
  minVolume: 5000,
  // Module Toggles
  timeDelayEnabled: true,    // TIME_DELAY Engine aktiv
  mispricingEnabled: false,  // MISPRICING Engine (default: aus - nur Digest)
  germanyOnly: true,         // Nur Deutschland-relevante Märkte
  // SAFE BET Auto-Trading
  autoBetOnSafeBet: false,   // Bei SAFE BET automatisch traden? Default: AUS (sicher)
};

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
  private pendingTrades: Map<string, TradeRecommendation> = new Map();
  private editingField: string | null = null; // Welches Feld wird gerade bearbeitet?

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
║     Alman Heimvorteil aktiviert  ║
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
      // KEIN automatisches sendWelcome() mehr!
      // Das Menü wird nur gesendet wenn User /start oder /menu eingibt.
      // Verhindert Spam bei Prozess-Restarts.
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

🟢 *Maschine läuft. Alman Heimvorteil aktiviert.*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  KAMPFKONFIGURATION             │
├─────────────────────────────────┤
│  Scan:     alle 5 Min           │
│  Ziele:    Politik, Wirtschaft  │
│  DE-Edge:  Scharf geschaltet    │
│  Trading:  Ein Klick zum Geld   │
└─────────────────────────────────┘
\`\`\`

*Was soll's sein, Chef?*`;

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
          { text: '📰 Alman News', callback_data: 'action:news' },
        ],
        [
          { text: '🇩🇪 Sonntagsfrage', callback_data: 'action:polls' },
          { text: '📈 Zeitvorsprung', callback_data: 'action:edge' },
        ],
        [
          { text: `🛡️ Risk ${killSwitchEmoji}`, callback_data: 'action:risk' },
          { text: `${modeEmoji} Mode: ${state.executionMode.toUpperCase()}`, callback_data: 'action:mode' },
        ],
        [
          { text: '⚙️ Settings', callback_data: 'action:settings' },
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
      } catch (err) {
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

    // /help - Kommando-Übersicht
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id.toString();

      const message = `${this.HEADER}

📖 *KOMMANDOS*

${this.DIVIDER}

\`\`\`
┌─────────────────────────────────┐
│  TRADING CONTROLS               │
├─────────────────────────────────┤
│  /kill [grund] - Stop All       │
│  /resume       - Resume Trading │
│  /cooldown     - Drawdown-Pause │
│  /mode [m]     - paper/shadow/  │
│                  live           │
├─────────────────────────────────┤
│  MONITORING                     │
├─────────────────────────────────┤
│  /pnl          - Tages-PnL      │
│  /positions    - Offene Pos.    │
│  /status       - System Status  │
│  /signals      - Aktive Signale │
├─────────────────────────────────┤
│  NOTIFICATIONS                  │
├─────────────────────────────────┤
│  /settings     - Push Settings  │
│  /push [mode]  - Push-Modus     │
│  /quiet [on/off] - Quiet Hours  │
│  /digest       - Signal Digest  │
├─────────────────────────────────┤
│  SCANNER                        │
├─────────────────────────────────┤
│  /scan         - Scan starten   │
│  /wallet       - Wallet Balance │
├─────────────────────────────────┤
│  EUSSR-TRACKER                       │
├─────────────────────────────────┤
│  /polls        - Wahlumfragen   │
│  /news         - Deutsche News  │
│  /edge         - Zeitvorsprung  │
├─────────────────────────────────┤
│  SONSTIGES                      │
├─────────────────────────────────┤
│  /menu         - Hauptmenü      │
│  /help         - Diese Hilfe    │
└─────────────────────────────────┘
\`\`\``;

      await this.sendMessage(message, chatId);
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
            await this.handleWatch(params[0], chatId);
            break;
          case 'chart':
            await this.handleChart(params[0], chatId);
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
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //                      ACTION HANDLERS
  // ═══════════════════════════════════════════════════════════════

  private async sendMainMenu(chatId: string, messageId?: number): Promise<void> {
    const message = `${this.HEADER}

Wähle eine Aktion:`;

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
    const phases = ['Polymarket wird durchsucht...', 'Alman-Daten laden...', 'Dawum-Umfragen checken...', 'Edge berechnen...', 'Alpha identifizieren...'];
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
            [{ text: '🔄 Neu laden', callback_data: 'action:news' }],
            [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
          ],
        });
      } else {
        await this.sendMessageWithKeyboard(emptyMessage, {
          inline_keyboard: [
            [{ text: '🔄 Neu laden', callback_data: 'action:news' }],
            [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
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
          [{ text: '🔄 Aktualisieren', callback_data: 'action:news' }],
          [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
        ],
      });
    } else {
      await this.sendMessageWithKeyboard(message, {
        inline_keyboard: [
          [{ text: '🔄 Aktualisieren', callback_data: 'action:news' }],
          [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
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
        sourceTable = '\n*Top Quellen:*\n\`\`\`\n';
        sourceTable += 'Quelle          | # | Adv.  | Acc.\n';
        sourceTable += '----------------|---|-------|-----\n';

        for (const src of dashboard.bySource.slice(0, 6)) {
          const name = src.source.substring(0, 15).padEnd(15);
          const count = src.count.toString().padStart(2);
          const adv = src.avgAdvantage > 0 ? `${src.avgAdvantage.toFixed(0)}m`.padStart(5) : '  -  ';
          const acc = src.accuracy > 0 ? `${src.accuracy.toFixed(0)}%`.padStart(4) : '  - ';
          sourceTable += `${name} |${count} |${adv} |${acc}\n`;
        }
        sourceTable += '\`\`\`';
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
│  ALMAN EDGE BEWEIS              │
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
        [{ text: '🔄 Aktualisieren', callback_data: 'action:edge' }],
        [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
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

    // Module Status Emojis
    const tdStatus = runtimeSettings.timeDelayEnabled ? '🟢' : '🔴';
    const mpStatus = runtimeSettings.mispricingEnabled ? '🟢' : '🔴';
    const deStatus = runtimeSettings.germanyOnly ? '🟢' : '🔴';
    const autoStatus = runtimeSettings.autoBetOnSafeBet ? '🟢' : '🔴';

    const message = `${this.HEADER}

⚙️ *EINSTELLUNGEN*

${this.DIVIDER}

*ALPHA MODULE:*
${tdStatus} ⚡ EUSSR-TRACKER: ${runtimeSettings.timeDelayEnabled ? 'AKTIV' : 'AUS'}
${mpStatus} MISPRICING: ${runtimeSettings.mispricingEnabled ? 'AKTIV' : 'AUS'}
${deStatus} Nur Deutschland: ${runtimeSettings.germanyOnly ? 'JA' : 'NEIN'}

${this.DIVIDER}

*SAFE BET AUTO\\-TRADING:*
${autoStatus} Auto\\-Bet: ${runtimeSettings.autoBetOnSafeBet ? '🚀 AKTIV' : '⏸️ AUS'}
_Bei SAFE BET ${runtimeSettings.autoBetOnSafeBet ? 'automatisch traden' : 'nur Benachrichtigung'}_

${this.DIVIDER}

*QUICK\\-BUY BETRÄGE:*
💰 ${config.quickBuy.amounts.join(', ')} USDC
_Änderbar via ENV: QUICK\\_BUY\\_AMOUNTS_

${this.DIVIDER}

_Tippe auf ein Modul zum Umschalten:_`;

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        // Module Toggles
        [
          { text: `${tdStatus} ⚡ EUSSR-TRACKER`, callback_data: 'toggle:timeDelay' },
          { text: `${mpStatus} MISPRICING`, callback_data: 'toggle:mispricing' },
        ],
        [
          { text: `${deStatus} 🇩🇪 Nur Deutschland`, callback_data: 'toggle:germanyOnly' },
        ],
        // SAFE BET Toggle
        [{ text: '── SAFE BET ──', callback_data: 'noop' }],
        [
          { text: `${autoStatus} 🚨 Auto-Bet bei SAFE BET`, callback_data: 'toggle:autoBet' },
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
        [{ text: '◀️ Zurück', callback_data: 'action:menu' }],
      ],
    };

    if (messageId) {
      await this.editMessage(chatId, messageId, message, keyboard);
    } else {
      await this.sendMessageWithKeyboard(message, keyboard, chatId);
    }
  }

  private async handleModuleToggle(module: string, chatId: string, messageId?: number): Promise<void> {
    const moduleMap: Record<string, keyof typeof runtimeSettings> = {
      timeDelay: 'timeDelayEnabled',
      mispricing: 'mispricingEnabled',
      germanyOnly: 'germanyOnly',
      autoBet: 'autoBetOnSafeBet',
    };

    const settingKey = moduleMap[module];
    if (!settingKey) return;

    // Toggle the value
    (runtimeSettings as unknown as Record<string, boolean>)[settingKey] = !runtimeSettings[settingKey];

    const newValue = runtimeSettings[settingKey];
    const moduleNames: Record<string, string> = {
      timeDelay: '⚡ EUSSR-TRACKER',
      mispricing: 'MISPRICING',
      germanyOnly: '🇩🇪 Nur Deutschland',
      autoBet: '🚨 Auto-Bet bei SAFE BET',
    };

    logger.info(`[TELEGRAM] Modul ${moduleNames[module]} → ${newValue ? 'AKTIVIERT' : 'DEAKTIVIERT'}`);

    // Zusätzliche Warnung und AutoTrader-Sync bei Auto-Bet Toggle
    if (module === 'autoBet') {
      // Sync mit AutoTrader UND TimeDelayEngine
      autoTrader.setEnabled(newValue as boolean);
      timeDelayEngine.updateConfig({ autoTradeEnabled: newValue as boolean });

      if (newValue) {
        const state = runtimeState.getState();
        await this.sendMessage(
          `🚨 *AUTO-TRADE AKTIVIERT*\n\n` +
          `Bei BREAKING_CONFIRMED Signalen wird jetzt automatisch getradet!\n\n` +
          `*Config:*\n` +
          `• Min Edge: ${(autoTrader.getConfig().minEdge * 100).toFixed(0)}%\n` +
          `• Max Size: $${autoTrader.getConfig().maxSize}\n` +
          `• Mode: ${state.executionMode.toUpperCase()}\n\n` +
          `_Stelle sicher, dass du im richtigen Trading-Mode bist!_`,
          chatId
        );
      } else {
        await this.sendMessage(
          `⏸️ *AUTO-TRADE DEAKTIVIERT*\n\n` +
          `BREAKING_CONFIRMED Signals werden jetzt nur noch angezeigt.`,
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

    // SAFE BET Custom-Betrag verarbeiten
    if (this.editingField.startsWith('safebet:')) {
      const handled = await this.handleSafeBetCustomInput(text, chatId);
      if (handled) return;
    }

    const numValue = parseFloat(text.replace(/[^0-9.]/g, ''));

    if (isNaN(numValue) || numValue <= 0) {
      await this.sendMessage('❌ Ungültiger Wert. Bitte eine Zahl eingeben.', chatId);
      return;
    }

    // Wert setzen
    (runtimeSettings as unknown as Record<string, number>)[this.editingField] = numValue;

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

    // Zurück zu Settings
    await this.handleSettings(chatId);
  }

  // ═══════════════════════════════════════════════════════════════
  //                   RISK DASHBOARD & CONTROLS
  // ═══════════════════════════════════════════════════════════════

  private async handleRiskDashboard(chatId: string, messageId?: number): Promise<void> {
    const dashboard = runtimeState.getRiskDashboard();
    const state = runtimeState.getState();

    // Kill-Switch Status
    const killSwitchStatus = dashboard.killSwitch.active
      ? `🔴 AKTIV (${dashboard.killSwitch.reason || 'Manuell'})`
      : '🟢 Inaktiv';

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
          { text: '🔄 Aktualisieren', callback_data: 'action:risk' },
          { text: '🗑️ Daily Reset', callback_data: 'killswitch:reset' },
        ],
        [{ text: '◀️ Zurück zum Menü', callback_data: 'action:menu' }],
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
        [{ text: '◀️ Zurück zum Menü', callback_data: 'action:menu' }],
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
            [{ text: '⚙️ Zurück zu Settings', callback_data: 'action:settings' }],
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
              [{ text: '⚙️ Zurück zu Settings', callback_data: 'action:settings' }],
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

${this.formatSignalReasoning(signal)}`;

    await this.sendMessageWithKeyboard(message, this.getSignalKeyboard(signalId), chatId);
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
    // AUTO-TRADE EVENTS (Breaking News automatisch traden)
    // ═══════════════════════════════════════════════════════════════
    autoTrader.on('auto_trade_executed', async (result: AutoTradeResult) => {
      logger.info(`[TELEGRAM] Auto-Trade executed event received`);
      await this.sendAutoTradeNotification(result, true);
    });

    autoTrader.on('auto_trade_blocked', async (result: AutoTradeResult) => {
      // Nur bei breaking_confirmed loggen/notifizieren
      if (result.signal.certainty === 'breaking_confirmed') {
        logger.info(`[TELEGRAM] Auto-Trade blocked: ${result.reason}`);
        // Optional: Notification bei blockiertem Trade
        // await this.sendAutoTradeNotification(result, false);
      }
    });

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
    const { candidate, market, whyNow, asOf } = notification;

    // Prüfe Deutschland-Bezug - nur bei Relevanz senden
    if (!hasGermanyRelevance(market.question)) {
      logger.info(`[TELEGRAM] Überspringe Alert - kein Deutschland-Bezug: ${market.question.substring(0, 50)}...`);
      return;
    }

    // Format as_of Zeit
    const asOfStr = asOf.toLocaleString('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    // Market URL
    const marketUrl = market.marketId
      ? `https://polymarket.com/event/${market.marketId}`
      : '';

    // Verbesserte "Why now?" Texte - keine falsche US-Medien Logik
    const improvedWhyNow = [
      `Deutsche Quelle: ${candidate.sourceName}`,
      `Markt hat noch nicht reagiert`,
      ...whyNow.filter(r => !r.includes('vor US-Medien') && !r.includes('Min vor')),
    ];

    const message = `
⚡ *EUSSR-TRACKER ALERT* ⚡

${this.DIVIDER}

📊 *Markt:*
\`\`\`
${market.question.substring(0, 100)}${market.question.length > 100 ? '...' : ''}
\`\`\`

${this.DIVIDER}

⏰ *Zeitvorsprung aktiv\\!*
📰 *Quelle:* ${candidate.sourceName}
💰 *Volume:* $${(market.totalVolume / 1000).toFixed(0)}k
📈 *Preis:* ${(market.currentPrice * 100).toFixed(1)}%
${candidate.suggestedDirection ? `🎯 *KI-Empfehlung:* ${candidate.suggestedDirection === 'yes' ? '🟢 YES kaufen' : '🔴 NO kaufen'}` : ''}
${candidate.llmReasoning ? `💡 *Grund:* ${candidate.llmReasoning}` : ''}

${this.DIVIDER}

🎯 *Why now?*
${improvedWhyNow.map(r => `• ${r}`).join('\n')}

${candidate.url ? `🔗 [Quelle](${candidate.url})` : ''}
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
      const marketUrl = `https://polymarket.com/event/${signalId}`;

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
          { text: '◀️ Zurück', callback_data: 'action:menu' },
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

    // Kill-Switch Check
    if (state.killSwitchActive) {
      await this.sendMessage('❌ Trade abgebrochen: Kill-Switch aktiv', chatId);
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
  private async handleWatch(signalId: string, chatId: string): Promise<void> {
    // TODO: Implementiere Watchlist-Funktionalität
    await this.sendMessage(`👀 *Watchlist*\n\nMarkt \`${signalId.substring(0, 16)}...\` wird beobachtet.\n\n_Watchlist-Feature kommt bald!_`, chatId);
    logger.info(`[WATCH] Added to watchlist: ${signalId}`);
  }

  /**
   * Chart-Handler: Zeigt Preis-Chart für Markt
   */
  private async handleChart(marketId: string, chatId: string): Promise<void> {
    const chartUrl = `https://polymarket.com/event/${marketId}`;
    await this.sendMessage(`📈 *Chart*\n\n[Chart auf Polymarket öffnen](${chartUrl})`, chatId);
    logger.info(`[CHART] Opened chart: ${marketId}`);
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

    // Format as_of Zeit
    const asOfStr = primary.asOf.toLocaleString('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

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
  //                    AUTO-TRADE NOTIFICATION
  // Speed ist essentiell - sofortige Benachrichtigung nach Trade!
  // ═══════════════════════════════════════════════════════════════

  private async sendAutoTradeNotification(result: AutoTradeResult, executed: boolean): Promise<void> {
    const { signal, execution, decision } = result;
    const state = runtimeState.getState();
    const modeEmoji = state.executionMode === 'live' ? '🚀' : state.executionMode === 'shadow' ? '👻' : '📝';

    const directionEmoji = signal.direction === 'yes' ? '✅' : '❌';

    // Market URL
    const marketUrl = `https://polymarket.com/event/${signal.marketId}`;

    if (executed) {
      // Trade wurde ausgeführt
      const message = `
🤖 *AUTO\\-TRADE AUSGEFÜHRT* 🤖

${this.DIVIDER}

✅ *BREAKING\\_CONFIRMED*
${modeEmoji} *Mode:* ${state.executionMode.toUpperCase()}

${this.DIVIDER}

📊 *Markt:*
\`\`\`
${signal.question.substring(0, 80)}...
\`\`\`

🎯 *Direction:* ${directionEmoji} ${signal.direction.toUpperCase()}
📈 *Edge:* ${(signal.predictedEdge * 100).toFixed(1)}%
💵 *Size:* $${decision?.sizeUsdc?.toFixed(2) || '?'}

${this.DIVIDER}

${execution ? `*Execution Details:*
• Fill Price: ${execution.fillPrice?.toFixed(4) || 'N/A'}
• Slippage: ${execution.slippage ? (execution.slippage * 100).toFixed(2) + '%' : 'N/A'}
• ID: \`${execution.executionId.substring(0, 8)}...\`` : ''}

_Zeitvorsprung genutzt \\- Trade automatisch ausgeführt\\!_

[📊 Polymarket](${marketUrl})`;

      await this.sendMessageWithKeyboard(message, {
        inline_keyboard: [
          [
            { text: '📊 Risk Dashboard', callback_data: 'action:risk' },
            { text: '💰 PnL', callback_data: 'action:pnl' },
          ],
          [
            { text: '⏸️ Auto-Trade AUS', callback_data: 'toggle:autoBet' },
          ],
        ],
      });

      logger.info(`[TELEGRAM] Auto-Trade Notification gesendet: ${signal.marketId}`);
    } else {
      // Trade wurde blockiert - optional notification
      const safeReason = result.reason.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
      const message = `
⚠️ *AUTO\\-TRADE BLOCKIERT* ⚠️

${this.DIVIDER}

*Grund:* ${safeReason}

📊 *Markt:*
\`\`\`
${signal.question.substring(0, 60)}...
\`\`\`

🎯 *Direction:* ${directionEmoji} ${signal.direction.toUpperCase()}
📈 *Edge:* ${(signal.predictedEdge * 100).toFixed(1)}%

${this.DIVIDER}

_Manuelles Trading über Polymarket möglich\\._

[📊 Polymarket](${marketUrl})`;

      await this.sendMessageWithKeyboard(message, {
        inline_keyboard: [
          [
            { text: '🔥 Manuell traden', url: marketUrl },
          ],
          [
            { text: '📊 Risk Dashboard', callback_data: 'action:risk' },
          ],
        ],
      });

      logger.info(`[TELEGRAM] Auto-Trade Blocked Notification gesendet: ${result.reason}`);
    }
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
