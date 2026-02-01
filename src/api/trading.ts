import { ethers } from 'ethers';
import axios from 'axios';
import { config, WALLET_PRIVATE_KEY, WALLET_ADDRESS, POLYGON_RPC_URL } from '../utils/config.js';
import logger from '../utils/logger.js';
import { AlphaSignal, TradeRecommendation, TradeExecution, Position } from '../types/index.js';
import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';

// Polymarket Contract Addresses (Polygon)
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// ERC20 ABI (minimal)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export class TradingClient extends EventEmitter {
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private usdcContract: ethers.Contract | null = null;
  private pendingExecutions: Map<string, TradeExecution> = new Map();

  constructor() {
    super();

    if (WALLET_PRIVATE_KEY && WALLET_ADDRESS) {
      try {
        this.provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
        this.wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, this.provider);
        this.usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, this.wallet);
        logger.info('Trading Client initialisiert');
      } catch (err) {
        logger.error(`Trading Client Fehler: ${(err as Error).message}`);
      }
    } else {
      logger.warn('Trading Client: Wallet nicht konfiguriert');
    }
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
    if (!WALLET_ADDRESS) {
      return [];
    }

    try {
      // Polymarket API für Positionen
      const response = await axios.get(
        `https://gamma-api.polymarket.com/positions`,
        {
          params: {
            user: WALLET_ADDRESS,
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
}

export const tradingClient = new TradingClient();
export default tradingClient;
