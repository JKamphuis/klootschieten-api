'use strict';
/**
 * src/scraper/normalise.js
 *
 * Maps known spelling variants from either website to a single
 * canonical club name, and splits "Club N" → { club, teamNr }.
 */

// Add more entries here as new variants are spotted.
const ALIASES = {
  'de brink'                              : 'Brink',
  'brink'                                 : 'Brink',
  'klootschietvereniging de brink'        : 'Brink',
  'k.v. de brink'                         : 'Brink',

  'soasel'                                : 'Soasel',
  'klootschietvereniging soasel'          : 'Soasel',
  'k.v. soasel'                           : 'Soasel',

  'hertme'                                : 'Hertme',
  'klootschietvereniging hertme'          : 'Hertme',
  'k.v. hertme'                           : 'Hertme',

  'de gunne'                              : 'Gunne',
  'gunne'                                 : 'Gunne',
  'klootschietvereniging de gunne'        : 'Gunne',
  'k.v. de gunne'                         : 'Gunne',

  'lattrop-breklenkamp'                   : 'Lattrop-Breklenkamp',
  'lattrop breklenkamp'                   : 'Lattrop-Breklenkamp',
  'klootschietvereniging lattrop breklenkamp': 'Lattrop-Breklenkamp',
  'k.v. lattrop-breklenkamp'              : 'Lattrop-Breklenkamp',

  'nijstad'                               : 'Nijstad',
  'de nijstad'                            : 'Nijstad',
  'klootschietvereniging de nijstad'      : 'Nijstad',
  'k.v. de nijstad'                       : 'Nijstad',

  'oud ootmarsum'                         : 'Oud Ootmarsum',
  'klootschietvereniging oud ootmarsum'   : 'Oud Ootmarsum',
  'k.v. oud ootmarsum'                    : 'Oud Ootmarsum',

  'wilskracht'                            : 'Wilskracht',
  'klootschietvereniging wilskracht'      : 'Wilskracht',
  'k.v. wilskracht'                       : 'Wilskracht',
};

function normaliseClub(raw) {
  if (!raw) return raw;
  const key = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  return ALIASES[key] || raw.trim();
}

/**
 * "Brink 3"               → { club: 'Brink',              teamNr: 3 }
 * "Lattrop Breklenkamp 5" → { club: 'Lattrop-Breklenkamp', teamNr: 5 }
 * "Soasel"                → { club: 'Soasel',              teamNr: 1 }
 */
function parseTeam(raw) {
  if (!raw) return { club: '', teamNr: 1, displayName: raw };
  const trimmed = raw.trim();
  const m = trimmed.match(/^(.+?)\s+(\d+)$/);
  if (m) {
    const club = normaliseClub(m[1]);
    const nr   = parseInt(m[2], 10);
    return { club, teamNr: nr, displayName: `${club} ${nr}` };
  }
  const club = normaliseClub(trimmed);
  return { club, teamNr: 1, displayName: club };
}

module.exports = { normaliseClub, parseTeam };
