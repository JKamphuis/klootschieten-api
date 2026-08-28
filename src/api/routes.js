'use strict';
/**
 * src/api/routes.js
 *
 * ── Public (no key needed) ────────────────────────────────────────────────
 *   GET  /api/v1/health
 *
 * ── Reader (any valid API key) ────────────────────────────────────────────
 *   GET  /api/v1/matches
 *   GET  /api/v1/matches/:id
 *   GET  /api/v1/leagues
 *   GET  /api/v1/clubs
 *   GET  /api/v1/clubs/:name/teams
 *   GET  /api/v1/teams
 *   GET  /api/v1/ranking
 *   GET  /api/v1/stats
 *
 * ── Admin only ────────────────────────────────────────────────────────────
 *   POST  /api/v1/scrape
 *   GET   /api/v1/admin/keys
 *   POST  /api/v1/admin/keys
 *   GET   /api/v1/admin/keys/:id
 *   PATCH /api/v1/admin/keys/:id
 *   DELETE /api/v1/admin/keys/:id
 *   PATCH /api/v1/admin/clubs/:id   – set display name for a club
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { requireAdmin, requireReader } = require('./auth');
const { runScrape } = require('../scraper');

// ── Shared helpers ────────────────────────────────────────────────────────────
function getDb(req)  { return req.app.locals.db; }

function ok(res, data, meta = {}) {
  res.json({ ok: true, ...meta, data });
}

function fail(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

/** Pull the club-ID restriction list from the authenticated principal. */
function clubIds(req) {
  return req.principal?.clubIds ?? [];
}

/** Pick allowed filter params from query string. */
function pickFilters(query) {
  const allowed = [
    'date', 'from', 'to', 'league', 'club', 'team',
    'category', 'source', 'played', 'speeldag', 'limit', 'offset',
  ];
  return Object.fromEntries(allowed.filter(k => query[k] !== undefined).map(k => [k, query[k]]));
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC
// ─────────────────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'klootschieten-api', version: '2.0' });
});

// ─────────────────────────────────────────────────────────────────────────────
//  MATCHES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/matches
 *
 * Query params (all optional):
 *   date       YYYY-MM-DD   exact match date
 *   from       YYYY-MM-DD   range start
 *   to         YYYY-MM-DD   range end
 *   league     text         partial match on league name
 *   club       text         partial match on home or away club name
 *   team       text         partial match on home or away team display name
 *   category   senioren | junioren
 *   source     nkb | tkc
 *   played     true | false
 *   speeldag   integer
 *   limit      integer (default 100, max 500)
 *   offset     integer (default 0)
 */
router.get('/matches', requireReader, (req, res) => {
  try {
    const { rows, total, limit, offset } = db.queryMatches(
      getDb(req), pickFilters(req.query), clubIds(req)
    );
    ok(res, rows, { total, limit, offset, returned: rows.length });
  } catch (e) {
    console.error(e);
    fail(res, 500, e.message);
  }
});

/** GET /api/v1/matches/:id */
router.get('/matches/:id', requireReader, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return fail(res, 400, 'Invalid id');
  const match = db.getMatchById(getDb(req), id, clubIds(req));
  if (!match) return fail(res, 404, 'Match not found or not accessible');
  ok(res, match);
});

// ─────────────────────────────────────────────────────────────────────────────
//  LEAGUES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/leagues
 * Query params: category, source
 */
router.get('/leagues', requireReader, (req, res) => {
  try {
    const filters = {};
    if (req.query.category) filters.category = req.query.category;
    if (req.query.source)   filters.source   = req.query.source;
    ok(res, db.getLeagues(getDb(req), filters));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CLUBS & TEAMS
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/clubs */
router.get('/clubs', requireReader, (req, res) => {
  try {
    // Readers with restricted access only see their own clubs
    const ids = clubIds(req);
    let clubs = db.getClubs(getDb(req));
    if (ids.length > 0) clubs = clubs.filter(c => ids.includes(c.id));
    ok(res, clubs);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** GET /api/v1/clubs/:name/teams */
router.get('/clubs/:name/teams', requireReader, (req, res) => {
  try {
    const teams = db.getTeams(getDb(req), { club: req.params.name }, clubIds(req));
    ok(res, teams);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/**
 * GET /api/v1/teams
 * Query params: club (partial text filter)
 */
router.get('/teams', requireReader, (req, res) => {
  try {
    const filters = req.query.club ? { club: req.query.club } : {};
    ok(res, db.getTeams(getDb(req), filters, clubIds(req)));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  RANKING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/ranking
 *
 * Returns a standings table calculated from played matches.
 *
 * Klootschieten scoring: the score value IS the ranking point.
 *   4-0 → winner +4, loser +0
 *   3-1 → winner +3, loser +1
 *   2-2 → both +2
 *
 * Accepts the same filters as /matches (league, category, source, club, team,
 * from, to, speeldag) so you can compute the ranking for any subset.
 *
 * Query params:
 *   league     text     — most useful: filter to one competition
 *   category   text     — junioren | senioren
 *   source     text     — nkb | tkc
 *   club       text     — show ranking filtered to a specific club's matches
 *   team       text     — show ranking for a specific team's matches
 *   from/to    dates    — ranking for a date range
 *   speeldag   integer  — ranking after a specific round
 */
router.get('/ranking', requireReader, (req, res) => {
  try {
    const filters = pickFilters(req.query);
    const ranking = db.computeRanking(getDb(req), filters, clubIds(req));
    ok(res, ranking, { teams: ranking.length });
  } catch (e) {
    console.error(e);
    fail(res, 500, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  STATS
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/stats */
router.get('/stats', requireReader, (req, res) => {
  try {
    ok(res, db.getStats(getDb(req)));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SCRAPE  (admin only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/scrape
 * Triggers a background scrape. Responds immediately with a log_id.
 * Check progress via GET /api/v1/stats → last_scrape.
 */
router.post('/scrape', requireAdmin, (req, res) => {
  const database = getDb(req);
  const logId = database.prepare(
    "INSERT INTO scrape_log (status) VALUES ('running')"
  ).run().lastInsertRowid;

  res.json({ ok: true, data: { message: 'Scrape started', log_id: logId } });

  runScrape(database)
    .then(s => {
      database.prepare(`
        UPDATE scrape_log SET finished_at = datetime('now'), status = 'ok',
          matches_added = ?, matches_updated = ? WHERE id = ?
      `).run(s.added, s.updated, logId);
    })
    .catch(e => {
      database.prepare(`
        UPDATE scrape_log SET finished_at = datetime('now'), status = 'error',
          error_msg = ? WHERE id = ?
      `).run(e.message, logId);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — API key management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/keys
 * List all API keys (no raw key values are ever returned).
 */
router.get('/admin/keys', requireAdmin, (req, res) => {
  try {
    ok(res, db.listApiKeys(getDb(req)));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/**
 * POST /api/v1/admin/keys
 * Create a new API key.
 *
 * Body (JSON):
 *   label      string   required — human-readable name, e.g. "Website Brink"
 *   role       string   optional — 'reader' (default) | 'admin'
 *   club_names string[] optional — array of canonical club names to restrict access
 *                                  empty array (or omit) = access to all clubs
 *
 * Response includes the rawKey exactly once — store it securely, it cannot be retrieved again.
 *
 * Example:
 *   { "label": "Website Brink", "club_names": ["Brink"] }
 *   { "label": "Full admin",    "role": "admin" }
 *   { "label": "Read-all" }
 */
router.post('/admin/keys', requireAdmin, (req, res) => {
  const { label, role, club_names } = req.body || {};
  if (!label || typeof label !== 'string') {
    return fail(res, 400, '"label" (string) is required');
  }
  if (role && !['reader', 'admin'].includes(role)) {
    return fail(res, 400, '"role" must be "reader" or "admin"');
  }

  const database  = getDb(req);
  let clubIds_arr = [];

  if (Array.isArray(club_names) && club_names.length > 0) {
    const allClubs = db.getClubs(database);
    clubIds_arr    = [];
    const notFound = [];

    for (const name of club_names) {
      const club = allClubs.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (!club) notFound.push(name);
      else clubIds_arr.push(club.id);
    }

    if (notFound.length > 0) {
      return fail(res, 400, `Unknown club name(s): ${notFound.join(', ')}. ` +
        `Available: ${allClubs.map(c => c.name).join(', ')}`);
    }
  }

  try {
    const { rawKey, id } = db.createApiKey(database, {
      label,
      role: role || 'reader',
      clubIds: clubIds_arr,
    });

    res.status(201).json({
      ok: true,
      data: {
        id,
        label,
        role        : role || 'reader',
        club_access : club_names || [],
        raw_key     : rawKey,
        warning     : 'Save this key now — it will not be shown again.',
      },
    });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/**
 * GET /api/v1/admin/keys/:id
 * Get metadata for a single key (no raw key).
 */
router.get('/admin/keys/:id', requireAdmin, (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const keys = db.listApiKeys(getDb(req));
  const key  = keys.find(k => k.id === id);
  if (!key) return fail(res, 404, 'Key not found');
  ok(res, key);
});

/**
 * PATCH /api/v1/admin/keys/:id
 * Update a key's club access or active status.
 *
 * Body (JSON, all fields optional):
 *   active      boolean   — true to enable, false to revoke
 *   club_names  string[]  — replace club access list ([] = full access)
 *
 * Example — revoke a key:
 *   { "active": false }
 *
 * Example — restrict to two clubs:
 *   { "club_names": ["Brink", "Hertme"] }
 *
 * Example — remove all restrictions:
 *   { "club_names": [] }
 */
router.patch('/admin/keys/:id', requireAdmin, (req, res) => {
  const id       = parseInt(req.params.id, 10);
  const database = getDb(req);

  // Verify key exists
  const keys = db.listApiKeys(database);
  if (!keys.find(k => k.id === id)) return fail(res, 404, 'Key not found');

  const { active, club_names } = req.body || {};

  if (active !== undefined) {
    db.setKeyActive(database, id, !!active);
  }

  if (club_names !== undefined) {
    if (!Array.isArray(club_names)) return fail(res, 400, '"club_names" must be an array');

    let clubIds_arr = [];
    if (club_names.length > 0) {
      const allClubs = db.getClubs(database);
      const notFound = [];
      for (const name of club_names) {
        const club = allClubs.find(c => c.name.toLowerCase() === name.toLowerCase());
        if (!club) notFound.push(name);
        else clubIds_arr.push(club.id);
      }
      if (notFound.length > 0) {
        return fail(res, 400, `Unknown club name(s): ${notFound.join(', ')}`);
      }
    }
    db.setKeyClubs(database, id, clubIds_arr);
  }

  // Return updated key
  const updated = db.listApiKeys(database).find(k => k.id === id);
  ok(res, updated);
});

/**
 * DELETE /api/v1/admin/keys/:id
 * Permanently delete a key.
 */
router.delete('/admin/keys/:id', requireAdmin, (req, res) => {
  const id       = parseInt(req.params.id, 10);
  const database = getDb(req);
  const keys     = db.listApiKeys(database);
  if (!keys.find(k => k.id === id)) return fail(res, 404, 'Key not found');

  db.deleteApiKey(database, id);
  res.json({ ok: true, data: { deleted: id } });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — club display names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/clubs
 * List all clubs with their internal canonical name and current display name.
 * Useful for knowing which IDs / canonical names to reference when renaming.
 */
router.get('/admin/clubs', requireAdmin, (req, res) => {
  try {
    ok(res, db.getClubs(getDb(req)));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/**
 * PATCH /api/v1/admin/clubs/:id
 * Set the human-readable display name for a club.
 *
 * The internal canonical name (used for normalisation / deduplication) never
 * changes. The display name is what every API response returns as home_club /
 * away_club, and what the ranking shows under "club".
 *
 * Body (JSON):
 *   { "display_name": "K.V. De Brink" }
 *
 * Examples:
 *   PATCH /api/v1/admin/clubs/1  { "display_name": "K.V. De Brink" }
 *   PATCH /api/v1/admin/clubs/3  { "display_name": "Klootschietvereniging Hertme" }
 *
 * To reset back to the canonical name, pass the canonical name as display_name,
 * or an empty string (which makes the API fall back to the canonical name automatically).
 */
router.patch('/admin/clubs/:id', requireAdmin, (req, res) => {
  const id          = parseInt(req.params.id, 10);
  const displayName = req.body?.display_name;

  if (!Number.isInteger(id)) return fail(res, 400, 'Invalid id');
  if (typeof displayName !== 'string')
    return fail(res, 400, '"display_name" (string) is required');

  try {
    db.setClubDisplayName(getDb(req), id, displayName.trim());
    const clubs = db.getClubs(getDb(req));
    const updated = clubs.find(c => c.id === id);
    if (!updated) return fail(res, 404, 'Club not found');
    ok(res, updated);
  } catch (e) {
    fail(res, e.message === 'Club not found' ? 404 : 500, e.message);
  }
});

module.exports = router;
