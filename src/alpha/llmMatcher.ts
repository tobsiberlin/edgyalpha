/**
 * LLM-basiertes News → Market Matching
 *
 * Nutzt Claude Haiku für schnelles, präzises Matching:
 * 1. Ist die News relevant für den Markt?
 * 2. Wenn ja: YES oder NO kaufen?
 * 3. Confidence Level
 *
 * Kosten-Tracking:
 * - Claude 3.5 Haiku: $0.80/1M Input, $4.00/1M Output
 * - Tägliches Budget konfigurierbar (default: €2.50)
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import type { Market } from '../types/index.js';
import type { SourceEvent } from './types.js';

// ═══════════════════════════════════════════════════════════════
// PRICING (Claude 3.5 Haiku - Stand 2026)
// ═══════════════════════════════════════════════════════════════

const HAIKU_PRICING = {
  inputPer1M: 0.80,   // $0.80 pro 1M Input Tokens
  outputPer1M: 4.00,  // $4.00 pro 1M Output Tokens
};

// EUR/USD Kurs (grob)
const EUR_USD_RATE = 1.08;

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface LLMMatchResult {
  marketId: string;
  marketQuestion: string;
  isRelevant: boolean;
  direction: 'yes' | 'no' | null;
  confidence: number;        // 0-100
  reasoning: string;
  impactStrength: 'none' | 'weak' | 'medium' | 'strong';
  shouldAlert: boolean;
}

export interface LLMMatcherStats {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  relevantMatches: number;
  strongMatches: number;
  avgLatencyMs: number;
  lastCallAt: Date | null;
}

export interface LLMCostStats {
  // Heute
  todayInputTokens: number;
  todayOutputTokens: number;
  todayCostUsd: number;
  todayCostEur: number;
  todayCalls: number;
  // Gesamt (seit Start)
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalCostEur: number;
  // Budget
  dailyBudgetEur: number;
  budgetUsedPercent: number;
  budgetExhausted: boolean;
  // Zeitstempel
  dayStartedAt: Date;
  lastCallAt: Date | null;
}

// ═══════════════════════════════════════════════════════════════
// LLM MATCHER CLASS
// ═══════════════════════════════════════════════════════════════

export class LLMMatcher {
  private client: Anthropic | null = null;
  private enabled: boolean = false;
  private stats: LLMMatcherStats = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    relevantMatches: 0,
    strongMatches: 0,
    avgLatencyMs: 0,
    lastCallAt: null,
  };
  private latencies: number[] = [];

  // Kosten-Tracking
  private todayInputTokens: number = 0;
  private todayOutputTokens: number = 0;
  private todayCalls: number = 0;
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;
  private dayStartedAt: Date = new Date();
  private budgetExhausted: boolean = false;

  constructor() {
    this.initialize();
    this.scheduleDailyReset();
  }

  private initialize(): void {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      logger.warn('[LLM_MATCHER] ANTHROPIC_API_KEY nicht gesetzt - LLM Matching deaktiviert');
      this.enabled = false;
      return;
    }

    try {
      this.client = new Anthropic({ apiKey });
      this.enabled = true;
      const budget = config.llm?.dailyBudgetEur ?? 2.50;
      logger.info(`[LLM_MATCHER] Initialisiert mit Claude Haiku (Budget: €${budget.toFixed(2)}/Tag)`);
    } catch (error) {
      logger.error('[LLM_MATCHER] Initialisierung fehlgeschlagen:', error);
      this.enabled = false;
    }
  }

  private scheduleDailyReset(): void {
    // Reset um Mitternacht UTC
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      this.resetDailyStats();
      // Dann jeden Tag um Mitternacht
      setInterval(() => this.resetDailyStats(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);

    logger.info(`[LLM_MATCHER] Daily Reset geplant in ${Math.round(msUntilMidnight / 60000)} Minuten`);
  }

  private resetDailyStats(): void {
    const costStats = this.getCostStats();
    logger.info(
      `[LLM_MATCHER] === TÄGLICHER RESET === ` +
      `Calls: ${this.todayCalls}, Kosten: €${costStats.todayCostEur.toFixed(4)}`
    );

    this.todayInputTokens = 0;
    this.todayOutputTokens = 0;
    this.todayCalls = 0;
    this.dayStartedAt = new Date();
    this.budgetExhausted = false;
  }

  private calculateCostUsd(inputTokens: number, outputTokens: number): number {
    return (inputTokens / 1_000_000) * HAIKU_PRICING.inputPer1M +
           (outputTokens / 1_000_000) * HAIKU_PRICING.outputPer1M;
  }

  private checkBudget(): boolean {
    const budget = config.llm?.dailyBudgetEur ?? 2.50;
    const todayCostEur = this.calculateCostUsd(this.todayInputTokens, this.todayOutputTokens) / EUR_USD_RATE;

    if (todayCostEur >= budget) {
      if (!this.budgetExhausted) {
        this.budgetExhausted = true;
        logger.warn(`[LLM_MATCHER] 🚨 BUDGET ERSCHÖPFT! €${todayCostEur.toFixed(2)} / €${budget.toFixed(2)}`);
      }
      return false;
    }
    return true;
  }

  isEnabled(): boolean {
    return this.enabled && !this.budgetExhausted;
  }

  isBudgetExhausted(): boolean {
    return this.budgetExhausted;
  }

  getStats(): LLMMatcherStats {
    return { ...this.stats };
  }

  getCostStats(): LLMCostStats {
    const budget = config.llm?.dailyBudgetEur ?? 2.50;
    const todayCostUsd = this.calculateCostUsd(this.todayInputTokens, this.todayOutputTokens);
    const todayCostEur = todayCostUsd / EUR_USD_RATE;
    const totalCostUsd = this.calculateCostUsd(this.totalInputTokens, this.totalOutputTokens);
    const totalCostEur = totalCostUsd / EUR_USD_RATE;

    return {
      todayInputTokens: this.todayInputTokens,
      todayOutputTokens: this.todayOutputTokens,
      todayCostUsd,
      todayCostEur,
      todayCalls: this.todayCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostUsd,
      totalCostEur,
      dailyBudgetEur: budget,
      budgetUsedPercent: (todayCostEur / budget) * 100,
      budgetExhausted: this.budgetExhausted,
      dayStartedAt: this.dayStartedAt,
      lastCallAt: this.stats.lastCallAt,
    };
  }

  /**
   * Prüft ob eine News für einen Markt relevant ist
   * Schnell und günstig mit Haiku
   */
  async matchNewsToMarket(
    news: { title: string; content?: string; source: string },
    market: { id: string; question: string; currentPrice?: number }
  ): Promise<LLMMatchResult> {
    if (!this.enabled || !this.client) {
      return this.createNullResult(market);
    }

    const startTime = Date.now();
    this.stats.totalCalls++;

    // Budget-Check vor API-Call
    if (!this.checkBudget()) {
      return this.createNullResult(market);
    }

    try {
      const prompt = this.buildMatchPrompt(news, market);

      const response = await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      });

      // Token-Tracking
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      this.todayInputTokens += inputTokens;
      this.todayOutputTokens += outputTokens;
      this.totalInputTokens += inputTokens;
      this.totalOutputTokens += outputTokens;
      this.todayCalls++;

      const latency = Date.now() - startTime;
      this.recordLatency(latency);
      this.stats.successfulCalls++;
      this.stats.lastCallAt = new Date();

      // Log Kosten periodisch
      if (this.todayCalls % 10 === 0) {
        const costStats = this.getCostStats();
        logger.info(
          `[LLM_MATCHER] Kosten heute: €${costStats.todayCostEur.toFixed(4)} ` +
          `(${costStats.budgetUsedPercent.toFixed(1)}% Budget, ${this.todayCalls} Calls)`
        );
      }

      // Parse response
      const text = response.content[0].type === 'text'
        ? response.content[0].text
        : '';

      const result = this.parseResponse(text, market);

      if (result.isRelevant) {
        this.stats.relevantMatches++;
        if (result.impactStrength === 'strong') {
          this.stats.strongMatches++;
        }
      }

      logger.debug(
        `[LLM_MATCHER] ${news.title.substring(0, 40)}... → ` +
        `${market.question.substring(0, 30)}... = ` +
        `${result.isRelevant ? `${result.direction?.toUpperCase()} (${result.confidence}%)` : 'NICHT RELEVANT'} ` +
        `[${latency}ms]`
      );

      return result;
    } catch (error) {
      this.stats.failedCalls++;
      logger.error('[LLM_MATCHER] API Fehler:', error);
      return this.createNullResult(market);
    }
  }

  /**
   * Batch-Matching: Eine News gegen mehrere Märkte
   * Filtert erst mit Keywords, dann LLM für Top-Kandidaten
   */
  async matchNewsToMarkets(
    news: { title: string; content?: string; source: string },
    markets: Market[],
    options: { maxLLMCalls?: number; minKeywordMatch?: number } = {}
  ): Promise<LLMMatchResult[]> {
    const { maxLLMCalls = 5, minKeywordMatch = 1 } = options;
    const results: LLMMatchResult[] = [];

    if (!this.enabled) {
      logger.debug('[LLM_MATCHER] Deaktiviert - überspringe Batch-Matching');
      return results;
    }

    // 1. Schneller Keyword-Filter (kostenlos)
    const newsText = `${news.title} ${news.content || ''}`.toLowerCase();
    const candidates: Array<{ market: Market; keywordScore: number }> = [];

    for (const market of markets) {
      const marketText = market.question.toLowerCase();
      const keywordScore = this.quickKeywordScore(newsText, marketText);

      if (keywordScore >= minKeywordMatch) {
        candidates.push({ market, keywordScore });
      }
    }

    // Sortiere nach Keyword-Score
    candidates.sort((a, b) => b.keywordScore - a.keywordScore);

    // 2. LLM-Check für Top-Kandidaten
    const toCheck = candidates.slice(0, maxLLMCalls);

    logger.debug(
      `[LLM_MATCHER] ${candidates.length} Kandidaten gefunden, ` +
      `prüfe Top ${toCheck.length} mit LLM`
    );

    for (const { market } of toCheck) {
      const result = await this.matchNewsToMarket(
        news,
        {
          id: market.id,
          question: market.question,
          currentPrice: market.outcomes?.[0]?.price,
        }
      );

      if (result.isRelevant) {
        results.push(result);
      }
    }

    return results;
  }

  private buildMatchPrompt(
    news: { title: string; content?: string; source: string },
    market: { id: string; question: string; currentPrice?: number }
  ): string {
    const priceInfo = market.currentPrice
      ? `\nAktueller YES-Preis: ${(market.currentPrice * 100).toFixed(0)}%`
      : '';

    return `Du bist ein Trading-Analyst. Prüfe ob diese News den Prediction Market DIREKT beeinflusst.

NEWS:
Titel: ${news.title}
${news.content ? `Inhalt: ${news.content.substring(0, 500)}` : ''}
Quelle: ${news.source}

MARKT:
Frage: ${market.question}${priceInfo}

AUFGABE:
1. Beeinflusst diese News die Wahrscheinlichkeit des Markt-Outcomes DIREKT?
   (Nicht nur thematisch ähnlich, sondern KAUSALE Verbindung!)
2. Wenn ja: Sollte der YES-Preis steigen oder fallen?
3. Wie stark ist der erwartete Einfluss?

ANTWORTE EXAKT IN DIESEM FORMAT:
RELEVANT: [JA/NEIN]
RICHTUNG: [YES/NO/KEINE]
CONFIDENCE: [0-100]
STÄRKE: [KEINE/SCHWACH/MITTEL/STARK]
GRUND: [1 Satz warum]

Beispiel für NICHT RELEVANT:
- News über Bayern-Transfer → Markt "Wird Freiburg Meister?" = NEIN (kein direkter Einfluss)
- News über Merz-Aussage → Markt "Wird Trump gewinnen?" = NEIN (andere Wahl)

Beispiel für RELEVANT:
- News "Freiburg-Trainer entlassen" → Markt "Wird Freiburg Meister?" = JA, NO kaufen (negativ für Team)
- News "Trump kündigt Kandidatur an" → Markt "Wird Trump antreten?" = JA, YES kaufen`;
  }

  private parseResponse(text: string, market: { id: string; question: string }): LLMMatchResult {
    const lines = text.split('\n');

    let isRelevant = false;
    let direction: 'yes' | 'no' | null = null;
    let confidence = 0;
    let impactStrength: LLMMatchResult['impactStrength'] = 'none';
    let reasoning = '';

    for (const line of lines) {
      const upper = line.toUpperCase();

      if (upper.startsWith('RELEVANT:')) {
        isRelevant = upper.includes('JA');
      } else if (upper.startsWith('RICHTUNG:')) {
        if (upper.includes('YES')) direction = 'yes';
        else if (upper.includes('NO')) direction = 'no';
      } else if (upper.startsWith('CONFIDENCE:')) {
        const match = line.match(/(\d+)/);
        if (match) confidence = parseInt(match[1], 10);
      } else if (upper.startsWith('STÄRKE:') || upper.startsWith('STAERKE:')) {
        if (upper.includes('STARK')) impactStrength = 'strong';
        else if (upper.includes('MITTEL')) impactStrength = 'medium';
        else if (upper.includes('SCHWACH')) impactStrength = 'weak';
      } else if (upper.startsWith('GRUND:')) {
        reasoning = line.substring(6).trim();
      }
    }

    // Bestimme ob Alert ausgelöst werden soll
    const shouldAlert = isRelevant &&
                       direction !== null &&
                       confidence >= 60 &&
                       (impactStrength === 'medium' || impactStrength === 'strong');

    return {
      marketId: market.id,
      marketQuestion: market.question,
      isRelevant,
      direction,
      confidence,
      reasoning,
      impactStrength,
      shouldAlert,
    };
  }

  private createNullResult(market: { id: string; question: string }): LLMMatchResult {
    return {
      marketId: market.id,
      marketQuestion: market.question,
      isRelevant: false,
      direction: null,
      confidence: 0,
      reasoning: 'LLM Matcher nicht verfügbar',
      impactStrength: 'none',
      shouldAlert: false,
    };
  }

  private quickKeywordScore(newsText: string, marketText: string): number {
    // Schneller Keyword-Check ohne LLM
    const newsWords = new Set(newsText.split(/\s+/).filter(w => w.length > 3));
    const marketWords = marketText.split(/\s+/).filter(w => w.length > 3);

    let matches = 0;
    for (const word of marketWords) {
      if (newsWords.has(word)) matches++;
    }

    return matches;
  }

  private recordLatency(latency: number): void {
    this.latencies.push(latency);
    if (this.latencies.length > 100) {
      this.latencies.shift();
    }
    this.stats.avgLatencyMs =
      this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════

export const llmMatcher = new LLMMatcher();
