'use strict';
/**
 * src/scraper/normalise.js
 *
 * Maps known spelling variants from either website to a single
 * canonical club name, and splits team strings into { club, teamNr, displayName }.
 *
 * Senior teams:  "Brink 3"    → club: Brink,  teamNr: 3
 * Junior teams:  "Brink A"    → club: Brink,  teamNr: 101  (A=101, B=102, …)
 *                "Brink A1"   → club: Brink,  teamNr: 101
 *                "Brink A2"   → club: Brink,  teamNr: 102  (second A-team = 102? No — )
 *
 * Letter → number mapping: A=101, B=102, … Z=126
 * A second team in the same letter class (A2) gets +50: A1=101, A2=151
 * This keeps junior teamNr values clearly separate from senior ones (1–99).
 */

const ALIASES = {
  'de brink'                               : 'Brink',
  'brink'                                  : 'Brink',
  'klootschietvereniging de brink'         : 'Brink',
  'k.v. de brink'                          : 'Brink',

  'soasel'                                 : 'Soasel',
  'klootschietvereniging soasel'           : 'Soasel',
  'k.v. soasel'                            : 'Soasel',

  'hertme'                                 : 'Hertme',
  'klootschietvereniging hertme'           : 'Hertme',
  'k.v. hertme'                            : 'Hertme',

  'de gunne'                               : 'Gunne',
  'gunne'                                  : 'Gunne',
  'klootschietvereniging de gunne'         : 'Gunne',
  'k.v. de gunne'                          : 'Gunne',

  'lattrop-breklenkamp'                    : 'Lattrop-Breklenkamp',
  'lattrop breklenkamp'                    : 'Lattrop-Breklenkamp',
  'klootschietvereniging lattrop breklenkamp': 'Lattrop-Breklenkamp',
  'k.v. lattrop-breklenkamp'               : 'Lattrop-Breklenkamp',

  'nijstad'                                : 'Nijstad',
  'de nijstad'                             : 'Nijstad',
  'klootschietvereniging de nijstad'       : 'Nijstad',
  'k.v. de nijstad'                        : 'Nijstad',

  'oud ootmarsum'                          : 'Oud Ootmarsum',
  'klootschietvereniging oud ootmarsum'    : 'Oud Ootmarsum',
  'k.v. oud ootmarsum'                     : 'Oud Ootmarsum',

  'wilskracht'                             : 'Wilskracht',
  'klootschietvereniging wilskracht'       : 'Wilskracht',
  'k.v. wilskracht'                        : 'Wilskracht',
};

function normaliseClub(raw) {
  if (!raw) return raw;
  const key = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  return ALIASES[key] || raw.trim();
}

/**
 * Convert a letter suffix to a numeric teamNr in the 100+ range so junior
 * teams are clearly separate from senior teams (which use 1–99).
 *
 * "A"  or "A1" → 101
 * "A2"         → 102
 * "B"  or "B1" → 111
 * "B2"         → 112
 * etc. (each letter gets a block of 10)
 */
function letterToNr(letter, sequence) {
  const base = 100 + (letter.toUpperCase().charCodeAt(0) - 65) * 10 + 1;
  return base + (sequence > 1 ? sequence - 1 : 0);
}

/**
 * Parse a raw team string into { club, teamNr, displayName }.
 *
 * Handled formats:
 *   "Brink 3"        → senior team 3
 *   "Brink A"        → junior A-team  (teamNr 101)
 *   "Brink A1"       → junior A-team  (teamNr 101)
 *   "Brink A2"       → junior second A-team (teamNr 102)
 *   "Brink B"        → junior B-team  (teamNr 111)
 *   "Soasel"         → senior team 1 (no suffix)
 */
function parseTeam(raw) {
  if (!raw) return { club: '', teamNr: 1, displayName: '' };
  const trimmed = raw.trim();

  // Senior: ends with a number   "Brink 3"
  const seniorM = trimmed.match(/^(.+?)\s+(\d+)$/);
  if (seniorM) {
    const club = normaliseClub(seniorM[1]);
    const nr   = parseInt(seniorM[2], 10);
    return { club, teamNr: nr, displayName: `${club} ${nr}` };
  }

  // Junior: ends with a letter, optionally followed by a digit
  // Matches: "Brink A", "Brink A1", "Brink A2", "Brink B"
  const juniorM = trimmed.match(/^(.+?)\s+([A-Za-z])(\d?)$/);
  if (juniorM) {
    const club     = normaliseClub(juniorM[1]);
    const letter   = juniorM[2].toUpperCase();
    const sequence = juniorM[3] ? parseInt(juniorM[3], 10) : 1;
    const teamNr   = letterToNr(letter, sequence);
    // Display name preserves the original suffix: "Brink A", "Brink A2"
    const suffix   = sequence > 1 ? `${letter}${sequence}` : letter;
    return { club, teamNr, displayName: `${club} ${suffix}` };
  }

  // No recognisable suffix — treat as single (senior) team
  const club = normaliseClub(trimmed);
  return { club, teamNr: 1, displayName: club };
}

module.exports = { normaliseClub, parseTeam };
