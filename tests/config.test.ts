/**
 * Tests fuer Config Secure Defaults
 * Prueft dass alle sicherheitskritischen Defaults korrekt gesetzt sind
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('Config Secure Defaults', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env und Module-Cache
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('TRADING_ENABLED defaults to false', async () => {
    delete process.env.TRADING_ENABLED;
    const { config } = await import('../src/utils/config.js');
    expect(config.trading.enabled).toBe(false);
  });

  it('EXECUTION_MODE defaults to paper', async () => {
    delete process.env.EXECUTION_MODE;
    const { config } = await import('../src/utils/config.js');
    expect(config.executionMode).toBe('paper');
  });

  it('REQUIRE_CONFIRMATION defaults to true', async () => {
    delete process.env.REQUIRE_CONFIRMATION;
    const { config } = await import('../src/utils/config.js');
    expect(config.trading.requireConfirmation).toBe(true);
  });

  it('germany.autoTrade defaults to false', async () => {
    delete process.env.GERMANY_AUTO_TRADE;
    const { config } = await import('../src/utils/config.js');
    expect(config.germany.autoTrade).toBe(false);
  });

  it('germany.autoTrade requires explicit true string', async () => {
    // '1' ist truthy aber nicht 'true'
    process.env.GERMANY_AUTO_TRADE = '1';
    const { config: config1 } = await import('../src/utils/config.js');
    expect(config1.germany.autoTrade).toBe(false);

    vi.resetModules();

    // 'yes' ist truthy aber nicht 'true'
    process.env.GERMANY_AUTO_TRADE = 'yes';
    const { config: config2 } = await import('../src/utils/config.js');
    expect(config2.germany.autoTrade).toBe(false);

    vi.resetModules();

    // Nur exakt 'true' aktiviert es
    process.env.GERMANY_AUTO_TRADE = 'true';
    const { config: config3 } = await import('../src/utils/config.js');
    expect(config3.germany.autoTrade).toBe(true);
  });

  it('AUTO_TRADE_ENABLED defaults to false', async () => {
    delete process.env.AUTO_TRADE_ENABLED;
    const { config } = await import('../src/utils/config.js');
    expect(config.autoTrade.enabled).toBe(false);
  });

  it('AUTO_TRADE_ENABLED requires explicit true string', async () => {
    process.env.AUTO_TRADE_ENABLED = '1';
    const { config: config1 } = await import('../src/utils/config.js');
    expect(config1.autoTrade.enabled).toBe(false);

    vi.resetModules();

    process.env.AUTO_TRADE_ENABLED = 'true';
    const { config: config2 } = await import('../src/utils/config.js');
    expect(config2.autoTrade.enabled).toBe(true);
  });

  it('TELEGRAM_ENABLED defaults to false', async () => {
    delete process.env.TELEGRAM_ENABLED;
    const { config } = await import('../src/utils/config.js');
    expect(config.telegram.enabled).toBe(false);
  });

  it('WEB_AUTH_ENABLED defaults to false (einfaches Setup)', async () => {
    delete process.env.WEB_AUTH_ENABLED;
    const { WEB_AUTH_ENABLED } = await import('../src/utils/config.js');
    expect(WEB_AUTH_ENABLED).toBe(false);
  });

  it('BACKTEST_MODE defaults to false', async () => {
    delete process.env.BACKTEST_MODE;
    const { config } = await import('../src/utils/config.js');
    expect(config.backtestMode).toBe(false);
  });
});

describe('Config Sensible Limits', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('MAX_BET_USDC has a safe default of 10', async () => {
    delete process.env.MAX_BET_USDC;
    const { config } = await import('../src/utils/config.js');
    expect(config.trading.maxBetUsdc).toBe(10);
  });

  it('KELLY_FRACTION defaults to conservative 0.25', async () => {
    delete process.env.KELLY_FRACTION;
    const { config } = await import('../src/utils/config.js');
    expect(config.trading.kellyFraction).toBe(0.25);
  });

  it('MIN_ALPHA_FOR_TRADE defaults to 0.15 (15%)', async () => {
    delete process.env.MIN_ALPHA_FOR_TRADE;
    const { config } = await import('../src/utils/config.js');
    expect(config.trading.minAlphaForTrade).toBe(0.15);
  });

  it('AUTO_TRADE_MIN_EDGE defaults to 0.15 (15%)', async () => {
    delete process.env.AUTO_TRADE_MIN_EDGE;
    const { config } = await import('../src/utils/config.js');
    expect(config.autoTrade.minEdge).toBe(0.15);
  });

  it('AUTO_TRADE_MAX_SIZE defaults to 50 USDC', async () => {
    delete process.env.AUTO_TRADE_MAX_SIZE;
    const { config } = await import('../src/utils/config.js');
    expect(config.autoTrade.maxSize).toBe(50);
  });
});
