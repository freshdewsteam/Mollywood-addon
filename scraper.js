/**
 * scraper.js — South Streams
 *
 * Movies  → Movie of the Night changes API (official day-0, primary)
 *           → JustWatch GraphQL newTitles (ALWAYS-ON safety net, 5 days)
 *           → TMDB Auto-Discover (foundation) → Google Sheet (patch + gaps)
 * Series  → Movie of the Night changes API → JustWatch safety net
 *           → Google Sheet (patch + gaps)
 * Enrichment → TMDB / OMDb API (posters, descriptions, IMDb IDs)
 *
 * Day-0 vs renewal logic:
 * - MoN/JustWatch "new" changes include re-licenses, renewals and back-catalog
 *   acquisitions — NOT just premieres.
 * - A genuine first OTT release is always recent by its TMDB release date
 *   (Indian theatrical→OTT windows are 4–8 weeks). If the title's TMDB release
 *   date is older than RERELEASE_MAX_AGE_DAYS, the "new" arrival is treated as
 *   a renewal: kept in the catalogue, sorted by its ORIGINAL release date and
 *   labeled "♻️ Re-release" — so premieres always sit at the top.
 * - New seasons (season >= 2) of returning shows are always fresh content.
 *
 * MoN scheduling: the 00:01 IST run sweeps DEEP (3 days) to catch titles MoN
 * indexed late (Aha/SonyLIV regional lag). Other runs are lean (since last
 * fetch). The JustWatch net runs on EVERY run regardless — it is free.
 */

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TMDB_KEY    = process.env.TMDB_API_KEY    || '';
const OMDB_KEY    = process.env.OMDB_API_KEY    || '';
const SHEET_URL   = process.env.GOOGLE_SHEET_URL || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL      || '';
const MON_API_KEY = process.env.MON_API_KEY      || '';
const BASE        = 'https://api.themoviedb.org/3';
const IMG         = 'https://image.tmdb.org/t/p/';

const JW_GRAPHQL_URL = 'https://apis.justwatch.com/graphql';
const JW_DAYS_TO_SCAN = 5; // JustWatch safety-net window (days)

const MON_CHANGES_URL = 'https://api.movieofthenight.com/v4/changes';

const MOVIE_CACHE_FILE  = path.join(__dirname, '..', 'data', 'movies-cache.json');
const SERIES_CACHE_FILE = path.join(__dirname, '..', 'data', 'series-cache.json');

const MOVIE_LOOKBACK  = 30;
const MOVIE_FIRST_RUN = 730;
const SKIP_TTL        = 14 * 24 * 60 * 60 * 1000; // 14 days
const RETRY_TTL       =  3 * 24 * 60 * 60 * 1000; //  3 days

// Day-0 arrivals whose TMDB release date is older than this are treated as
// renewals/re-releases (sorted by ORIGINAL date + labeled), not premieres.
// Indian theatrical→OTT windows are 4–8 weeks, so 90 days is a safe margin.
const RERELEASE_MAX_AGE_DAYS = 90;

// ── CACHE ─────────────────────────────────────────────────────────────────────
let movieCache  = {};
let seriesCache = {};
let seen        = {}; // first-run flags + MoN fetch timestamps
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
function fetchUrl(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign(
        { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'SouthStreams/2.0' },
        extraHeaders || {}
      ),
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
      if (String(e.message).includes('HTTP 404')) throw e; // 404 = doesn't exist, retrying won't help
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

// ── MOVIE OF THE NIGHT (OFFICIAL DAY-0 SOURCE — PRIMARY) ─────────────────────
// GET https://api.movieofthenight.com/v4/changes
//   country=in, change_type=new, item_type=show, show_type=movie|series,
//   from=<unix>, order_direction=desc, cursor pagination (25/page)
// Response: { changes: [...], shows: {...map keyed by show id...}, hasMore, nextCursor }

// Module cache: the build runs 4 scrape calls (ml/ta × movie/series) but MoN
// changes are country-wide — fetch once per kind, share across languages.
const monRawCache = { MOVIE: null, SHOW: null };

// Window start: the 00:01 IST run sweeps DEEP (3 days) to catch titles MoN
// indexed late (Aha/SonyLIV regional lag). All other runs are lean — only
// fetching changes since the last successful fetch (~720 requests/month
// against the 1,000 free budget).
function monWindowStart(kind) {
  const now = Date.now();
  const utcHour = new Date().getUTCHours();

  // DEEP SWEEP: the 00:01–01:30 IST runs (18:00–20:00 UTC) scan back 3 days.
  if (utcHour >= 18 && utcHour < 20) return now - 3 * 86400 * 1000;

  // First run ever: also deep
  const last = seen['mon_' + kind];
  if (!last || isNaN(last)) return now - 3 * 86400 * 1000;

  // Lean runs: only since the last successful fetch
  return Math.max(last - 3600 * 1000, now - 12 * 3600 * 1000);
}

async function fetchMonRaw(kind) {
  if (!MON_API_KEY) { console.log('[MoN] MON_API_KEY not set — skipping'); return null; }
  if (monRawCache[kind]) return monRawCache[kind];

  const showType = kind === 'SHOW' ? 'series' : 'movie';
  const fromUnix = Math.floor(monWindowStart(kind) / 1000);

  const changes   = [];
  const showsById = {};
  let cursor  = null;
  let lastErr = null;

  for (let page = 0; page < 4; page++) { // budget cap: 4 pages × 25 = 100 changes
    const params = new URLSearchParams({
      country: 'in',
      change_type: 'new',
      item_type: 'show',
      show_type: showType,
      from: String(fromUnix),
      order_direction: 'desc'
    });
    if (cursor) params.set('cursor', cursor);

    try {
      const text = await fetchUrl(MON_CHANGES_URL + '?' + params.toString(), { 'X-API-Key': MON_API_KEY });
      const data = JSON.parse(text);

      // MoN returns `shows` as an OBJECT MAP keyed by show ID (not an array).
      // Object.entries() converts it into a list we can iterate. Array support
      // kept in case they change the shape someday.
      let showsList = [];
      if (Array.isArray(data.shows)) {
        showsList = data.shows;
      } else if (data.shows && typeof data.shows === 'object') {
        showsList = Object.entries(data.shows).map(([key, val]) => {
          if (val && typeof val === 'object') {
            if (val.id === undefined || val.id === null) val.id = key; // ensure id — use the map key
            return val;
          }
          return { id: key };
        });
      }

      // One-time field dump — verifies the show object shape (tmdbId? originalLanguage?)
      if (page === 0 && showsList.length) {
        console.log('[MoN] Show fields available: ' + Object.keys(showsList[0]).join(', '));
      }

      for (const ch of (Array.isArray(data.changes) ? data.changes : [])) changes.push(ch);
      for (const sh of showsList) if (sh && sh.id !== undefined) showsById[String(sh.id)] = sh;

      if (!data.hasMore || !data.nextCursor) break;
      cursor = data.nextCursor;
    } catch (e) {
      lastErr = e;
      console.warn('[MoN] ' + showType + ' page ' + (page + 1) + ' failed: ' + e.message);
      break;
    }
  }

  if (!changes.length) {
    console.warn('[MoN] ' + showType + ': no changes fetched' + (lastErr ? ' (' + lastErr.message + ')' : ''));
    return null; // null = failure → JustWatch net still runs from fetchDay0Items
  }

  // SAFETY GUARD: changes without shows are unusable
  if (!Object.keys(showsById).length) {
    console.warn('[MoN] ' + showType + ': changes fetched but no shows parsed');
    return null;
  }

  // Remember fetch time so the next run queries only newer changes
  seen['mon_' + kind] = Date.now();
  cacheDirty = true;

  console.log('[MoN] ' + showType + ' changes: ' + changes.length + ' across ' + Object.keys(showsById).length + ' shows');
  monRawCache[kind] = { changes, showsById };
  return monRawCache[kind];
}

// Filter MoN changes to one language + resolve to TMDB IDs.
// Returns [{ id, arrivalDate, title, imdbId, year, isNewSeason }]
async function resolveMonForLang(raw, lang, kind) {
  const langLabel = lang === 'ml' ? 'Malayalam' : 'Tamil';
  const showType  = kind === 'SHOW' ? 'series' : 'movies';
  const items     = [];
  const seenIds   = new Set();

  // Dedupe by showId keeping the NEWEST change (desc order → first is latest).
  // Season/episode changes map to their parent show.
  const latestByShow = new Map();
  for (const ch of raw.changes) {
    if (!ch || ch.showId === undefined) continue;
    // Only genuine streaming arrivals — skip rent/buy noise
    const opt = ch.streamingOptionType;
    if (opt && opt !== 'subscription' && opt !== 'free' && opt !== 'ads' && opt !== 'addon') continue;
    const sid = String(ch.showId);
    if (!latestByShow.has(sid)) latestByShow.set(sid, ch);
  }

  for (const [sid, ch] of latestByShow) {
    const sh = raw.showsById[sid];
    if (!sh) continue;

    const title = (sh.originalTitle || sh.title || '').trim();
    if (!title) continue;

    // Language pre-filter — skips wrong-language titles with ZERO TMDB calls
    if (sh.originalLanguage && String(sh.originalLanguage).toLowerCase() !== lang) continue;

    // Exact arrival date from the change timestamp
    const arrivalDate = ch.timestamp
      ? new Date(ch.timestamp * 1000).toISOString().slice(0, 10)
      : today();

    // Season ≥2 change = returning show's new season → always fresh content
    const isNewSeason = ch.itemType === 'season' && (ch.season || 0) >= 2;

    const tmdbId = (sh.tmdbId !== undefined && sh.tmdbId !== null) ? parseInt(sh.tmdbId, 10) : NaN;
    const imdbId = sh.imdbId || null;
    const year   = sh.releaseYear || null;

    // Path A: TMDB ID provided directly
    if (!isNaN(tmdbId) && tmdbId > 0) {
      if (!seenIds.has(tmdbId)) { seenIds.add(tmdbId); items.push({ id: tmdbId, arrivalDate, title, imdbId, year, isNewSeason }); }
      continue;
    }

    // Path B: IMDb ID → TMDB /find
    if (imdbId) {
      try {
        const data = await tmdb('/find/' + imdbId + '?external_source=imdb_id');
        const hit  = kind === 'SHOW' ? (data.tv_results || [])[0] : (data.movie_results || [])[0];
        if (hit && !seenIds.has(hit.id)) { seenIds.add(hit.id); items.push({ id: hit.id, arrivalDate, title, imdbId, year, isNewSeason }); }
        continue;
      } catch (e) { console.warn('[MoN] Find failed for ' + imdbId + ': ' + e.message); }
    }

    // Path C: title + year search
    const retryKey = 'mon_' + kind.toLowerCase() + '_' + title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
    if (readCacheEntry(movieCache[retryKey]) === 'retry') continue;
    try {
      let r = null;
      if (kind === 'SHOW') {
        const yearParam = year ? '&first_air_date_year=' + year : '';
        const data = await tmdb('/search/tv?query=' + encodeURIComponent(title) + '&language=en-US&page=1' + yearParam);
        r = (data.results || [])[0];
      } else {
        const yearParam = year ? '&primary_release_year=' + year : '';
        const data = await tmdb('/search/movie?query=' + encodeURIComponent(title) + '&language=en-US&page=1' + yearParam);
        r = (data.results || [])[0];
      }
      if (r && !seenIds.has(r.id)) { seenIds.add(r.id); items.push({ id: r.id, arrivalDate, title, imdbId, year, isNewSeason }); }
      else {
        console.log('[MoN] "' + title + '" not on TMDB yet — will retry');
        setRetry(movieCache, retryKey);
      }
    } catch (e) { console.warn('[MoN] Search failed for "' + title + '": ' + e.message); }
  }

  console.log('[MoN] ' + langLabel + ' ' + showType + ' resolved: ' + items.length);
  return items;
}

// ── JUSTWATCH (ALWAYS-ON SAFETY NET — GraphQL newTitles) ──────────────────────

const JW_NEW_QUERY_MOVIE_RICH = `
query JwNew($country: Country!, $date: Date!, $language: Language!, $filter: TitleFilter, $first: Int!, $after: String) {
  newTitles(country: $country, date: $date, filter: $filter, after: $after, first: $first, priceDrops: false, pageType: NEW) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        __typename
        ... on MovieOrSeason {
          objectId
          objectType
          content(country: $country, language: $language) {
            title
            shortDescription
            fullPath
            originalReleaseYear
            externalIds { imdbId tmdbId }
            isReleased
          }
        }
      }
    }
  }
}`;

const JW_NEW_QUERY_SHOW_RICH = `
query JwNew($country: Country!, $date: Date!, $language: Language!, $filter: TitleFilter, $first: Int!, $after: String) {
  newTitles(country: $country, date: $date, filter: $filter, after: $after, first: $first, priceDrops: false, pageType: NEW) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        __typename
        ... on MovieOrSeason {
          objectId
          objectType
          content(country: $country, language: $language) {
            title
            shortDescription
            fullPath
            originalReleaseYear
            externalIds { imdbId tmdbId }
            isReleased
          }
          ... on Season {
            show {
              objectId
              content(country: $country, language: $language) {
                title
                fullPath
                originalReleaseYear
                externalIds { imdbId tmdbId }
              }
            }
          }
        }
      }
    }
  }
}`;

const JW_NEW_QUERY_MOVIE_MINIMAL = `
query JwNew($country: Country!, $date: Date!, $language: Language!, $filter: TitleFilter, $first: Int!, $after: String) {
  newTitles(country: $country, date: $date, filter: $filter, after: $after, first: $first, priceDrops: false, pageType: NEW) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        __typename
        ... on MovieOrSeason {
          objectType
          content(country: $country, language: $language) {
            title
            fullPath
          }
        }
      }
    }
  }
}`;

const JW_NEW_QUERY_SHOW_MINIMAL = `
query JwNew($country: Country!, $date: Date!, $language: Language!, $filter: TitleFilter, $first: Int!, $after: String) {
  newTitles(country: $country, date: $date, filter: $filter, after: $after, first: $first, priceDrops: false, pageType: NEW) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        __typename
        ... on MovieOrSeason {
          objectType
          content(country: $country, language: $language) {
            title
            fullPath
          }
          ... on Season {
            show {
              content(country: $country, language: $language) {
                title
                fullPath
              }
            }
          }
        }
      }
    }
  }
}`;

const jwUseRichQuery = { MOVIE: true, SHOW: true };

function extractJwIdentifiers(node, kind) {
  if (!node) return null;

  if (kind === 'SHOW' && node.show && node.show.content) {
    const sc = node.show.content;
    return {
      title: (sc.title || '').trim(),
      tmdbId: sc.externalIds && sc.externalIds.tmdbId ? parseInt(sc.externalIds.tmdbId, 10) : NaN,
      imdbId: sc.externalIds && sc.externalIds.imdbId ? sc.externalIds.imdbId : null,
      year: sc.originalReleaseYear || null,
      isReleased: node.content ? node.content.isReleased !== false : true,
    };
  }

  const c = node.content;
  if (!c) return null;
  return {
    title: (c.title || '').trim(),
    tmdbId: c.externalIds && c.externalIds.tmdbId ? parseInt(c.externalIds.tmdbId, 10) : NaN,
    imdbId: c.externalIds && c.externalIds.imdbId ? c.externalIds.imdbId : null,
    year: c.originalReleaseYear || null,
    isReleased: c.isReleased !== false,
  };
}

async function jwNewTitlesForDate(dateStr, filter, kind) {
  const collected = [];
  let after = null;

  for (let page = 0; page < 3; page++) {
    const query = jwUseRichQuery[kind]
      ? (kind === 'SHOW' ? JW_NEW_QUERY_SHOW_RICH : JW_NEW_QUERY_MOVIE_RICH)
      : (kind === 'SHOW' ? JW_NEW_QUERY_SHOW_MINIMAL : JW_NEW_QUERY_MOVIE_MINIMAL);

    const payload = JSON.stringify({
      operationName: 'JwNew',
      query: query,
      variables: { country: 'IN', date: dateStr, language: 'en', first: 50, after: after, filter }
    });
    const text = await postJson(JW_GRAPHQL_URL, payload);
    const data = JSON.parse(text);
    if (data.errors && data.errors.length) {
      const msg = data.errors.map(e => e.message).join(' | ');
      if (jwUseRichQuery[kind]) {
        console.warn('[JustWatch] ' + kind + ' rich query rejected, downgrading: ' + msg.slice(0, 120));
        jwUseRichQuery[kind] = false;
        collected.length = 0; after = null; page = -1;
        continue;
      }
      throw new Error('GraphQL: ' + msg);
    }
    const conn = data.data && data.data.newTitles;
    if (!conn) throw new Error('GraphQL: empty newTitles');
    for (const e of (conn.edges || [])) {
      if (e && e.node) collected.push(e.node);
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return collected;
}

const JW_POPULAR_QUERY = `
query JwFetch($filter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!) {
  popularTitles(country: $country, filter: $filter, first: $first, sortBy: POPULAR) {
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

async function fetchJustWatch(lang, kind) {
  const kindLabel = kind === 'SHOW' ? 'series' : 'movies';
  const contents  = [];
  const seenKeys  = new Set();
  let lastErr     = null;

  for (let d = 0; d < JW_DAYS_TO_SCAN; d++) {
    const dateStr = daysAgo(d);
    try {
      const nodes = await jwNewTitlesForDate(dateStr, { objectTypes: [kind] }, kind);
      let added = 0;
      for (const node of nodes) {
        const ids = extractJwIdentifiers(node, kind);
        if (!ids || !ids.title) continue;
        if (!ids.isReleased) continue;
        const key = (node.content && node.content.fullPath) || (ids.title + '|' + (isNaN(ids.tmdbId) ? '' : ids.tmdbId));
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        ids._arrivalDate = dateStr;
        contents.push(ids);
        added++;
      }
      console.log('[JustWatch] ' + kindLabel + ' arrivals on ' + dateStr + ': ' + nodes.length + ' (' + added + ' new to us)');
    } catch (e) {
      lastErr = e;
      console.warn('[JustWatch] ' + dateStr + ' failed: ' + (e.message || '').slice(0, 150));
    }
    await new Promise(r => setTimeout(r, 200));
  }

  if (!contents.length) {
    console.warn('[JustWatch] newTitles unusable (' + (lastErr ? lastErr.message : 'empty') + ') — trying popularTitles fallback');
    try {
      const payload = JSON.stringify({
        operationName: 'JwFetch',
        query: JW_POPULAR_QUERY,
        variables: { country: 'IN', language: 'en', first: 100, filter: { objectTypes: [kind] } }
      });
      const text  = await postJson(JW_GRAPHQL_URL, payload);
      const data  = JSON.parse(text);
      if (data.errors && data.errors.length) throw new Error('GraphQL: ' + data.errors.map(e => e.message).join(' | '));
      const edges = (data.data.popularTitles.edges || []);
      for (const e of edges) {
        if (e && e.node && e.node.content) {
          const c = e.node.content;
          contents.push({
            title: (c.title || '').trim(),
            tmdbId: c.externalIds && c.externalIds.tmdbId ? parseInt(c.externalIds.tmdbId, 10) : NaN,
            imdbId: c.externalIds && c.externalIds.imdbId ? c.externalIds.imdbId : null,
            year: c.originalReleaseYear || null,
            isReleased: true,
            _arrivalDate: today(),
          });
        }
      }
      console.log('[JustWatch] popularTitles fallback: ' + contents.length + ' titles');
    } catch (e) {
      console.warn('[JustWatch] popularTitles fallback also failed: ' + e.message);
      await sendAlert('JustWatch failed: ' + e.message);
      return [];
    }
  }

  const resolved = [];
  const seenIds  = new Set();

  for (const c of contents) {
    const title = c.title;
    if (!title) continue;

    if (!isNaN(c.tmdbId) && c.tmdbId > 0) {
      if (!seenIds.has(c.tmdbId)) { seenIds.add(c.tmdbId); resolved.push({ id: c.tmdbId, arrivalDate: c._arrivalDate, title: c.title, imdbId: c.imdbId, year: c.year }); }
      continue;
    }

    if (c.imdbId) {
      try {
        const data = await tmdb('/find/' + c.imdbId + '?external_source=imdb_id');
        const hit  = kind === 'SHOW'
          ? (data.tv_results || [])[0]
          : (data.movie_results || [])[0];
        if (hit && !seenIds.has(hit.id)) { seenIds.add(hit.id); resolved.push({ id: hit.id, arrivalDate: c._arrivalDate, title: c.title, imdbId: c.imdbId, year: c.year }); }
        continue;
      } catch (e) { console.warn('[JustWatch] Find failed for ' + c.imdbId + ': ' + e.message); }
    }

    const retryKey = 'jw_' + kind.toLowerCase() + '_' + title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
    if (readCacheEntry(movieCache[retryKey]) === 'retry') continue;
    try {
      let r = null;
      if (kind === 'SHOW') {
        const yearParam = c.year ? '&first_air_date_year=' + c.year : '';
        const data = await tmdb('/search/tv?query=' + encodeURIComponent(title) + '&language=en-US&page=1' + yearParam);
        r = (data.results || [])[0];
      } else {
        const yearParam = c.year ? '&primary_release_year=' + c.year : '';
        const data = await tmdb('/search/movie?query=' + encodeURIComponent(title) + '&language=en-US&page=1' + yearParam);
        r = (data.results || [])[0];
      }
      if (r && !seenIds.has(r.id)) { seenIds.add(r.id); resolved.push({ id: r.id, arrivalDate: c._arrivalDate, title: c.title, imdbId: c.imdbId, year: c.year }); }
      else {
        console.log('[JustWatch] "' + title + '" not on TMDB yet — will retry');
        setRetry(movieCache, retryKey);
      }
    } catch (e) { console.warn('[JustWatch] Search failed for "' + title + '": ' + e.message); }

    await new Promise(r => setTimeout(r, 100));
  }

  console.log('[JustWatch] Resolved ' + resolved.length + ' ' + kindLabel + ' to TMDB IDs');
  return resolved;
}

// Unified day-0 entry point: MoN (official, exact timestamps) first, and
// JustWatch ALWAYS runs as a multi-day safety net (it's free). This catches
// titles MoN indexed late or missed entirely (Aha/SonyLIV regional lag).
// Dedup by TMDB id — MoN's exact arrival timestamps win because it runs first.
async function fetchDay0Items(lang, kind) {
  const byId = new Map();

  const monRaw = await fetchMonRaw(kind);
  if (monRaw) {
    for (const it of await resolveMonForLang(monRaw, lang, kind)) {
      if (!byId.has(it.id)) byId.set(it.id, it);
    }
  } else {
    console.log('[Day0] MoN unavailable — JustWatch becomes primary');
  }

  // JustWatch net — ALWAYS on, scans several days back
  try {
    for (const it of await fetchJustWatch(lang, kind)) {
      if (!byId.has(it.id)) byId.set(it.id, it);
    }
  } catch (e) {
    console.warn('[Day0] JustWatch net failed: ' + e.message);
  }

  console.log('[Day0] Combined day-0 pool: ' + byId.size + ' titles');
  return Array.from(byId.values());
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
// - expectedLang: reject movies whose TMDB original_language doesn't match (day-0 path)
// - strictLang: when true, English is ALSO rejected (blocks Hollywood from day-0 feed)
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
      setRetry(movieCache, cacheKey); // IMDb IDs often appear on TMDB days later — retry
      console.log('[Skip] No IMDb ID (will retry): ' + (detail.title || ''));
      return null;
    }

    if (expectedLang && detail.original_language &&
        detail.original_language !== expectedLang &&
        (strictLang || detail.original_language !== 'en')) {
      setSkip(movieCache, cacheKey);
      console.log('[Skip] Wrong language (' + detail.original_language + '): ' + (detail.title || ''));
      return null;
    }

    const IN  = detail['watch/providers'] && detail['watch/providers'].results && detail['watch/providers'].results.IN;
    const all = IN ? [...(IN.flatrate||[]), ...(IN.free||[]), ...(IN.ads||[])] : [];
    if (!all.length) {
      setRetry(movieCache, cacheKey); // provider tags sync from JustWatch with lag — retry in 3 days
      console.log('[Skip] Not on OTT/IN (will retry): ' + (detail.title || ''));
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

// processSeriesJW(item, lang) — for day-0-sourced series arrivals.
// item: { id (TMDB), title, imdbId, year, arrivalDate }
// Handles stale source TMDB IDs: if /tv/{id} 404s, re-resolves via the
// IMDb ID first, then title+year search, before giving up.
async function processSeriesJW(item, lang) {
  const cacheKey = lang + '_series_' + item.id;
  const cached   = readCacheEntry(seriesCache[cacheKey]);

  if (cached === 'skip')  return null;
  if (cached === 'retry') { /* fall through */ }
  else if (cached)        return cached;

  try {
    let tmdbId = item.id;
    let detail = null;

    // Attempt 1: the provided TMDB ID
    try {
      detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers');
    } catch (e) {
      if (!String(e.message).includes('HTTP 404')) throw e; // real errors propagate
      console.log('[JW Series] TMDB ID ' + tmdbId + ' not found for "' + item.title + '" — re-resolving...');
    }

    // Attempt 2: re-resolve via IMDb ID (most reliable)
    if (!detail && item.imdbId) {
      try {
        const data = await tmdb('/find/' + item.imdbId + '?external_source=imdb_id');
        const tv   = (data.tv_results || [])[0];
        if (tv) {
          tmdbId = tv.id;
          detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers');
          console.log('[JW Series] Re-resolved via IMDb -> TMDB ' + tmdbId);
        }
      } catch (e) { console.warn('[JW Series] IMDb re-resolve failed: ' + e.message); }
    }

    // Attempt 3: re-resolve via title + year search
    if (!detail && item.title) {
      try {
        const yearParam = item.year ? '&first_air_date_year=' + item.year : '';
        const data = await tmdb('/search/tv?query=' + encodeURIComponent(item.title) + '&language=en-US&page=1' + yearParam);
        const tv   = (data.results || [])[0];
        if (tv) {
          tmdbId = tv.id;
          detail = await tmdb('/tv/' + tmdbId + '?language=en-US&append_to_response=watch/providers');
          console.log('[JW Series] Re-resolved via search -> TMDB ' + tmdbId);
        }
      } catch (e) { console.warn('[JW Series] Search re-resolve failed: ' + e.message); }
    }

    if (!detail) {
      setRetry(seriesCache, cacheKey);
      console.log('[JW Series] Could not resolve on TMDB (will retry): ' + (item.title || ('ID ' + item.id)));
      return null;
    }

    // STRICT language guard: day-0-sourced series must be exactly the target language
    if (!detail.original_language || detail.original_language !== lang) {
      setSkip(seriesCache, cacheKey);
      console.log('[Skip] Wrong language (' + (detail.original_language || '?') + '): ' + (detail.name || ''));
      return null;
    }

    if (detail.status && detail.status !== 'Returning Series' && detail.status !== 'Ended' && detail.status !== 'Released') {
      setRetry(seriesCache, cacheKey);
      console.log('[Skip] Not released yet (will retry): ' + (detail.name || ''));
      return null;
    }

    // Get IMDb ID — mandatory for Stremio
    let imdbId = null;
    try {
      const ext = await tmdb('/tv/' + tmdbId + '/external_ids');
      imdbId = ext.imdb_id || null;
    } catch(e) {}
    if (!imdbId) {
      setRetry(seriesCache, cacheKey); // IMDb IDs often appear later — retry
      console.log('[Skip] No IMDb ID (will retry): ' + (detail.name || ''));
      return null;
    }

    const IN  = detail['watch/providers'] && detail['watch/providers'].results && detail['watch/providers'].results.IN;
    const all = IN ? [...(IN.flatrate||[]), ...(IN.free||[]), ...(IN.ads||[])] : [];
    const platform = all.length
      ? all.filter((p, i, arr) => arr.findIndex(x => x.provider_id === p.provider_id) === i)
           .map(p => p.provider_name).join(', ')
      : '';

    const meta = buildMeta({
      imdbId:      imdbId,
      type:        'series',
      title:       detail.name || '',
      platform,
      releaseDate: detail.first_air_date || item.arrivalDate || today(),
      overview:    detail.overview || '',
      rating:      detail.vote_average,
      posterPath:  detail.poster_path,
      backdropPath: detail.backdrop_path,
      genres:      (detail.genres || []).map(g => g.name),
    });

    seriesCache[cacheKey] = meta;
    cacheDirty = true;
    console.log('[JW Series OK] ' + meta.name + ' -> ' + imdbId + ' on ' + (platform || 'OTT/IN'));
    return meta;
  } catch (e) {
    setRetry(seriesCache, cacheKey);
    console.warn('[JW Series] Failed: ' + e.message);
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

// ── MOVIES ORCHESTRATOR (MoN → JustWatch → TMDB → Sheet, zero duplicates) ────
async function scrapeMovies(lang) {
  const langLabel = lang === 'ml' ? 'Malayalam' : 'Tamil';
  const metas = [];
  const processedImdbIds = new Set();

  // --- STEP 1: DAY-0 DETECTION (MoN official + JustWatch always-on net) ---
  console.log('\n[Movies] Fetching ' + langLabel + ' day-0 arrivals (MoN → JustWatch)...');
  const day0Items = await fetchDay0Items(lang, 'MOVIE');
  for (const day0Item of day0Items) {
    const cacheKey = lang + '_' + day0Item.id;
    const cachedEntry    = readCacheEntry(movieCache[cacheKey]);
    const isNewDiscovery = cachedEntry === undefined || cachedEntry === 'retry';

    const meta = await processMovie(day0Item, lang, lang, true);
    if (meta && meta.id && !processedImdbIds.has(meta.id) && !metas.some(m => m.id === meta.id)) {
      if (isNewDiscovery) {
        const arrivalDate = day0Item.arrivalDate || today();
        // meta.releaseInfo = TMDB's release date (theatrical, or OTT date for
        // direct-to-OTT). Genuine premieres are always recent by that measure.
        const tmdbDate    = meta.releaseInfo || arrivalDate;
        const ageMs       = Date.now() - new Date(tmdbDate).getTime();
        const isRerelease = !isNaN(ageMs) && ageMs > RERELEASE_MAX_AGE_DAYS * 24 * 3600 * 1000;

        if (isRerelease) {
          // Renewal: keep ORIGINAL date → sorts where it belongs, not on top
          let desc = meta.description || '';
          desc += '\n\n♻️ Re-release: back on OTT on ' + arrivalDate;
          meta.description = desc.trim();
          console.log('[Rerelease] ' + meta.name + ' (from ' + tmdbDate + ') — back on OTT ' + arrivalDate);
        } else {
          // Genuine first OTT release → arrival date is the release date
          meta.releaseInfo = arrivalDate;
        }

        movieCache[cacheKey] = meta;
        cacheDirty = true;
      }
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log('[Movies] ' + metas.length + ' after day-0 detection');

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

    // SMART PATCH: already added by day-0/TMDB, BUT the Sheet has a more
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

    // Day-0 & TMDB both missed it — process from scratch
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
    console.log('[Sheet OK] ' + item.title + ' -> ' + finalImdbId + ' (missed by day-0 & TMDB)');
    await new Promise(r => setTimeout(r, 100));
  }

  // Final Sort
  metas.sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''));
  const finalResult = metas.slice(0, 120);

  console.log('[Movies] ' + lang + ': ' + finalResult.length + ' total in catalogue');
  return finalResult;
}

// ── SERIES (MoN day-0 → JustWatch net → Sheet patch/gap-fill) ────────────────
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
  const metas = [];
  const processedImdbIds = new Set();
  const skipped = [];

  // --- STEP 1: DAY-0 DETECTION (MoN official + JustWatch always-on net) ---
  console.log('\n[Series] Fetching ' + langLabel + ' series day-0 arrivals (MoN → JustWatch)...');
  const day0Items = await fetchDay0Items(lang, 'SHOW');
  for (const day0Item of day0Items) {
    const cacheKey = lang + '_series_' + day0Item.id;
    const cachedEntry    = readCacheEntry(seriesCache[cacheKey]);
    const isNewDiscovery = cachedEntry === undefined || cachedEntry === 'retry';

    const meta = await processSeriesJW(day0Item, lang);
    if (meta && meta.id && !processedImdbIds.has(meta.id) && !metas.some(m => m.id === meta.id)) {
      if (isNewDiscovery) {
        const arrivalDate = day0Item.arrivalDate || today();
        // meta.releaseInfo = TMDB first_air_date (set in processSeriesJW)
        const firstAir    = meta.releaseInfo || arrivalDate;
        const ageMs       = Date.now() - new Date(firstAir).getTime();
        // New seasons of returning shows are always fresh content
        const isNewSeason = day0Item.isNewSeason === true;
        const isRerelease = !isNewSeason && !isNaN(ageMs) && ageMs > RERELEASE_MAX_AGE_DAYS * 24 * 3600 * 1000;

        if (isRerelease) {
          let desc = meta.description || '';
          desc += '\n\n♻️ Re-release: back on OTT on ' + arrivalDate;
          meta.description = desc.trim();
          console.log('[Rerelease] ' + meta.name + ' (first aired ' + firstAir + ') — back on OTT ' + arrivalDate);
        } else {
          meta.releaseInfo = arrivalDate; // premiere OR new season
        }

        seriesCache[cacheKey] = meta;
        cacheDirty = true;
      }
      metas.push(meta);
      processedImdbIds.add(meta.id);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log('[Series] ' + metas.length + ' after day-0 detection');

  // --- STEP 2: GOOGLE SHEET (Patching OTT dates & filling gaps) ---
  console.log('\n[Series] Checking ' + langLabel + ' Sheet for OTT date patches and missing series...');
  const sheetItems = await fetchSheetContent(langLabel, 'series');

  for (const item of sheetItems.slice(0, 50)) {
    let checkId = item.imdbId || null;

    if (!checkId) {
      console.log('[Sheet] No IMDb ID for "' + item.title + '" — searching...');
      const searchData = await tmdb('/search/tv?query=' + encodeURIComponent(item.title) + '&language=en-US&page=1');
      const match = searchData.results.find(r => r.original_language === lang || (r.origin_country && r.origin_country.includes('IN')));
      if (match) {
        try {
          const ext = await tmdb('/tv/' + match.id + '/external_ids');
          checkId = ext.imdb_id || null;
        } catch(e) {}
      }
    }

    // SMART PATCH: already added by day-0, BUT the Sheet has the accurate OTT date
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

        console.log('[Sheet Patch] ✅ Updated OTT date for series ' + item.title + ' to ' + item.date);
      }
      continue;
    }

    // Day-0 missed it — process from scratch via Sheet enrichment
    const tmdbData    = await enrichSeries(item.imdbId, item.title, lang);
    const finalImdbId = item.imdbId || (tmdbData && tmdbData.imdbId) || checkId || null;

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
    processedImdbIds.add(finalImdbId);
    console.log('[Sheet OK] ' + item.title + ' -> ' + finalImdbId + ' (missed by day-0)');
    await new Promise(r => setTimeout(r, 100));
  }

  if (skipped.length > 0) {
    console.log('\n[Series] ⚠️  ' + skipped.length + ' skipped (no IMDb ID found):');
    skipped.forEach(t => console.log('   • ' + t));
    await sendAlert('Series skipped (no IMDb ID): ' + skipped.join(', '));
  }

  // Final Sort (newest OTT arrivals first)
  metas.sort((a, b) => (b.releaseInfo || '').localeCompare(a.releaseInfo || ''));
  const finalResult = metas.slice(0, 80);

  console.log('[Series] ' + lang + ': ' + finalResult.length + ' total in catalogue');
  return finalResult;
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
