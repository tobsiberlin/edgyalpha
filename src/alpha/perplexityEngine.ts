/**
 * PERPLEXITY LLM ALPHA ENGINE
 *
 * Browser Automation für Perplexity Pro Deep Research
 * Semantische News-Analyse für Trading-Signal-Generierung
 */

import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import type { Market } from '../types/index.js';

// ============================================================================
// INTERFACES
// ============================================================================

export interface LLMSignal {
  id: string;
  timestamp: Date;
  marketId: string;
  marketSlug: string;
  marketQuestion: string;

  // LLM-Analyse
  direction: 'yes' | 'no';
  confidence: number;           // 0-100
  estimatedProbability: number; // 0-1

  // Kontext
  newsContext: string[];        // Gefundene relevante News
  reasoning: string;            // LLM-Begründung
  sources: string[];            // Quellen

  // Markt-Daten
  currentPrice: number;
  priceGap: number;             // Differenz geschätzt vs. Markt

  // Qualität
  signalStrength: 'weak' | 'medium' | 'strong' | 'very_strong';
  newsRecency: 'breaking' | 'recent' | 'older';
}

export interface PerplexityConfig {
  enabled: boolean;
  headless: boolean;
  sessionCookies?: string;      // Optional: Gespeicherte Session
  maxConcurrent: number;
  queryInterval: number;        // ms zwischen Queries
  minConfidence: number;        // Min. Konfidenz für Signal
  priorityKeywords: string[];   // Priorisierte Suchbegriffe
}

export interface EngineStats {
  queriesTotal: number;
  queriesSuccessful: number;
  queriesFailed: number;
  signalsGenerated: number;
  strongSignals: number;
  lastQueryTime: Date | null;
  averageQueryDuration: number;
  browserActive: boolean;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: PerplexityConfig = {
  enabled: true,
  headless: true,
  maxConcurrent: 1,
  queryInterval: 30000,         // 30s zwischen Queries
  minConfidence: 60,
  priorityKeywords: [
    'Deutschland', 'Bundesregierung', 'Bundeskanzler',
    'Trump', 'Ukraine', 'NATO', 'EU',
    'Bundestagswahl', 'Koalition', 'Merz', 'Scholz'
  ]
};

// ============================================================================
// PERPLEXITY ENGINE CLASS
// ============================================================================

export class PerplexityEngine extends EventEmitter {
  private config: PerplexityConfig;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isReady: boolean = false;
  private isQuerying: boolean = false;

  private stats: EngineStats = {
    queriesTotal: 0,
    queriesSuccessful: 0,
    queriesFailed: 0,
    signalsGenerated: 0,
    strongSignals: 0,
    lastQueryTime: null,
    averageQueryDuration: 0,
    browserActive: false
  };

  private queryDurations: number[] = [];
  private signals: LLMSignal[] = [];

  constructor(config: Partial<PerplexityConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // BROWSER LIFECYCLE
  // --------------------------------------------------------------------------

  async initialize(): Promise<boolean> {
    if (!this.config.enabled) {
      logger.info('[PERPLEXITY] Engine disabled');
      return false;
    }

    try {
      logger.info('[PERPLEXITY] Starting browser...');

      this.browser = await chromium.launch({
        headless: this.config.headless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox'
        ]
      });

      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'de-DE'
      });

      this.page = await this.context.newPage();

      // Anti-Detection (runs in browser context)
      await this.page.addInitScript(() => {
        // @ts-expect-error - runs in browser context, not Node.js
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      // Navigate to Perplexity
      await this.page.goto('https://www.perplexity.ai/', {
        waitUntil: 'networkidle',
        timeout: 60000
      });

      // Check login status
      await this.page.waitForTimeout(3000);
      const isLoggedIn = await this.checkLoginStatus();

      if (!isLoggedIn) {
        logger.warn('[PERPLEXITY] Not logged in - manual login required');
        this.emit('login_required');

        // Wait for manual login in non-headless mode
        if (!this.config.headless) {
          logger.info('[PERPLEXITY] Waiting for manual login...');
          await this.waitForLogin(120000);
        }
      }

      this.isReady = true;
      this.stats.browserActive = true;
      logger.info('[PERPLEXITY] Engine ready');
      this.emit('ready');

      return true;
    } catch (error) {
      logger.error('[PERPLEXITY] Initialization failed:', error);
      this.emit('error', error);
      return false;
    }
  }

  async shutdown(): Promise<void> {
    logger.info('[PERPLEXITY] Shutting down...');

    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.isReady = false;
    this.stats.browserActive = false;
    this.emit('shutdown');
  }

  private async checkLoginStatus(): Promise<boolean> {
    if (!this.page) return false;

    try {
      // Check for Pro indicators
      const proIndicator = await this.page.$('text=Pro');
      const userMenu = await this.page.$('[data-testid="user-menu"]');

      return !!(proIndicator || userMenu);
    } catch {
      return false;
    }
  }

  private async waitForLogin(timeout: number): Promise<boolean> {
    if (!this.page) return false;

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const isLoggedIn = await this.checkLoginStatus();
      if (isLoggedIn) {
        logger.info('[PERPLEXITY] Login detected');
        return true;
      }
      await this.page.waitForTimeout(2000);
    }

    logger.warn('[PERPLEXITY] Login timeout');
    return false;
  }

  // --------------------------------------------------------------------------
  // QUERY METHODS
  // --------------------------------------------------------------------------

  async queryMarket(market: Market): Promise<LLMSignal | null> {
    if (!this.isReady || !this.page || this.isQuerying) {
      return null;
    }

    this.isQuerying = true;
    const startTime = Date.now();
    this.stats.queriesTotal++;

    try {
      // Build query
      const query = this.buildMarketQuery(market);
      logger.info(`[PERPLEXITY] Querying: ${market.slug}`);

      // Navigate to fresh search
      await this.page.goto('https://www.perplexity.ai/', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      await this.page.waitForTimeout(1000);

      // Find and fill search input
      const searchInput = await this.page.waitForSelector(
        'textarea[placeholder*="Ask"], textarea[placeholder*="Frage"], input[type="text"]',
        { timeout: 10000 }
      );

      if (!searchInput) {
        throw new Error('Search input not found');
      }

      await searchInput.click();
      await searchInput.fill(query);
      await this.page.waitForTimeout(500);

      // Submit query
      await this.page.keyboard.press('Enter');

      // Wait for response
      await this.page.waitForSelector(
        '[class*="prose"], [class*="markdown"], [class*="answer"]',
        { timeout: 60000 }
      );

      // Wait for streaming to complete
      await this.page.waitForTimeout(5000);

      // Additional wait for full response
      await this.waitForResponseComplete();

      // Extract response
      const response = await this.extractResponse();

      if (!response) {
        throw new Error('Could not extract response');
      }

      // Parse signal from response
      const signal = this.parseSignalFromResponse(market, response);

      const duration = Date.now() - startTime;
      this.recordQueryDuration(duration);
      this.stats.queriesSuccessful++;
      this.stats.lastQueryTime = new Date();

      if (signal) {
        this.signals.unshift(signal);
        if (this.signals.length > 100) {
          this.signals.pop();
        }

        this.stats.signalsGenerated++;
        if (signal.signalStrength === 'strong' || signal.signalStrength === 'very_strong') {
          this.stats.strongSignals++;
        }

        this.emit('signal', signal);
        logger.info(`[PERPLEXITY] Signal: ${signal.direction.toUpperCase()} @ ${(signal.confidence).toFixed(0)}% for ${market.slug}`);
      }

      return signal;
    } catch (error) {
      this.stats.queriesFailed++;
      logger.error(`[PERPLEXITY] Query failed for ${market.slug}:`, error);
      this.emit('query_error', { market, error });
      return null;
    } finally {
      this.isQuerying = false;
    }
  }

  private buildMarketQuery(market: Market): string {
    const question = market.question;

    // Extract key entities
    const entities = this.extractEntities(question);

    return `
Aktuelle Nachrichten und Entwicklungen zu: "${question}"

Fokus auf:
${entities.map(e => `- ${e}`).join('\n')}

Bitte analysiere:
1. Was sind die neuesten Entwicklungen (letzte 24-48 Stunden)?
2. Welche Faktoren sprechen für JA?
3. Welche Faktoren sprechen für NEIN?
4. Wie hoch schätzt du die Wahrscheinlichkeit für JA ein (0-100%)?
5. Wie sicher bist du dir bei dieser Einschätzung?

Antworte strukturiert und nenne konkrete Quellen.
    `.trim();
  }

  private extractEntities(question: string): string[] {
    const entities: string[] = [];

    // Common political figures
    const politicians = [
      'Trump', 'Biden', 'Merz', 'Scholz', 'Habeck', 'Lindner',
      'Zelensky', 'Putin', 'Macron', 'von der Leyen'
    ];

    for (const pol of politicians) {
      if (question.toLowerCase().includes(pol.toLowerCase())) {
        entities.push(pol);
      }
    }

    // Countries and orgs
    const geoEntities = [
      'Deutschland', 'Germany', 'USA', 'Ukraine', 'Russia', 'Russland',
      'EU', 'NATO', 'China', 'Israel', 'Gaza'
    ];

    for (const geo of geoEntities) {
      if (question.toLowerCase().includes(geo.toLowerCase())) {
        entities.push(geo);
      }
    }

    // Add priority keywords that match
    for (const keyword of this.config.priorityKeywords) {
      if (question.toLowerCase().includes(keyword.toLowerCase()) && !entities.includes(keyword)) {
        entities.push(keyword);
      }
    }

    return entities.slice(0, 5);
  }

  private async waitForResponseComplete(): Promise<void> {
    if (!this.page) return;

    // Wait until no new content appears for 3 seconds
    let lastContent = '';
    let stableCount = 0;

    while (stableCount < 3) {
      await this.page.waitForTimeout(1000);

      const currentContent = await this.page.evaluate(() => {
        // @ts-expect-error - runs in browser context
        const answer = (document as Document).querySelector('[class*="prose"], [class*="markdown"], [class*="answer"]');
        return answer?.textContent || '';
      });

      if (currentContent === lastContent) {
        stableCount++;
      } else {
        stableCount = 0;
        lastContent = currentContent;
      }
    }
  }

  private async extractResponse(): Promise<string | null> {
    if (!this.page) return null;

    try {
      // Try multiple selectors
      const selectors = [
        '[class*="prose"]',
        '[class*="markdown"]',
        '[class*="answer"]',
        '[class*="response"]',
        'article'
      ];

      for (const selector of selectors) {
        const element = await this.page.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text && text.length > 100) {
            return text;
          }
        }
      }

      // Fallback: Get main content
      return await this.page.evaluate(() => {
        // @ts-expect-error - runs in browser context
        const main = (document as Document).querySelector('main');
        return main?.textContent || null;
      });
    } catch {
      return null;
    }
  }

  private parseSignalFromResponse(market: Market, response: string): LLMSignal | null {
    try {
      // Extract probability estimates
      const probMatch = response.match(/(\d{1,3})\s*%/g);
      const probabilities: number[] = [];

      if (probMatch) {
        for (const match of probMatch) {
          const num = parseInt(match);
          if (num >= 0 && num <= 100) {
            probabilities.push(num);
          }
        }
      }

      // Find the most likely probability estimate
      let estimatedProb = 0.5;
      if (probabilities.length > 0) {
        // Look for probability near end of response (conclusion)
        const lastProbs = probabilities.slice(-3);
        estimatedProb = lastProbs.reduce((a, b) => a + b, 0) / lastProbs.length / 100;
      }

      // Determine direction
      const direction: 'yes' | 'no' = estimatedProb >= 0.5 ? 'yes' : 'no';

      // Calculate confidence based on language
      let confidence = 50;
      const highConfidenceWords = ['sicher', 'definitiv', 'klar', 'eindeutig', 'zweifellos', 'certain', 'definitely'];
      const medConfidenceWords = ['wahrscheinlich', 'vermutlich', 'likely', 'probably'];
      const lowConfidenceWords = ['möglich', 'unsicher', 'unklar', 'schwer zu sagen', 'uncertain'];

      const lowerResponse = response.toLowerCase();

      if (highConfidenceWords.some(w => lowerResponse.includes(w))) {
        confidence = 80;
      } else if (medConfidenceWords.some(w => lowerResponse.includes(w))) {
        confidence = 65;
      } else if (lowConfidenceWords.some(w => lowerResponse.includes(w))) {
        confidence = 40;
      }

      // Adjust confidence based on probability distance from 50%
      const probDistance = Math.abs(estimatedProb - 0.5);
      confidence = Math.min(95, confidence + probDistance * 30);

      // Extract news context (sentences with dates or "heute", "gestern")
      const newsContext: string[] = [];
      const sentences = response.split(/[.!?]+/);

      for (const sentence of sentences) {
        const lower = sentence.toLowerCase();
        if (
          lower.includes('heute') ||
          lower.includes('gestern') ||
          lower.includes('aktuell') ||
          lower.includes('neu') ||
          /\d{1,2}\.\s*(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)/i.test(sentence) ||
          /\d{4}/.test(sentence)
        ) {
          newsContext.push(sentence.trim());
        }
      }

      // Extract sources
      const sources: string[] = [];
      const sourcePatterns = [
        /(?:laut|nach|gemäß|according to)\s+([A-Z][a-zA-Z\s]+)/g,
        /(Reuters|Bloomberg|DPA|AFP|Spiegel|Zeit|FAZ|Tagesschau|Handelsblatt)/gi
      ];

      for (const pattern of sourcePatterns) {
        let match;
        while ((match = pattern.exec(response)) !== null) {
          if (!sources.includes(match[1])) {
            sources.push(match[1]);
          }
        }
      }

      // Determine signal strength
      const currentPrice = market.outcomes[0]?.price || 0.5;
      const priceGap = Math.abs(estimatedProb - currentPrice);
      let signalStrength: LLMSignal['signalStrength'] = 'weak';

      if (priceGap >= 0.15 && confidence >= 75) {
        signalStrength = 'very_strong';
      } else if (priceGap >= 0.10 && confidence >= 65) {
        signalStrength = 'strong';
      } else if (priceGap >= 0.05 && confidence >= 55) {
        signalStrength = 'medium';
      }

      // Determine news recency
      let newsRecency: LLMSignal['newsRecency'] = 'older';
      if (lowerResponse.includes('heute') || lowerResponse.includes('gerade') || lowerResponse.includes('breaking')) {
        newsRecency = 'breaking';
      } else if (lowerResponse.includes('gestern') || lowerResponse.includes('kürzlich')) {
        newsRecency = 'recent';
      }

      // Only return signal if meets minimum confidence
      if (confidence < this.config.minConfidence) {
        logger.info(`[PERPLEXITY] Signal below threshold: ${confidence}% < ${this.config.minConfidence}%`);
        return null;
      }

      // Extract reasoning (first 500 chars of conclusion-like text)
      let reasoning = '';
      const conclusionMarkers = ['zusammenfassend', 'insgesamt', 'daher', 'deshalb', 'fazit', 'conclusion'];
      for (const marker of conclusionMarkers) {
        const idx = lowerResponse.indexOf(marker);
        if (idx !== -1) {
          reasoning = response.substring(idx, idx + 500);
          break;
        }
      }
      if (!reasoning) {
        reasoning = response.substring(Math.max(0, response.length - 500));
      }

      const signal: LLMSignal = {
        id: `llm_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        timestamp: new Date(),
        marketId: market.id,
        marketSlug: market.slug,
        marketQuestion: market.question,
        direction,
        confidence,
        estimatedProbability: estimatedProb,
        newsContext: newsContext.slice(0, 5),
        reasoning: reasoning.trim(),
        sources: sources.slice(0, 5),
        currentPrice: currentPrice,
        priceGap,
        signalStrength,
        newsRecency
      };

      return signal;
    } catch (error) {
      logger.error('[PERPLEXITY] Failed to parse signal:', error);
      return null;
    }
  }

  private recordQueryDuration(duration: number): void {
    this.queryDurations.push(duration);
    if (this.queryDurations.length > 50) {
      this.queryDurations.shift();
    }
    this.stats.averageQueryDuration =
      this.queryDurations.reduce((a, b) => a + b, 0) / this.queryDurations.length;
  }

  // --------------------------------------------------------------------------
  // BATCH PROCESSING
  // --------------------------------------------------------------------------

  async analyzeMarkets(markets: Market[], options?: {
    maxMarkets?: number;
    prioritizeHot?: boolean;
  }): Promise<LLMSignal[]> {
    const signals: LLMSignal[] = [];
    const maxMarkets = options?.maxMarkets || 10;

    // Sort by priority
    let sortedMarkets = [...markets];
    if (options?.prioritizeHot) {
      sortedMarkets.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
    }

    // Filter for Germany-relevant markets
    sortedMarkets = sortedMarkets.filter(m =>
      this.isGermanyRelevant(m) || this.hasPriorityKeyword(m)
    );

    const toAnalyze = sortedMarkets.slice(0, maxMarkets);

    logger.info(`[PERPLEXITY] Analyzing ${toAnalyze.length} markets`);

    for (const market of toAnalyze) {
      const signal = await this.queryMarket(market);
      if (signal) {
        signals.push(signal);
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, this.config.queryInterval));
    }

    return signals;
  }

  private isGermanyRelevant(market: Market): boolean {
    const question = market.question.toLowerCase();
    const germanyKeywords = [
      'germany', 'german', 'deutschland', 'deutsch',
      'bundestag', 'bundesregierung', 'bundeskanzler',
      'merz', 'scholz', 'habeck', 'lindner', 'weidel', 'afd', 'cdu', 'spd', 'grüne'
    ];
    return germanyKeywords.some(k => question.includes(k));
  }

  private hasPriorityKeyword(market: Market): boolean {
    const question = market.question.toLowerCase();
    return this.config.priorityKeywords.some(k => question.toLowerCase().includes(k.toLowerCase()));
  }

  // --------------------------------------------------------------------------
  // GETTERS
  // --------------------------------------------------------------------------

  getStats(): EngineStats {
    return { ...this.stats };
  }

  getSignals(limit: number = 20): LLMSignal[] {
    return this.signals.slice(0, limit);
  }

  getStrongSignals(): LLMSignal[] {
    return this.signals.filter(s =>
      s.signalStrength === 'strong' || s.signalStrength === 'very_strong'
    );
  }

  isActive(): boolean {
    return this.isReady && this.stats.browserActive;
  }

  toJSON(): Record<string, unknown> {
    return {
      stats: this.getStats(),
      signals: this.getSignals(20),
      strongSignals: this.getStrongSignals(),
      isActive: this.isActive(),
      config: {
        enabled: this.config.enabled,
        headless: this.config.headless,
        minConfidence: this.config.minConfidence,
        queryInterval: this.config.queryInterval
      }
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const perplexityEngine = new PerplexityEngine();
