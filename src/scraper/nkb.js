'use strict';
/**
 * src/scraper/nkb.js
 */

const cheerio    = require('cheerio');
const playwright = require('playwright');
const { parseTeam } = require('./normalise');

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
    { name: 'Hoofdklasse',  url: 'https://nkbuitslagen.nl/hoofdklasse/' },
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

function parseNkbDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function parseTableRows($, leagueName, category, sourceUrl) {
  const matches = [];
  $('table').first().find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 4) return;
    const dateRaw = $(cells[1]).text().trim();
    const homeRaw = $(cells[2]).text().trim();
    const awayRaw = $(cells[3]).text().trim();
    if (!homeRaw || !awayRaw) return;
    const scoreH = cells.length > 4 ? $(cells[4]).text().trim() : '';
    const scoreA = cells.length > 5 ? $(cells[5]).text().trim() : '';
    matches.push({
      source: 'nkb', category, league: leagueName,
      match_date: parseNkbDate(dateRaw), match_time: null, speeldag: null,
      home_team: parseTeam(homeRaw), away_team: parseTeam(awayRaw),
      home_score: scoreH !== '' ? (parseInt(scoreH, 10) || null) : null,
      away_score: scoreA !== '' ? (parseInt(scoreA, 10) || null) : null,
      location: null, source_url: sourceUrl,
    });
  });
  return matches;
}

/** Count visible tbody rows in the first table via page.evaluate */
async function countRows(page) {
  return page.evaluate(() => {
    const table = document.querySelector('table tbody');
    return table ? table.querySelectorAll('tr').length : 0;
  });
}

async function scrapeLeague(page, league, category) {
  console.log(`  [NKB] ${category} / ${league.name}`);

  await page.goto(league.url, { waitUntil: 'networkidle', timeout: 30_000 });

  // Give JS-rendered tables extra time — slow pages need up to 15s
  try {
    await page.waitForSelector('table tbody tr td', { timeout: 15_000 });
  } catch {
    console.log('    → tabel leeg / seizoen nog niet begonnen');
    return [];
  }

  const matches = [];
  let pageNum = 1;

  while (true) {
    // Parse current page
    const $ = cheerio.load(await page.content());
    const pageMatches = parseTableRows($, league.name, category, league.url);
    matches.push(...pageMatches);
    console.log(`    → pagina ${pageNum}: ${pageMatches.length} rijen`);

    // Find the Next button — exact selector from the live site
    const nextBtn = await page.$('button.dt-paging-button.next');
    if (!nextBtn) break;

    // Check if disabled (DataTables adds 'disabled' class when on last page)
    const disabled = await nextBtn.evaluate(el => el.disabled || el.classList.contains('disabled'));
    if (disabled) break;

    // Remember current row count so we can wait for table to re-render
    const rowsBefore = await countRows(page);

    await nextBtn.click();

    // Wait until row count changes (table re-rendered) — max 5s
    try {
      await page.waitForFunction(
        (before) => {
          const t = document.querySelector('table tbody');
          return t && t.querySelectorAll('tr').length !== before;
        },
        rowsBefore,
        { timeout: 5_000 }
      );
    } catch {
      // Timed out waiting for new rows — we're probably on the last page
      break;
    }

    pageNum++;
    if (pageNum > 10) break; // max 10 pages (150 matches per league is plenty)
  }

  console.log(`    → totaal: ${matches.length} wedstrijden`);
  return matches;
}

async function scrapeAllNkb() {
  const browser = await playwright.chromium.launch({ headless: true });
  const page    = await browser.newPage();
  const all     = [];
  try {
    for (const [category, leagues] of Object.entries(LEAGUES)) {
      for (const league of leagues) {
        try {
          all.push(...await scrapeLeague(page, league, category));
        } catch (err) {
          console.warn(`  [NKB] fout bij ${league.url}: ${err.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  return all;
}

module.exports = { scrapeAllNkb };
