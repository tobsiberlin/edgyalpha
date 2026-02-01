#!/usr/bin/env tsx
/**
 * DAWUM CLI Script
 * Zeigt aktuelle Sonntagsfrage-Umfragen an
 *
 * Usage:
 *   npm run dawum           # Zeigt letzte 3 Umfragen
 *   npm run dawum -- --all  # Alle Umfragen
 */

import { getLatestPolls, fetchDawumPolls, normalizePolls, type NormalizedPoll } from '../src/germany/dawum.js';

// CLI Arguments parsen
const args = process.argv.slice(2);
const showAll = args.includes('--all') || args.includes('-a');

async function main(): Promise<void> {
  console.log('\n=== DAWUM - Aktuelle Sonntagsfrage (Bundestag) ===');
  console.log('='.repeat(47));

  let polls: NormalizedPoll[];

  if (showAll) {
    const rawPolls = await fetchDawumPolls();
    polls = normalizePolls(rawPolls);
    console.log(`\n(Alle ${polls.length} Bundestag-Umfragen)\n`);
  } else {
    polls = await getLatestPolls(3);
    console.log('\n(Letzte 3 Umfragen)\n');
  }

  if (polls.length === 0) {
    console.log('Keine Umfragen gefunden.');
    process.exit(1);
  }

  for (const poll of polls) {
    // Datum und Institut
    console.log(`${poll.date} | ${poll.institute}`);

    // Parteien mit Prozentwerten
    const parts: string[] = [];

    if (poll.cduCsu > 0) parts.push(`CDU/CSU: ${poll.cduCsu}%`);
    if (poll.spd > 0) parts.push(`SPD: ${poll.spd}%`);
    if (poll.gruene > 0) parts.push(`Gruene: ${poll.gruene}%`);
    if (poll.afd > 0) parts.push(`AfD: ${poll.afd}%`);
    if (poll.fdp > 0) parts.push(`FDP: ${poll.fdp}%`);
    if (poll.bsw > 0) parts.push(`BSW: ${poll.bsw}%`);
    if (poll.linke > 0) parts.push(`Linke: ${poll.linke}%`);
    if (poll.sonstige > 0) parts.push(`Sonstige: ${poll.sonstige}%`);

    console.log(`   ${parts.join(' | ')}`);
    console.log('');
  }

  console.log('='.repeat(47));
  console.log('Quelle: api.dawum.de');
}

main().catch((err) => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
