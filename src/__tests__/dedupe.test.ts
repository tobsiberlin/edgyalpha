/**
 * Tests fuer News Dedupe Funktionen
 * Prueft Hash-Generierung fuer konsistente Deduplizierung
 */

import { describe, it, expect } from 'vitest';
import { computeNewsHash } from '../germany/rss.js';

describe('News Dedupe', () => {
  describe('computeNewsHash', () => {
    it('should generate consistent hash for same input', () => {
      const item = {
        source: 'Tagesschau',
        url: 'https://tagesschau.de/article/123',
        title: 'Bundestagswahl: CDU fuehrt in Umfragen',
      };

      const hash1 = computeNewsHash(item);
      const hash2 = computeNewsHash(item);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex = 64 chars
    });

    it('should generate different hash for different input', () => {
      const item1 = {
        source: 'Tagesschau',
        url: 'https://tagesschau.de/article/123',
        title: 'Bundestagswahl: CDU fuehrt in Umfragen',
      };

      const item2 = {
        source: 'Tagesschau',
        url: 'https://tagesschau.de/article/124',
        title: 'Bundestagswahl: SPD holt auf',
      };

      const hash1 = computeNewsHash(item1);
      const hash2 = computeNewsHash(item2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle items without URL', () => {
      const item = {
        source: 'Spiegel',
        title: 'Test Artikel ohne URL',
      };

      const hash = computeNewsHash(item);

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });

    it('should generate different hash when source differs', () => {
      const item1 = {
        source: 'Tagesschau',
        url: 'https://example.com/article',
        title: 'Same Title',
      };

      const item2 = {
        source: 'Spiegel',
        url: 'https://example.com/article',
        title: 'Same Title',
      };

      const hash1 = computeNewsHash(item1);
      const hash2 = computeNewsHash(item2);

      expect(hash1).not.toBe(hash2);
    });

    it('should generate different hash when title differs', () => {
      const item1 = {
        source: 'Tagesschau',
        url: 'https://tagesschau.de/article/123',
        title: 'Title A',
      };

      const item2 = {
        source: 'Tagesschau',
        url: 'https://tagesschau.de/article/123',
        title: 'Title B',
      };

      const hash1 = computeNewsHash(item1);
      const hash2 = computeNewsHash(item2);

      expect(hash1).not.toBe(hash2);
    });

    it('should be deterministic across multiple calls', () => {
      const item = {
        source: 'Reuters',
        url: 'https://reuters.com/world/123',
        title: 'Global Markets Update',
      };

      const hashes = Array.from({ length: 10 }, () => computeNewsHash(item));

      // Alle Hashes sollten identisch sein
      expect(new Set(hashes).size).toBe(1);
    });
  });
});
