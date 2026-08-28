'use strict';
/**
 * src/jobs/matchday-scheduler.js
 *
 * Replaces the single weekly cron with a two-tier schedule:
 *
 *  NON-matchdays  → one scrape per week (Sunday 23:00, configurable via SCRAPE_CRON)
 *  Matchdays      → frequent polling between 10:00 and 22:00, then stops
 *                   automatically once every match on that date has a score.
 *
 * Polling intervals on matchdays:
 *   10:00 – 14:00   every 15 minutes  (early check-ins / morning matches)
 *   14:00 – 18:00   every 10 minutes  (typical afternoon match window)
 *   18:00 – 22:00   every 20 minutes  (late results / stragglers)
 *   after 22:00     stops until next matchday
 *
 * State is held in memory; a server restart resets it cleanly (worst case: one
 * extra scrape at startup on a matchday, which is harmless).
 */

const cron          = require('node-cron');
const db            = require('../db');
const { runScrape } = require('../scraper');

// ── Interval table ────────────────────────────────────────────────────────────
// Each entry: [startHour (inclusive), endHour (exclusive), intervalMinutes]
const MATCHDAY_INTERVALS = [
  [10, 14, 15],
  [14, 18, 10],
  [18, 22, 20],
];

function intervalForHour(hour) {
  for (const [start, end, mins] of MATCHDAY_INTERVALS) {
    if (hour >= start && hour < end) return mins;
  }
  return null; // outside polling window
}

// ── Scrape-log helper (mirrors what server.js does) ───────────────────────────
async function runAndLog(database, reason) {
  const logId = database.prepare(
    "INSERT INTO scrape_log (status) VALUES ('running')"
  ).run().lastInsertRowid;

  try {
    const s = await runScrape(database);
    database.prepare(`
      UPDATE scrape_log
      SET finished_at = datetime('now'), status = 'ok',
          matches_added = ?, matches_updated = ?
      WHERE id = ?
    `).run(s.added, s.updated, logId);
    console.log(`[scheduler] ${reason} — added: ${s.added}, updated: ${s.updated}`);
    return s;
  } catch (err) {
    database.prepare(`
      UPDATE scrape_log
      SET finished_at = datetime('now'), status = 'error', error_msg = ?
      WHERE id = ?
    `).run(err.message, logId);
    console.error(`[scheduler] ${reason} scrape error:`, err.message);
    throw err;
  }
}

// ── Query helpers (keep these lean — no joins needed) ────────────────────────

/** All distinct match dates that exist in the DB and are >= today. */
function upcomingMatchDates(database) {
  return database.prepare(`
    SELECT DISTINCT match_date
    FROM matches
    WHERE match_date >= date('now', 'localtime')
      AND match_date IS NOT NULL
    ORDER BY match_date
  `).all().map(r => r.match_date);
}

/** How many matches on `date` are still without a score. */
function pendingCount(database, date) {
  return database.prepare(`
    SELECT COUNT(*) AS n FROM matches
    WHERE match_date = ? AND home_score IS NULL
  `).get(date).n;
}

/** Total matches on `date`. */
function totalCount(database, date) {
  return database.prepare(`
    SELECT COUNT(*) AS n FROM matches WHERE match_date = ?
  `).get(date).n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('better-sqlite3').Database} database
 * @param {string} weeklyCron  – fallback cron expression (default '0 23 * * 0')
 */
function startMatchdayScheduler(database, weeklyCron = '0 23 * * 0') {

  // Per-date state: tracks whether we've already declared a date "done"
  // and when we last scraped it.
  const dateState = {};   // { [YYYY-MM-DD]: { done: bool, lastScrape: Date|null } }

  let scraping = false;   // guard: prevent concurrent scrape runs

  function getState(date) {
    if (!dateState[date]) dateState[date] = { done: false, lastScrape: null };
    return dateState[date];
  }

  // ── Matchday polling (every 5 minutes) ────────────────────────────────────
  // We check every 5 minutes but only scrape when the interval for the current
  // hour has elapsed since the last scrape for that date.
  cron.schedule('*/5 * * * *', async () => {
    if (scraping) return;  // previous scrape still running; skip this tick
    const now      = new Date();
    const todayStr = toLocalDateStr(now);
    const hour     = now.getHours();

    const intervalMins = intervalForHour(hour);
    if (intervalMins === null) return; // outside 10:00–22:00 window

    // Which matchdays are due for a poll right now?
    // Normally just today, but we also catch yesterday if it somehow ran late.
    const candidates = upcomingMatchDates(database).filter(d => d <= todayStr);

    for (const date of candidates) {
      const state = getState(date);
      if (state.done) continue;

      // Check if there are any matches at all for this date
      if (totalCount(database, date) === 0) continue;

      // Has the interval elapsed since last scrape for this date?
      const msSinceLast = state.lastScrape
        ? now - state.lastScrape
        : Infinity;
      const msNeeded = intervalMins * 60 * 1000;
      if (msSinceLast < msNeeded) continue;

      console.log(
        `[scheduler] Matchday poll for ${date} ` +
        `(${now.toTimeString().slice(0, 5)}, interval ${intervalMins}min)`
      );

      state.lastScrape = now;

      try {
        scraping = true;
        await runAndLog(database, `matchday ${date}`);
      } catch {
        continue; // error already logged; try again next tick
      } finally {
        scraping = false;
      }

      // After scraping, check if everything is done
      const pending = pendingCount(database, date);
      const total   = totalCount(database, date);

      if (pending === 0 && total > 0) {
        state.done = true;
        console.log(
          `[scheduler] All ${total} matches for ${date} have scores — ` +
          `no more polls today.`
        );
      } else {
        console.log(`[scheduler] ${pending}/${total} matches still pending for ${date}`);
      }
    }
  });

  console.log('[scheduler] Matchday poller active (checks every 5 min, polls 10:00–22:00)');

  // ── Weekly fallback scrape ────────────────────────────────────────────────
  // Keeps the programme data fresh on non-matchdays (new fixtures, corrections).
  if (cron.validate(weeklyCron)) {
    cron.schedule(weeklyCron, async () => {
      console.log(`[scheduler] Weekly scrape (${weeklyCron})`);
      try {
        await runAndLog(database, 'weekly');
      } catch { /* already logged */ }
    });
    console.log(`[scheduler] Weekly fallback scrape: ${weeklyCron}`);
  } else {
    console.warn(`[scheduler] Invalid SCRAPE_CRON "${weeklyCron}" — weekly scrape disabled`);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Returns today's date as YYYY-MM-DD in local time. */
function toLocalDateStr(date) {
  const y  = date.getFullYear();
  const m  = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { startMatchdayScheduler };
