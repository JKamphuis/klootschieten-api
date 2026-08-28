'use strict';
/**
 * src/server.js
 *
 * Environment variables:
 *   PORT             HTTP port (default 3000)
 *   DB_PATH          Path to SQLite file (default ./data/matches.db)
 *   ADMIN_KEY        If set AND no admin key exists yet, this raw value is
 *                    bootstrapped as the first admin key on startup.
 *                    Remove from environment after first run.
 *   SCRAPE_CRON      Weekly fallback cron (default: Sunday 23:00 → '0 23 * * 0')
 *                   On matchdays the scheduler polls every 10-20 min 10:00–22:00
 *                   regardless of this setting, stopping once all scores are in.
 *   CORS_ORIGIN      Allowed CORS origin(s), comma-separated (* = all, default)
 *                    e.g.  https://myclub.nl,https://www.myclub.nl
 */

const express = require('express');
const db      = require('./db');
const routes  = require('./api/routes');
const { startMatchdayScheduler } = require('./jobs/matchday-scheduler');

const PORT        = process.env.PORT        || 3000;
const CRON_SCHED  = process.env.SCRAPE_CRON || '0 23 * * 0';
const SCRAPE_BOOT = process.env.SCRAPE_ON_START === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN  || '*';

// ── Database ──────────────────────────────────────────────────────────────────
const database = db.openDb();

// ── Bootstrap admin key ───────────────────────────────────────────────────────
// On first run, if ADMIN_KEY env var is set and no admin keys exist yet,
// register it so you can immediately use the API to create reader keys.
(function bootstrapAdminKey() {
  const raw = process.env.ADMIN_KEY;
  if (!raw) return;

  const existing = database.prepare(
    "SELECT id FROM api_keys WHERE role = 'admin' LIMIT 1"
  ).get();

  if (existing) {
    console.log('[bootstrap] Admin key already exists — skipping ADMIN_KEY.');
    return;
  }

  const { id } = db.createApiKey(database, {
    label  : 'Bootstrap admin key',
    role   : 'admin',
    clubIds: [],
  });

  // We store the hash of whatever was in ADMIN_KEY — override with the
  // provided value by patching key_hash directly.
  const crypto = require('crypto');
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  database.prepare('UPDATE api_keys SET key_hash = ? WHERE id = ?').run(hash, id);

  console.log(`[bootstrap] Admin key registered (id=${id}). Remove ADMIN_KEY from environment after first use.`);
})();

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.locals.db = database;

// CORS — allow specified origins so browser JS (e.g. club websites) can call the API directly.
const allowedOrigins = CORS_ORIGIN === '*'
  ? null  // null → allow all
  : CORS_ORIGIN.split(',').map(o => o.trim());

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (!allowedOrigins) {
    // Wildcard mode — browsers can't send credentials with *, which is fine
    // for read-only public data accessed via API key in the request.
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Root info ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service : 'Klootschieten API',
    version : '2.0',
    auth    : 'All /api/v1/* endpoints require an API key (Bearer token, X-Api-Key header, or ?api_key= param)',
    endpoints: {
      health  : 'GET  /api/v1/health            (public)',
      matches : 'GET  /api/v1/matches',
      match   : 'GET  /api/v1/matches/:id',
      leagues : 'GET  /api/v1/leagues',
      clubs   : 'GET  /api/v1/clubs',
      teams   : 'GET  /api/v1/teams',
      ranking : 'GET  /api/v1/ranking',
      stats   : 'GET  /api/v1/stats',
      scrape  : 'POST /api/v1/scrape             (admin)',
      keys    : 'CRUD /api/v1/admin/keys         (admin)',
      clubs_admin: 'PATCH /api/v1/admin/clubs/:id  (admin)',
    },
  });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Klootschieten API  →  http://localhost:${PORT}`);
  console.log(`CORS origin: ${CORS_ORIGIN}`);
  console.log(`Auto-scrape: ${CRON_SCHED}`);
});

// ── Scheduler (weekly + matchday-aware polling) ───────────────────────────────
startMatchdayScheduler(database, CRON_SCHED);

// ── Optional boot scrape ──────────────────────────────────────────────────────
if (SCRAPE_BOOT) {
  console.log('SCRAPE_ON_START=true — scraping now...');
  require('./scraper').runScrape(database)
    .catch(e => console.error('Boot scrape failed:', e.message));
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => { database.close(); process.exit(0); });
process.on('SIGINT',  () => { database.close(); process.exit(0); });
