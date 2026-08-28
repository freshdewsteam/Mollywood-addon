/**
 * scraper.js — South Streams
 *
 * Movies  → JustWatch GraphQL (day-0 OTT detection) → TMDB Auto-Discover (foundation)
 *           → Google Sheet (patching + gap fill)
 * Series  → Google Sheet CSV (manually maintained, primary)
 * Enrichment → TMDB / OMDb API (posters, descriptions, IMDb IDs)
 *
 * JustWatch strategy: introspection is disabled on their API, so we probe
 * candidate sort/filter combinations at runtime — GraphQL validation errors
 * tell us which combos are valid. First accepted combo wins and is cached
 * for the rest of the run.
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TMDB_KEY    = process.env.TMDB_API_KEY    || '';
const OMDB_KEY    = process.env.OMDB_API_KEY    || '';
const SHEET_URL   = process.env.GOOGLE_SHEET_URL || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL      || '';
const BASE        = 'https://api.themoviedb.org/3';
const IMG         = 'https://image.tmdb.org/t/p/';

const JW_GRAPHQL_URL = 'https://apis.justwatch.com/graphql';

const MOVIE_CACHE_FILE  = path.join(__dirname, '..', 'data', 'movies-cache.json');
const SERIES_CACHE_FILE = path.join(__dirname, '..', 'data', 'series-cache.json');

const MOVIE_LOOKBACK  = 30;
const MOVIE_FIRST_RUN = 730;
const SKIP_TTL        = 14 * 24 * 60 * 60 * 1000; // 14 days
const RETRY_TTL       =  3 * 24 * 60 * 60 * 1000; //  3 days

// ── CACHE ─────────────────────────────────────────────────────────────────────
let movieCache  = {};
let seriesCache = {};
let seen        = {};
let cacheDirty  = false;

function loadCache() {
  try {
    if (fs.existsSync(MOVIE_CACHE_FILE)) {
      const raw   = JSON.parse(fs.readFileSync(MOVIE_CACHE_FILE, 'utf8'));
      movieCache  = raw._data || {};
      seen        = raw._seen || {};
      console.log('[Cache] Movies: ' + Object.keys(movieCache).length + ' entries');
    }
    if (fs.existsSync(SERIES_CACHE_FILE)) {
      const raw   = JSON.parse(fs.readFileSync(SERIES_CACHE_FILE, 'utf8'));
      seriesCache = raw._data || {};
      console.log('[Cache] Series: ' + Object.keys(seriesCache).length + ' entries');
    }
  } catch (e) {
    console.warn('[Cache] Load failed: ' + e.message);
    movieCache = {}; seriesCache = {}; seen = {};
  }
}

function saveCache() {
  if (!cacheDirty) return;
  try {
    const dir = path.dirname(MOVIE_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MOVIE_CACHE_FILE,  JSON.stringify({ _data: movieCache,  _seen: seen }, null, 2));
    fs.writeFileSync(SERIES_CACHE_FILE, JSON.stringify({ _data: seriesCache }, null, 2));
    console.log('[Cache] Saved ' + Object.keys(movieCache).length + ' movies, ' + Object.keys(seriesCache).length + ' series');
    cacheDirty = false;
  } catch (e) {
    console.warn('[Cache] Save failed: ' + e.message);
  }
}

function readCacheEntry(entry) {
  if (entry === undefined) return undefined;
  if (entry === 'skip')  return 'skip';
  if (entry === 'retry') return 'retry';
  if (entry && typeof entry === 'object' && entry._status) {
    const age = Date.now() - (entry._at || 0);
    const ttl = entry._status === 'skip' ? SKIP_TTL : RETRY_TTL;
    if (age < ttl) return entry._status;
    return undefined;
  }
  if (entry && typeof entry === 'object' && entry.id) return entry;
  return undefined;
}

function setSkip(cacheObj, key)  { cacheObj[key] = { _status: 'skip',  _at: Date.now() }; cacheDirty = true; }
function setRetry(cacheObj, key) { cacheObj[key] = { _status: 'retry', _at: Date.now() }; cacheDirty = true; }

// ── HEALTH ────────────────────────────────────────────────────────────────────
function getHealthStatus() {
  const mc = Object.values(movieCache).filter(v => v && typeof v === 'object' && v.id && !v._status).length;
  const sc = Object.values(seriesCache).filter(v => v && typeof v === 'object' && v.id && !v._status).length;
  console.log('[Health] ' + mc + ' movies, ' + sc + ' series');
  return { movies: mc, series: sc, total: mc + sc };
}

// ── ALERTS ────────────────────────────────────────────────────────────────────
async function sendAlert(message) {
  console.log('[Alert] ' + message);
  if (!WEBHOOK_URL) return;
  try {
    const body = JSON.stringify({ content: '🎬 South Streams: ' + message, username: 'South Streams' });
    await new Promise((resolve, reject) => {
      const u   = new URL(WEBHOOK_URL);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(body); req.end();
    });
  } catch (e) { console.warn('[Alert] Failed: ' + e.message); }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'SouthStreams/2.0' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      let s = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    s = res.pipe(zlib.createGunzip());
      if (enc === 'br')      s = res.pipe(zlib.createBrotliDecompress());
      if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      const c = [];
      s.on('data', d => c.push(d));
      s.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
      s.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = (typeof payload === 'string') ? payload : JSON.stringify(payload);
    const u    = new URL(url);
    const req  = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (compatible; SouthStreamsAddon/2.0)',
        'App-Version': '3.8.0-web-web'
      }
    }, (res) => {
      let s = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      if (enc === 'br')   s = res.pipe(zlib.createBrotliDecompress());
      const c = [];
      s.on('data', d => c.push(d));
      s.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ': ' + text.slice(0, 300)));
        }
        resolve(text);
      });
      s.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, function() { this.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

function fetchJson(url) { return fetchUrl(url).then(t => JSON.parse(t)); }

let reqCount = 0, reqReset = Date.now();
async function tmdb(endpoint, retries) {
  retries = retries || 3;
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY not set');
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const now = Date.now();
      if (now - reqReset > 10000) { reqCount = 0; reqReset = now; }
      if (reqCount >= 35) {
        const wait = 15100 - (now - reqReset);
        console.log('[Rate] Pausing ' + Math.ceil(wait/1000) + 's...');
        await new Promise(r => setTimeout(r, wait));
        reqCount = 0; reqReset = Date.now();
      }
      reqCount++;
      const sep = endpoint.includes('?') ? '&' : '?';
      return await fetchJson(BASE + endpoint + sep + 'api_key=' + TMDB_KEY);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw lastErr;
}

// ── DATES ─────────────────────────────────────────────────────────────────────
const _M = {
  jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
  january:0,february:1,march:2,april:3,june:5,july:6,august:7,
  september:8,october:9,november:10,december:11
};

function parseAnyDate(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/soon|tba|tbd|upcoming|expected|coming/i.test(s)) return null;
  let m;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) { const mo = _M[m[2].toLowerCase()]; if (mo !== undefined) return new Date(+m[3], mo, +m[1]); }
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) { const mo = _M[m[1].toLowerCase()]; if (mo !== undefined) return new Date(+m[3], mo, +m[2]); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isReleased(dateStr) {
  const d = parseAnyDate(dateStr);
  if (!d) return false;
  const now = new Date(); now.setHours(23, 59, 59, 999);
  return d <= now;
}

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function today()    { return new Date().toISOString().slice(0,10); }

// ── TITLE VARIATIONS ──────────────────────────────────────────────────────────
function getTitleVariations(title) {
  const v = new Set([title]);
  v.add(title.replace(/\band\b/gi, '&'));
  v.add(title.replace(/&/g, ' and '));
  v.add(title.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
  v.add(title.replace(/\s*\(\d{4}\)\s*$/, '').trim());
  v.add(title.replace(/\s*[-–]\s*season\s*\d+/i, '').trim());
  v.add(title.replace(/^(the|a|an)\s+/i, '').trim());
  v.add(title.replace(/\s+(series|show|tv|web series)$/i, '').trim());
  return Array.from(v).filter(x => x.length >= 2);
}

// ── POSTER FETCHER ────────────────────────────────────────────────────────────
async function fetchPosterFallback(title, imdbId, type) {
  if (!OMDB_KEY) return null;
  const mediaType = type === 'series' ? 'series' : 'movie';

  if (imdbId) {
    try {
      const data = await fetchJson('https://www.omdbapi.com/?apikey=' + OMDB_KEY + '&i=' + imdbId);
      if (data && data.Response === 'True' && data.Poster && data.Poster !== 'N/A') {
        console.log('[Poster] OMDb by ID: ' + imdbId);
        return data.Poster;
      }
    } catch(e) {}
  }

  const variations = getTitleVariations(title).slice(0, 3);
  for (const v of variations) {
    try {
      const data = await fetchJson(
        'https://www.omdbapi.com/?apikey=' + OMDB_KEY +
        '&t=' + encodeURIComponent(v) + '&type=' + mediaType
      );
      if (data && data.Response === 'True' && data.Poster && data.Poster !== 'N/A') {
        console.log('[Poster] OMDb by title: ' + v);
        return data.Poster;
      }
    } catch(e) {}
  }
  return null;
}

// ── BUILD META ────────────────────────────────────────────────────────────────
function buildMeta({ imdbId, type, title, platform, releaseDate, overview,
                     rating, posterPath, backdropPath, genres, posterUrl, backdropUrl }) {
  let desc = '';
  if (overview)    desc += overview + '\n\n';
  if (platform)    desc += '📺 Streaming on: ' + platform;
  if (releaseDate) desc += '\n📅 Release: ' + releaseDate;
  if (rating)      desc += '\n⭐ Rating: ' + Number(rating).toFixed(1) + '/10';

  let poster   = posterUrl || (posterPath   ? IMG + 'w500'  + posterPath   : undefined);
  let backdrop = backdropUrl || (backdropPath ? IMG + 'w1280' + backdropPath : undefined);

  const meta = {
    id:          imdbId,
    type,
    name:        title,
    releaseInfo: releaseDate || '',
    description: desc.trim(),
    poster,
    background:  backdrop,
    genres:      genres && genres.length ? genres : undefined,
  };
  Object.keys(meta).forEach(k => meta[k] === undefined && delete meta[k]);
  return meta;
}

// ── GOOGLE SHEET FETCHER (UNIFIED) ────────────────────────────────────────────
function parseCSVRow(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

async function fetchSheetContent(filterLang, filterType) {
  if (!SHEET_URL) { console.warn('[Sheet] GOOGLE_SHEET_URL not set'); return []; }
  try {
    let url = SHEET_URL;
    if (url.includes('docs.google.com/spreadsheets')) {
      const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if (id) url = 'https://docs.google.com/spreadsheets/d/' + id[1] + '/export?format=csv&gid=0';
    }
    console.log('[Sheet] Fetching ' + filterType + '...');
    const csv   = await fetchUrl(url);
    const lines = csv.trim().split('\n');
    const items = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const row      = parseCSVRow(lines[i]);
      const type     = (row[0] || '').toLowerCase().trim();   // Column A: type
      const title    = (row[1] || '').trim();                 // Column B: title
      const lang     = (row[2] || '').toLowerCase().trim();   // Column C: lang
      const platform = (row[3] || '').trim();                 // Column D: platform
      const dateRaw  = (row[4] || '').trim();                 // Column E: date
      const imdbId   = (row[5] || '').trim();                 // Column F: imdbId

      if (!title) continue;
      if (!lang.includes(filterLang.toLowerCase())) continue;
      if (type !== filterType) continue;
      if (!isReleased(dateRaw)) continue;

      const d = parseAnyDate(dateRaw);
      const dateISO = d ? d.toISOString().slice(0, 10) : dateRaw;

      items.push({ type, title, platform, date: dateISO, imdbId });
    }

    console.log('[Sheet] ' + items.length + ' released ' + filterLang + ' ' + filterType);
    return items;
  } catch (e) {
    console.warn('[Sheet] Failed: ' + e.message);
    await sendAlert('Google Sheet fetch failed: ' + e.message);
    return [];
  }
}

// ── JUSTWATCH (DAY-0 OTT DETECTION — runtime schema probing) ──────────────────
// Introspection is disabled on JustWatch's API, so we discover the working
// sort/filter combo by probing: GraphQL 422 errors name the exact invalid
// field/enum, and the first accepted combo returns real titles.

function jwQuery(operationName, sortBy) {
  return `
query ` + operationName + `($filter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!) {
  popularTitles(country: $country, filter: $filter, first: $first, sortBy: ` + sortBy + `) {
    edges {
      node {
        __typename
        ... on MovieOrShow {
          objectType
          content(country: $country, language: $language) {
            title
            originalReleaseYear
            fullPath
            externalIds { imdbId tmdbId }
          }
        }
      }
    }
  }
}`;
}

async function jwGraphql(sortBy, filter) {
  const payload = JSON.stringify({
    operationName: 'JwFetch',
    query: jwQuery('JwFetch', sortBy),
    variables: { country: 'IN', language: 'en', first: 100, filter }
  });
  const text = await postJson(JW_GRAPHQL_URL, payload);
  const data = JSON.parse(text);
  if (data.errors && data.errors.length) {
    throw new Error('GraphQL: ' + data.errors.map(e => e.message).join(' | '));
  }
  if (!data.data || !data.data.popularTitles) throw new Error('GraphQL: empty popularTitles');
  return data.data.popularTitles;
}

async function fetchJustWatch(lang) {
  const langCode  = lang === 'ml' ? 'MAL' : 'TAM';
  const langLabel = lang === 'ml' ? 'Malayalam' : 'Tamil';

  // Candidate combinations, probed in order until one is accepted.
  // Sort candidates: newest-first values we believe might exist (POPULAR is verified).
  // Language field candidates: common names for the original-language filter.
  const sortCandidates = ['NEWEST', 'NEW', 'LATEST', 'RECENT', 'POPULAR'];
  const langFieldCandidates = ['languages', 'originalLanguages', 'spokenLanguages'];

  let contents = null;
  let usedDesc = '';

  outer:
  for (const sortBy of sortCandidates) {
    for (const field of langFieldCandidates) {
      const filter = { objectTypes: ['MOVIE'] };
      filter[field] = [langCode];
      try {
        const titles  = await jwGraphql(sortBy, filter);
        const content = (titles.edges || []).map(e => e.node && e.node.content).filter(Boolean);
        console.log('[JustWatch] ✅ Combo found: sortBy=' + sortBy + ' + ' + field + '=' + langCode + ' → ' + content.length + ' titles');
        if (content.length > 0) {
          contents = content;
          usedDesc = sortBy + ' + ' + field;
          break outer;
        }
      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('does not exist in')) {
          // Invalid sort enum — no point trying other fields with this sort
          console.warn('[JustWatch] sortBy=' + sortBy + ' is invalid, skipping to next sort');
          break;
        }
        // Otherwise assume the language field name is wrong — try next field
        console.warn('[JustWatch] Probe failed (' + sortBy + ' + ' + field + '): ' + msg.slice(0, 120));
      }
    }
  }

  // Final fallback: POPULAR + objectTypes only (verified working), filter strictly client-side
  let langFilteredByServer = true;
  if (!contents) {
    console.warn('[JustWatch] All language-filter probes failed — falling back to POPULAR unfiltered');
    try {
      const titles  = await jwGraphql('POPULAR', { objectTypes: ['MOVIE'] });
      contents = (titles.edges || []).map(e => e.node && e.node.content).filter(Boolean);
      usedDesc = 'POPULAR unfiltered';
      langFilteredByServer = false;
      console.log('[JustWatch] Fallback POPULAR: ' + contents.length + ' titles (strict client filter ON)');
    } catch (e) {
      console.warn('[JustWatch] Even POPULAR fallback failed: ' + e.message);
      await sendAlert('JustWatch failed: ' + e.message);
      return [];
    }
  }

  // ── Resolve each JustWatch title to a TMDB ID ──
  const resolved = [];
  const seenIds  = new Set();

  for (const c of contents) {
    const title = (c.title || '').trim();
    if (!title) continue;

    // Path A: JustWatch gave us the TMDB ID directly — zero API calls needed
    const tmdbIdStr = c.externalIds && c.externalIds.tmdbId;
    const tmdbId    = tmdbIdStr ? parseInt(tmdbIdStr, 10) : NaN;
    if (!isNaN(tmdbId) && tmdbId > 0) {
      if (!seenIds.has(tmdbId)) { seenIds.add(tmdbId); resolved.push({ id: tmdbId }); }
      continue;
    }

    // Path B: IMDb ID → TMDB /find
    const imdbId = c.externalIds && c.externalIds.imdbId;
    if (imdbId) {
      try {
        const data  = await tmdb('/find/' + imdbId + '?external_source=imdb_id');
        const movie = (data.movie_results || [])[0];
        if (movie && !seenIds.has(movie.id)) { seenIds.add(movie.id); resolved.push({ id: movie.id }); }
        continue;
      } catch (e) { console.warn('[JustWatch] Find failed for ' + imdbId + ': ' + e.message); }
    }

    // Path C: title + year search
    const retryKey = 'jw_title_' + title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
    if (readCacheEntry(movieCache[retryKey]) === 'retry') continue;
    try {
      const yearParam = c.originalReleaseYear ? '&primary_release_year=' + c.originalReleaseYear : '';
      const data = await tmdb('/search/movie?query=' + encodeURIComponent(title) + '&language=en-US&page=1' + yearParam);
      const r    = (data.results || [])[0];
      if (r && !seenIds.has(r.id)) { seenIds.add(r.id); resolved.push({ id: r.id }); }
      else {
        console.log('[JustWatch] "' + title + '" not on TMDB yet — will retry');
        setRetry(movieCache, retryKey);
      }
    } catch (e) { console.warn('[JustWatch] Search failed for "' + title + '": ' + e.message); }

    await new Promise(r => setTimeout(r, 100));
  }

  console.log('[JustWatch] Used: ' + usedDesc + (langFilteredByServer ? ' (server language filter)' : ' (client language filter)'));
  console.log('[JustWatch] Resolved ' + resolved.length + ' titles to TMDB IDs');
  return resolved;
}

// ── MOVIES: TMDB DISCOVER (FOUNDATION) ────────────────────────────────────────

async function discoverMovies(lang, lookbackDays) {
  const dateFrom = daysAgo(lookbackDays);
  const results  = [];

  for (let page = 1; page <= 5; page++) {
    try {
      const data = await tmdb(
        '/discover/movie?with_original_language=' + lang +
        '&watch_region=IN&with_watch_monetization_types=flatrate|free|ads' +
        '&sort_by=primary_release_date.desc' +
        '&primary_release_date.gte=' + dateFrom +
        '&primary_release_date.lte=' + today() +
        '&page=' + page
      );
      if (!data.results || !data.results.length) break;

      const newItems = data.results
        .filter(r => {
          if (r.original_language === lang) return true;
          if (r.original_language === 'en' && Array.isArray(r.origin_country) && r.origin_country.includes('IN')) return true;
          return false;
        });

      results.push(...newItems);
      if (page >= (data.total_pages || 1) || newItems.length === 0) break;
    } catch (e) { console.warn('[Discover] Page ' + page + ': ' + e.message); break; }
  }
  return results;
}

// processMovie(item, lang, expectedLang, strictLang)
// - expectedLang: reject movies whose TMDB original_language doesn't match (used by JW path)
// - strictLang: when true, English does NOT pass the guard (blocks Hollywood from the
//   unfiltered JW fallback feed). TMDB Discover path omits it so 'en'+IN docs still pass.
async function processMovie(item, lang, expectedLang, strictLang) {
  const langPfx  = lang + '_';
  const cacheKey = langPfx + item.id;
  const cached   = readCacheEntry(movieCache[cacheKey]);

  if (cached === 'skip')  return null;
  if (cached === 'retry') { /* fall through */ }
  else if (cached)        return cached;

  try {
    const detail = await tmdb('/movie/' + item.id + '?language=en-US&append_to_response=watch/providers');

    if (!detail.imdb_id) {
      setSkip(movieCache, cacheKey);
      console.log('[Skip] No IMDb ID: ' + (detail.title || ''));
      return null;
    }

    // Language guard for JustWatch-sourced results
    if (expectedLang && detail.original_language &&
        detail.original_language !== expectedLang &&
        (!strictLang || detail.original_language !== 'en')) {
      setSkip(movieCache, cacheKey);
      console.log('[Skip] Wrong language (' + detail.original_language + '): ' + (detail.title || ''));
      return null;
    }

    const IN  = detail['watch/providers'] && detail['watch/providers'].results && detail['watch/providers'].results.IN;
    const all = IN ? [...(IN.flatrate||[]), ...(IN.free||[]), ...(IN.ads||[])] : [];
    if (!all.length) {
      setSkip(movieCache, cacheKey);
      console.log('[Skip] Not on OTT/IN: ' + (detail.title || ''));
      return null;
    }

    const seenP    = new Set();
    const platform = all
      .filter(p => { if (seenP.has(p.provider_id)) return false; seenP.add(p.provider_id); return true; })
      .map(p => p.provider_name).join(', ');

    const meta = buildMeta({
      imdbId:      detail.imdb_id,
      type:        'movie',
      title:       detail.title || '',
      platform,
      releaseDate: detail.release_date || '',
      overview:    detail.overview || '',
      rating:      detail.vote_average,
      posterPath:  detail.poster_path,
      backdropPath: detail.backdrop_path,
      genres:      (detail.genres || []).map(g => g.name),
    });

    movieCache[cacheKey] = meta;
    cacheDirty = true;
    console.log('[TMDB OK] ' + meta.name + ' -> ' + detail.imdb_id + ' on ' + platform);
    return meta;
  } catch (e) {
    setRetry(movieCache, cacheKey);
    console.warn('[TMDB] Failed: ' + e.message);
    return null;
  }
}

async function enrichMovie(imdbId, title, lang) {
  const cacheKey = imdbId && imdbId.startsWith('tt') ? imdbId : 'title_' + title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
  const cached   = readCacheEntry(movieCache[cacheKey]);

  if (cached === 'skip')  return null;
  if (cached === 'retry') { /* fall through */ }
  else if (cached)        return cached;

  try {
    let movieId = null;
    let resolvedImdbId = imdbId || null;

    if (imdbId && imdbId.startsWith('tt')) {
      try {
        const data = await tmdb('/find/' + imdbId + '?external_source=imdb_id');
        const movie = (data.movie_results || [])[0];
        if (movie) {
          movieId = movie.id;
          console.log('[Find] ' + imdbId + ' -> TMDB Movie ' + movieId);
        } else {
          console.log('[Find] ' + imdbId + ' not yet indexed on TMDB — trying OMDb for poster');
          let omdbPoster = null;
          let omdbOverview = '';
          if (OMDB_KEY) {
            try {
              const omdb = await fetchJson('https://www.omdbapi.com/?apikey=' + OMDB_KEY + '&i=' + imdbId);
              if (omdb && omdb.Response === 'True') {
                omdbPoster   = omdb.Poster && omdb.Poster !== 'N/A' ? omdb.Poster : null;
                omdbOverview = omdb.Plot   && omdb.Plot   !== 'N/A' ? omdb.Plot   : '';
                if (omdbPoster) console.log('[OMDb] Got poster for: ' + imdbId);
              }
            } catch(e) { console.warn('[OMDb] ' + imdbId + ': ' + e.message); }
          }
          setRetry(movieCache, cacheKey);
          return { imdbId, poster: omdbPoster, backdrop: null, overview: omdbOverview, rating: null, genres: [] };
        }
      } catch(e) {
        console.warn('[Find] ' + imdbId + ': ' + e.message);
        setRetry(movieCache, cacheKey);
        return { imdbId, poster: null, backdrop: null, overview: '', rating: null, genres: [] };
      }
    }

    if (!movieId) {
      console.log('[Search] Looking up movie: ' + title);
      let best = null, bestScore = -1;

      for (const v of getTitleVariations(title)) {
        try {
          const data = await tmdb('/search/movie?query=' + encodeURIComponent(v) + '&language=en-US&page=1');
          for (const r of (data.results || [])) {
            let sc = 0;
            const rt = (r.title || '').toLowerCase(), vl = v.toLowerCase();
            if (rt === vl)              sc += 100;
            else if (rt.includes(vl))  sc += 40;
            else if (vl.includes(rt))  sc += 40;
            if (r.original_language === lang)                                   sc += 50;
            if (r.origin_country && r.origin_country.includes('IN'))            sc += 30;
            if (r.original_language !== lang && r.original_language !== 'en')   sc -= 50;
            if (sc > bestScore && sc >= 70) { bestScore = sc; best = r; }
          }
          if (best && bestScore >= 100) break;
        } catch(e) {}
      }

      if (best) {
        movieId = best.id;
        console.log('[Search] Matched: ' + best.title + ' (score: ' + bestScore + ')');
      } else {
        console.log('[Search] No confident match for movie: ' + title);
        setRetry(movieCache, cacheKey);
        return null;
      }
    }

    const detail = await tmdb('/movie/' + movieId + '?language=en-US');

    if (!resolvedImdbId) {
      try {
        const ext  = await tmdb('/movie/' + movieId + '/external_ids');
        resolvedImdbId = ext.imdb_id || null;
      } catch(e) {}
    }

    let posterUrl  = detail.poster_path   ? IMG + 'w500'  + detail.poster_path   : null;
    let backdropUrl = detail.backdrop_path ? IMG + 'w1280' + detail.backdrop_path : null;

    if (!posterUrl) {
      console.log('[Poster] No TMDB poster for: ' + title + ' — trying OMDb');
      posterUrl = await fetchPosterFallback(title, resolvedImdbId, 'movie');
    }

    const result = {
      imdbId:   resolvedImdbId,
      poster:   posterUrl   || null,
      backdrop: backdropUrl || null,
      overview: detail.overview || '',
      rating:   detail.vote_average || null,
      genres:   (detail.genres || []).map(g => g.name),
    };

    movieCache[cacheKey] = result;
    cacheDirty = true;
    console.log('[Movie OK] ' + title + ' -> ' + (resolvedImdbId || 'no IMDb') + (posterUrl ? ' (has poster)' : ' (no poster)'));
    return result;
  } catch (e) {
    console.warn('[Enrich Movie] ' + (imdbId || title) + ': ' + e.message);
    setRetry(movieCache, cacheKey);
    return null;
  }
}

// ── MOVIES ORCHESTRATOR (JustWatch → TMDB → Sheet, zero duplicates) ──────────
async function scrapeMovies(lang) {
  const langLabel = lang === 'ml' ? 'Malayalam' : 'Tamil';
  const metas = [];
  const processedImdbIds = new Set();

  // --- STEP 1: JUSTWATCH (Day-0 OTT detection) ---
  console.log('\n[Movies] Fetching ' + langLabel + ' from JustWatch (day-0 detection)...');
  const jwItems = await fetchJustWatch(lang);
  for (const jwItem of jwItems) {
    const cacheKey = lang + '_' + jwItem.id;
    const cachedEntry    = readCacheEntry(movieCache[cacheKey]);
    const isNewDiscovery = cachedEntry === undefined || cachedEntry === 'retry';

    // strictLang = true: block Hollywood/English titles from the JW feed
    const meta = await processMovie(jwItem, lang, lang, true);
    if (meta && meta.id && !processedImdbIds.has(meta.id) && !metas.some(m => m.id === meta.id)) {
      if (isNewDiscovery) {
        meta.releaseInfo = today(); // Day-0 OTT stamp
        movieCache[cacheKey] = meta;
        cacheDirty = true;
      }
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log('[Movies] ' + metas.length + ' after JustWatch');

  // --- STEP 2: TMDB AUTO-DISCOVER (Foundation) ---
  const key      = lang + '_movie';
  const isFirst  = !seen[key];
  const lookback = isFirst ? MOVIE_FIRST_RUN : MOVIE_LOOKBACK;
  console.log('\n[Movies] ' + lang + ' TMDB | lookback: ' + lookback + 'd' + (isFirst ? ' (FIRST RUN)' : ''));

  const tmdbItems = await discoverMovies(lang, lookback);

  for (let i = 0; i < tmdbItems.length; i++) {
    const meta = await processMovie(tmdbItems[i], lang);
    if (meta && meta.id && !processedImdbIds.has(meta.id)) {
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
    if ((i+1) % 10 === 0) await new Promise(r => setTimeout(r, 300));
  }
  seen[key] = true;
  console.log('[Movies] ' + metas.length + ' after TMDB Discover');

  // --- STEP 3: GOOGLE SHEET (Patching OTT dates & filling gaps) ---
  console.log('\n[Movies] Checking ' + langLabel + ' Sheet for OTT date patches and missing movies...');
  const sheetItems = await fetchSheetContent(langLabel, 'movie');

  for (const item of sheetItems.slice(0, 50)) {
    let checkId = item.imdbId || null;

    if (!checkId) {
      console.log('[Sheet] No IMDb ID for "' + item.title + '" — searching...');
      const searchData = await tmdb('/search/movie?query=' + encodeURIComponent(item.title) + '&language=en-US&page=1');
      const match = searchData.results.find(r => r.original_language === lang || (r.origin_country && r.origin_country.includes('IN')));
      if (match) {
        try {
          const ext = await tmdb('/movie/' + match.id + '/external_ids');
          checkId = ext.imdb_id || null;
        } catch(e) {}
      }
    }

    // SMART PATCH: already added by JustWatch/TMDB, BUT the Sheet has a more
    // accurate OTT date! Overwrite the date, keep the rest of the metadata.
    if (checkId && processedImdbIds.has(checkId)) {
      const existingIndex = metas.findIndex(m => m.id === checkId);
      if (existingIndex !== -1) {
        const existingMeta = metas[existingIndex];

        existingMeta.releaseInfo = item.date;

        let desc = existingMeta.overview || '';
        if (desc) desc += '\n\n';
        if (item.platform) desc += '📺 Streaming on: ' + item.platform;
        desc += '\n📅 OTT Release: ' + item.date;
        if (existingMeta.rating) desc += '\n⭐ Rating: ' + Number(existingMeta.rating).toFixed(1) + '/10';
        existingMeta.description = desc.trim();

        console.log('[Sheet Patch] ✅ Updated OTT date for ' + item.title + ' to ' + item.date);
      }
      continue;
    }

    // JustWatch & TMDB both missed it — process from scratch
    const tmdbData    = await enrichMovie(item.imdbId, item.title, lang);
    const finalImdbId = item.imdbId || (tmdbData && tmdbData.imdbId) || checkId || null;

    if (!finalImdbId) {
      console.log('[Sheet] ⚠️  Could not resolve IMDb ID for: ' + item.title);
      continue;
    }

    const meta = buildMeta({
      imdbId:      finalImdbId,
      type:        'movie',
      title:       item.title,
      platform:    item.platform,
      releaseDate: item.date,
      overview:    tmdbData && tmdbData.overview || '',
      rating:      tmdbData && tmdbData.rating   || null,
      posterUrl:   tmdbData && tmdbData.poster   || undefined,
      backdropUrl: tmdbData && tmdbData.backdrop || undefined,
      genres:      tmdbData && tmdbData.genres   || [],
    });

    metas.push(meta);
    processedImdbIds.add(finalImdbId);
    console.log('[Sheet OK] ' + item.title + ' -> ' + finalImdbId + ' (missed by JustWatch & TMDB)');
    await new Promise(r => setTimeout(r, 100));
  }

  // Final Sort
  metas.sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''));
  const finalResult = metas.slice(0, 120);

  console.log('[Movies] ' + lang + ': ' + finalResult.length + ' total in catalogue');
  return finalResult;
}

// ── SERIES (SHEET ONLY) ──────────────────────────────────────────────────────
async function enrichSeries(imdbId, title, lang) {
  const cacheKey = imdbId && imdbId.startsWith('tt') ? imdbId : 'title_' + title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
  const cached   = readCacheEntry(seriesCache[cacheKey]);

  if (cached === 'skip')  return null;
  if (cached === 'retry') { /* fall through */ }
  else if (cached)        return cached;

  try {
    let tvId = null;
    let resolvedImdbId = imdbId || null;

    if (imdbId && imdbId.startsWith('tt')) {
      try {
        const data = await tmdb('/find/' + imdbId + '?external_source=imdb_id');
        const tv   = (data.tv_results || [])[0];
        if (tv) {
          tvId = tv.id;
          console.log('[Find] ' + imdbId + ' -> TMDB TV ' + tvId);
        } else {
          console.log('[Find] ' + imdbId + ' not yet indexed on TMDB — trying OMDb for poster');
          let omdbPoster = null;
          let omdbOverview = '';
          if (OMDB_KEY) {
            try {
              const omdb = await fetchJson('https://www.omdbapi.com/?apikey=' + OMDB_KEY + '&i=' + imdbId);
              if (omdb && omdb.Response === 'True') {
                omdbPoster   = omdb.Poster && omdb.Poster !== 'N/A' ? omdb.Poster   : null;
                omdbOverview = omdb.Plot   && omdb.Plot   !== 'N/A' ? omdb.Plot     : '';
                if (omdbPoster) console.log('[OMDb] Got poster for: ' + imdbId);
              }
            } catch(e) { console.warn('[OMDb] ' + imdbId + ': ' + e.message); }
          }
          setRetry(seriesCache, cacheKey);
          return { imdbId, poster: omdbPoster, backdrop: null, overview: omdbOverview, rating: null, genres: [] };
        }
      } catch(e) {
        console.warn('[Find] ' + imdbId + ': ' + e.message);
        setRetry(seriesCache, cacheKey);
        return { imdbId, poster: null, backdrop: null, overview: '', rating: null, genres: [] };
      }
    }

    if (!tvId) {
      console.log('[Search] Looking up series: ' + title);
      let best = null, bestScore = -1;

      for (const v of getTitleVariations(title)) {
        try {
          const data = await tmdb('/search/tv?query=' + encodeURIComponent(v) + '&language=en-US&page=1');
          for (const r of (data.results || [])) {
            let sc = 0;
            const rt = (r.name || '').toLowerCase(), vl = v.toLowerCase();
            if (rt === vl)              sc += 100;
            else if (rt.includes(vl))  sc += 40;
            else if (vl.includes(rt))  sc += 40;
            if (r.original_language === lang)                                   sc += 50;
            if (r.origin_country && r.origin_country.includes('IN'))            sc += 30;
            if (r.original_language !== lang && r.original_language !== 'en')   sc -= 50;
            if (sc > bestScore && sc >= 70) { bestScore = sc; best = r; }
          }
          if (best && bestScore >= 100) break;
        } catch(e) {}
      }

      if (best) {
        tvId = best.id;
        console.log('[Search] Matched: ' + best.name + ' (score: ' + bestScore + ')');
      } else {
        console.log('[Search] No confident match for series: ' + title);
        setRetry(seriesCache, cacheKey);
        return null;
      }
    }

    const detail = await tmdb('/tv/' + tvId + '?language=en-US');

    if (!resolvedImdbId) {
      try {
        const ext  = await tmdb('/tv/' + tvId + '/external_ids');
        resolvedImdbId = ext.imdb_id || null;
      } catch(e) {}
    }

    let posterUrl  = detail.poster_path   ? IMG + 'w500'  + detail.poster_path   : null;
    let backdropUrl = detail.backdrop_path ? IMG + 'w1280' + detail.backdrop_path : null;

    if (!posterUrl) {
      console.log('[Poster] No TMDB poster for: ' + title + ' — trying OMDb');
      posterUrl = await fetchPosterFallback(title, resolvedImdbId, 'series');
    }

    const result = {
      imdbId:   resolvedImdbId,
      poster:   posterUrl   || null,
      backdrop: backdropUrl || null,
      overview: detail.overview || '',
      rating:   detail.vote_average || null,
      genres:   (detail.genres || []).map(g => g.name),
    };

    seriesCache[cacheKey] = result;
    cacheDirty = true;
    console.log('[Series OK] ' + title + ' -> ' + (resolvedImdbId || 'no IMDb') + (posterUrl ? ' (has poster)' : ' (no poster)'));
    return result;
  } catch (e) {
    console.warn('[Enrich Series] ' + (imdbId || title) + ': ' + e.message);
    setRetry(seriesCache, cacheKey);
    return null;
  }
}

async function scrapeSeries(lang) {
  const langLabel = lang === 'ml' ? 'Malayalam' : 'Tamil';
  const items     = await fetchSheetContent(langLabel, 'series');
  const skipped   = [];

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const metas = [];
  for (const item of items.slice(0, 50)) {
    const tmdbData    = await enrichSeries(item.imdbId, item.title, lang);
    const finalImdbId = item.imdbId || (tmdbData && tmdbData.imdbId) || null;

    if (!finalImdbId) {
      skipped.push(item.title);
      console.log('[Series] ⚠️  No IMDb ID: ' + item.title);
      continue;
    }

    const meta = buildMeta({
      imdbId:      finalImdbId,
      type:        'series',
      title:       item.title,
      platform:    item.platform,
      releaseDate: item.date,
      overview:    tmdbData && tmdbData.overview || '',
      rating:      tmdbData && tmdbData.rating   || null,
      posterUrl:   tmdbData && tmdbData.poster   || undefined,
      backdropUrl: tmdbData && tmdbData.backdrop || undefined,
      genres:      tmdbData && tmdbData.genres   || [],
    });

    metas.push(meta);
    console.log('[Series] ' + item.title + ' -> ' + finalImdbId + (meta.poster ? ' ✅ poster' : ' (no poster yet)'));
    await new Promise(r => setTimeout(r, 100));
  }

  if (skipped.length > 0) {
    console.log('\n[Series] ⚠️  ' + skipped.length + ' skipped (no IMDb ID found):');
    skipped.forEach(t => console.log('   • ' + t));
    await sendAlert('Series skipped (no IMDb ID): ' + skipped.join(', '));
  }

  console.log('[Series] ' + lang + ': ' + metas.length + ' in catalogue');
  return metas;
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
async function scrapeMalayalam(type) {
  loadCache();
  try {
    const result = type === 'series' ? await scrapeSeries('ml') : await scrapeMovies('ml');
    saveCache();
    return result;
  } catch (e) {
    console.error('[scrapeMalayalam] ' + e.message);
    await sendAlert('Malayalam ' + type + ' failed: ' + e.message);
    saveCache(); return [];
  }
}

async function scrapeTamil(type) {
  loadCache();
  try {
    const result = type === 'series' ? await scrapeSeries('ta') : await scrapeMovies('ta');
    saveCache();
    return result;
  } catch (e) {
    console.error('[scrapeTamil] ' + e.message);
    await sendAlert('Tamil ' + type + ' failed: ' + e.message);
    saveCache(); return [];
  }
}

module.exports = { scrapeMalayalam, scrapeTamil, getHealthStatus };
