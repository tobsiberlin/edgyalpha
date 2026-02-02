#!/usr/bin/env tsx
/**
 * CLOB Order Test Script
 *
 * Testet den gesamten Order-Flow:
 * 1. CLOB Client Initialisierung
 * 2. Balance Check
 * 3. Orderbook Abruf
 * 4. Order Platzierung (optional mit --live)
 * 5. Order Status Polling
 * 6. Order Cancellation (wenn nicht gefüllt)
 *
 * Usage:
 *   npm run test:clob                      # Dry-Run (nur Checks)
 *   npm run test:clob -- --live            # Echte Order mit 0.01 USDC
 *   npm run test:clob -- --amount=1        # Echte Order mit 1 USDC
 *
 * Note: Standalone-Script wegen p-limit Bug in Node v24
 *       Nutzt ClobClient direkt statt tradingClient
 */

import 'dotenv/config';
import axios from 'axios';
import { ethers } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';

// ═══════════════════════════════════════════════════════════════
// KONFIGURATION
// ═══════════════════════════════════════════════════════════════

const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
];

// CLI Args
const args = process.argv.slice(2);
const isLiveMode = args.includes('--live');
const amountArg = args.find(a => a.startsWith('--amount='));
const testAmount = amountArg ? parseFloat(amountArg.split('=')[1]) : 0.01;

// ENV
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const TEST_TOKEN_ID = process.env.TEST_TOKEN_ID || '';

// ═══════════════════════════════════════════════════════════════
// ETHERS V6 → V5 COMPAT WRAPPER
// ═══════════════════════════════════════════════════════════════

/**
 * Wrapper für ethers v6 Wallet um v5-kompatible Methoden bereitzustellen
 * Der @polymarket/clob-client erwartet ethers v5 Signaturen
 */
function createV5CompatibleWallet(wallet: ethers.Wallet): ethers.Wallet {
  // Proxy der _signTypedData auf signTypedData mappt
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === '_signTypedData') {
        // ethers v5 nutzt _signTypedData, v6 nutzt signTypedData
        return target.signTypedData.bind(target);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface GammaMarket {
  id: string;
  question: string;
  volume24hr: number;
  clobTokenIds: string;
  outcomePrices: string;
  outcomes: string;
  active: boolean;
}

type OrderStatus = 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'expired' | 'failed';

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchActiveMarkets(): Promise<GammaMarket[]> {
  try {
    const response = await axios.get(`${GAMMA_API_URL}/markets`, {
      params: {
        active: true,
        closed: false,
        limit: 100,
      },
      timeout: 15000,
    });
    return response.data || [];
  } catch (err) {
    console.error(`Gamma API Fehler: ${(err as Error).message}`);
    return [];
  }
}

async function getWalletBalance(
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet
): Promise<{ usdc: number; matic: number }> {
  try {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const [usdcBalance, maticBalance] = await Promise.all([
      usdcContract.balanceOf(wallet.address),
      provider.getBalance(wallet.address),
    ]);
    return {
      usdc: parseFloat(ethers.formatUnits(usdcBalance, 6)),
      matic: parseFloat(ethers.formatEther(maticBalance)),
    };
  } catch (err) {
    console.error(`Balance-Abfrage Fehler: ${(err as Error).message}`);
    return { usdc: 0, matic: 0 };
  }
}

async function getOrderStatus(
  clobClient: ClobClient,
  orderId: string
): Promise<{ status: OrderStatus; fillPercent: number; sizeMatched: number; price: number } | null> {
  try {
    const order = await clobClient.getOrder(orderId);
    if (!order) return null;

    let status: OrderStatus = 'pending';
    const orderStatus = (order.status || '').toLowerCase();

    if (orderStatus === 'matched' || orderStatus === 'filled') {
      status = 'filled';
    } else if (orderStatus === 'open' || orderStatus === 'live') {
      const sizeMatched = parseFloat(order.size_matched || '0');
      const originalSize = parseFloat(order.original_size || '0');
      status = sizeMatched > 0 && sizeMatched < originalSize ? 'partial' : 'open';
    } else if (orderStatus === 'cancelled' || orderStatus === 'canceled') {
      status = 'cancelled';
    } else if (orderStatus === 'expired') {
      status = 'expired';
    }

    const sizeMatched = parseFloat(order.size_matched || '0');
    const originalSize = parseFloat(order.original_size || '0');

    return {
      status,
      fillPercent: originalSize > 0 ? (sizeMatched / originalSize) * 100 : 0,
      sizeMatched,
      price: parseFloat(order.price || '0'),
    };
  } catch {
    return null;
  }
}

async function waitForFill(
  clobClient: ClobClient,
  orderId: string,
  timeoutMs: number = 30000
): Promise<{ status: OrderStatus; fillPercent: number; sizeMatched: number; price: number; timedOut: boolean }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await getOrderStatus(clobClient, orderId);

    if (!status) {
      break;
    }

    if (status.status === 'filled' || status.status === 'cancelled' || status.status === 'expired') {
      return { ...status, timedOut: false };
    }

    if (status.status === 'partial') {
      console.log(`   Partial Fill: ${status.fillPercent.toFixed(1)}%`);
    }

    await sleep(1000);
  }

  return { status: 'failed', fillPercent: 0, sizeMatched: 0, price: 0, timedOut: true };
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('              CLOB ORDER TEST SCRIPT');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`Mode: ${isLiveMode ? '🔴 LIVE' : '🟢 DRY-RUN'}`);
  console.log(`Test Amount: $${testAmount} USDC\n`);

  // ─────────────────────────────────────────────────────────────────
  // 1. WALLET CHECK
  // ─────────────────────────────────────────────────────────────────
  console.log('🔑 [1/6] Wallet Check...');

  if (!WALLET_PRIVATE_KEY) {
    console.error('❌ WALLET_PRIVATE_KEY nicht gesetzt!');
    console.log('   Setze WALLET_PRIVATE_KEY in .env oder als Umgebungsvariable');
    process.exit(1);
  }

  let provider: ethers.JsonRpcProvider;
  let wallet: ethers.Wallet;

  try {
    provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
    console.log(`   Wallet: ${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`);
    console.log('✅ Wallet OK\n');
  } catch (err) {
    console.error(`❌ Wallet-Fehler: ${(err as Error).message}`);
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. CLOB CLIENT INITIALISIERUNG
  // ─────────────────────────────────────────────────────────────────
  console.log('📡 [2/6] CLOB Client Initialisierung...');

  let clobClient: ClobClient;

  try {
    // ethers v6 → v5 Kompatibilitäts-Wrapper
    const v5Wallet = createV5CompatibleWallet(wallet);

    // Temporärer Client für API Key Derivation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tempClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, v5Wallet as any);

    console.log('   Deriviere API Credentials...');
    const apiCreds = await tempClient.createOrDeriveApiKey();

    if (!apiCreds || !apiCreds.key || !apiCreds.secret) {
      throw new Error('API Credentials konnten nicht erstellt werden');
    }

    console.log(`   API Key: ${apiCreds.key.substring(0, 10)}...`);

    // Vollständiger Client mit Credentials
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clobClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, v5Wallet as any, apiCreds);

    console.log('✅ CLOB Client bereit\n');
  } catch (err) {
    console.error(`❌ CLOB Client Fehler: ${(err as Error).message}`);
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. BALANCE CHECK
  // ─────────────────────────────────────────────────────────────────
  console.log('💰 [3/6] Balance Check...');

  const balance = await getWalletBalance(provider, wallet);
  console.log(`   USDC: $${balance.usdc.toFixed(2)}`);
  console.log(`   MATIC: ${balance.matic.toFixed(4)}`);

  if (balance.usdc < testAmount && isLiveMode) {
    console.error(`❌ Unzureichende Balance: $${balance.usdc} < $${testAmount}`);
    process.exit(1);
  }

  if (balance.matic < 0.01) {
    console.warn('⚠️  Warnung: Niedrige MATIC Balance für Gas');
  }

  console.log('✅ Balance OK\n');

  // ─────────────────────────────────────────────────────────────────
  // 4. TEST-TOKEN ERMITTELN
  // ─────────────────────────────────────────────────────────────────
  console.log('🔍 [4/6] Test-Token ermitteln...');

  let tokenId = TEST_TOKEN_ID;

  if (!tokenId) {
    const markets = await fetchActiveMarkets();

    const liquidMarket = markets.find(m => {
      const volume = parseFloat(String(m.volume24hr || 0));
      const clobTokenIds = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
      const hasValidTokens = clobTokenIds.length >= 2 &&
        clobTokenIds[0] &&
        !String(clobTokenIds[0]).startsWith('outcome-');
      return m.active && volume > 10000 && hasValidTokens;
    });

    if (!liquidMarket) {
      console.error('❌ Kein geeigneter Test-Markt gefunden');
      console.log('   Versuche es mit TEST_TOKEN_ID in .env');
      process.exit(1);
    }

    const clobTokenIds = JSON.parse(liquidMarket.clobTokenIds);
    tokenId = clobTokenIds[0];
    const volume24h = parseFloat(String(liquidMarket.volume24hr || 0));

    console.log(`   Markt: ${liquidMarket.question.substring(0, 60)}...`);
    console.log(`   Token ID: ${tokenId.substring(0, 20)}...`);
    console.log(`   24h Volume: $${volume24h.toLocaleString()}`);
  } else {
    console.log(`   Token ID: ${tokenId.substring(0, 20)}... (aus ENV)`);
  }

  console.log('✅ Token gefunden\n');

  // ─────────────────────────────────────────────────────────────────
  // 5. ORDERBOOK CHECK
  // ─────────────────────────────────────────────────────────────────
  console.log('📊 [5/6] Orderbook Check...');

  let orderbook: { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> };

  try {
    orderbook = await clobClient.getOrderBook(tokenId);
  } catch (err) {
    console.error(`❌ Orderbook Fehler: ${(err as Error).message}`);
    process.exit(1);
  }

  const bestBid = orderbook.bids[0];
  const bestAsk = orderbook.asks[0];
  const bidPrice = bestBid ? parseFloat(bestBid.price) : 0;
  const askPrice = bestAsk ? parseFloat(bestAsk.price) : 0;
  const spread = bidPrice > 0 ? ((askPrice - bidPrice) / bidPrice) * 100 : 0;

  console.log(`   Best Bid: ${bidPrice.toFixed(4)} (${bestBid ? parseFloat(bestBid.size).toFixed(2) : 0} shares)`);
  console.log(`   Best Ask: ${askPrice.toFixed(4)} (${bestAsk ? parseFloat(bestAsk.size).toFixed(2) : 0} shares)`);
  console.log(`   Spread: ${spread.toFixed(2)}%`);
  console.log(`   Bids: ${orderbook.bids.length} levels`);
  console.log(`   Asks: ${orderbook.asks.length} levels`);

  if (!bestAsk) {
    console.error('❌ Keine Ask-Orders im Orderbook');
    process.exit(1);
  }

  console.log('✅ Orderbook OK\n');

  // ─────────────────────────────────────────────────────────────────
  // 6. ORDER PLATZIERUNG (nur bei --live)
  // ─────────────────────────────────────────────────────────────────
  console.log('📝 [6/6] Order Platzierung...');

  if (!isLiveMode) {
    console.log('   🟢 DRY-RUN: Order wird NICHT platziert');
    console.log(`   Würde kaufen: ${(testAmount / askPrice).toFixed(2)} shares @ ${askPrice.toFixed(4)}`);
    console.log('   Für echten Trade: npm run test:clob -- --live');
    console.log('✅ Dry-Run abgeschlossen\n');

    printSummary(false);
    return;
  }

  console.log('   🔴 LIVE MODE: Platziere echte Order...');
  console.log(`   Amount: $${testAmount} USDC`);
  console.log(`   Token: ${tokenId.substring(0, 20)}...`);
  console.log(`   Side: BUY`);

  // Order erstellen
  const size = testAmount / askPrice;
  const limitPrice = askPrice * 1.02; // 2% Slippage Toleranz

  console.log(`   Size: ${size.toFixed(4)} shares`);
  console.log(`   Limit Price: ${limitPrice.toFixed(4)}`);

  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      side: Side.BUY,
      price: limitPrice,
      size,
      feeRateBps: 0,
      nonce: Date.now(),
      expiration: Math.floor(Date.now() / 1000) + 60 * 60, // 1h gültig
    });

    console.log('   Order erstellt, sende an CLOB...');

    const response = await clobClient.postOrder(order, OrderType.GTC);

    if (!response || !response.orderID) {
      console.error('❌ Keine Order ID erhalten');
      printSummary(false);
      return;
    }

    console.log(`   Order ID: ${response.orderID}`);
    console.log('   Warte auf Fill (max 30s)...');

    // Auf Fill warten
    const fillResult = await waitForFill(clobClient, response.orderID, 30000);

    console.log(`\n   Order Result:`);
    console.log(`   - Status: ${fillResult.status}`);
    console.log(`   - Fill %: ${fillResult.fillPercent.toFixed(1)}%`);
    console.log(`   - Size Matched: ${fillResult.sizeMatched.toFixed(4)}`);
    console.log(`   - Price: ${fillResult.price.toFixed(4)}`);
    console.log(`   - Timed Out: ${fillResult.timedOut}`);

    // Bei Timeout: Order stornieren
    if (fillResult.timedOut && (fillResult.status === 'open' || fillResult.status === 'partial')) {
      console.log('\n   Storniere Order wegen Timeout...');
      try {
        await clobClient.cancelOrder({ orderID: response.orderID });
        console.log('   Order storniert');
      } catch (cancelErr) {
        console.error(`   Cancel Fehler: ${(cancelErr as Error).message}`);
      }
    }

    const success = fillResult.status === 'filled' ||
      (fillResult.status === 'partial' && fillResult.fillPercent > 50);

    printSummary(success, {
      orderId: response.orderID,
      status: fillResult.status,
      fillPrice: fillResult.price || askPrice,
      fillSize: fillResult.sizeMatched,
      slippage: fillResult.price > 0 ? Math.abs(fillResult.price - askPrice) / askPrice : 0,
    });

  } catch (err) {
    console.error(`❌ Order Fehler: ${(err as Error).message}`);
    printSummary(false);
  }
}

function printSummary(
  success: boolean,
  orderResult?: {
    orderId: string;
    status: string;
    fillPrice: number;
    fillSize: number;
    slippage: number;
  }
) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                         SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');

  if (!orderResult) {
    console.log('✅ DRY-RUN ERFOLGREICH');
    console.log('   - Wallet: OK');
    console.log('   - CLOB Client: OK');
    console.log('   - Balance: OK');
    console.log('   - Orderbook: OK');
    console.log('\n   Für echten Trade: npm run test:clob -- --live');
  } else if (success) {
    console.log('✅ LIVE ORDER ERFOLGREICH');
    console.log(`   - Order ID: ${orderResult.orderId}`);
    console.log(`   - Status: ${orderResult.status}`);
    console.log(`   - Fill Price: ${orderResult.fillPrice.toFixed(4)}`);
    console.log(`   - Fill Size: ${orderResult.fillSize.toFixed(4)}`);
    console.log(`   - Slippage: ${(orderResult.slippage * 100).toFixed(2)}%`);
  } else {
    console.log('❌ LIVE ORDER FEHLGESCHLAGEN');
    console.log(`   - Status: ${orderResult?.status || 'Unknown'}`);
    console.log('\n   Prüfe:');
    console.log('   - Wallet Balance ausreichend?');
    console.log('   - Token-ID gültig?');
    console.log('   - Markt noch aktiv?');
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
}

// Run
main().catch(err => {
  console.error(`Test-Script Fehler: ${err.message}`);
  console.error(err);
  process.exit(1);
});
