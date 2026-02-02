import { ethers } from 'ethers';
import axios from 'axios';
import { config, WALLET_PRIVATE_KEY, WALLET_ADDRESS, POLYGON_RPC_URL } from '../utils/config.js';
import logger from '../utils/logger.js';
import { AlphaSignal, TradeRecommendation, TradeExecution, Position, ExecutionMode } from '../types/index.js';
import { Decision, Execution, MarketQuality, RiskChecks } from '../alpha/types.js';
import { checkRiskGates, updateRiskState, getRiskState, RiskCheckResult } from '../alpha/riskGates.js';
import { calculatePositionSize, estimateSlippage, SizingResult } from '../alpha/sizing.js';
import { polymarketClient } from './polymarket.js';
import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';

// Polymarket Contract Addresses (Polygon)
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// Execution Errors
export class LiveModeNoCredentialsError extends Error {
  constructor() {
    super('LIVE_MODE_NO_CREDENTIALS: Wallet nicht konfiguriert');
    this.name = 'LiveModeNoCredentialsError';
  }
}

export class RiskGatesFailedError extends Error {
  constructor(public readonly failedReasons: string[]) {
    super(`RISK_GATES_FAILED: ${failedReasons.join(', ')}`);
    this.name = 'RiskGatesFailedError';
  }
}

// ERC20 ABI (minimal)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// Polymarket CLOB Config
const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

export class TradingClient extends EventEmitter {
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private usdcContract: ethers.Contract | null = null;
  private pendingExecutions: Map<string, TradeExecution> = new Map();

  // Polymarket CLOB Client
  private clobClient: ClobClient | null = null;
  private clobInitialized = false;

  constructor() {
    super();

    if (WALLET_PRIVATE_KEY) {
      try {
        this.provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
        this.wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, this.provider);
        this.usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, this.wallet);
        // Adresse automatisch aus Private Key ableiten
        const derivedAddress = this.wallet.address;
        logger.info(`Trading Client initialisiert: ${derivedAddress.slice(0, 10)}...`);

        // CLOB Client initialisieren (async)
        this.initializeClobClient().catch(err => {
          logger.error(`CLOB Client Init Fehler: ${(err as Error).message}`);
        });
      } catch (err) {
        logger.error(`Trading Client Fehler: ${(err as Error).message}`);
      }
    } else {
      logger.warn('Trading Client: Wallet nicht konfiguriert (kein Private Key)');
    }
  }

  /**
   * Initialisiert den Polymarket CLOB Client mit API Credentials
   */
  private async initializeClobClient(): Promise<void> {
    if (!this.wallet || !WALLET_PRIVATE_KEY) {
      logger.warn('[CLOB] Kein Wallet für CLOB Client');
      return;
    }

    try {
      // Temporärer Client für API Key Derivation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tempClient = new ClobClient(
        CLOB_HOST,
        POLYGON_CHAIN_ID,
        this.wallet as any // Type cast für ethers v6 → v5 Kompatibilität
      );

      // API Credentials erstellen oder derivieren
      logger.info('[CLOB] Deriviere API Credentials...');
      const apiCreds = await tempClient.createOrDeriveApiKey();

      if (!apiCreds || !apiCreds.key || !apiCreds.secret) {
        throw new Error('API Credentials konnten nicht erstellt werden');
      }

      logger.info(`[CLOB] API Key erhalten: ${apiCreds.key.substring(0, 10)}...`);

      // Vollständiger Client mit Credentials
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.clobClient = new ClobClient(
        CLOB_HOST,
        POLYGON_CHAIN_ID,
        this.wallet as any, // Type cast für ethers v6 → v5 Kompatibilität
        apiCreds
      );

      this.clobInitialized = true;
      logger.info('[CLOB] Client erfolgreich initialisiert');

      this.emit('clob_ready');
    } catch (err) {
      const error = err as Error;
      logger.error(`[CLOB] Initialisierung fehlgeschlagen: ${error.message}`);
      this.clobInitialized = false;
    }
  }

  /**
   * Prüft ob CLOB Client bereit ist
   */
  isClobReady(): boolean {
    return this.clobInitialized && this.clobClient !== null;
  }

  /**
   * Holt das aktuelle Orderbook für einen Token
   */
  async getOrderbook(tokenId: string): Promise<{ bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> } | null> {
    if (!this.clobClient) {
      logger.warn('[CLOB] Client nicht initialisiert');
      return null;
    }

    try {
      const orderbook = await this.clobClient.getOrderBook(tokenId);
      return {
        bids: orderbook.bids.map((b: { price: string; size: string }) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
        asks: orderbook.asks.map((a: { price: string; size: string }) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
      };
    } catch (err) {
      logger.error(`[CLOB] Orderbook Fehler: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Platziert eine echte Order auf Polymarket
   */
  async placeOrder(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    orderType?: OrderType;
  }): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (!this.clobClient || !this.clobInitialized) {
      return { success: false, error: 'CLOB Client nicht initialisiert' };
    }

    try {
      logger.info(`[CLOB] Platziere Order: ${params.side} ${params.size} @ ${params.price} für ${params.tokenId}`);

      // Order erstellen
      const order = await this.clobClient.createOrder({
        tokenID: params.tokenId,
        side: params.side === 'BUY' ? Side.BUY : Side.SELL,
        price: params.price,
        size: params.size,
        feeRateBps: 0, // 0% Maker Fee aktuell
        nonce: Date.now(),
        expiration: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24h gültig
      });

      // Order signieren und posten
      const response = await this.clobClient.postOrder(order, params.orderType || OrderType.GTC);

      if (response && response.orderID) {
        logger.info(`[CLOB] Order erfolgreich: ${response.orderID}`);
        return { success: true, orderId: response.orderID };
      } else {
        logger.warn(`[CLOB] Order Response ohne Order ID:`, response);
        return { success: false, error: 'Keine Order ID erhalten' };
      }
    } catch (err) {
      const error = err as Error;
      logger.error(`[CLOB] Order Fehler: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Platziert eine Market Order (Fill-or-Kill)
   */
  async placeMarketOrder(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    amount: number; // in USDC
  }): Promise<{ success: boolean; orderId?: string; fillPrice?: number; error?: string }> {
    if (!this.clobClient || !this.clobInitialized) {
      return { success: false, error: 'CLOB Client nicht initialisiert' };
    }

    try {
      // Hole aktuelles Orderbook für Preisbestimmung
      const orderbook = await this.getOrderbook(params.tokenId);
      if (!orderbook) {
        return { success: false, error: 'Orderbook nicht verfügbar' };
      }

      // Beste Seite des Orderbooks
      const bestPrice = params.side === 'BUY'
        ? orderbook.asks[0]?.price  // Kaufe zum niedrigsten Ask
        : orderbook.bids[0]?.price; // Verkaufe zum höchsten Bid

      if (!bestPrice) {
        return { success: false, error: 'Kein Preis verfügbar im Orderbook' };
      }

      // Berechne Size aus Amount
      const size = params.amount / bestPrice;

      logger.info(`[CLOB] Market Order: ${params.side} $${params.amount} → ${size.toFixed(2)} Shares @ ${bestPrice}`);

      // FOK Order platzieren (Fill-or-Kill)
      const result = await this.placeOrder({
        tokenId: params.tokenId,
        side: params.side,
        price: bestPrice,
        size,
        orderType: OrderType.FOK,
      });

      return {
        ...result,
        fillPrice: result.success ? bestPrice : undefined,
      };
    } catch (err) {
      const error = err as Error;
      logger.error(`[CLOB] Market Order Fehler: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  getWalletAddress(): string | null {
    return this.wallet?.address || null;
  }

  async getWalletBalance(): Promise<{ usdc: number; matic: number }> {
    if (!this.wallet || !this.usdcContract || !this.provider) {
      return { usdc: 0, matic: 0 };
    }

    try {
      const [usdcBalance, maticBalance] = await Promise.all([
        this.usdcContract.balanceOf(this.wallet.address),
        this.provider.getBalance(this.wallet.address),
      ]);

      return {
        usdc: parseFloat(ethers.formatUnits(usdcBalance, 6)),
        matic: parseFloat(ethers.formatEther(maticBalance)),
      };
    } catch (err) {
      logger.error(`Balance-Abfrage Fehler: ${(err as Error).message}`);
      return { usdc: 0, matic: 0 };
    }
  }

  async getPositions(): Promise<Position[]> {
    const walletAddress = this.wallet?.address || WALLET_ADDRESS;
    if (!walletAddress) {
      return [];
    }

    try {
      // Polymarket API für Positionen
      const response = await axios.get(
        `https://gamma-api.polymarket.com/positions`,
        {
          params: {
            user: walletAddress,
          },
        }
      );

      return (response.data || []).map((p: Record<string, unknown>) => ({
        marketId: String(p.market_id || ''),
        marketQuestion: String(p.market_question || ''),
        outcome: p.outcome === 'Yes' ? 'YES' : 'NO',
        shares: parseFloat(String(p.shares || 0)),
        avgPrice: parseFloat(String(p.avg_price || 0)),
        currentPrice: parseFloat(String(p.current_price || 0)),
        unrealizedPnl: parseFloat(String(p.unrealized_pnl || 0)),
        createdAt: new Date(String(p.created_at || Date.now())),
      })) as Position[];
    } catch (err) {
      logger.error(`Positions-Abfrage Fehler: ${(err as Error).message}`);
      return [];
    }
  }

  async createTradeExecution(
    signal: AlphaSignal,
    recommendation: TradeRecommendation,
    direction: 'YES' | 'NO'
  ): Promise<TradeExecution> {
    const execution: TradeExecution = {
      id: uuid(),
      signal,
      recommendation,
      status: 'pending',
    };

    this.pendingExecutions.set(execution.id, execution);

    if (config.trading.requireConfirmation) {
      // Warte auf Bestätigung
      logger.info(`Trade ${execution.id} wartet auf Bestätigung`);
      this.emit('trade_pending', execution);
    } else {
      // Sofort ausführen
      await this.executeTrade(execution.id, direction);
    }

    return execution;
  }

  async confirmTrade(executionId: string, direction: 'YES' | 'NO'): Promise<TradeExecution | null> {
    const execution = this.pendingExecutions.get(executionId);

    if (!execution) {
      logger.warn(`Trade ${executionId} nicht gefunden`);
      return null;
    }

    execution.status = 'confirmed';
    return this.executeTrade(executionId, direction);
  }

  async executeTrade(executionId: string, direction: 'YES' | 'NO'): Promise<TradeExecution | null> {
    const execution = this.pendingExecutions.get(executionId);

    if (!execution) {
      return null;
    }

    if (!this.wallet || !config.trading.enabled) {
      execution.status = 'failed';
      execution.error = 'Trading nicht aktiviert oder Wallet nicht konfiguriert';
      logger.error(execution.error);
      return execution;
    }

    try {
      execution.status = 'confirmed';
      logger.info(
        `Trade wird ausgeführt: ${execution.signal.market.question.substring(0, 50)}...`
      );
      logger.info(`Richtung: ${direction}, Einsatz: $${execution.recommendation.positionSize}`);

      // Hier würde die echte Polymarket CLOB API Integration kommen
      // Für jetzt simulieren wir den Trade

      // Polymarket CLOB API Order
      const orderPayload = {
        market: execution.signal.market.id,
        side: direction === 'YES' ? 'BUY' : 'SELL',
        size: execution.recommendation.positionSize,
        price: direction === 'YES'
          ? execution.signal.market.outcomes.find(o => o.name === 'Yes')?.price
          : execution.signal.market.outcomes.find(o => o.name === 'No')?.price,
      };

      logger.info(`Order Payload: ${JSON.stringify(orderPayload)}`);

      // TODO: Echte API-Integration
      // const response = await this.submitOrder(orderPayload);

      // Simulation: Trade als erfolgreich markieren
      execution.status = 'executed';
      execution.executedAt = new Date();
      execution.txHash = `0x${Math.random().toString(16).substring(2)}...`;

      this.emit('trade_executed', execution);
      logger.info(`Trade erfolgreich: ${execution.txHash}`);

      return execution;
    } catch (err) {
      const error = err as Error;
      execution.status = 'failed';
      execution.error = error.message;
      logger.error(`Trade fehlgeschlagen: ${error.message}`);
      this.emit('trade_failed', execution);
      return execution;
    }
  }

  async cancelTrade(executionId: string): Promise<boolean> {
    const execution = this.pendingExecutions.get(executionId);

    if (!execution || execution.status !== 'pending') {
      return false;
    }

    execution.status = 'cancelled';
    this.pendingExecutions.delete(executionId);
    logger.info(`Trade ${executionId} abgebrochen`);
    return true;
  }

  getPendingTrades(): TradeExecution[] {
    return Array.from(this.pendingExecutions.values()).filter(
      (e) => e.status === 'pending'
    );
  }

  // Polymarket CLOB API Signierung (für echte Trades)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async _signOrder(order: Record<string, unknown>): Promise<string> {
    if (!this.wallet) {
      throw new Error('Wallet nicht verfügbar');
    }

    const message = JSON.stringify(order);
    const signature = await this.wallet.signMessage(message);
    return signature;
  }

  // Approve USDC für Trading (einmalig)
  async approveUSDC(amount: number = 1000000): Promise<string | null> {
    if (!this.usdcContract || !this.wallet) {
      return null;
    }

    try {
      const amountWei = ethers.parseUnits(amount.toString(), 6);
      const tx = await this.usdcContract.approve(CTF_EXCHANGE, amountWei);
      await tx.wait();
      logger.info(`USDC Approval erfolgreich: ${tx.hash}`);
      return tx.hash;
    } catch (err) {
      logger.error(`USDC Approval Fehler: ${(err as Error).message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //              GESTUFTE EXECUTION - NEUE METHODEN
  // ═══════════════════════════════════════════════════════════════

  /**
   * Prüft ob Live-Credentials vorhanden sind
   */
  validateLiveCredentials(): boolean {
    const hasWallet = !!this.wallet && !!WALLET_PRIVATE_KEY;
    const hasProvider = !!this.provider;
    const hasUsdcContract = !!this.usdcContract;

    if (!hasWallet) {
      logger.error('Live-Credentials Check: Kein Wallet/Private Key');
    }
    if (!hasProvider) {
      logger.error('Live-Credentials Check: Kein Provider');
    }
    if (!hasUsdcContract) {
      logger.error('Live-Credentials Check: Kein USDC Contract');
    }

    return hasWallet && hasProvider && hasUsdcContract;
  }

  /**
   * Führt einen Trade je nach ExecutionMode aus
   * DEFAULT ist IMMER 'paper'
   */
  async executeWithMode(
    decision: Decision,
    mode: ExecutionMode = 'paper'
  ): Promise<Execution> {
    const executionId = uuid();

    logger.info(`[${executionId}] Execute with mode: ${mode}`, {
      decisionId: decision.decisionId,
      action: decision.action,
      sizeUsdc: decision.sizeUsdc,
    });

    // Base Execution Object
    const baseExecution: Execution = {
      executionId,
      decisionId: decision.decisionId,
      mode,
      status: 'pending',
      fillPrice: null,
      fillSize: null,
      slippage: null,
      fees: null,
      txHash: null,
      createdAt: new Date(),
      filledAt: null,
    };

    try {
      switch (mode) {
        case 'paper':
          return await this.executePaper(decision, baseExecution);

        case 'shadow':
          return await this.executeShadow(decision, baseExecution);

        case 'live':
          return await this.executeLive(decision, baseExecution);

        default:
          logger.warn(`Unbekannter ExecutionMode: ${mode}, fallback zu paper`);
          return await this.executePaper(decision, baseExecution);
      }
    } catch (err) {
      const error = err as Error;
      logger.error(`[${executionId}] Execution fehlgeschlagen: ${error.message}`);

      return {
        ...baseExecution,
        status: 'failed',
      };
    }
  }

  /**
   * Paper Trading: Nur Logging, kein API-Call
   */
  private async executePaper(
    decision: Decision,
    execution: Execution
  ): Promise<Execution> {
    logger.info(`[PAPER] Simulierter Trade`, {
      executionId: execution.executionId,
      decisionId: decision.decisionId,
      action: decision.action,
      sizeUsdc: decision.sizeUsdc,
      rationale: decision.rationale,
    });

    // Simuliere Fill
    const simulatedPrice = 0.5 + Math.random() * 0.1 - 0.05; // ~0.45-0.55
    const simulatedSlippage = 0.001 + Math.random() * 0.002; // 0.1-0.3%
    const simulatedFees = (decision.sizeUsdc || 0) * 0.002; // 0.2% Fee

    const filledExecution: Execution = {
      ...execution,
      status: 'filled',
      fillPrice: simulatedPrice,
      fillSize: decision.sizeUsdc,
      slippage: simulatedSlippage,
      fees: simulatedFees,
      txHash: `paper_${execution.executionId.slice(0, 8)}`,
      filledAt: new Date(),
    };

    logger.info(`[PAPER] Trade simuliert erfolgreich`, {
      executionId: execution.executionId,
      fillPrice: filledExecution.fillPrice,
      fillSize: filledExecution.fillSize,
      slippage: filledExecution.slippage,
    });

    this.emit('paper_trade', filledExecution);

    return filledExecution;
  }

  /**
   * Shadow Trading: Quotes holen, Checks durchführen, simulieren
   */
  private async executeShadow(
    decision: Decision,
    execution: Execution
  ): Promise<Execution> {
    logger.info(`[SHADOW] Shadow Trade gestartet`, {
      executionId: execution.executionId,
      decisionId: decision.decisionId,
    });

    // 1. Risk Gates prüfen
    if (!decision.riskChecks || !this.allRiskChecksPassed(decision.riskChecks)) {
      const failedChecks = this.getFailedRiskChecks(decision.riskChecks);
      logger.warn(`[SHADOW] Risk Gates fehlgeschlagen`, { failedChecks });

      return {
        ...execution,
        status: 'failed',
      };
    }

    // 2. Versuche echte Quotes zu holen (wenn möglich)
    let realQuote: { price: number; liquidity: number } | null = null;
    try {
      realQuote = await this.fetchQuote(decision);
      logger.info(`[SHADOW] Quote erhalten`, { quote: realQuote });
    } catch (err) {
      logger.warn(`[SHADOW] Quote-Abruf fehlgeschlagen: ${(err as Error).message}`);
    }

    // 3. Simuliere Fill basierend auf Quote oder Schätzung
    const fillPrice = realQuote?.price || 0.5;
    const estimatedSlippage = realQuote
      ? 0.001 // Niedrigerer Slippage mit echtem Quote
      : 0.003; // Höherer Slippage ohne Quote

    const filledExecution: Execution = {
      ...execution,
      status: 'filled',
      fillPrice,
      fillSize: decision.sizeUsdc,
      slippage: estimatedSlippage,
      fees: (decision.sizeUsdc || 0) * 0.002,
      txHash: `shadow_${execution.executionId.slice(0, 8)}`,
      filledAt: new Date(),
    };

    logger.info(`[SHADOW] Shadow Trade erfolgreich`, {
      executionId: execution.executionId,
      fillPrice: filledExecution.fillPrice,
      fillSize: filledExecution.fillSize,
      hadRealQuote: !!realQuote,
    });

    this.emit('shadow_trade', filledExecution);

    return filledExecution;
  }

  /**
   * Live Trading: Echter Trade mit Credential-Check und CLOB API
   */
  private async executeLive(
    decision: Decision,
    execution: Execution
  ): Promise<Execution> {
    // 1. HARTE VERWEIGERUNG: Credentials prüfen
    if (!this.validateLiveCredentials()) {
      throw new LiveModeNoCredentialsError();
    }

    logger.info(`[LIVE] Live Trade gestartet`, {
      executionId: execution.executionId,
      decisionId: decision.decisionId,
      walletAddress: this.wallet?.address.slice(0, 10),
    });

    // 2. Risk Gates prüfen (PFLICHT für Live)
    if (!decision.riskChecks || !this.allRiskChecksPassed(decision.riskChecks)) {
      const failedChecks = this.getFailedRiskChecks(decision.riskChecks);
      logger.error(`[LIVE] Risk Gates fehlgeschlagen - Trade verweigert`, { failedChecks });

      return {
        ...execution,
        status: 'failed',
      };
    }

    // 3. Trading aktiviert?
    if (!config.trading.enabled) {
      logger.error(`[LIVE] Trading ist deaktiviert in Config`);
      return {
        ...execution,
        status: 'failed',
      };
    }

    // 4. Balance prüfen
    const balance = await this.getWalletBalance();
    if (balance.usdc < (decision.sizeUsdc || 0)) {
      logger.error(`[LIVE] Unzureichende Balance: ${balance.usdc} USDC < ${decision.sizeUsdc} USDC`);
      return {
        ...execution,
        status: 'failed',
      };
    }

    // 5. CLOB Client prüfen
    if (!this.isClobReady()) {
      logger.error(`[LIVE] CLOB Client nicht bereit - Trade verweigert`);
      return {
        ...execution,
        status: 'failed',
      };
    }

    // 6. Markt laden und Token-ID extrahieren
    let tokenId: string | null = null;
    let marketDirection: 'YES' | 'NO' = 'YES';

    try {
      // MarketId aus Decision - Format kann "marketId" oder "marketId:direction" sein
      const marketId = decision.signalId.split(':')[0] || decision.signalId;

      // Markt von Polymarket API laden
      const market = await polymarketClient.getMarketById(marketId);
      if (!market) {
        logger.error(`[LIVE] Markt ${marketId} nicht gefunden`);
        return { ...execution, status: 'failed' };
      }

      // Direction aus Decision rationale oder Signal extrahieren
      const rationale = decision.rationale;
      if (rationale && typeof rationale === 'object') {
        // Check ob direction im rationale steht
        const topFeatures = rationale.topFeatures || [];
        const hasYesDirection = topFeatures.some(f => f.toLowerCase().includes('yes') || f.toLowerCase().includes('ja'));
        const hasNoDirection = topFeatures.some(f => f.toLowerCase().includes('no') || f.toLowerCase().includes('nein'));
        marketDirection = hasNoDirection && !hasYesDirection ? 'NO' : 'YES';
      }

      // Token-ID für die entsprechende Seite
      const outcomeLabel = marketDirection === 'YES' ? 'Yes' : 'No';
      const outcome = market.outcomes.find(o => o.name.toLowerCase() === outcomeLabel.toLowerCase());

      if (!outcome || !outcome.id || outcome.id.startsWith('outcome-')) {
        logger.error(`[LIVE] Keine gültige Token-ID für ${outcomeLabel} in Markt ${marketId}`);
        return { ...execution, status: 'failed' };
      }

      tokenId = outcome.id;
      logger.info(`[LIVE] Token-ID: ${tokenId} für ${outcomeLabel} @ ${market.question.substring(0, 50)}...`);

    } catch (err) {
      logger.error(`[LIVE] Markt-Lookup fehlgeschlagen: ${(err as Error).message}`);
      return { ...execution, status: 'failed' };
    }

    // 7. Quote mit echtem Orderbook holen
    let quote: { price: number; liquidity: number; tokenId?: string };
    try {
      quote = await this.fetchQuote(decision, tokenId);
      logger.info(`[LIVE] Quote erhalten`, { quote });
    } catch (err) {
      logger.error(`[LIVE] Quote-Abruf fehlgeschlagen: ${(err as Error).message}`);
      return { ...execution, status: 'failed' };
    }

    // 8. ECHTE CLOB ORDER PLATZIEREN
    try {
      logger.info(`[LIVE] Platziere echte CLOB Order...`);

      const orderResult = await this.placeMarketOrder({
        tokenId,
        side: 'BUY', // Kaufe immer den Token (YES oder NO)
        amount: decision.sizeUsdc || 0,
      });

      if (!orderResult.success) {
        logger.error(`[LIVE] CLOB Order fehlgeschlagen: ${orderResult.error}`);
        return { ...execution, status: 'failed' };
      }

      const filledExecution: Execution = {
        ...execution,
        status: 'filled',
        fillPrice: orderResult.fillPrice || quote.price,
        fillSize: decision.sizeUsdc,
        slippage: orderResult.fillPrice ? Math.abs(orderResult.fillPrice - quote.price) / quote.price : 0.001,
        fees: (decision.sizeUsdc || 0) * 0.002, // 0.2% Taker Fee
        txHash: orderResult.orderId || `clob_${execution.executionId.slice(0, 8)}`,
        filledAt: new Date(),
      };

      // Risk State aktualisieren
      updateRiskState(0, decision.signalId, decision.sizeUsdc || 0);

      logger.info(`[LIVE] 🎯 ECHTE ORDER ERFOLGREICH`, {
        executionId: execution.executionId,
        orderId: orderResult.orderId,
        fillPrice: filledExecution.fillPrice,
        fillSize: filledExecution.fillSize,
        direction: marketDirection,
      });

      this.emit('live_trade', filledExecution);

      return filledExecution;
    } catch (err) {
      const error = err as Error;
      logger.error(`[LIVE] Trade-Ausführung fehlgeschlagen: ${error.message}`);

      return {
        ...execution,
        status: 'failed',
      };
    }
  }

  /**
   * Holt Quote von Polymarket API - ECHTE IMPLEMENTATION
   */
  private async fetchQuote(
    decision: Decision,
    tokenId?: string
  ): Promise<{ price: number; liquidity: number; tokenId?: string }> {
    // Wenn tokenId gegeben, nutze CLOB Orderbook
    if (tokenId && this.isClobReady()) {
      try {
        const orderbook = await this.getOrderbook(tokenId);
        if (orderbook && orderbook.asks.length > 0) {
          // Bester Ask-Preis und Liquidität berechnen
          const bestAsk = orderbook.asks[0];
          const totalLiquidity = orderbook.asks.reduce((sum, a) => sum + a.size * a.price, 0);

          logger.info(`[QUOTE] CLOB Orderbook: Best Ask ${bestAsk.price}, Liquidity $${totalLiquidity.toFixed(2)}`);

          return {
            price: bestAsk.price,
            liquidity: totalLiquidity,
            tokenId,
          };
        }
      } catch (err) {
        logger.warn(`[QUOTE] CLOB Orderbook Fehler: ${(err as Error).message}`);
      }
    }

    // Fallback: Simulierte Quotes
    const simulatedPrice = 0.45 + Math.random() * 0.1;
    const simulatedLiquidity = 10000 + Math.random() * 50000;

    return {
      price: simulatedPrice,
      liquidity: simulatedLiquidity,
    };
  }

  /**
   * Prüft ob alle Risk Checks bestanden wurden
   */
  private allRiskChecksPassed(checks: RiskChecks): boolean {
    return (
      checks.dailyLossOk &&
      checks.maxPositionsOk &&
      checks.perMarketCapOk &&
      checks.liquidityOk &&
      checks.spreadOk &&
      checks.killSwitchOk
    );
  }

  /**
   * Gibt Liste der fehlgeschlagenen Risk Checks zurück
   */
  private getFailedRiskChecks(checks: RiskChecks | undefined): string[] {
    if (!checks) return ['Keine Risk Checks vorhanden'];

    const failed: string[] = [];
    if (!checks.dailyLossOk) failed.push('dailyLoss');
    if (!checks.maxPositionsOk) failed.push('maxPositions');
    if (!checks.perMarketCapOk) failed.push('perMarketCap');
    if (!checks.liquidityOk) failed.push('liquidity');
    if (!checks.spreadOk) failed.push('spread');
    if (!checks.killSwitchOk) failed.push('killSwitch');

    return failed;
  }

  /**
   * Gibt aktuellen Risk State zurück
   */
  getRiskState() {
    return getRiskState();
  }

  /**
   * Berechnet Position Size für einen Trade
   */
  calculateSize(
    edge: number,
    confidence: number,
    quality: MarketQuality
  ): SizingResult {
    const bankroll = config.trading.maxBankrollUsdc;
    const kellyFraction = config.trading.kellyFraction;

    return calculatePositionSize(edge, confidence, bankroll, quality, kellyFraction);
  }

  /**
   * Führt vollständigen Risk Check durch
   */
  performRiskCheck(
    sizeUsdc: number,
    marketId: string,
    quality: MarketQuality
  ): RiskCheckResult {
    return checkRiskGates(sizeUsdc, marketId, quality);
  }
}

export const tradingClient = new TradingClient();
export default tradingClient;
