# Klootschieten API

REST API + automatic scraper for klootschieten match data.

**Data sources**

| Website | Technique |
|---------|-----------|
| [nkbuitslagen.nl](https://nkbuitslagen.nl) | Playwright (JavaScript-rendered tables) |
| [tkc-klootschieten.nl/programma](https://www.tkc-klootschieten.nl/programma/) | fetch + cheerio (plain HTML) |

Data is stored in a local **SQLite database** (`./data/matches.db`) and served via a **REST API** that club websites can query directly from the browser.

---

## Quick start

```bash
git clone <repo> klootschieten-api
cd klootschieten-api
bash setup.sh

# First run: set your admin key in the environment
cp .env.example .env
# Edit .env — set ADMIN_KEY to a long random string (openssl rand -hex 32)

# Populate the database
node src/jobs/scrape.js

# Start the API server
node src/server.js
```

The server listens on **http://localhost:3000** by default.

---

## Authentication

**Every endpoint** (except `GET /api/v1/health`) requires a valid API key.

Send the key in **one** of these ways:

```
Authorization: Bearer <key>
X-Api-Key: <key>
?api_key=<key>          ← handy for quick browser/curl tests
```

### Roles

| Role | Can do |
|------|--------|
| `reader` | Read all endpoints (`/matches`, `/ranking`, `/clubs`, etc.) |
| `admin`  | Everything a reader can + trigger scrapes + manage API keys |

### Club-level access control

Each API key can be restricted to **one or more clubs**. A restricted key only sees matches where at least one of the teams belongs to its allowed clubs. Unrestricted keys (club list = empty) see all data.

This lets you give a club website a key that only exposes their own fixtures and standings.

---

## First-time setup: bootstrap admin key

On first startup, set the `ADMIN_KEY` environment variable to the raw key string you want to use as the first admin. The server registers its hash and confirms in the log. **Remove** `ADMIN_KEY` from the environment afterwards.

```bash
# Generate a secure key
openssl rand -hex 32
# → e.g. a3f8c2d1e9b7…

# Add to .env
ADMIN_KEY=a3f8c2d1e9b7…

# Start once — it logs confirmation, then remove ADMIN_KEY
node src/server.js
```

Use that admin key to create reader keys for club websites via the `/admin/keys` endpoints.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/matches.db` | SQLite database path |
| `CORS_ORIGIN` | `*` | Allowed browser origins (comma-separated, or `*`) |
| `ADMIN_KEY` | — | Bootstrap admin key (first run only, then remove) |
| `SCRAPE_CRON` | `0 23 * * 0` | Cron schedule for automatic scraping |
| `SCRAPE_ON_START` | `false` | Scrape on server startup |

---

## CORS

The API sends `Access-Control-Allow-Origin` headers, so club websites can call it **directly from the browser** — no proxy needed.

```javascript
// Example: fetch upcoming matches on a club website
const res  = await fetch('https://api.myserver.nl/api/v1/matches?played=false&club=Brink', {
  headers: { 'X-Api-Key': 'your-reader-key' }
});
const json = await res.json();
// json.data = array of matches
```

If you want to restrict browser access to specific domains:
```
CORS_ORIGIN=https://klootschieten.brink.nl,https://www.hertme.nl
```

---

## API reference

Base URL: `http://localhost:3000/api/v1`

All responses:
```json
{ "ok": true, "data": [...], "total": 42, "limit": 100, "offset": 0, "returned": 42 }
```

---

### `GET /api/v1/health` *(public)*

Health check — no API key required.

---

### `GET /api/v1/matches`

List matches. Supports rich filtering.

| Param | Type | Description |
|-------|------|-------------|
| `date` | YYYY-MM-DD | Exact date |
| `from` | YYYY-MM-DD | Range start |
| `to` | YYYY-MM-DD | Range end |
| `league` | text | Partial match on league name |
| `club` | text | Partial match on home or away club |
| `team` | text | Partial match on team name (e.g. `Brink 3`) |
| `category` | `senioren`\|`junioren` | Category filter |
| `source` | `nkb`\|`tkc` | Source filter |
| `played` | `true`\|`false` | Filter by whether result is known |
| `speeldag` | integer | Round number |
| `limit` | integer | Max rows (default 100, max 500) |
| `offset` | integer | Pagination offset |

```
GET /api/v1/matches?date=2025-09-14
GET /api/v1/matches?club=brink&category=senioren
GET /api/v1/matches?league=Klasse+1&from=2025-09-01&to=2026-04-30
GET /api/v1/matches?team=Soasel+2
GET /api/v1/matches?played=false
GET /api/v1/matches?limit=20&offset=40
```

**Match object:**
```json
{
  "id": 42,
  "source": "tkc",
  "category": "senioren",
  "league": "TKC Klasse 1",
  "match_date": "2025-09-14",
  "match_time": "10:00",
  "speeldag": 1,
  "home_team": "Brink 3",
  "away_team": "Soasel 1",
  "home_club": "Brink",
  "away_club": "Soasel",
  "home_team_nr": 3,
  "away_team_nr": 1,
  "home_score": 4,
  "away_score": 0,
  "location": "Klootschietvereniging De Brink",
  "source_url": "https://www.tkc-klootschieten.nl/programma/",
  "fetched_at": "2025-09-20T18:00:00"
}
```

---

### `GET /api/v1/matches/:id`

Single match by id.

---

### `GET /api/v1/leagues`

All competitions. Optional params: `category`, `source`.

---

### `GET /api/v1/clubs`

All clubs. Restricted keys only see their own clubs.

Each club has an internal **canonical name** (used for cross-site deduplication) and a **display name** shown in all API responses. They start out identical; use `PATCH /api/v1/admin/clubs/:id` to customise the display name without affecting normalisation.

**Response:**
```json
[
  { "id": 1, "name": "Brink", "display_name": "K.V. De Brink", "teams_count": 7 },
  { "id": 2, "name": "Hertme", "display_name": "Hertme",        "teams_count": 9 }
]
```

---

### `GET /api/v1/clubs/:name/teams`

Teams for a specific club (e.g. `/api/v1/clubs/Brink/teams`).

---

### `GET /api/v1/teams`

All teams. Optional param: `club` (partial text filter).

---

### `GET /api/v1/ranking`

**Standings table** calculated from played matches.

#### Klootschieten scoring

The score value *is* the ranking point earned:

| Result | Home gets | Away gets |
|--------|-----------|-----------|
| 4 – 0  | 4 pts     | 0 pts     |
| 3 – 1  | 3 pts     | 1 pt      |
| 2 – 2  | 2 pts     | 2 pts     |

Tiebreakers (in order): total points → wins → points scored → matches played (asc) → team name.

Accepts the same filters as `/matches`:

```
GET /api/v1/ranking?league=TKC+Klasse+1
GET /api/v1/ranking?category=junioren&source=nkb
GET /api/v1/ranking?club=hertme          ← ranking within Hertme's matches
GET /api/v1/ranking?team=Brink+3         ← single team's record
GET /api/v1/ranking?league=TKC+Klasse+1&to=2025-11-01  ← standings at a point in time
```

**Ranking row:**
```json
{
  "position": 1,
  "team": "Brink 3",
  "club": "Brink",
  "played": 8,
  "won": 6,
  "drawn": 1,
  "lost": 1,
  "points_for": 26,
  "points_against": 6,
  "points": 26
}
```

---

### `GET /api/v1/stats`

Database statistics and last scrape info.

---

### `POST /api/v1/scrape` *(admin)*

Trigger a scrape in the background. Returns immediately with a `log_id`. Monitor progress via `/api/v1/stats → last_scrape`.

---

### Admin — API key management

All endpoints require `role: admin`.

#### `GET /api/v1/admin/keys`
List all keys (raw key values are never returned after creation).

**Response:**
```json
[
  {
    "id": 1,
    "label": "Website Brink",
    "role": "reader",
    "active": true,
    "created_at": "2025-09-20T18:00:00",
    "last_used": "2025-11-17T10:23:44",
    "club_access": ["Brink"]
  },
  {
    "id": 2,
    "label": "Read-all key",
    "role": "reader",
    "active": true,
    "club_access": []
  }
]
```

`club_access: []` means **unrestricted** (access to all clubs).

---

#### `POST /api/v1/admin/keys`
Create a new key. **The raw key is shown exactly once — save it.**

```json
// Request body
{
  "label": "Website Brink",
  "role": "reader",
  "club_names": ["Brink"]
}

// Unrestricted reader key (no club_names or empty array):
{ "label": "Dashboard admin" }

// Admin key:
{ "label": "Deploy key", "role": "admin" }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": 3,
    "label": "Website Brink",
    "role": "reader",
    "club_access": ["Brink"],
    "raw_key": "a3f8c2d1e9b7…",
    "warning": "Save this key now — it will not be shown again."
  }
}
```

---

#### `PATCH /api/v1/admin/keys/:id`
Update a key's club access or active status.

```json
// Revoke
{ "active": false }

// Restrict to two clubs
{ "club_names": ["Brink", "Hertme"] }

// Remove all restrictions
{ "club_names": [] }

// Both at once
{ "active": true, "club_names": ["Soasel"] }
```

---

#### `DELETE /api/v1/admin/keys/:id`
Permanently delete a key.

---

## Browser / JavaScript usage

```javascript
const API_BASE = 'https://api.myserver.nl/api/v1';
const KEY      = 'your-reader-key';

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Api-Key': KEY }
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

// Upcoming matches for Brink
const upcoming = await apiGet('/matches?club=Brink&played=false');

// Current standings for TKC Klasse 1
const standing = await apiGet('/ranking?league=TKC+Klasse+1');

// All Senioren results this season
const results  = await apiGet('/matches?category=senioren&played=true&limit=200');
```

---

### Admin — club display names

All endpoints require `role: admin`.

#### `GET /api/v1/admin/clubs`

List all clubs with both their internal canonical name and their current display name. Use this to find the `id` to pass to the PATCH endpoint.

#### `PATCH /api/v1/admin/clubs/:id`

Set the human-readable display name for a club. This is what appears in every API response (`home_club`, `away_club`, ranking `club` field). The internal canonical name used for scraper deduplication never changes.

Pass an empty string `""` to reset back to the canonical name.

```bash
# Find club IDs
curl -H "X-Api-Key: $ADMIN_KEY" https://api.example.nl/api/v1/admin/clubs

# Set display name
curl -X PATCH https://api.example.nl/api/v1/admin/clubs/1 \
  -H "X-Api-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"display_name": "K.V. De Brink"}'

# Reset to canonical name
curl -X PATCH https://api.example.nl/api/v1/admin/clubs/1 \
  -H "X-Api-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"display_name": ""}'
```

**Response** — the updated club object:
```json
{
  "ok": true,
  "data": { "id": 1, "name": "Brink", "display_name": "K.V. De Brink", "teams_count": 7 }
}
```

---

## Database structure

```
clubs          id, name (canonical), display_name
leagues        id, name, category, source
teams          id, club_id, team_nr, display_name
matches        id, source, league_id, home_team_id, away_team_id,
               match_date, match_time, speeldag,
               home_score, away_score, location, source_url, fetched_at
api_keys       id, key_hash, label, role, active, created_at, last_used
api_key_clubs  api_key_id, club_id   ← empty = unrestricted
scrape_log     id, started_at, finished_at, status, matches_added, matches_updated, error_msg
```

Raw API keys are **never stored** — only their SHA-256 hash.

---

## Automatic scraping

The server uses a **two-tier schedule**:

### Non-matchdays

A weekly scrape runs on the `SCRAPE_CRON` schedule (default: every Sunday at 23:00) to pull in newly published fixtures and programme changes.

### Matchdays

When the database contains matches scheduled for today, the scheduler automatically switches to frequent polling between **10:00 and 22:00**:

| Window | Interval |
|--------|----------|
| 10:00 – 14:00 | every 20 min |
| 14:00 – 18:00 | every 10 min |
| 18:00 – 22:00 | every 20 min |

As soon as **all matches for that date have a score**, polling stops immediately — no unnecessary requests for the rest of the day.

The detection is automatic: no configuration needed. Any day with at least one match row in the database for that date is treated as a matchday.

### Without the server (standalone cron job)

```bash
# crontab -e
0 23 * * 0  cd /path/to/klootschieten-api && node src/jobs/scrape.js >> logs/scrape.log 2>&1
```

Note: the standalone job does not have matchday-aware polling — run the server for that.

---

## Production deployment (PM2)

```bash
npm install -g pm2

pm2 start src/server.js --name klootschieten-api \
  --env PORT=3000 \
  --env CORS_ORIGIN="https://myclub.nl" \
  --env SCRAPE_ON_START=true

pm2 save
pm2 startup
```
