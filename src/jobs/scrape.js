#!/usr/bin/env node
'use strict';
/**
 * src/jobs/scrape.js
 *
 * Standalone scrape runner – no HTTP server needed.
 * Useful for cron jobs or one-off refreshes.
 *
 *   node src/jobs/scrape.js
 */

const db = require('../db');
const { runScrape } = require('../scraper');

(async () => {
  const database = db.openDb();

  const logId = database.prepare(
    "INSERT INTO scrape_log (status) VALUES ('running')"
  ).run().lastInsertRowid;

  try {
    const summary = await runScrape(database);

    database.prepare(`
      UPDATE scrape_log
      SET finished_at = datetime('now'), status = 'ok',
          matches_added = ?, matches_updated = ?
      WHERE id = ?
    `).run(summary.added, summary.updated, logId);

    console.log('\n── Scrape complete ──────────────────');
    console.log(`  Added:   ${summary.added}`);
    console.log(`  Updated: ${summary.updated}`);
    if (summary.errors.length) {
      console.log(`  Errors:  ${summary.errors.length}`);
      summary.errors.forEach(e => console.log('    -', e));
    }
    console.log('────────────────────────────────────');

  } catch (err) {
    database.prepare(`
      UPDATE scrape_log
      SET finished_at = datetime('now'), status = 'error', error_msg = ?
      WHERE id = ?
    `).run(err.message, logId);
    console.error('Fatal scrape error:', err);
    process.exit(1);

  } finally {
    database.close();
  }
})();
