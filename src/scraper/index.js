'use strict';
/**
 * src/scraper/index.js
 *
 * Orchestrates TKC + NKB scrapers and persists results into the
 * normalised database (clubs / leagues / teams / matches tables).
 *
 * Can be called programmatically (from the cron job or the API)
 * or directly: node src/scraper/index.js
 */

const db          = require('../db');
const { scrapeAllTkc } = require('./tkc');
const { scrapeAllNkb } = require('./nkb');

/**
 * Run a full scrape and return a summary { added, updated, errors }.
 * @param {import('better-sqlite3').Database} database
 */
async function runScrape(database) {
  let added   = 0;
  let updated = 0;
  const errors = [];

  // ── 1. Collect raw match data from both sources ──────────────────────────
  console.log('\n=== Starting scrape ===');

  let rawMatches = [];

  try {
    const tkc = await scrapeAllTkc();
    rawMatches.push(...tkc);
  } catch (err) {
    console.error('[TKC] scrape failed:', err.message);
    errors.push(`TKC: ${err.message}`);
  }

  try {
    const nkb = await scrapeAllNkb();
    rawMatches.push(...nkb);
  } catch (err) {
    console.error('[NKB] scrape failed:', err.message);
    errors.push(`NKB: ${err.message}`);
  }

  console.log(`\nTotal raw matches collected: ${rawMatches.length}`);

  // ── 2. Persist to normalised tables ──────────────────────────────────────
  const persist = database.transaction((rows) => {
    for (const row of rows) {
      try {
        // clubs
        const homeClubId = db.getOrCreateClub(database, row.home_team.club);
        const awayClubId = db.getOrCreateClub(database, row.away_team.club);

        // league
        const leagueId = db.getOrCreateLeague(database, {
          name     : row.league,
          category : row.category,
          source   : row.source,
        });

        // teams
        const homeTeamId = db.getOrCreateTeam(database, {
          clubId     : homeClubId,
          teamNr     : row.home_team.teamNr,
          displayName: row.home_team.displayName,
        });
        const awayTeamId = db.getOrCreateTeam(database, {
          clubId     : awayClubId,
          teamNr     : row.away_team.teamNr,
          displayName: row.away_team.displayName,
        });

        // match
        const result = db.upsertMatch(database, {
          source      : row.source,
          league_id   : leagueId,
          home_team_id: homeTeamId,
          away_team_id: awayTeamId,
          match_date  : row.match_date,
          match_time  : row.match_time,
          speeldag    : row.speeldag || null,
          home_score  : row.home_score,
          away_score  : row.away_score,
          location    : row.location,
          source_url  : row.source_url,
        });

        if (result === 'added')   added++;
        if (result === 'updated') updated++;

      } catch (err) {
        // Don't let one bad row abort the whole transaction
        errors.push(`Row error: ${err.message} (${JSON.stringify(row).slice(0, 80)})`);
      }
    }
  });

  persist(rawMatches);

  const summary = { added, updated, errors, total: rawMatches.length };
  console.log(`\nDone – added: ${added}, updated: ${updated}, errors: ${errors.length}`);
  return summary;
}

// ── Allow direct invocation ──────────────────────────────────────────────────
if (require.main === module) {
  const database = db.openDb();
  runScrape(database)
    .then(summary => {
      console.log('\nSummary:', summary);
      database.close();
      process.exit(summary.errors.length ? 1 : 0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runScrape };
