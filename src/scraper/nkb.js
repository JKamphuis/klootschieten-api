'use strict';
/**
 * src/scraper/nkb.js
 *
 * DataTables note: NKB uses DataTables which renders ALL rows in the DOM
 * but hides non-visible pages with display:none. Pagination buttons
 * show/hide rows without changing the DOM count.
 *
 * Strategy: click "Volgende" to advance pages, collect only VISIBLE rows
 * each time using page.$$eval filtering on offsetParent !== null.
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

const DUTCH_MONTHS_NKB = {
  januari:1, februari:2, maart:3, april:4, mei:5, juni:6,
  juli:7, augustus:8, september:9, oktober:10, november:11, december:12,
};

function parseNkbDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // DD-MM-YYYY
  const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  // Dutch long form: "2 mei 2027" or "12 september 2026"
  const dutch = raw.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
  if (dutch) {
    const month = DUTCH_MONTHS_NKB[dutch[2].toLowerCase()];
    if (month) {
      const mm = String(month).padStart(2, '0');
      const dd = dutch[1].padStart(2, '0');
      return `${dutch[3]}-${mm}-${dd}`;
    }
  }
  return null;
}

/**
 * Extract visible rows from the first table via page.evaluate.
 * DataTables hides rows with display:none — we filter those out.
 * Returns array of plain objects with the cell text values.
 *
 * Columns: 0=Klasse 1=Wedstrijddag 2=Thuis 3=Uit 4=Thuis score 5=Uit score 6=Verslag
 */
async function getVisibleRows(page) {
  return page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    return rows
      .filter(tr => tr.style.display !== 'none' && tr.offsetHeight > 0)
      .map(tr => {
        const cells = Array.from(tr.querySelectorAll('td'));
        return cells.map(td => {
          // Prefer data-order attribute (DataTables often stores sort value there,
          // which for dates is the ISO date string)
          const dataOrder = td.getAttribute('data-order') || td.getAttribute('data-sort');
          if (dataOrder) return dataOrder.trim();
          // Fall back to innerText with collapsed whitespace
          return (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
        });
      });
  });
}

/** Log first visible row raw HTML for debugging — called once per league */
async function debugFirstRow(page) {
  const info = await page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) return 'no table';
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const visible = rows.filter(tr => tr.style.display !== 'none' && tr.offsetHeight > 0);
    if (!visible.length) return 'no visible rows';
    return visible[0].innerHTML.slice(0, 800);
  });
  console.log('    [debug] first row HTML:', info);
}

/**
 * Get the active page number from the DataTables pagination info.
 * Returns null if not found.
 */
async function getActivePage(page) {
  return page.evaluate(() => {
    const active = document.querySelector('button.dt-paging-button.current, .paginate_button.current');
    return active ? active.textContent.trim() : null;
  });
}

async function scrapeLeague(page, league, category) {
  console.log(`  [NKB] ${category} / ${league.name}`);

  await page.goto(league.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // Wait for real data rows — not the "Laden..." placeholder
  try {
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const visible = rows.filter(tr => tr.style.display !== 'none' && tr.offsetHeight > 0);
      if (!visible.length) return false;
      // Reject if the only visible row is a colspan "Laden..." or "dt-empty" cell
      if (visible.length === 1) {
        const firstCell = visible[0].querySelector('td');
        if (!firstCell) return false;
        const colspan = firstCell.getAttribute('colspan');
        if (colspan && parseInt(colspan) > 1) return false;  // loading/empty placeholder
      }
      return true;
    }, { timeout: 20_000 });
  } catch {
    console.log('    → tabel leeg / seizoen nog niet begonnen');
    return [];
  }

  const matches = [];
  let pageNum = 1;

  // Debug: log raw HTML of first row to reveal date cell structure
  await debugFirstRow(page);

  while (true) {
    // Read only currently visible rows
    const rows = await getVisibleRows(page);
    console.log(`    → pagina ${pageNum}: ${rows.length} rijen zichtbaar`);

    for (const cells of rows) {
      if (cells.length < 4) continue;

      // col 1 = Wedstrijddag, col 2 = Thuis, col 3 = Uit
      const dateRaw  = cells[1] || '';
      const homeRaw  = cells[2] || '';
      const awayRaw  = cells[3] || '';
      if (!homeRaw || !awayRaw) continue;

      const scoreH = cells[4] || '';
      const scoreA = cells[5] || '';

      matches.push({
        source     : 'nkb',
        category,
        league     : league.name,
        match_date : parseNkbDate(dateRaw),
        match_time : null,
        speeldag   : null,
        home_team  : parseTeam(homeRaw),
        away_team  : parseTeam(awayRaw),
        home_score : scoreH !== '' ? (parseInt(scoreH, 10) || null) : null,
        away_score : scoreA !== '' ? (parseInt(scoreA, 10) || null) : null,
        location   : null,
        source_url : league.url,
      });
    }

    // Find the Next button
    const nextBtn = await page.$('button.dt-paging-button.next');
    if (!nextBtn) {
      console.log('    → geen volgende-knop gevonden, klaar');
      break;
    }

    // Check disabled state — DataTables sets both class and attribute
    const isDisabled = await page.evaluate(btn => {
      return btn.disabled ||
        btn.classList.contains('disabled') ||
        btn.getAttribute('aria-disabled') === 'true';
    }, nextBtn);

    if (isDisabled) {
      console.log('    → laatste pagina bereikt');
      break;
    }

    // Remember which page we're on before clicking
    const currentPage = await getActivePage(page);

    await nextBtn.click();

    // Wait until the active page indicator changes, meaning DataTables
    // has finished re-rendering the visible rows — max 5 seconds
    try {
      await page.waitForFunction((prevPage) => {
        const active = document.querySelector(
          'button.dt-paging-button.current, .paginate_button.current'
        );
        return active && active.textContent.trim() !== prevPage;
      }, currentPage, { timeout: 5_000 });
    } catch {
      // If the page indicator didn't change, we're stuck — stop here
      console.log('    → paginering reageert niet, stoppen');
      break;
    }

    pageNum++;
    if (pageNum > 20) {
      console.log('    → veiligheidsgrens van 20 paginas bereikt');
      break;
    }
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
        // Fresh page per league — avoids interrupted navigation errors from
        // the previous page still loading when we navigate to the next one.
        const page = await browser.newPage();
        try {
          all.push(...await scrapeLeague(page, league, category));
        } catch (err) {
          console.warn(`  [NKB] fout bij ${league.url}: ${err.message}`);
        } finally {
          await page.close();
        }
        // Brief pause between leagues to avoid rate-limiting
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  } finally {
    await browser.close();
  }

  return all;
}

module.exports = { scrapeAllNkb };
