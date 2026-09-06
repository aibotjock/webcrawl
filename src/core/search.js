// Keyless web search: DuckDuckGo HTML endpoints, browser-render fallback. Never throws.
import { fetchPage, normalizeUrl } from './fetch.js';
import { config } from './config.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', deg: '°', pound: '£', euro: '€', plusmn: '±' };
const decode = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] || m);
const strip = (s) => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ')
  .replace(/\s*\.\.\.\s*/g, ' ').replace(/^[\s.….]+|[\s.….]+$/g, '').trim();

function unwrap(href) {
  let h = decode(String(href || '').trim());
  const m = h.match(/[?&]uddg=([^&"'\s]+)/);
  if (m) { try { h = decodeURIComponent(m[1]); } catch { h = m[1]; } }
  if (h.startsWith('//')) h = 'https:' + h;
  return h;
}
const junk = (u) => !u || /duckduckgo\.com\/(y\.js|l\/|ad)|([a-z0-9-]*\.)?duckduckgo\.com\/(search|anomaly)\.|doubleclick\.net|amazon-adsystem|bing\.com\/aclick/i.test(u)
  || /^https?:\/\/([a-z0-9.-]*\.)?duckduckgo\.com\//i.test(u);

function anchors(html, cls) {
  const out = [];
  const re = new RegExp(`<a\\b([^>]*\\bclass=["']${cls}["'][^>]*)>([\\s\\S]*?)</a>`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push({ href: (m[1].match(/href=["']([^"']+)["']/i) || [])[1], text: m[2] });
  return out;
}
const parseHtml = (html) => { const l = anchors(html, 'result__a'), s = anchors(html, 'result__snippet'); return l.map((a, i) => ({ title: strip(a.text), url: unwrap(a.href), description: strip(s[i]?.text) })); };
const parseLite = (html) => {
  const l = anchors(html, 'result-link'), s = [...html.matchAll(/class=["']?result-snippet["']?[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
  return l.map((a, i) => ({ title: strip(a.text), url: unwrap(a.href), description: strip(s[i]) }));
};
const parseRendered = (html) => {
  const t = [...html.matchAll(/<a\b([^>]*data-testid="result-title-a"[^>]*)>([\s\S]*?)<\/a>/gi)];
  const s = [...html.matchAll(/data-result="snippet"[^>]*>([\s\S]*?)<\/(?:div|span)>/gi)].map((m) => m[1]);
  return t.map((m, i) => ({ title: strip(m[2]), url: unwrap((m[1].match(/href=["']([^"']+)["']/i) || [])[1]), description: strip(s[i]) }));
};

function clean(rows, limit) {
  const seen = new Set(), out = [];
  for (const r of rows || []) {
    const url = normalizeUrl(unwrap(r.url), 'https://duckduckgo.com');
    if (!url || junk(r.url) || junk(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: r.title || url, url, description: r.description || '' });
    if (out.length >= limit) break;
  }
  return out;
}

async function ddgPost(url, q) {
  const res = await fetch(`${url}?q=${encodeURIComponent(q)}`, {
    method: 'POST',
    headers: { 'user-agent': config.userAgent, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', origin: 'https://duckduckgo.com', referer: 'https://duckduckgo.com/' },
    body: new URLSearchParams({ q }).toString(),
    signal: AbortSignal.timeout(12000),
  });
  return { status: res.status, html: await res.text(), error: res.status >= 400 ? `http ${res.status}` : undefined };
}
async function ddgGet(url, q) {
  const r = await fetchPage(`${url}?q=${encodeURIComponent(q)}`, { timeoutMs: 12000 });
  return { status: r.status, html: r.html, error: r.error };
}
async function tryHttp(kind, url, q) {
  const r = kind === 'post' ? await ddgPost(url, q) : await ddgGet(url, q);
  if (r.error) throw new Error(`${url} ${r.error}`);
  if (r.status === 202 || /anomaly-modal|Unfortunately, bots/i.test(r.html)) throw new Error(`${url} anomaly-blocked (${r.status})`);
  const rows = url.includes('lite.') ? parseLite(r.html) : parseHtml(r.html);
  if (!rows.length) throw new Error(`${url} no results`);
  return rows;
}
async function tryRender(q) {
  const { renderPage } = await import('./browser.js');
  const enc = encodeURIComponent(q);
  for (const [u, parse] of [[`https://duckduckgo.com/?q=${enc}`, parseRendered], [`https://html.duckduckgo.com/html/?q=${enc}`, parseHtml], [`https://lite.duckduckgo.com/lite/?q=${enc}`, parseLite]]) {
    const r = await renderPage(u, { timeoutMs: 20000 });
    if (!r?.error && r?.html) {
      const rows = parse(r.html);
      if (rows.length) return rows;
    }
  }
  throw new Error('rendered SERP yielded no results');
}

export async function webSearch(query, { limit = 8 } = {}) {
  const t0 = Date.now();
  const attempts = [
    ['post', 'https://html.duckduckgo.com/html/'],
    ['get', 'https://html.duckduckgo.com/html/'],
    ['post', 'https://lite.duckduckgo.com/lite/'],
    ['get', 'https://lite.duckduckgo.com/lite/'],
  ];
  const errs = [];
  for (const [kind, url] of attempts) {
    try {
      const results = clean(await tryHttp(kind, url, query), limit);
      if (results.length) return { results, latencyMs: Date.now() - t0 };
      errs.push(`${url} filtered empty`);
    } catch (e) { errs.push(String(e?.message || e)); }
  }
  try {
    const results = clean(await tryRender(query), limit);
    if (results.length) return { results, latencyMs: Date.now() - t0 };
  } catch (e) { errs.push(String(e?.message || e)); }
  return { results: [], latencyMs: Date.now() - t0, error: 'search unavailable: ' + errs.join(' | ') };
}
