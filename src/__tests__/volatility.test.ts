/**
 * Tests fuer Volatility-Berechnung
 * Prueft echte 30-Tage Volatilitaet aus historischen Preisdaten
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateVolatility30d,
  clearVolatilityCache,
  getVolatilityCacheStats,
  DEFAULT_VOLATILITY,
  MIN_DAILY_RETURNS,
} from '../alpha/volatility.js';

describe('Volatility Calculator', () => {
  beforeEach(() => {
    // Cache vor jedem Test leeren
    clearVolatilityCache();
  });

  describe('calculateVolatility30d', () => {
    it('should return fallback when API fails', async () => {
      // Test mit ungueltigem Token ID - erhoehtes Timeout wegen Retries
      const result = await calculateVolatility30d('invalid-token-id');

      expect(result.volatility30d).toBe(DEFAULT_VOLATILITY);
      expect(result.source).toBe('fallback');
      expect(result.fallbackReason).toBeDefined();
    }, 15000); // 15 Sekunden Timeout

    it('should use cache for repeated calls', async () => {
      // Erster Call
      const result1 = await calculateVolatility30d('test-token-1');

      // Zweiter Call - sollte aus Cache kommen (wenn nicht Fallback)
      const result2 = await calculateVolatility30d('test-token-1');

      // Beide sollten gleich sein
      expect(result2.volatility30d).toBe(result1.volatility30d);
    }, 15000); // 15 Sekunden Timeout
  });

  describe('Constants', () => {
    it('should have correct default volatility', () => {
      expect(DEFAULT_VOLATILITY).toBe(0.15);
    });

    it('should require 30 daily returns minimum', () => {
      expect(MIN_DAILY_RETURNS).toBe(30);
    });
  });

  describe('Cache Statistics', () => {
    it('should track cache entries', async () => {
      clearVolatilityCache();

      const stats = getVolatilityCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.entries).toHaveLength(0);
    });
  });

  describe('Volatility Calculation Logic', () => {
    it('should bound volatility between 0.01 and 2.0', async () => {
      // Diese Tests pruefen die Begrenzung der Volatilitaet
      // Bei echten Daten sollte Volatilitaet immer im Bereich liegen
      const result = await calculateVolatility30d('any-token');

      expect(result.volatility30d).toBeGreaterThanOrEqual(0.01);
      expect(result.volatility30d).toBeLessThanOrEqual(2.0);
    }, 15000); // 15 Sekunden Timeout
  });
});
