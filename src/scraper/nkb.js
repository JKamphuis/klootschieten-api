'use strict';
/**
 * src/scraper/nkb.js
 *
 * Scrapes all Junioren + Senioren league pages on nkbuitslagen.nl.
 * Tables are JavaScript-rendered, so we use Playwright (headless Chromium).
 */

const cheerio    = require('cheerio');
const playwright = require('playwright');
const { parseTeam } = require('./normalise');

// All league URLs on nkbuitslagen.nl
const LEAGUES = {
  junioren: [
    { name: 'Klasse A', url: 'https://nkbuitslagen.nl/klasse-a-junioren/' },
    { name: 'Klasse B', url: 'https://nkbuitslagen.nl/klasse-b/' },
    { name: 'Klasse C', url: 'https://nkbuitslagen.nl/klasse-c/' },
    { name: 'Klasse D', url: 'https://nkbuitslagen.nl/klasse-d/' },
    { name: 'Klasse E', url: 'https://nkbuitslagen.nl/klasse-e/' },
    { name: 'Klasse F', url: 'https://nkbuitslagen.nl/klasse-f/' },
  ],
  senioren: [
    { name: 'Hoofdklasse', url: 'https://nkbuitslagen.nl/hoofdklasse/' },
    { name: 'Klasse 1 NKB', url: 'https://nkbuitslagen.nl/klasse-1/' },
    { name: 'Klasse 2 NKB', url: 'https://nkbuitslagen.nl/klasse-2/' },
    { name: 'Klasse 3 NKB', url: 'https://nkbuitslagen.nl/klasse-3/' },
    { name: 'Klasse 4 NKB', url: 'https://nkbuitslagen.nl/klasse-4/' },
    { name: 'Klasse 5',     url: 'https://nkbuitslagen.nl/klasse-5/' },
    { name: 'Klasse 6',     url: 'https://nkbuitslagen.nl/klasse-6/' },
    { name: 'Klasse 7',     url: 'https://nkbuitslagen.nl/klasse-7/' },
    { name: 'Klasse 8',     url: 'https://nkbuitslagen.nl/klasse-8/' },
    { name: 'Klasse 9',     url: 'https://nkbuitslagen.nl/klasse-9/' },
    { name: 'Klasse 10',    url: 'https://nkbuitslagen.nl/klasse-10/' },
    { name: 'Klasse 11',    url: 'https://nkbuitslagen.nl/klasse-11/' },
    { name: 'Klasse 12',    url: 'https://nkbuitslagen.nl/klasse-12/' },
  ],
};

// ─── date helpers ────────────────────────────────────────────────────────────

function parseNkbDate(raw) {
  if (!raw) return null;
  // yyyy-mm-dd (possibly with time suffix)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // dd-mm-yyyy
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// ─── per-league scrape ───────────────────────────────────────────────────────

async function scrapeLeague(page, league, category) {
  console.log(`  [NKB] ${category} / ${league.name}`);

  await page.goto(league.url, { waitUntil: 'networkidle', timeout: 30_000 });

  // Wait for at least one data cell in the first table
  try {
    await page.waitForSelector('table:first-of-type tbody tr td', { timeout: 8_000 });
  } catch {
    console.log('    → tabel leeg / seizoen nog niet begonnen');
    return [];
  }

  const html    = await page.content();
  const $       = cheerio.load(html);
  const matches = [];

  // First table = Programmatabel
  // Columns: Klasse | Wedstrijddag | Thuis team | Uit team | Thuis score | Uit score | Verslag
  $('table').first().find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 4) return;

    const dateRaw  = $(cells[1]).text().trim();
    const homeRaw  = $(cells[2]).text().trim();
    const awayRaw  = $(cells[3]).text().trim();
    const scoreH   = $(cells[4])?.text().trim() || '';
    const scoreA   = $(cells[5])?.text().trim() || '';

    if (!homeRaw || !awayRaw) return;

    const homeTeam = parseTeam(homeRaw);
    const awayTeam = parseTeam(awayRaw);

    matches.push({
      source      : 'nkb',
      category,
      league      : league.name,
      match_date  : parseNkbDate(dateRaw),
      match_time  : null,
      speeldag    : null,
      home_team   : homeTeam,
      away_team   : awayTeam,
      home_score  : scoreH !== '' ? parseInt(scoreH, 10) || null : null,
      away_score  : scoreA !== '' ? parseInt(scoreA, 10) || null : null,
      location    : null,
      source_url  : league.url,
    });
  });

  console.log(`    → ${matches.length} wedstrijden`);
  return matches;
}

// ─── main export ─────────────────────────────────────────────────────────────

async function scrapeAllNkb() {
  const browser = await playwright.chromium.launch({ headless: true });
  const page    = await browser.newPage();
  const all     = [];

  try {
    for (const [category, leagues] of Object.entries(LEAGUES)) {
      for (const league of leagues) {
        const matches = await scrapeLeague(page, league, category);
        all.push(...matches);
      }
    }
  } finally {
    await browser.close();
  }

  return all;
}

module.exports = { scrapeAllNkb };
