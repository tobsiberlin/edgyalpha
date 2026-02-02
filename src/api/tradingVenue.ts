/**
 * TradingVenue Abstraktion
 *
 * Einheitliches Interface für Trading-Venues (Polymarket, etc.)
 * Ermöglicht saubere Trennung zwischen Venue-Logik und Business-Logik.
 */

// ═══════════════════════════════════════════════════════════════
//                    QUOTE & ORDERBOOK
// ═══════════════════════════════════════════════════════════════

export interface Quote {
  price: number;
  liquidity: number;
  spread: number;
  timestamp: Date;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: Date;
}

// ═══════════════════════════════════════════════════════════════
//                    ORDER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'FOK' | 'GTC';
export type OrderStatus = 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'failed' | 'expired';

export interface OrderParams {
  tokenId: string;
  side: OrderSide;
  size: number;      // Anzahl Shares
  price: number;     // Preis pro Share (0-1)
  type: OrderType;
  amountUsdc?: number; // Optional: USDC-Betrag statt size
}

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  filledSize?: number;
  avgPrice?: number;
  fees?: number;
  txHash?: string;
  errorMessage?: string;
}

export interface OpenOrder {
  orderId: string;
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  filledSize: number;
  status: OrderStatus;
  createdAt: Date;
}

// ═══════════════════════════════════════════════════════════════
//                    POSITIONS & BALANCE
// ═══════════════════════════════════════════════════════════════

export interface VenuePosition {
  tokenId: string;
  marketId?: string;
  marketQuestion?: string;
  side: 'YES' | 'NO';
  size: number;           // Anzahl Shares
  avgEntryPrice: number;
  currentPrice?: number;
  unrealizedPnl?: number;
}

export interface VenueBalance {
  usdc: number;
  matic: number;
  timestamp: Date;
}

// ═══════════════════════════════════════════════════════════════
//                    TRADING VENUE INTERFACE
// ═══════════════════════════════════════════════════════════════

export interface TradingVenue {
  /** Venue-Name (z.B. "PolymarketCLOB") */
  readonly name: string;

  // ─────────────────────────────────────────────────────────────
  // Pre-flight Checks
  // ─────────────────────────────────────────────────────────────

  /**
   * Prüft ob die Venue bereit ist für Trading.
   * @returns true wenn Client initialisiert und API erreichbar
   */
  isReady(): Promise<boolean>;

  /**
   * Validiert Credentials (Wallet, API Keys).
   * @returns true wenn alle Credentials vorhanden und gültig
   */
  validateCredentials(): Promise<boolean>;

  // ─────────────────────────────────────────────────────────────
  // Quote & Orderbook
  // ─────────────────────────────────────────────────────────────

  /**
   * Holt ein Quote für eine bestimmte Order.
   * @param tokenId Token-ID des Outcome-Tokens
   * @param side Kauf oder Verkauf
   * @param size Anzahl Shares
   */
  getQuote(tokenId: string, side: OrderSide, size: number): Promise<Quote>;

  /**
   * Holt das vollständige Orderbook.
   * @param tokenId Token-ID des Outcome-Tokens
   */
  getOrderbook(tokenId: string): Promise<Orderbook>;

  // ─────────────────────────────────────────────────────────────
  // Order Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Platziert eine Order.
   * @param params Order-Parameter
   * @param idempotencyKey Eindeutiger Key zur Vermeidung von Duplikaten
   */
  placeOrder(params: OrderParams, idempotencyKey: string): Promise<OrderResult>;

  /**
   * Holt den Status einer Order.
   * @param orderId Order-ID
   */
  getOrder(orderId: string): Promise<OrderResult>;

  /**
   * Storniert eine offene Order.
   * @param orderId Order-ID
   * @returns true wenn erfolgreich storniert
   */
  cancelOrder(orderId: string): Promise<boolean>;

  /**
   * Holt alle offenen Orders.
   */
  getOpenOrders(): Promise<OpenOrder[]>;

  // ─────────────────────────────────────────────────────────────
  // Positions & Balance
  // ─────────────────────────────────────────────────────────────

  /**
   * Holt alle aktuellen Positionen.
   */
  getPositions(): Promise<VenuePosition[]>;

  /**
   * Holt die Wallet-Balance.
   */
  getBalance(): Promise<VenueBalance>;
}

// ═══════════════════════════════════════════════════════════════
//                    ERRORS
// ═══════════════════════════════════════════════════════════════

export class VenueNotReadyError extends Error {
  constructor(venueName: string, reason?: string) {
    super(`Venue ${venueName} nicht bereit${reason ? `: ${reason}` : ''}`);
    this.name = 'VenueNotReadyError';
  }
}

export class VenueCredentialsError extends Error {
  constructor(venueName: string, details?: string) {
    super(`Venue ${venueName} Credentials ungültig${details ? `: ${details}` : ''}`);
    this.name = 'VenueCredentialsError';
  }
}

export class OrderExecutionError extends Error {
  constructor(
    public readonly orderId: string | undefined,
    message: string,
    public readonly errorCode?: string
  ) {
    super(`Order-Ausführung fehlgeschlagen: ${message}`);
    this.name = 'OrderExecutionError';
  }
}

export class InsufficientLiquidityError extends Error {
  constructor(
    public readonly tokenId: string,
    public readonly requestedSize: number,
    public readonly availableLiquidity: number
  ) {
    super(`Unzureichende Liquidität für ${tokenId}: ${requestedSize} angefordert, ${availableLiquidity} verfügbar`);
    this.name = 'InsufficientLiquidityError';
  }
}
