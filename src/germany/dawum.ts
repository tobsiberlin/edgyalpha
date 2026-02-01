/**
 * DAWUM API Parser
 * Korrekte Verarbeitung der Dawum Sonntagsfrage-API
 *
 * API-Struktur:
 * - Surveys: Objekt mit Survey-IDs als Keys
 * - Results: Party-IDs -> Prozentwerte (in Survey-Objekten)
 * - Parliaments: Objekt mit Parliament-IDs (0 = Bundestag)
 * - Institutes: Objekt mit Institut-IDs
 * - Parties: Objekt mit Party-IDs
 */

import axios from 'axios';
import logger from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════

export interface DawumPoll {
  id: string;
  date: string;
  institute: string;
  parliament: string;
  results: Record<string, number>; // Party-Shortcut -> Prozent
}

export interface NormalizedPoll {
  date: string;
  institute: string;
  cduCsu: number;     // CDU + CSU zusammengeführt
  spd: number;
  gruene: number;
  afd: number;
  fdp: number;
  linke: number;
  bsw: number;
  sonstige: number;
}

// API Response Interfaces
interface DawumApiParty {
  Shortcut: string;
  Name: string;
}

interface DawumApiInstitute {
  Name: string;
}

interface DawumApiParliament {
  Shortcut: string;
  Name: string;
  Election: string;
}

interface DawumApiSurvey {
  Date: string;
  Survey_Period?: {
    Date_Start: string;
    Date_End: string;
  };
  Surveyed_Persons?: string;
  Parliament_ID: string;
  Institute_ID: string;
  Tasker_ID?: string;
  Method_ID?: string;
  Results: Record<string, number>; // Party-ID -> Prozent
}

interface DawumApiResponse {
  Database: {
    License: { Name: string; Shortcut: string; Link: string };
    Publisher: string;
    Author: string;
    Last_Update: string;
  };
  Parliaments: Record<string, DawumApiParliament>;
  Institutes: Record<string, DawumApiInstitute>;
  Parties: Record<string, DawumApiParty>;
  Surveys: Record<string, DawumApiSurvey>;
}

// Bundestag Parliament ID
const BUNDESTAG_PARLIAMENT_ID = '0';

// Party-ID Mapping (numerische IDs aus der API)
const PARTY_ID_MAP: Record<string, string> = {
  '1': 'CDU/CSU',     // Gemeinsamer Wert auf Bundesebene
  '101': 'CDU',       // CDU einzeln (Landtage)
  '102': 'CSU',       // CSU einzeln (Bayern)
  '2': 'SPD',
  '3': 'FDP',
  '4': 'Gruene',
  '5': 'Linke',
  '7': 'AfD',
  '8': 'FW',          // Freie Waehler
  '23': 'BSW',
  '0': 'Sonstige',
};

// ═══════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Holt alle Umfragen von der Dawum API
 */
export async function fetchDawumPolls(): Promise<DawumPoll[]> {
  try {
    const response = await axios.get<DawumApiResponse>('https://api.dawum.de/', {
      timeout: 10000,
    });

    const data = response.data;

    if (!data.Surveys || !data.Parties || !data.Institutes || !data.Parliaments) {
      logger.error('Dawum API: Unerwartete Response-Struktur');
      return [];
    }

    const polls: DawumPoll[] = [];

    // Surveys durchgehen (sind ein Objekt, kein Array!)
    for (const [surveyId, survey] of Object.entries(data.Surveys)) {
      // Nur Bundestag-Umfragen
      if (survey.Parliament_ID !== BUNDESTAG_PARLIAMENT_ID) {
        continue;
      }

      // Institut-Name resolven
      const institute = data.Institutes[survey.Institute_ID]?.Name || `Institut ${survey.Institute_ID}`;

      // Parliament-Name resolven
      const parliament = data.Parliaments[survey.Parliament_ID]?.Shortcut || 'Unbekannt';

      // Ergebnisse mit Party-Namen mappen
      const results: Record<string, number> = {};

      for (const [partyId, percentage] of Object.entries(survey.Results)) {
        // Erst statisches Mapping probieren, dann API-Daten
        let partyName = PARTY_ID_MAP[partyId];

        if (!partyName) {
          // Fallback: Party-Name aus API-Daten
          partyName = data.Parties[partyId]?.Shortcut || `Party ${partyId}`;
        }

        results[partyName] = percentage;
      }

      polls.push({
        id: surveyId,
        date: survey.Date,
        institute,
        parliament,
        results,
      });
    }

    // Nach Datum sortieren (neueste zuerst)
    polls.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    logger.debug(`Dawum: ${polls.length} Bundestag-Umfragen geladen`);

    return polls;
  } catch (err) {
    const error = err as Error;
    logger.error(`Dawum API Fehler: ${error.message}`);
    return [];
  }
}

/**
 * Normalisiert Umfragen und fuehrt CDU/CSU zusammen
 */
export function normalizePolls(polls: DawumPoll[]): NormalizedPoll[] {
  return polls.map((poll) => {
    const results = poll.results;

    // CDU/CSU zusammenfuehren
    // Auf Bundesebene gibt es meistens nur "CDU/CSU" (ID 1)
    // Aber sicherheitshalber alle drei Varianten addieren
    const cduCsu =
      (results['CDU/CSU'] || 0) +
      (results['CDU'] || 0) +
      (results['CSU'] || 0);

    return {
      date: poll.date,
      institute: poll.institute,
      cduCsu,
      spd: results['SPD'] || 0,
      gruene: results['Gruene'] || results['Grüne'] || 0,
      afd: results['AfD'] || 0,
      fdp: results['FDP'] || 0,
      linke: results['Linke'] || 0,
      bsw: results['BSW'] || 0,
      sonstige: results['Sonstige'] || 0,
    };
  });
}

/**
 * Holt die neuesten normalisierten Umfragen
 */
export async function getLatestPolls(limit: number = 5): Promise<NormalizedPoll[]> {
  const polls = await fetchDawumPolls();
  const normalized = normalizePolls(polls);
  return normalized.slice(0, limit);
}

/**
 * Formatiert eine Umfrage fuer die Konsole
 */
export function formatPollForConsole(poll: NormalizedPoll): string {
  const parts = [
    `CDU/CSU: ${poll.cduCsu}%`,
    `SPD: ${poll.spd}%`,
    `Gruene: ${poll.gruene}%`,
    `AfD: ${poll.afd}%`,
    `FDP: ${poll.fdp}%`,
    `BSW: ${poll.bsw}%`,
    `Linke: ${poll.linke}%`,
  ];

  // Sonstige nur anzeigen wenn > 0
  if (poll.sonstige > 0) {
    parts.push(`Sonstige: ${poll.sonstige}%`);
  }

  return `${poll.date} | ${poll.institute}\n   ${parts.join(' | ')}`;
}

/**
 * Gibt alle Umfragen formatiert aus
 */
export function printPolls(polls: NormalizedPoll[]): void {
  console.log('\n=== DAWUM - Aktuelle Sonntagsfrage (Bundestag) ===');
  console.log('='.repeat(50));

  for (const poll of polls) {
    console.log(`\n${formatPollForConsole(poll)}`);
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Quelle: api.dawum.de | ${polls.length} Umfragen`);
}
