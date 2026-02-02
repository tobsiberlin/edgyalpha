/**
 * Position Sync Module
 * Synchronisiert offene Positionen von Polymarket mit dem Risk State
 *
 * KRITISCH: Nach Server-Restart "vergisst" das System offene Positionen.
 * Diese Funktion holt die echten Positionen von der Polymarket API
 * und synchronisiert sie mit dem internen Risk State.
 */

import { tradingClient } from '../api/trading.js';
import { setRiskState, getRiskState } from '../alpha/riskGates.js';
import runtimeState from './state.js';
import logger from '../utils/logger.js';
import { Position } from '../types/index.js';
import { writeAuditLog } from '../storage/repositories/riskState.js';
import { isDatabaseInitialized } from '../storage/db.js';

export interface SyncResult {
  synced: boolean;
  reason?: string;
  openPositions: number;
  totalExposure: number;
  markets: string[];
  positionsPerMarket: Map<string, number>;
}

/**
 * Synchronisiert offene Positionen von Polymarket mit dem Risk State
 * Sollte beim Server-Start aufgerufen werden
 */
export async function syncPositionsToRiskState(): Promise<SyncResult> {
  logger.info('[POSITION-SYNC] Starte Synchronisierung...');

  // 1. Hole aktuelle Positionen von Polymarket API
  let positions: Position[];
  try {
    positions = await tradingClient.getPositions();
    logger.info(`[POSITION-SYNC] ${positions.length} Positionen von Polymarket API erhalten`);
  } catch (err) {
    const error = err as Error;
    logger.warn(`[POSITION-SYNC] Konnte Positionen nicht abrufen: ${error.message}`);
    return {
      synced: false,
      reason: `API-Fehler: ${error.message}`,
      openPositions: 0,
      totalExposure: 0,
      markets: [],
      positionsPerMarket: new Map(),
    };
  }

  // 2. Keine Positionen = nichts zu synchronisieren
  if (positions.length === 0) {
    logger.info('[POSITION-SYNC] Keine offenen Positionen gefunden');

    // Reset Risk State falls er falsche Positionen hatte
    const currentState = getRiskState();
    if (currentState.openPositions > 0) {
      logger.warn(`[POSITION-SYNC] Risk State hatte ${currentState.openPositions} Positionen, aber API zeigt 0. Resette...`);
      setRiskState({
        openPositions: 0,
        positionsPerMarket: new Map(),
      });
    }

    return {
      synced: true,
      openPositions: 0,
      totalExposure: 0,
      markets: [],
      positionsPerMarket: new Map(),
    };
  }

  // 3. Berechne Exposure pro Market
  const positionsPerMarket = new Map<string, number>();
  let totalExposure = 0;
  const markets: string[] = [];

  for (const position of positions) {
    const marketId = position.marketId;
    // Exposure = Shares * avgPrice (was wir investiert haben)
    const exposure = position.shares * position.avgPrice;

    const currentExposure = positionsPerMarket.get(marketId) || 0;
    positionsPerMarket.set(marketId, currentExposure + exposure);
    totalExposure += exposure;

    if (!markets.includes(marketId)) {
      markets.push(marketId);
    }

    logger.debug(`[POSITION-SYNC] Position: ${position.marketQuestion?.substring(0, 50)}...`, {
      marketId,
      outcome: position.outcome,
      shares: position.shares,
      avgPrice: position.avgPrice,
      exposure: exposure.toFixed(2),
    });
  }

  const openPositions = positionsPerMarket.size;

  // 4. Aktualisiere Risk State (riskGates.ts)
  const oldRiskState = getRiskState();
  setRiskState({
    openPositions,
    positionsPerMarket: new Map(positionsPerMarket),
  });

  logger.info(`[POSITION-SYNC] Risk State aktualisiert:`, {
    vorher: {
      openPositions: oldRiskState.openPositions,
      markets: Array.from(oldRiskState.positionsPerMarket.keys()),
    },
    nachher: {
      openPositions,
      totalExposure: totalExposure.toFixed(2),
      markets,
    },
  });

  // 5. Aktualisiere Runtime State (runtime/state.ts)
  // Nutze die dedizierte Sync-Methode die den State komplett ersetzt
  runtimeState.syncPositionsFromApi(positionsPerMarket, totalExposure);

  // 6. Audit Log
  if (isDatabaseInitialized()) {
    try {
      writeAuditLog({
        eventType: 'settings',
        actor: 'system',
        action: `Position-Sync nach Restart: ${openPositions} Positionen, ${totalExposure.toFixed(2)} USDC Exposure`,
        details: {
          openPositions,
          totalExposure,
          markets,
          positionsPerMarket: Object.fromEntries(positionsPerMarket),
        },
        riskStateBefore: {
          openPositions: oldRiskState.openPositions,
          positionsPerMarket: Object.fromEntries(oldRiskState.positionsPerMarket),
        },
        riskStateAfter: {
          openPositions,
          totalExposure,
          positionsPerMarket: Object.fromEntries(positionsPerMarket),
        },
      });
    } catch {
      // Audit Log Fehler ignorieren
    }
  }

  // 7. Log Summary
  logger.info('[POSITION-SYNC] =====================================');
  logger.info(`[POSITION-SYNC] Synchronisierung abgeschlossen:`);
  logger.info(`[POSITION-SYNC]   Offene Positionen: ${openPositions}`);
  logger.info(`[POSITION-SYNC]   Total Exposure: ${totalExposure.toFixed(2)} USDC`);
  logger.info(`[POSITION-SYNC]   Markets: ${markets.join(', ').substring(0, 100)}...`);
  logger.info('[POSITION-SYNC] =====================================');

  return {
    synced: true,
    openPositions,
    totalExposure,
    markets,
    positionsPerMarket,
  };
}

/**
 * Prüft ob Positions-Sync nötig ist
 * (z.B. wenn Risk State und API nicht übereinstimmen)
 */
export async function checkPositionSyncNeeded(): Promise<{
  needed: boolean;
  reason?: string;
  riskStatePositions: number;
  apiPositions: number;
}> {
  const riskState = getRiskState();
  const riskStatePositions = riskState.openPositions;

  let apiPositions = 0;
  try {
    const positions = await tradingClient.getPositions();
    // Zähle unique Markets
    const uniqueMarkets = new Set(positions.map(p => p.marketId));
    apiPositions = uniqueMarkets.size;
  } catch {
    return {
      needed: false,
      reason: 'API nicht erreichbar',
      riskStatePositions,
      apiPositions: -1,
    };
  }

  if (riskStatePositions !== apiPositions) {
    return {
      needed: true,
      reason: `Risk State zeigt ${riskStatePositions}, API zeigt ${apiPositions} Positionen`,
      riskStatePositions,
      apiPositions,
    };
  }

  return {
    needed: false,
    riskStatePositions,
    apiPositions,
  };
}

export default {
  syncPositionsToRiskState,
  checkPositionSyncNeeded,
};
