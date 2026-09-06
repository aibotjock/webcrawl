// Fast URL discovery without full scrapes: /sitemap.xml (+ robots.txt Sitemap:
// lines, sitemap indexes recursed) races a live same-origin link-graph BFS.
// Merged under a hard time budget. Never throws.
import { config } from './config.js';
import { fetchPage, extractHrefs, normalizeUrl } from './fetch.js';

const isSame = (u, origin) => u.startsWith(origin + '/') || u === origin || u === origin + '/';

// fetchPage drops text/plain bodies (robots.txt), so it needs a raw fetch.
async function getText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': config.userAgent } });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function sitemapStrategy(origin, deadline, found) {
  const queue = [origin + '/sitemap.xml'];
  const robots = await getText(origin + '/robots.txt', Math.min(10000, deadline - Date.now()));
  for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  const seen = new Set();
  while (queue.length && Date.now() < deadline && found.size < 20000) {
    const batch = [];
    for (const raw of queue.splice(0, config.concurrency)) {
      const sm = normalizeUrl(raw, origin);
      if (sm && !seen.has(sm)) {
        seen.add(sm);
        batch.push(sm);
      }
    }
    const results = await Promise.all(
      batch.map(async sm => {
        const r = await fetchPage(sm, { timeoutMs: Math.min(10000, deadline - Date.now()) });
        if (r.error || !r.html) return null;
        return { index: /<sitemapindex/i.test(r.html), locs: [...r.html.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1]) };
      })
    );
    for (const res of results.filter(Boolean)) {
      if (res.index) queue.push(...res.locs);
      else for (const l of res.locs) {
        const u = normalizeUrl(l, origin);
        if (u && isSame(u, origin)) found.add(u);
      }
    }
  }
}

async function linkStrategy(start, origin, deadline, limit, found) {
  const queued = new Set([start]);
  const queue = [start];
  let active = 0;
  let fetched = 0;
  await new Promise(resolve => {
    const done = () => !active && (!queue.length || fetched >= limit || Date.now() >= deadline);
    const tick = () => {
      if (done()) return resolve();
      while (queue.length && active < config.concurrency && fetched < limit && Date.now() < deadline) {
        const u = queue.shift();
        active++;
        fetched++;
        fetchPage(u, { timeoutMs: Math.min(config.timeoutMs, deadline - Date.now()) })
          .then(r => {
            if (!r.error && r.html)
              for (const h of extractHrefs(r.html)) {
                const v = normalizeUrl(h, r.finalUrl || u);
                if (!v || !isSame(v, origin)) continue;
                found.add(v); // collect even unexpanded URLs
                if (!queued.has(v) && queued.size < 20000) {
                  queued.add(v);
                  queue.push(v);
                }
              }
          })
          .catch(() => {})
          .finally(() => {
            active--;
            tick();
          });
      }
      if (done()) resolve();
    };
    tick();
  });
}

export async function mapSite(url, { limit = 200, timeout = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const start = normalizeUrl(url);
    if (!start) throw new Error('invalid url: ' + url);
    const origin = new URL(start).origin;
    const deadline = t0 + timeout;
    const sm = new Set();
    const lk = new Set();
    await Promise.all([
      sitemapStrategy(origin, deadline, sm).catch(() => {}),
      linkStrategy(start, origin, deadline, limit, lk).catch(() => {}),
    ]);
    const urls = [...new Set([...sm, ...lk])].sort();
    return {
      urls,
      count: urls.length,
      latencyMs: Date.now() - t0,
      source: {
        sitemap: urls.filter(u => sm.has(u)).length,
        links: urls.filter(u => lk.has(u)).length,
      },
      ...(urls.length ? {} : { error: 'no urls discovered' }),
    };
  } catch (e) {
    return { urls: [], count: 0, latencyMs: Date.now() - t0, error: String(e?.message || e) };
  }
}
