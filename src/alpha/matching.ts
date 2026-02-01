/**
 * News -> Market Matching Module
 * Stage 1: Keyword-basiertes Fuzzy-Matching ohne LLM
 */

import { Market } from '../types/index.js';
import { SourceEvent } from './types.js';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface MatchResult {
  marketId: string;
  confidence: number; // 0-1
  matchedKeywords: string[];
  matchedEntities: string[];
  reasoning: string;
}

// ═══════════════════════════════════════════════════════════════
// STOPWORDS (Deutsch + Englisch)
// ═══════════════════════════════════════════════════════════════

const STOPWORDS_DE = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'oder', 'aber', 'denn', 'weil', 'wenn', 'als', 'dass', 'ob', 'wie', 'wo', 'wer', 'was',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'sie', 'sich', 'mich', 'dich', 'uns', 'euch',
  'mein', 'dein', 'sein', 'ihr', 'unser', 'euer', 'meine', 'deine', 'seine', 'ihre', 'unsere', 'eure',
  'ist', 'sind', 'war', 'waren', 'wird', 'werden', 'wurde', 'wurden', 'hat', 'haben', 'hatte', 'hatten',
  'kann', 'konnte', 'muss', 'musste', 'soll', 'sollte', 'will', 'wollte', 'darf', 'durfte',
  'nicht', 'kein', 'keine', 'keiner', 'keines', 'keinem', 'keinen',
  'auch', 'noch', 'schon', 'nur', 'immer', 'wieder', 'sehr', 'mehr', 'viel', 'wenig',
  'hier', 'dort', 'da', 'jetzt', 'nun', 'dann', 'so', 'also', 'doch', 'jedoch',
  'nach', 'vor', 'mit', 'bei', 'von', 'aus', 'zu', 'bis', 'durch', 'um', 'gegen', 'ohne', 'unter', 'über',
  'auf', 'an', 'in', 'im', 'am', 'zum', 'zur', 'vom', 'beim',
  'alle', 'alles', 'jeder', 'jede', 'jedes', 'dieser', 'diese', 'dieses', 'welcher', 'welche', 'welches',
]);

const STOPWORDS_EN = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'who', 'what', 'how', 'why',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'doing', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
  'not', 'no', 'nor', 'neither', 'either', 'both', 'all', 'each', 'every', 'some', 'any', 'many', 'much',
  'this', 'that', 'these', 'those', 'which', 'whose', 'whom',
  'here', 'there', 'now', 'then', 'so', 'also', 'too', 'very', 'just', 'only', 'even', 'still', 'already',
  'of', 'to', 'for', 'with', 'by', 'from', 'at', 'in', 'on', 'about', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'between', 'under', 'over', 'again', 'further', 'once',
  'than', 'as', 'because', 'while', 'although', 'though', 'since', 'unless', 'until',
]);

const ALL_STOPWORDS = new Set([...STOPWORDS_DE, ...STOPWORDS_EN]);

// ═══════════════════════════════════════════════════════════════
// BEKANNTE ENTITIES (Politiker, Organisationen, etc.)
// ═══════════════════════════════════════════════════════════════

const KNOWN_ENTITIES = new Set([
  // Deutsche Politik
  'Merz', 'Scholz', 'Habeck', 'Lindner', 'Baerbock', 'Weidel', 'Chrupalla', 'Wagenknecht',
  'CDU', 'CSU', 'SPD', 'Gruene', 'FDP', 'AfD', 'Linke', 'BSW',
  'Bundestag', 'Bundesrat', 'Bundesregierung', 'Kanzler', 'Kanzleramt',

  // US Politik
  'Trump', 'Biden', 'Harris', 'Vance', 'DeSantis', 'Haley', 'Ramaswamy', 'Newsom', 'Musk', 'RFK',
  'Democrats', 'Republicans', 'GOP', 'Congress', 'Senate', 'House',

  // International
  'Putin', 'Zelenskyy', 'Zelensky', 'Macron', 'Starmer', 'Sunak', 'Meloni', 'Orban',
  'NATO', 'EU', 'UN', 'WHO', 'IMF', 'ECB', 'Fed', 'OPEC',
  'Ukraine', 'Russia', 'China', 'Iran', 'Israel', 'Gaza', 'Taiwan',

  // Tech & Crypto
  'Bitcoin', 'Ethereum', 'BTC', 'ETH', 'SEC', 'Gensler',
  'Apple', 'Google', 'Microsoft', 'Amazon', 'Meta', 'Tesla', 'Nvidia', 'OpenAI',

  // Sport
  'FIFA', 'UEFA', 'DFB', 'Bundesliga', 'Champions', 'Bayern', 'Dortmund', 'Madrid', 'Barcelona',
  'SuperBowl', 'NFL', 'NBA', 'MLB',
]);

// ═══════════════════════════════════════════════════════════════
// LEVENSHTEIN DISTANCE
// ═══════════════════════════════════════════════════════════════

/**
 * Berechnet die Levenshtein-Distanz zwischen zwei Strings
 * Optimal fuer Typo-Toleranz im Matching
 */
export function levenshteinDistance(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return 0;
  if (aLower.length === 0) return bLower.length;
  if (bLower.length === 0) return aLower.length;

  // Matrix initialisieren
  const matrix: number[][] = [];

  for (let i = 0; i <= bLower.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= aLower.length; j++) {
    matrix[0][j] = j;
  }

  // Matrix fuellen
  for (let i = 1; i <= bLower.length; i++) {
    for (let j = 1; j <= aLower.length; j++) {
      const cost = bLower.charAt(i - 1) === aLower.charAt(j - 1) ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // Deletion
        matrix[i][j - 1] + 1,      // Insertion
        matrix[i - 1][j - 1] + cost // Substitution
      );
    }
  }

  return matrix[bLower.length][aLower.length];
}

/**
 * Normalisierte Aehnlichkeit (0-1) basierend auf Levenshtein
 */
function normalizedSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(a, b);
  return 1 - (distance / maxLen);
}

// ═══════════════════════════════════════════════════════════════
// KEYWORD EXTRACTION
// ═══════════════════════════════════════════════════════════════

/**
 * Extrahiert relevante Keywords aus einem Text
 * Entfernt Stopwords und kurze Woerter
 */
export function extractKeywords(text: string): string[] {
  if (!text) return [];

  // Text bereinigen und tokenisieren
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\säöüß-]/g, ' ') // Sonderzeichen entfernen (deutsche Umlaute behalten)
    .split(/\s+/)
    .filter(token => token.length > 2); // Min. 3 Zeichen

  // Stopwords entfernen
  const keywords = tokens.filter(token => !ALL_STOPWORDS.has(token));

  // Duplikate entfernen und sortieren nach Laenge (laengere = spezifischer)
  const unique = [...new Set(keywords)];
  unique.sort((a, b) => b.length - a.length);

  return unique;
}

// ═══════════════════════════════════════════════════════════════
// ENTITY EXTRACTION
// ═══════════════════════════════════════════════════════════════

/**
 * Extrahiert Named Entities aus Text
 * Kombiniert: Bekannte Namen + Grossgeschriebene Woerter
 */
export function extractEntities(text: string): string[] {
  if (!text) return [];

  const entities: Set<string> = new Set();

  // 1. Bekannte Entities finden
  for (const entity of KNOWN_ENTITIES) {
    // Case-insensitive Suche aber Original-Form behalten
    const regex = new RegExp(`\\b${entity}\\b`, 'gi');
    if (regex.test(text)) {
      entities.add(entity);
    }
  }

  // 2. Grossgeschriebene Woerter extrahieren (potentielle Entities)
  const capitalizedPattern = /\b[A-ZÄÖÜ][a-zäöüß]{2,}\b/g;
  const matches = text.match(capitalizedPattern) || [];

  for (const match of matches) {
    // Nicht am Satzanfang (heuristisch: pruefen ob Wort nicht nach Punkt/Fragezeichen steht)
    const index = text.indexOf(match);
    const charBefore = index > 1 ? text.charAt(index - 2) : '';

    // Skip wenn nach Satzende
    if (['.', '!', '?', ':'].includes(charBefore)) continue;

    // Skip Stopwords
    if (ALL_STOPWORDS.has(match.toLowerCase())) continue;

    entities.add(match);
  }

  // 3. Akronyme (2-5 Grossbuchstaben)
  const acronymPattern = /\b[A-Z]{2,5}\b/g;
  const acronyms = text.match(acronymPattern) || [];

  for (const acronym of acronyms) {
    if (!ALL_STOPWORDS.has(acronym.toLowerCase())) {
      entities.add(acronym);
    }
  }

  return [...entities];
}

// ═══════════════════════════════════════════════════════════════
// FUZZY MATCHING
// ═══════════════════════════════════════════════════════════════

/**
 * Hauptfunktion: Matched ein SourceEvent gegen mehrere Markets
 * Gibt alle Matches mit Confidence > 0 zurueck
 */
export function fuzzyMatch(
  event: SourceEvent,
  markets: Market[]
): MatchResult[] {
  const results: MatchResult[] = [];

  // Text aus Event extrahieren
  const eventText = `${event.title} ${event.content || ''}`;
  const eventKeywords = extractKeywords(eventText);
  const eventEntities = extractEntities(eventText);

  // Auch vorhandene Keywords aus Event nutzen
  const allEventKeywords = [...new Set([...eventKeywords, ...event.keywords])];

  logger.debug(`Matching Event: "${event.title.substring(0, 50)}..." (${allEventKeywords.length} keywords, ${eventEntities.length} entities)`);

  for (const market of markets) {
    // Market-Text extrahieren
    const marketText = market.question;
    const marketKeywords = extractKeywords(marketText);
    const marketEntities = extractEntities(marketText);

    // Keyword-Matches finden
    const matchedKeywords: string[] = [];
    for (const eventKw of allEventKeywords) {
      for (const marketKw of marketKeywords) {
        // Exakter Match
        if (eventKw.toLowerCase() === marketKw.toLowerCase()) {
          matchedKeywords.push(eventKw);
          break;
        }

        // Fuzzy Match (Levenshtein) fuer laengere Woerter
        if (eventKw.length >= 5 && marketKw.length >= 5) {
          const similarity = normalizedSimilarity(eventKw, marketKw);
          if (similarity >= 0.8) {
            matchedKeywords.push(`${eventKw}~${marketKw}`);
            break;
          }
        }

        // Substring Match (eines enthaelt das andere)
        if (eventKw.length >= 4 && marketKw.length >= 4) {
          if (eventKw.toLowerCase().includes(marketKw.toLowerCase()) ||
              marketKw.toLowerCase().includes(eventKw.toLowerCase())) {
            matchedKeywords.push(`${eventKw}*`);
            break;
          }
        }
      }
    }

    // Entity-Matches finden
    const matchedEntities: string[] = [];
    for (const eventEntity of eventEntities) {
      for (const marketEntity of marketEntities) {
        // Exakter Match (case-insensitive)
        if (eventEntity.toLowerCase() === marketEntity.toLowerCase()) {
          matchedEntities.push(eventEntity);
          break;
        }

        // Fuzzy Match fuer Entities
        const similarity = normalizedSimilarity(eventEntity, marketEntity);
        if (similarity >= 0.85) {
          matchedEntities.push(`${eventEntity}~${marketEntity}`);
          break;
        }
      }
    }

    // Confidence berechnen
    const confidence = calculateMatchConfidence(
      matchedKeywords,
      matchedEntities,
      allEventKeywords.length,
      eventEntities.length,
      marketKeywords.length,
      marketEntities.length
    );

    // Nur Matches mit Confidence > 0 zurueckgeben
    if (confidence > 0) {
      const reasoning = buildMatchReasoning(matchedKeywords, matchedEntities, confidence);

      results.push({
        marketId: market.id,
        confidence,
        matchedKeywords: [...new Set(matchedKeywords)],
        matchedEntities: [...new Set(matchedEntities)],
        reasoning,
      });

      logger.debug(
        `Match found: "${market.question.substring(0, 40)}..." -> ` +
        `confidence=${confidence.toFixed(2)}, ` +
        `keywords=[${matchedKeywords.slice(0, 3).join(', ')}], ` +
        `entities=[${matchedEntities.join(', ')}]`
      );
    }
  }

  // Nach Confidence sortieren (beste zuerst)
  results.sort((a, b) => b.confidence - a.confidence);

  return results;
}

// ═══════════════════════════════════════════════════════════════
// CONFIDENCE CALCULATION
// ═══════════════════════════════════════════════════════════════

function calculateMatchConfidence(
  matchedKeywords: string[],
  matchedEntities: string[],
  totalEventKeywords: number,
  totalEventEntities: number,
  totalMarketKeywords: number,
  totalMarketEntities: number
): number {
  // Gewichtungen
  const ENTITY_WEIGHT = 0.6;  // Entities sind wichtiger
  const KEYWORD_WEIGHT = 0.4;

  // Entity Score
  let entityScore = 0;
  if (totalEventEntities > 0 && totalMarketEntities > 0) {
    // Jaccard-aehnlich: Matches / Max moegliche Matches
    const maxEntityMatches = Math.min(totalEventEntities, totalMarketEntities);
    entityScore = matchedEntities.length / maxEntityMatches;
  } else if (matchedEntities.length > 0) {
    // Mindestens ein Match auch ohne explizite Entity-Listen
    entityScore = 0.5;
  }

  // Keyword Score
  let keywordScore = 0;
  if (totalEventKeywords > 0 && totalMarketKeywords > 0) {
    const maxKeywordMatches = Math.min(totalEventKeywords, totalMarketKeywords);
    keywordScore = matchedKeywords.length / maxKeywordMatches;

    // Cap at 1.0 (kann durch Fuzzy-Matches > 1 werden)
    keywordScore = Math.min(keywordScore, 1.0);
  }

  // Kombinierter Score
  let confidence = (entityScore * ENTITY_WEIGHT) + (keywordScore * KEYWORD_WEIGHT);

  // Bonus fuer starke Matches
  if (matchedEntities.length >= 2) {
    confidence += 0.1; // Bonus fuer multiple Entity-Matches
  }

  if (matchedKeywords.length >= 3) {
    confidence += 0.05; // Kleiner Bonus fuer viele Keyword-Matches
  }

  // Minimum-Threshold: Mindestens ein Entity-Match ODER 2+ Keyword-Matches
  if (matchedEntities.length === 0 && matchedKeywords.length < 2) {
    confidence = 0;
  }

  // Cap at 1.0
  return Math.min(confidence, 1.0);
}

// ═══════════════════════════════════════════════════════════════
// REASONING BUILDER
// ═══════════════════════════════════════════════════════════════

function buildMatchReasoning(
  matchedKeywords: string[],
  matchedEntities: string[],
  confidence: number
): string {
  const parts: string[] = [];

  // Confidence Level
  if (confidence >= 0.7) {
    parts.push('Starker Match');
  } else if (confidence >= 0.4) {
    parts.push('Moderater Match');
  } else {
    parts.push('Schwacher Match');
  }

  // Entities
  if (matchedEntities.length > 0) {
    parts.push(`Entities: ${matchedEntities.slice(0, 5).join(', ')}`);
  }

  // Keywords
  if (matchedKeywords.length > 0) {
    const displayKeywords = matchedKeywords
      .slice(0, 5)
      .map(kw => kw.replace('~', '=').replace('*', ''));
    parts.push(`Keywords: ${displayKeywords.join(', ')}`);
  }

  return parts.join(' | ');
}

// ═══════════════════════════════════════════════════════════════
// BATCH MATCHING
// ═══════════════════════════════════════════════════════════════

/**
 * Matched mehrere Events gegen mehrere Markets
 * Gruppiert Ergebnisse nach Market
 */
export function batchMatch(
  events: SourceEvent[],
  markets: Market[]
): Map<string, { event: SourceEvent; match: MatchResult }[]> {
  const marketMatches = new Map<string, { event: SourceEvent; match: MatchResult }[]>();

  for (const event of events) {
    const matches = fuzzyMatch(event, markets);

    for (const match of matches) {
      if (!marketMatches.has(match.marketId)) {
        marketMatches.set(match.marketId, []);
      }
      marketMatches.get(match.marketId)!.push({ event, match });
    }
  }

  return marketMatches;
}

export default {
  fuzzyMatch,
  batchMatch,
  levenshteinDistance,
  extractKeywords,
  extractEntities,
};
