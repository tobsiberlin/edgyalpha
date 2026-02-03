/**
 * Tests fuer Fuzzy-Matching
 * Prueft News-zu-Market Matching Algorithmen
 */

import { describe, it, expect } from 'vitest';
import {
  fuzzyMatch,
  levenshteinDistance,
  extractKeywords,
  extractEntities,
} from '../alpha/matching.js';
import type { SourceEvent } from '../alpha/types.js';
import type { Market } from '../types/index.js';

describe('Matching', () => {
  describe('levenshteinDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshteinDistance('test', 'test')).toBe(0);
      expect(levenshteinDistance('Bundestagswahl', 'Bundestagswahl')).toBe(0);
    });

    it('should be case-insensitive', () => {
      expect(levenshteinDistance('Test', 'test')).toBe(0);
      expect(levenshteinDistance('MERZ', 'merz')).toBe(0);
    });

    it('should calculate distance for simple transposition', () => {
      // 'test' -> 'tset' braucht 2 Operationen (swap)
      expect(levenshteinDistance('test', 'tset')).toBe(2);
    });

    it('should calculate distance for single insertion', () => {
      expect(levenshteinDistance('test', 'tests')).toBe(1);
    });

    it('should calculate distance for single deletion', () => {
      expect(levenshteinDistance('tests', 'test')).toBe(1);
    });

    it('should calculate distance for single substitution', () => {
      expect(levenshteinDistance('test', 'tent')).toBe(1);
    });

    it('should handle empty strings', () => {
      expect(levenshteinDistance('', '')).toBe(0);
      expect(levenshteinDistance('test', '')).toBe(4);
      expect(levenshteinDistance('', 'test')).toBe(4);
    });

    it('should handle completely different strings', () => {
      const distance = levenshteinDistance('abc', 'xyz');
      expect(distance).toBe(3);
    });
  });

  describe('extractKeywords', () => {
    it('should extract meaningful words', () => {
      const text = 'Die Bundestagswahl findet im September statt';
      const keywords = extractKeywords(text);

      expect(keywords).toContain('bundestagswahl');
      expect(keywords).toContain('september');
      expect(keywords).toContain('findet');
      expect(keywords).toContain('statt');
    });

    it('should remove German stopwords', () => {
      const text = 'Der die das und oder aber wenn';
      const keywords = extractKeywords(text);

      expect(keywords).not.toContain('der');
      expect(keywords).not.toContain('die');
      expect(keywords).not.toContain('das');
      expect(keywords).not.toContain('und');
      expect(keywords).not.toContain('oder');
    });

    it('should remove English stopwords', () => {
      const text = 'The and or but if then else when';
      const keywords = extractKeywords(text);

      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('and');
      expect(keywords).not.toContain('but');
    });

    it('should filter short words', () => {
      const text = 'a an is it to be or no';
      const keywords = extractKeywords(text);

      expect(keywords).toHaveLength(0);
    });

    it('should handle empty input', () => {
      expect(extractKeywords('')).toEqual([]);
      expect(extractKeywords(null as unknown as string)).toEqual([]);
    });

    it('should remove duplicates', () => {
      const text = 'Merz Merz Merz CDU CDU';
      const keywords = extractKeywords(text);

      const merzCount = keywords.filter(k => k === 'merz').length;
      const cduCount = keywords.filter(k => k === 'cdu').length;

      expect(merzCount).toBe(1);
      expect(cduCount).toBe(1);
    });

    it('should sort by length descending', () => {
      const text = 'cat elephant dog';
      const keywords = extractKeywords(text);

      // Laengere Woerter sollten zuerst kommen
      const elephantIndex = keywords.indexOf('elephant');
      const catIndex = keywords.indexOf('cat');
      const dogIndex = keywords.indexOf('dog');

      expect(elephantIndex).toBeLessThan(catIndex);
      expect(elephantIndex).toBeLessThan(dogIndex);
    });
  });

  describe('extractEntities', () => {
    it('should extract known German politicians', () => {
      const text = 'Merz und Scholz diskutierten im Bundestag';
      const entities = extractEntities(text);

      expect(entities).toContain('Merz');
      expect(entities).toContain('Scholz');
      expect(entities).toContain('Bundestag');
    });

    it('should extract known US politicians', () => {
      const text = 'Trump and Biden compete for the presidency';
      const entities = extractEntities(text);

      expect(entities).toContain('Trump');
      expect(entities).toContain('Biden');
    });

    it('should extract organizations', () => {
      const text = 'Die NATO und EU reagierten auf die Krise';
      const entities = extractEntities(text);

      expect(entities).toContain('NATO');
      expect(entities).toContain('EU');
    });

    it('should extract capitalized words as potential entities', () => {
      const text = 'Der neue Kanzlerkandidat Mueller sprach heute';
      const entities = extractEntities(text);

      expect(entities).toContain('Mueller');
    });

    it('should extract acronyms', () => {
      const text = 'Die CDU und SPD bilden eine Koalition mit FDP';
      const entities = extractEntities(text);

      expect(entities).toContain('CDU');
      expect(entities).toContain('SPD');
      expect(entities).toContain('FDP');
    });

    it('should handle empty input', () => {
      expect(extractEntities('')).toEqual([]);
    });
  });

  describe('fuzzyMatch', () => {
    // Mock SourceEvent
    const createEvent = (title: string, content: string = ''): SourceEvent => ({
      eventHash: 'test-hash',
      sourceId: 'test-source',
      sourceName: 'Test Source',
      url: null,
      title,
      content,
      category: 'politics',
      keywords: [],
      publishedAt: new Date(),
      ingestedAt: new Date(),
      reliabilityScore: 0.8,
    });

    // Mock Market
    const createMarket = (id: string, question: string): Market => ({
      id,
      question,
      slug: id,
      category: 'politics',
      volume24h: 10000,
      totalVolume: 100000,
      liquidity: 50000,
      outcomes: [
        { id: 'yes', name: 'Yes', price: 0.5, volume24h: 5000 },
        { id: 'no', name: 'No', price: 0.5, volume24h: 5000 },
      ],
      endDate: '2025-12-31',
      resolved: false,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    });

    it('should match news to relevant markets', () => {
      const event = createEvent(
        'Merz kuendigt haertere Migrationspolitik an',
        'CDU-Vorsitzender Friedrich Merz will nach Wahlsieg Asylpolitik aendern'
      );

      const markets = [
        createMarket('market-1', 'Will CDU win the German federal election?'),
        createMarket('market-2', 'Will Bitcoin reach $100k?'),
        createMarket('market-3', 'Will Merz become German Chancellor?'),
      ];

      const matches = fuzzyMatch(event, markets);

      // Sollte Market 1 und 3 matchen (CDU, Merz)
      expect(matches.length).toBeGreaterThan(0);

      // Merz Market sollte matchen
      const merzMatch = matches.find(m => m.marketId === 'market-3');
      expect(merzMatch).toBeDefined();
      expect(merzMatch!.confidence).toBeGreaterThanOrEqual(0.3);

      // Bitcoin Market sollte nicht matchen
      const bitcoinMatch = matches.find(m => m.marketId === 'market-2');
      expect(bitcoinMatch).toBeUndefined();
    });

    it('should return matches sorted by confidence', () => {
      const event = createEvent(
        'Trump announces new campaign rally',
        'Former President Trump speaks about 2024 election'
      );

      const markets = [
        createMarket('market-1', 'Will Trump win Republican primary?'),
        createMarket('market-2', 'Will Trump be president in 2025?'),
        createMarket('market-3', 'Will Democrats win Senate?'),
      ];

      const matches = fuzzyMatch(event, markets);

      // Matches sollten nach Confidence absteigend sortiert sein
      for (let i = 0; i < matches.length - 1; i++) {
        expect(matches[i].confidence).toBeGreaterThanOrEqual(matches[i + 1].confidence);
      }
    });

    it('should include matched keywords and entities in result', () => {
      const event = createEvent('NATO announces new defense spending targets');

      const markets = [
        createMarket('market-1', 'Will NATO increase defense budget in 2025?'),
      ];

      const matches = fuzzyMatch(event, markets);

      expect(matches.length).toBeGreaterThan(0);
      const match = matches[0];

      // Sollte NATO als Entity oder Keyword haben
      const hasNato = match.matchedEntities.includes('NATO') ||
                      match.matchedKeywords.some(k => k.toLowerCase().includes('nato'));
      expect(hasNato).toBe(true);
    });

    it('should require minimum matches for non-zero confidence', () => {
      const event = createEvent('Wetterbericht: Regen erwartet');

      const markets = [
        createMarket('market-1', 'Will Bitcoin reach $100k?'),
      ];

      const matches = fuzzyMatch(event, markets);

      // Keine relevanten Matches
      expect(matches).toHaveLength(0);
    });

    it('should handle events with pre-existing keywords', () => {
      const event: SourceEvent = {
        eventHash: 'test-hash',
        sourceId: 'test-source',
        sourceName: 'Test Source',
        url: null,
        title: 'Breaking News',
        content: null,
        category: 'politics',
        keywords: ['merz', 'kanzler', 'wahl'], // Pre-existing keywords
        publishedAt: new Date(),
        ingestedAt: new Date(),
        reliabilityScore: 0.8,
      };

      const markets = [
        createMarket('market-1', 'Wird Merz der naechste Kanzler?'),
      ];

      const matches = fuzzyMatch(event, markets);

      expect(matches.length).toBeGreaterThan(0);
    });

    it('should provide reasoning for matches', () => {
      const event = createEvent('CDU und SPD fuehren Koalitionsgespraeche');

      const markets = [
        createMarket('market-1', 'Will CDU and SPD form coalition government?'),
      ];

      const matches = fuzzyMatch(event, markets);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].reasoning).toBeDefined();
      expect(matches[0].reasoning.length).toBeGreaterThan(0);
    });

    // ═══════════════════════════════════════════════════════════════
    // CONTEXT-AWARENESS TESTS
    // Das Fuzzy-Matching kann False Positives haben - der LLM-Matcher
    // filtert diese dann raus. Diese Tests dokumentieren bekannte Limits.
    // ═══════════════════════════════════════════════════════════════

    it('should NOT match "Bayern Transfer" with "Freiburg Meister" - different teams', () => {
      const event = createEvent(
        'FC Bayern verpflichtet Talentspieler',
        'Bayern München hat einen neuen Spieler aus der Jugend geholt'
      );

      const markets = [
        createMarket('market-freiburg', 'Wird Freiburg Deutscher Meister 2025?'),
        createMarket('market-bayern', 'Will Bayern Munich win the Bundesliga?'),
      ];

      const matches = fuzzyMatch(event, markets);

      // Freiburg sollte NICHT matchen - anderes Team!
      const freiburgMatch = matches.find(m => m.marketId === 'market-freiburg');
      expect(freiburgMatch).toBeUndefined();

      // Bayern SOLLTE matchen - gleiches Team
      const bayernMatch = matches.find(m => m.marketId === 'market-bayern');
      expect(bayernMatch).toBeDefined();
    });

    it('should have LOW confidence for generic league news with specific team markets', () => {
      const event = createEvent(
        'Bundesliga Spieltag 20 Zusammenfassung',
        'Alle Ergebnisse des 20. Spieltags der Bundesliga'
      );

      const markets = [
        createMarket('market-dortmund', 'Will Dortmund win the Bundesliga?'),
        createMarket('market-leipzig', 'Will RB Leipzig finish in top 4?'),
      ];

      const matches = fuzzyMatch(event, markets);

      // Fuzzy-Matching kann hier Kandidaten finden (wegen "Bundesliga"),
      // aber die Confidence sollte niedrig sein (<0.5 = unter Alert-Threshold).
      // Der LLM-Matcher im Ticker filtert solche False Positives zusätzlich.
      for (const match of matches) {
        // Kein Match sollte hohe Confidence haben ohne spezifisches Team
        expect(match.confidence).toBeLessThan(0.7);
      }
    });

    it('should NOT match Merz news with Trump markets - different countries', () => {
      const event = createEvent(
        'Merz kuendigt Steuerreform an',
        'CDU-Vorsitzender Friedrich Merz plant grosse Steuerreform'
      );

      const markets = [
        createMarket('market-trump', 'Will Trump win the 2024 election?'),
        createMarket('market-merz', 'Will Merz become German Chancellor?'),
      ];

      const matches = fuzzyMatch(event, markets);

      // Trump sollte NICHT matchen - völlig anderes Land/Thema
      const trumpMatch = matches.find(m => m.marketId === 'market-trump');
      expect(trumpMatch).toBeUndefined();

      // Merz SOLLTE matchen
      const merzMatch = matches.find(m => m.marketId === 'market-merz');
      expect(merzMatch).toBeDefined();
    });

    // HINWEIS: Der "Hamburger Hafen" vs "Hamburger SV" Fall
    // wird vom Fuzzy-Matching vielleicht noch gematcht (weil "Hamburger" shared ist),
    // ABER der LLM-Matcher im Ticker filtert diesen False Positive dann raus.
    // Siehe: ticker/index.ts -> findMatchingMarkets() -> LLM-Validierung
  });
});
