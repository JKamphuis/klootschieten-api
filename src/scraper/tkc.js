'use strict';
const cheerio = require('cheerio');
const { normaliseClub, parseTeam } = require('./normalise');

const PAGES = [
  { url: 'https://www.tkc-klootschieten.nl/programma/', category: 'senioren' },
  { url: 'https://www.tkc-klootschieten.nl/junioren/',  category: 'junioren' },
];

const DUTCH_MONTHS = {
  januari:1, februari:2, maart:3, april:4, mei:5, juni:6,
  juli:7, augustus:8, september:9, oktober:10, november:11, december:12,
};

function parseTkcDatetime(raw) {
  if (!raw) return { date: null, time: null };
  raw = raw.trim();
  const isoM = raw.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (isoM) return { date: isoM[1], time: isoM[2] };
  const dutchM = raw.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
  if (dutchM) {
    const mm = String(DUTCH_MONTHS[dutchM[2].toLowerCase()] || 0).padStart(2, '0');
    const dd = dutchM[1].padStart(2, '0');
    return { date: `${dutchM[3]}-${mm}-${dd}`, time: null };
  }
  return { date: null, time: null };
}

function parseTkcScore(raw) {
  if (!raw) return { home: null, away: null };
  const m = raw.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$/);
  return m ? { home: parseInt(m[1], 10), away: parseInt(m[2], 10) } : { home: null, away: null };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KlootschietenAPI/2.0)', 'Accept': 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function scrapeTkcPage({ url, category }) {
  console.log(`  [TKC] ${category} – ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const matches = [];
  let speeldag = 0;
  let currentLeague = 'TKC Onbekend';

  $('h2, h3, h5, table').each((_, el) => {
    const tag  = el.tagName.toLowerCase();
    const text = $(el).text().trim();
    if (tag === 'h2' || tag === 'h3') {
      const m = text.match(/speeldag\s+(\d+)/i);
      if (m) speeldag = parseInt(m[1], 10);
      return;
    }
    if (tag === 'h5') {
      currentLeague = text.startsWith('TKC') ? text : `TKC ${text}`;
      return;
    }
    if (tag === 'table') {
      $(el).find('tbody tr').each((_, tr) => {
        const cells = $(tr).find('td');
        if (cells.length < 3) return;
        const dateRaw  = $(cells[0]).text().trim();
        const { date: matchDate, time: matchTime } = parseTkcDatetime(dateRaw);
        const eventRaw = $(cells[1]).find('a').first().text().trim() || $(cells[1]).text().trim();
        const tegenM   = eventRaw.match(/^(.+?)\s+tegen\s+(.+)$/i);
        if (!tegenM) return;
        const scoreRaw = $(cells[2]).find('a').first().text().trim() || $(cells[2]).text().trim();
        const score    = parseTkcScore(scoreRaw);
        const locationRaw = cells.length > 3
          ? ($(cells[3]).find('a').first().text().trim() || $(cells[3]).text().trim())
          : null;
        matches.push({
          source: 'tkc', category, league: currentLeague,
          match_date: matchDate, match_time: matchTime, speeldag,
          home_team: parseTeam(tegenM[1].trim()),
          away_team: parseTeam(tegenM[2].trim()),
          home_score: score.home, away_score: score.away,
          location: normaliseClub(locationRaw), source_url: url,
        });
      });
    }
  });

  console.log(`    → ${matches.length} wedstrijden`);
  return matches;
}

async function scrapeAllTkc() {
  const all = [];
  for (const page of PAGES) {
    try { all.push(...await scrapeTkcPage(page)); }
    catch (err) { console.warn(`  [TKC] fout bij ${page.url}: ${err.message}`); }
  }
  return all;
}

module.exports = { scrapeAllTkc };
