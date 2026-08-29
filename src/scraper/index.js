'use strict';
/**
 * src/db/index.js
 *
 * Database layer: schema migration, scraper upserts, API key management,
 * match queries with club-access enforcement, and ranking computation.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'matches.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const Database = require('better-sqlite3');

// ─────────────────────────────────────────────────────────────────────────────
//  Open + migrate
// ─────────────────────────────────────────────────────────────────────────────
function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    -- ── Clubs ────────────────────────────────────────────────────────────────
    -- name         = internal canonical key used for normalisation (never changes)
    -- display_name = what the API returns; admin can set this freely
    CREATE TABLE IF NOT EXISTS clubs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL DEFAULT ''
    );

    -- ── Leagues ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS leagues (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL,
      category  TEXT NOT NULL,   -- 'junioren' | 'senioren'
      source    TEXT NOT NULL,   -- 'nkb' | 'tkc'
      UNIQUE(name, source)
    );

    -- ── Teams ────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS teams (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id       INTEGER NOT NULL REFERENCES clubs(id),
      team_nr       INTEGER NOT NULL DEFAULT 1,
      display_name  TEXT    NOT NULL,
      UNIQUE(club_id, team_nr)
    );

    -- ── Matches ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS matches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT    NOT NULL,
      league_id     INTEGER NOT NULL REFERENCES leagues(id),
      home_team_id  INTEGER NOT NULL REFERENCES teams(id),
      away_team_id  INTEGER NOT NULL REFERENCES teams(id),
      match_date    TEXT,
      match_time    TEXT,
      speeldag      INTEGER,
      home_score    INTEGER,
      away_score    INTEGER,
      location      TEXT,
      source_url    TEXT,
      fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, league_id, home_team_id, away_team_id, match_date)
    );

    -- ── API keys ─────────────────────────────────────────────────────────────
    -- Raw key is never stored; only its SHA-256 hash.
    -- role: 'admin' can manage keys + trigger scrapes
    --       'reader' can only read data
    -- If no api_key_clubs rows exist for a key, the key has access to ALL clubs.
    CREATE TABLE IF NOT EXISTS api_keys (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash    TEXT    NOT NULL UNIQUE,
      label       TEXT    NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'reader',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      last_used   TEXT
    );

    -- ── Per-key club access list ──────────────────────────────────────────────
    -- Empty set  → full access to all clubs
    -- Non-empty  → restricted to only those clubs
    CREATE TABLE IF NOT EXISTS api_key_clubs (
      api_key_id  INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      club_id     INTEGER NOT NULL REFERENCES clubs(id)    ON DELETE CASCADE,
      PRIMARY KEY (api_key_id, club_id)
    );

    -- ── Scrape log ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS scrape_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT,
      status          TEXT,
      matches_added   INTEGER DEFAULT 0,
      matches_updated INTEGER DEFAULT 0,
      error_msg       TEXT
    );

    -- ── Indexes ──────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_match_date      ON matches(match_date);

    CREATE INDEX IF NOT EXISTS idx_match_league    ON matches(league_id);
    CREATE INDEX IF NOT EXISTS idx_match_home      ON matches(home_team_id);
    CREATE INDEX IF NOT EXISTS idx_match_away      ON matches(away_team_id);
    CREATE INDEX IF NOT EXISTS idx_league_category ON leagues(category);
    CREATE INDEX IF NOT EXISTS idx_team_club       ON teams(club_id);
    CREATE INDEX IF NOT EXISTS idx_apikey_hash     ON api_keys(key_hash);
  `);

  // ── Non-destructive column additions for pre-existing databases ──────────
  // SQLite has no IF NOT EXISTS for ALTER TABLE, so we probe via PRAGMA first.
  const clubCols = db.prepare('PRAGMA table_info(clubs)').all().map(c => c.name);
  if (!clubCols.includes('display_name')) {
    db.exec("ALTER TABLE clubs ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    // Seed display_name = name for rows that pre-date this column
    db.exec("UPDATE clubs SET display_name = name WHERE display_name = ''");
    console.log('[migrate] Added display_name column to clubs table');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  API key management
// ─────────────────────────────────────────────────────────────────────────────

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateRawKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Resolve a raw Bearer token → principal or null.
 * Returns { id, label, role, clubIds }
 *   clubIds = []  → unrestricted (access to all clubs)
 *   clubIds = [1,2,…] → restricted to those club IDs
 */
function resolveApiKey(db, rawKey) {
  if (!rawKey) return null;
  const hash = hashKey(rawKey);
  const row  = db.prepare(
    "SELECT id, label, role, active FROM api_keys WHERE key_hash = ?"
  ).get(hash);

  if (!row || !row.active) return null;

  db.prepare("UPDATE api_keys SET last_used = datetime('now') WHERE id = ?").run(row.id);

  const clubRows = db.prepare(
    "SELECT club_id FROM api_key_clubs WHERE api_key_id = ?"
  ).all(row.id);

  return {
    id     : row.id,
    label  : row.label,
    role   : row.role,
    clubIds: clubRows.map(r => r.club_id),
  };
}

/**
 * Create a new API key.
 * clubIds: []  → unrestricted;  [1,2,…] → restricted
 * Returns { rawKey, id }  — rawKey shown only once!
 */
function createApiKey(db, { label, role = 'reader', clubIds = [] }) {
  const rawKey = generateRawKey();
  const hash   = hashKey(rawKey);
  const id = db.prepare(
    "INSERT INTO api_keys (key_hash, label, role) VALUES (?, ?, ?)"
  ).run(hash, label, role).lastInsertRowid;

  if (clubIds.length > 0) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO api_key_clubs (api_key_id, club_id) VALUES (?, ?)"
    );
    db.transaction(() => clubIds.forEach(cid => ins.run(id, cid)))();
  }

  return { rawKey, id };
}

/** List all keys (no raw key / hash exposed). */
function listApiKeys(db) {
  return db.prepare(`
    SELECT k.id, k.label, k.role, k.active, k.created_at, k.last_used,
      GROUP_CONCAT(c.name, ', ') AS club_access
    FROM api_keys k
    LEFT JOIN api_key_clubs akc ON akc.api_key_id = k.id
    LEFT JOIN clubs c ON c.id = akc.club_id
    GROUP BY k.id ORDER BY k.id
  `).all().map(k => ({
    ...k,
    active      : !!k.active,
    club_access : k.club_access ? k.club_access.split(', ') : [],  // [] = all
  }));
}

/** Replace the club-access list for a key. Pass [] to grant full access. */
function setKeyClubs(db, keyId, clubIds) {
  db.transaction(() => {
    db.prepare("DELETE FROM api_key_clubs WHERE api_key_id = ?").run(keyId);
    const ins = db.prepare(
      "INSERT INTO api_key_clubs (api_key_id, club_id) VALUES (?, ?)"
    );
    clubIds.forEach(cid => ins.run(keyId, cid));
  })();
}

function setKeyActive(db, keyId, active) {
  db.prepare("UPDATE api_keys SET active = ? WHERE id = ?").run(active ? 1 : 0, keyId);
}

function deleteApiKey(db, keyId) {
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(keyId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scraper upsert helpers
// ─────────────────────────────────────────────────────────────────────────────
function getOrCreateClub(db, name) {
  const row = db.prepare('SELECT id FROM clubs WHERE name = ?').get(name);
  if (row) return row.id;
  // display_name defaults to the canonical name; admin can override it later
  return db.prepare('INSERT INTO clubs (name, display_name) VALUES (?, ?)').run(name, name).lastInsertRowid;
}

/** Admin: set the human-readable display name for a club. */
function setClubDisplayName(db, clubId, displayName) {
  const info = db.prepare('UPDATE clubs SET display_name = ? WHERE id = ?').run(displayName, clubId);
  if (info.changes === 0) throw new Error('Club not found');
}

function getOrCreateLeague(db, { name, category, source }) {
  const row = db.prepare(
    'SELECT id FROM leagues WHERE name = ? AND source = ?'
  ).get(name, source);
  if (row) return row.id;
  return db.prepare(
    'INSERT INTO leagues (name, category, source) VALUES (?, ?, ?)'
  ).run(name, category, source).lastInsertRowid;
}

function getOrCreateTeam(db, { clubId, teamNr, displayName }) {
  const row = db.prepare(
    'SELECT id FROM teams WHERE club_id = ? AND team_nr = ?'
  ).get(clubId, teamNr);
  if (row) return row.id;
  return db.prepare(
    'INSERT INTO teams (club_id, team_nr, display_name) VALUES (?, ?, ?)'
  ).run(clubId, teamNr, displayName).lastInsertRowid;
}

function upsertMatch(db, row) {
  const existing = db.prepare(`
    SELECT id, home_score, away_score FROM matches
    WHERE source = ? AND league_id = ? AND home_team_id = ? AND away_team_id = ?
      AND (match_date = ? OR (match_date IS NULL AND ? IS NULL))
  `).get(row.source, row.league_id, row.home_team_id, row.away_team_id,
         row.match_date, row.match_date);

  if (!existing) {
    db.prepare(`
      INSERT INTO matches (source, league_id, home_team_id, away_team_id,
        match_date, match_time, speeldag, home_score, away_score, location, source_url)
      VALUES (@source, @league_id, @home_team_id, @away_team_id,
        @match_date, @match_time, @speeldag, @home_score, @away_score, @location, @source_url)
    `).run(row);
    return 'added';
  }

  if (existing.home_score !== row.home_score || existing.away_score !== row.away_score) {
    db.prepare(`
      UPDATE matches SET home_score = @home_score, away_score = @away_score,
        match_time = @match_time, location = @location, fetched_at = datetime('now')
      WHERE id = @id
    `).run({ ...row, id: existing.id });
    return 'updated';
  }

  return 'unchanged';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Core SELECT fragment
// ─────────────────────────────────────────────────────────────────────────────
const MATCH_SELECT = `
  SELECT
    m.id, m.source, l.category, l.name AS league,
    m.match_date, m.match_time, m.speeldag,
    ht.display_name AS home_team, at.display_name AS away_team,
    COALESCE(NULLIF(hc.display_name,''), hc.name) AS home_club,
    COALESCE(NULLIF(ac.display_name,''), ac.name) AS away_club,
    ht.team_nr AS home_team_nr,   at.team_nr AS away_team_nr,
    m.home_score, m.away_score, m.location, m.source_url, m.fetched_at
  FROM matches m
  JOIN leagues l  ON l.id = m.league_id
  JOIN teams   ht ON ht.id = m.home_team_id
  JOIN teams   at ON at.id = m.away_team_id
  JOIN clubs   hc ON hc.id = ht.club_id
  JOIN clubs   ac ON ac.id = at.club_id
`;

/**
 * Build WHERE clause conditions + bound params.
 * clubIds restricts results to matches where either team belongs to those clubs.
 */
function buildMatchConditions(filters, clubIds = []) {
  const conditions = [];
  const params     = {};

  if (filters.date)     { conditions.push('m.match_date = :date');            params.date     = filters.date; }
  if (filters.from)     { conditions.push('m.match_date >= :from');           params.from     = filters.from; }
  if (filters.to)       { conditions.push('m.match_date <= :to');             params.to       = filters.to; }
  if (filters.league)   { conditions.push("l.name LIKE '%'||:league||'%'");   params.league   = filters.league; }
  if (filters.category) { conditions.push('l.category = :category');          params.category = filters.category.toLowerCase(); }
  if (filters.source)   { conditions.push('m.source = :source');              params.source   = filters.source.toLowerCase(); }
  if (filters.speeldag) { conditions.push('m.speeldag = :speeldag');          params.speeldag = parseInt(filters.speeldag, 10); }

  if (filters.club) {
    conditions.push("(hc.name LIKE '%'||:club||'%' OR hc.display_name LIKE '%'||:club||'%' OR ac.name LIKE '%'||:club||'%' OR ac.display_name LIKE '%'||:club||'%')");
    params.club = filters.club;
  }
  if (filters.team) {
    conditions.push("(ht.display_name LIKE '%'||:team||'%' OR at.display_name LIKE '%'||:team||'%')");
    params.team = filters.team;
  }
  if (filters.played === 'true'  || filters.played === true)  conditions.push('m.home_score IS NOT NULL');
  if (filters.played === 'false' || filters.played === false) conditions.push('m.home_score IS NULL');

  // Club-access restriction: only matches involving at least one of the allowed clubs
  if (clubIds.length > 0) {
    const ph = clubIds.map((_, i) => `:cid${i}`).join(', ');
    conditions.push(`(ht.club_id IN (${ph}) OR at.club_id IN (${ph}))`);
    clubIds.forEach((id, i) => { params[`cid${i}`] = id; });
  }

  return { conditions, params };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Match queries
// ─────────────────────────────────────────────────────────────────────────────
function queryMatches(db, filters = {}, clubIds = []) {
  const { conditions, params } = buildMatchConditions(filters, clubIds);
  const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit  = Math.min(parseInt(filters.limit  || 100, 10), 500);
  const offset = parseInt(filters.offset || 0, 10);

  const rows = db.prepare(`
    ${MATCH_SELECT} ${where}
    ORDER BY m.match_date ASC, m.match_time ASC, l.name ASC, ht.display_name ASC
    LIMIT ${limit} OFFSET ${offset}
  `).all(params);

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM matches m
    JOIN leagues l  ON l.id = m.league_id
    JOIN teams  ht  ON ht.id = m.home_team_id
    JOIN teams  at  ON at.id = m.away_team_id
    JOIN clubs  hc  ON hc.id = ht.club_id
    JOIN clubs  ac  ON ac.id = at.club_id
    ${where}
  `).get(params).n;

  return { rows, total, limit, offset };
}

function getMatchById(db, id, clubIds = []) {
  const { conditions, params } = buildMatchConditions({}, clubIds);
  conditions.push('m.id = :matchId');
  params.matchId = id;
  const where = 'WHERE ' + conditions.join(' AND ');
  return db.prepare(`${MATCH_SELECT} ${where}`).get(params);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rankings
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Klootschieten points:
 *   Each match produces 4 points total to distribute (though 2-2 is also common).
 *   The score IS the points: home_score goes to home team, away_score to away team.
 *   e.g. 4-0 → home +4, away +0
 *        3-1 → home +3, away +1
 *        2-2 → home +2, away +2
 *
 * Ranking tiebreakers (in order):
 *   1. Points (desc)
 *   2. Wins (desc)
 *   3. Points for (desc)
 *   4. Matches played (asc — fewer played = higher up if same points)
 *   5. Team name (asc)
 *
 * Supports same filters as queryMatches (league, category, source, team, etc.)
 * plus clubIds access restriction.
 */
function computeRanking(db, filters = {}, clubIds = []) {
  // ── Step 1: seed every team that appears in ANY match for these filters ──
  // We query all matches (played or not) to find all participating teams,
  // then initialise them with zero stats. This ensures teams with no played
  // matches still appear in the ranking.
  const allFilters = { ...filters };
  delete allFilters.played;   // include both played and unplayed for seeding
  const { conditions: allConds, params: allParams } = buildMatchConditions(allFilters, clubIds);
  const allWhere = allConds.length ? 'WHERE ' + allConds.join(' AND ') : '';

  const allMatches = db.prepare(`${MATCH_SELECT} ${allWhere} ORDER BY m.match_date ASC`).all(allParams);

  const stats = {};

  function getOrInit(teamName, clubName) {
    if (!stats[teamName]) {
      stats[teamName] = {
        team          : teamName,
        club          : clubName,
        played        : 0,
        won           : 0,
        drawn         : 0,
        lost          : 0,
        points_for    : 0,
        points_against: 0,
        points        : 0,
      };
    }
    return stats[teamName];
  }

  // Seed all teams with zeros
  for (const m of allMatches) {
    getOrInit(m.home_team, m.home_club);
    getOrInit(m.away_team, m.away_club);
  }

  // ── Step 2: accumulate stats from played matches only ───────────────────
  const played = allMatches.filter(m => m.home_score !== null && m.away_score !== null);

  for (const m of played) {
    const home = getOrInit(m.home_team, m.home_club);
    const away = getOrInit(m.away_team, m.away_club);

    home.played++;
    away.played++;

    home.points_for     += m.home_score;
    home.points_against += m.away_score;
    away.points_for     += m.away_score;
    away.points_against += m.home_score;

    home.points += m.home_score;
    away.points += m.away_score;

    if (m.home_score > m.away_score)      { home.won++;   away.lost++;  }
    else if (m.home_score < m.away_score) { away.won++;   home.lost++;  }
    else                                   { home.drawn++; away.drawn++; }
  }

  return Object.values(stats)
    .sort((a, b) =>
      (b.points       - a.points)       ||
      (b.won          - a.won)          ||
      (b.points_for   - a.points_for)   ||
      (a.played       - b.played)       ||
      a.team.localeCompare(b.team)
    )
    .map((r, i) => ({ position: i + 1, ...r }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Misc lookups
// ─────────────────────────────────────────────────────────────────────────────
function getLeagues(db, filters = {}) {
  const conds  = [];
  const params = {};
  if (filters.category) { conds.push('category = :category'); params.category = filters.category; }
  if (filters.source)   { conds.push('source = :source');     params.source   = filters.source; }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.prepare(
    `SELECT * FROM leagues ${where} ORDER BY category, source, name`
  ).all(params);
}

function getClubs(db) {
  return db.prepare(`
    SELECT c.id, c.name,
      COALESCE(NULLIF(c.display_name,''), c.name) AS display_name,
      COUNT(DISTINCT t.id) AS teams_count
    FROM clubs c LEFT JOIN teams t ON t.club_id = c.id
    GROUP BY c.id ORDER BY c.name
  `).all();
}

function getTeams(db, filters = {}, clubIds = []) {
  const conds  = [];
  const params = {};
  if (filters.club) {
    conds.push("(c.name LIKE '%'||:club||'%' OR c.display_name LIKE '%'||:club||'%')");
    params.club = filters.club;
  }
  if (clubIds.length > 0) {
    const ph = clubIds.map((_, i) => `:cid${i}`).join(', ');
    conds.push(`c.id IN (${ph})`);
    clubIds.forEach((id, i) => { params[`cid${i}`] = id; });
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.prepare(`
    SELECT t.id, t.display_name, t.team_nr,
      COALESCE(NULLIF(c.display_name,''), c.name) AS club
    FROM teams t JOIN clubs c ON c.id = t.club_id
    ${where} ORDER BY c.name, t.team_nr
  `).all(params);
}

function getLastScrapeInfo(db) {
  return db.prepare('SELECT * FROM scrape_log ORDER BY id DESC LIMIT 1').get();
}

function getStats(db) {
  return {
    matches_total   : db.prepare('SELECT COUNT(*) AS n FROM matches').get().n,
    matches_played  : db.prepare('SELECT COUNT(*) AS n FROM matches WHERE home_score IS NOT NULL').get().n,
    matches_pending : db.prepare('SELECT COUNT(*) AS n FROM matches WHERE home_score IS NULL').get().n,
    clubs_total     : db.prepare('SELECT COUNT(*) AS n FROM clubs').get().n,
    teams_total     : db.prepare('SELECT COUNT(*) AS n FROM teams').get().n,
    leagues_total   : db.prepare('SELECT COUNT(*) AS n FROM leagues').get().n,
    last_scrape     : getLastScrapeInfo(db),
    by_source       : db.prepare(`
      SELECT source, category, COUNT(*) AS matches
      FROM matches m JOIN leagues l ON l.id = m.league_id
      GROUP BY source, category
    `).all(),
  };
}

module.exports = {
  // club display name
  setClubDisplayName,
  openDb,
  // scraper
  getOrCreateClub, getOrCreateLeague, getOrCreateTeam, upsertMatch,
  // api key management
  resolveApiKey, createApiKey, listApiKeys, setKeyClubs, setKeyActive, deleteApiKey,
  // queries
  queryMatches, getMatchById, computeRanking,
  getLeagues, getClubs, getTeams, getStats, getLastScrapeInfo,
};
