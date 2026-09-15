'use strict';
/**
 * src/scraper/nkb.js
 *
 * NKB uses DataTables which renders ALL rows in the DOM but hides
 * non-visible pages with display:none. We use page.evaluate() to
 * read only visible rows directly in the browser context.
 */

const playwright = require('playwright');
const { parseTeam } = require('./normalise');

const LEAGUES = {
  junioren: [
    { name: 'Klasse A', url: 'https://nkbuitslagen.nl/klasse-a-junioren/' },
    { name: 'Klasse B', url: 'https://nkbuitslagen.nl/klasse-b/' },
    { name: 'Klasse C', url: 'https://nkbuitslagen.nl/klasse-c/' },
    { name: 'Klasse D', url: 'https://nkbuitslagen.nl/klasse-d/' },
    { name: 'Klasse E', url: 'https://nkbuitslagen.nl/klasse-e/' },
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

const DUTCH_MONTHS_NKB = {
  januari:1, februari:2, maart:3, april:4, mei:5, juni:6,
  juli:7, augustus:8, september:9, oktober:10, november:11, december:12,
};

function parseNkbDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const dutch = raw.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
  if (dutch) {
    const month = DUTCH_MONTHS_NKB[dutch[2].toLowerCase()];
    if (month) {
      return `${dutch[3]}-${String(month).padStart(2,'0')}-${dutch[1].padStart(2,'0')}`;
    }
  }
  return null;
}

function parseScore(h, a) {
  const hi = parseInt(h, 10);
  const ai = parseInt(a, 10);
  if (isNaN(hi) || isNaN(ai)) return { home: null, away: null };
  if (hi === 0 && ai === 0)   return { home: null, away: null }; // not played yet
  return { home: hi, away: ai };
}

/**
 * Read all visible rows from the table via page.evaluate.
 * Returns array of string arrays (one per row, one string per cell).
 * Uses data-order attribute first (DataTables sort key), then innerText.
 */
async function getVisibleRows(page) {
  return page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) return [];
    return Array.from(table.querySelectorAll('tbody tr'))
      .filter(tr => {
        if (tr.style.display === 'none') return false;
        if (tr.offsetHeight === 0) return false;
        // Skip loading/empty placeholder rows (colspan > 1)
        const cells = tr.querySelectorAll('td');
        if (cells.length === 1 && cells[0].getAttribute('colspan') > 1) return false;
        return true;
      })
      .map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => {
          const dataOrder = td.getAttribute('data-order') || td.getAttribute('data-sort');
          if (dataOrder) return dataOrder.trim();
          return (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
        })
      );
  });
}

/**
 * Wait for the table to show real data rows (not just a Laden... spinner).
 * Returns true if data is ready, false if the table is genuinely empty.
 */
async function waitForTableData(page) {
  try {
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'))
        .filter(tr => tr.style.display !== 'none' && tr.offsetHeight > 0);
      if (!rows.length) return false;
      // If only one row and it has a colspan, it's still loading or empty
      if (rows.length === 1) {
        const firstCell = rows[0].querySelector('td');
        if (firstCell && parseInt(firstCell.getAttribute('colspan')) > 1) return false;
      }
      return true;
    }, { timeout: 25_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a fingerprint of the current first visible row's text content.
 * Used to detect when DataTables has re-rendered after a page click.
 */
async function getFirstRowFingerprint(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'))
      .filter(tr => tr.style.display !== 'none' && tr.offsetHeight > 0);
    if (!rows.length) return '';
    return Array.from(rows[0].querySelectorAll('td'))
      .map(td => (td.innerText || '').trim()).join('|');
  });
}

async function scrapeLeague(page, league, category) {
  console.log(`  [NKB] ${category} / ${league.name}`);

  await page.goto(league.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const hasData = await waitForTableData(page);
  if (!hasData) {
    console.log('    → tabel leeg / seizoen nog niet begonnen');
    return [];
  }

  const matches = [];
  let pageNum = 1;

  while (true) {
    const rows = await getVisibleRows(page);
    console.log(`    → pagina ${pageNum}: ${rows.length} rijen`);

    for (const cells of rows) {
      if (cells.length < 4) continue;
      const dateRaw = cells[1] || '';
      const homeRaw = cells[2] || '';
      const awayRaw = cells[3] || '';
      if (!homeRaw || !awayRaw) continue;

      const { home: homeScore, away: awayScore } = parseScore(cells[4] || '', cells[5] || '');

      matches.push({
        source     : 'nkb',
        category,
        league     : league.name,
        match_date : parseNkbDate(dateRaw),
        match_time : null,
        speeldag   : null,
        home_team  : parseTeam(homeRaw),
        away_team  : parseTeam(awayRaw),
        home_score : homeScore,
        away_score : awayScore,
        location   : null,
        source_url : league.url,
      });
    }

    // Check if Next button exists and is enabled
    const nextBtn = await page.$('button.dt-paging-button.next');
    if (!nextBtn) break;

    const isDisabled = await page.evaluate(
      btn => btn.disabled || btn.classList.contains('disabled'),
      nextBtn
    );
    if (isDisabled) break;

    // Take a fingerprint of the current first row before clicking
    const fingerprintBefore = await getFirstRowFingerprint(page);

    await nextBtn.click();

    // Wait until the first visible row changes — simple and reliable
    try {
      await page.waitForFunction((before) => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'))
          .filter(tr => tr.style.display !== 'none' && tr.offsetHeight > 0);
        if (!rows.length) return false;
        const current = Array.from(rows[0].querySelectorAll('td'))
          .map(td => (td.innerText || '').trim()).join('|');
        return current !== before && current !== '';
      }, fingerprintBefore, { timeout: 8_000 });
    } catch {
      console.log('    → paginering reageert niet, stoppen');
      break;
    }

    pageNum++;
    if (pageNum > 20) break;
  }

  console.log(`    → totaal: ${matches.length} wedstrijden`);
  return matches;
}

async function scrapeAllNkb() {
  const browser = await playwright.chromium.launch({ headless: true });
  const all     = [];

  try {
    for (const [category, leagues] of Object.entries(LEAGUES)) {
      for (const league of leagues) {
        const page = await browser.newPage();
        try {
          all.push(...await scrapeLeague(page, league, category));
        } catch (err) {
          console.warn(`  [NKB] fout bij ${league.url}: ${err.message}`);
        } finally {
          await page.close();
        }
        // Brief pause between leagues
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } finally {
    await browser.close();
  }

  return all;
}

module.exports = { scrapeAllNkb };
