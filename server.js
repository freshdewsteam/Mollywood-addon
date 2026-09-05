// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Helper to read JSON file
function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  } catch (e) {
    console.error('Error reading JSON:', e.message);
    return null;
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = req.url.split('?')[0]; // Remove query params

  // ── Serve HTML page for root ──
  if (url === '/') {
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      // Live stats from cache — shows visitors the addon is alive
      const cache = readJsonFile(path.join(__dirname, 'data', 'cache.json'));
      const counts = cache ? {
        mm: (cache['malayalam-movies']  || []).length,
        ms: (cache['malayalam-series']  || []).length,
        tm: (cache['tamil-movies']      || []).length,
        ts: (cache['tamil-series']      || []).length,
      } : { mm: 0, ms: 0, tm: 0, ts: 0 };
      const total = counts.mm + counts.ms + counts.tm + counts.ts;
      const host = req.headers.host;

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${manifest.name} — New Malayalam & Tamil OTT releases, daily</title>
  <meta name="description" content="${manifest.description}">
  <meta property="og:title" content="${manifest.name} — Mollywood & Kollywood on OTT, day-0">
  <meta property="og:description" content="New Malayalam & Tamil movies and series on OTT — detected the day they drop. Free Stremio addon, updated 5x daily.">
  <meta property="og:image" content="https://${host}/public/og-image.png">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background:#0a0e14; color:#e6edf3; line-height:1.6; }
    .wrap { max-width: 880px; margin: 0 auto; padding: 0 20px; }
    a { color:#4fd1c5; }

    .hero { text-align:center; padding: 80px 0 50px; background: radial-gradient(ellipse at top, #0f2733 0%, #0a0e14 70%); }
    .badge { display:inline-block; background:#132a33; color:#4fd1c5; border:1px solid #1e4a52; padding:5px 14px; border-radius:20px; font-size:.8rem; font-weight:600; letter-spacing:.5px; margin-bottom:22px; }
    h1 { font-size: clamp(2.4rem, 6vw, 3.6rem); background: linear-gradient(90deg,#4fd1c5,#63b3ed); -webkit-background-clip:text; background-clip:text; color:transparent; }
    .tagline { font-size:1.15rem; color:#9fb3c8; max-width:560px; margin:14px auto 8px; }
    .tagline b { color:#e6edf3; }
    .cta-row { margin-top:30px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
    .btn { display:inline-block; padding:14px 32px; border-radius:10px; font-size:1.05rem; font-weight:700; text-decoration:none; transition: transform .15s, box-shadow .15s; }
    .btn:hover { transform: translateY(-2px); }
    .btn-primary { background: linear-gradient(90deg,#14b8a6,#3b82f6); color:#fff; box-shadow: 0 4px 24px rgba(20,184,166,.35); }
    .btn-primary:hover { box-shadow: 0 6px 32px rgba(20,184,166,.5); }
    .btn-ghost { background:#16202b; color:#c9d6e2; border:1px solid #263444; }
    .stats { display:flex; gap:30px; justify-content:center; margin-top:36px; flex-wrap:wrap; }
    .stat b { display:block; font-size:1.5rem; color:#4fd1c5; }
    .stat span { font-size:.8rem; color:#7a8ea3; text-transform:uppercase; letter-spacing:1px; }

    section { padding: 44px 0; }
    h2 { font-size:1.5rem; margin-bottom:20px; text-align:center; }
    h2 span { color:#4fd1c5; }

    .callout { background:#1a2332; border:1px solid #2b6a5e; border-left:4px solid #14b8a6; border-radius:10px; padding:18px 22px; font-size:.95rem; }
    .callout b { color:#4fd1c5; }

    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; }
    .card { background:#111926; border:1px solid #1e2c3d; border-radius:12px; padding:20px; transition: border-color .2s; }
    .card:hover { border-color:#2b6a5e; }
    .card .ico { font-size:1.6rem; }
    .card h3 { font-size:1rem; margin:8px 0 4px; }
    .card p { font-size:.85rem; color:#8ba0b5; }
    .card .num { font-size:1.3rem; font-weight:800; color:#4fd1c5; }

    .steps { counter-reset: step; }
    .step { display:flex; gap:16px; padding:14px 0; align-items:flex-start; }
    .step::before { counter-increment: step; content: counter(step); flex-shrink:0; width:32px; height:32px; border-radius:50%; background:#132a33; color:#4fd1c5; font-weight:700; display:flex; align-items:center; justify-content:center; border:1px solid #1e4a52; }
    .step div b { display:block; }
    .step div { color:#9fb3c8; font-size:.95rem; }

    details { background:#111926; border:1px solid #1e2c3d; border-radius:10px; padding:14px 18px; margin-bottom:10px; }
    summary { cursor:pointer; font-weight:600; }
    details p { color:#9fb3c8; font-size:.92rem; margin-top:10px; }

    footer { border-top:1px solid #1a2433; margin-top:40px; padding:34px 0 50px; text-align:center; color:#7a8ea3; font-size:.85rem; }
    footer .heart { color:#e2556e; }
    @media (max-width:600px){ .hero{padding:56px 0 36px;} .stats{gap:18px;} }
  </style>
</head>
<body>

  <div class="hero">
    <div class="wrap">
      <span class="badge">⚡ UPDATED 5× A DAY — AUTOMATICALLY</span>
      <h1>🌊 ${manifest.name}</h1>
      <p class="tagline">New <b>Malayalam</b> & <b>Tamil</b> movies and series on OTT — detected <b>the day they drop</b>. Never miss an OTT release again.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="stremio://${host}/manifest.json">📦 Install in Stremio</a>
        <a class="btn btn-ghost" href="https://${host}/manifest.json">🔧 Manual / Nuvio install</a>
      </div>
      <div class="stats">
        <div class="stat"><b>${total}</b><span>Titles tracked</span></div>
        <div class="stat"><b>${counts.mm + counts.tm}</b><span>Movies</span></div>
        <div class="stat"><b>${counts.ms + counts.ts}</b><span>Series</span></div>
        <div class="stat"><b>4</b><span>Catalogs</span></div>
      </div>
    </div>
  </div>

  <section>
    <div class="wrap">
      <div class="callout">
        🎯 <b>This is a discovery addon.</b> It tells you <i>what's new on OTT</i> — pair it with a stream addon like <b>Torrentio</b> or <b>TorBox</b> to actually watch. Install both, and new releases appear in your home row the day they premiere.
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <h2>📚 <span>Catalogs</span></h2>
      <div class="grid">
        <div class="card"><div class="ico">🎬</div><h3>Malayalam Movies</h3><p class="num">${counts.mm} tracking</p><p>Latest Mollywood OTT premieres</p></div>
        <div class="card"><div class="ico">📺</div><h3>Malayalam Series</h3><p class="num">${counts.ms} tracking</p><p>New web series & returning seasons</p></div>
        <div class="card"><div class="ico">🎬</div><h3>Tamil Movies</h3><p class="num">${counts.tm} tracking</p><p>Latest Kollywood OTT premieres</p></div>
        <div class="card"><div class="ico">📺</div><h3>Tamil Series</h3><p class="num">${counts.ts} tracking</p><p>New web series & returning seasons</p></div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <h2>⚙️ <span>How it works</span></h2>
      <div class="steps">
        <div class="step"><div><b>Day-0 detection</b>Official streaming-catalog APIs watch every Indian OTT platform — Hotstar, Prime, SonyLIV, Zee5, SunNXT, ManoramaMAX & more — for new arrivals.</div></div>
        <div class="step"><div><b>Smart enrichment</b>TMDB & OMDb attach posters, descriptions, ratings and IMDb IDs. Wrong-language titles are filtered out automatically.</div></div>
        <div class="step"><div><b>Human verification</b>A manually maintained release-date sheet patches and corrects anything the machines get wrong.</div></div>
        <div class="step"><div><b>Straight to your home screen</b>The catalog refreshes 5 times a day. New premieres appear at the top — on release day, not a week later.</div></div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <h2>✨ <span>Why South Streams</span></h2>
      <div class="grid">
        <div class="card"><div class="ico">⚡</div><h3>Same-day detection</h3><p>Premieres appear within hours of hitting OTT — not days.</p></div>
        <div class="card"><div class="ico">🛡️</div><h3>Renewal-proof</h3><p>Re-licenses and renewals are labeled — only real premieres top the list.</p></div>
        <div class="card"><div class="ico">🇮🇳</div><h3>Curated, not flooded</h3><p>Strict Malayalam & Tamil language guards. No random Hollywood dumps.</p></div>
        <div class="card"><div class="ico">🆓</div><h3>Free forever</h3><p>No accounts, no keys, no tracking. Just install and browse.</p></div>
        <div class="card"><div class="ico">📱</div><h3>Works everywhere</h3><p>Stremio on Android, iOS, Windows, Mac, TV — and Nuvio.</p></div>
        <div class="card"><div class="ico">🤝</div><h3>Plays nice</h3><p>Uses standard IMDb IDs — pairs perfectly with Torrentio, TorBox & debrid addons.</p></div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <h2>❓ <span>FAQ</span></h2>
      <details open><summary>How do I watch the movies?</summary><p>South Streams is a catalog addon — it shows you what's new. Install a stream addon like <b>Torrentio</b> (free, torrent-based) or <b>TorBox</b> alongside it, and play buttons appear automatically on every title.</p></details>
      <details><summary>Does it cost anything?</summary><p>No. The addon is completely free and open source. Your Stremio account and any stream addons you choose are separate.</p></details>
      <details><summary>How often does it update?</summary><p>Five times daily (midnight, early morning, morning, noon and evening IST) — new OTT premieres usually appear within hours of release.</p></details>
      <details><summary>A movie I expected is missing?</summary><p>Only titles that genuinely premiered on Indian OTT appear at the top. Catalog re-licenses appear lower, labeled "Re-release". Very rare edge cases can be reported on GitHub.</p></details>
    </div>
  </section>

  <footer>
    <div class="wrap">
      <p><a href="https://github.com/freshdewsteam/South-Streams">GitHub — open source</a> · Report issues · Contribute</p>
      <p style="margin-top:10px;">South Streams provides metadata only and hosts no content. All titles link to their official streaming platforms.</p>
      <p style="margin-top:10px;">Built with <span class="heart">❤️</span> for the South Indian OTT community</p>
    </div>
  </footer>

</body>
</html>
      `);
    } else {
      res.writeHead(404);
      res.end('Manifest not found');
    }
    return;
  }

server.listen(PORT, () => {
  console.log('🌊 South Streams server running on port ' + PORT);
});
