#!/usr/bin/env node
// Ground truth for map/crawl judging: sitemap.xml URLs ∪ exhaustive same-origin link walk.
// This is BAR infrastructure (independent of the product implementation).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from '../src/core/config.js';
import { fetchPage, extractHrefs, normalizeUrl } from '../src/core/fetch.js';

mkdirSync(new URL('../results/', import.meta.url).pathname, { recursive: true });
const UA = config.userAgent;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sitemapUrls(origin) {
  const found = new Set();
  const seen = new Set();
  const queue = [];
  // discover candidates: robots.txt + /sitemap.xml
  for (const p of [`${origin}/robots.txt`, `${origin}/sitemap.xml`]) {
    const r = await fetchPage(p, { timeoutMs: 15000 });
    if (!r.html) continue;
    if (p.endsWith('robots.txt')) {
      for (const m of r.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
    } else queue.push(p);
  }
  while (queue.length) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await fetchPage(u, { timeoutMs: 20000 });
    if (!r.html?.includes('<sitemap') && !r.html?.includes('<urlset')) continue;
    for (const m of r.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const loc = m[1].trim();
      if (/\.xml(\.gz)?$/i.test(loc)) queue.push(loc); else found.add(normalizeUrl(loc, u) || loc);
    }
  }
  return [...found];
}

async function exhaustiveWalk(start, { maxPages = 2500, timeBudgetMs = 120000, concurrency = 12 } = {}) {
  const t0 = Date.now();
  const origin = new URL(start).origin;
  const seen = new Set([normalizeUrl(start, start)]);
  const queue = [normalizeUrl(start, start)];
  let fetched = 0;
  const pool = Array.from({ length: concurrency }, async () => {
    while (queue.length && fetched < maxPages && Date.now() - t0 < timeBudgetMs) {
      const url = queue.shift();
      if (!url) continue;
      fetched++;
      const r = await fetchPage(url, { timeoutMs: 15000 });
      if (!r.html) continue;
      for (const raw of extractHrefs(r.html)) {
        const n = normalizeUrl(raw, url);
        if (!n || !n.startsWith(origin)) continue;
        if (/\.(css|js|png|jpe?g|gif|svg|ico|xml|zip|pdf|woff2?|ttf|mp4|webm)$/i.test(new URL(n).pathname)) continue;
        if (!seen.has(n)) { seen.add(n); if (queue.length < 20000) queue.push(n); }
      }
    }
  });
  await Promise.all(pool);
  return { urls: [...seen], fetched, elapsedMs: Date.now() - t0 };
}

for (const domain of ['https://books.toscrape.com', 'https://docs.python.org/3/', 'https://react.dev']) {
  const t0 = Date.now();
  const [sitemap, walk] = [await sitemapUrls(new URL(domain).origin), null];
  const w = await exhaustiveWalk(domain);
  const union = new Set([...sitemap, ...w.urls]);
  const out = {
    domain, sitemap: sitemap.sort(), walked: w.urls.sort(), walkedPages: w.fetched, walkElapsedMs: w.elapsedMs,
    union: [...union].sort(), sitemapCount: sitemap.length, walkedCount: w.urls.length, unionCount: union.size,
    elapsedMs: Date.now() - t0,
  };
  const name = domain.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  writeFileSync(new URL(`../results/truth-${name}.json`, import.meta.url).pathname, JSON.stringify(out, null, 1));
  console.log(`TRUTH ${domain}: sitemap=${sitemap.length} walked=${w.urls.length} (fetched ${w.fetched} in ${(w.elapsedMs/1000).toFixed(0)}s) union=${union.length}`);
}
