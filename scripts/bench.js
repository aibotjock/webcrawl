#!/usr/bin/env node
// Benchmarks OUR product against the frozen bar (bar_cache/) and ground truth (results/truth-*).
// Usage: node scripts/bench.js [scrape|map|search|crawl|extract|all]   (default all)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => JSON.parse(readFileSync(ROOT + p, 'utf8'));
const write = (p, o) => writeFileSync(ROOT + p, JSON.stringify(o, null, 2));
mkdirSync(ROOT + 'results', { recursive: true });
const testset = read('testset.json');
const tokens = (s) => (s ? Math.ceil(s.length / 4) : 0);
const slug = (s) => s.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90);
const which = process.argv[2] || 'all';
const done = [];

async function benchScrape() {
  const { scrape } = await import('../src/core/scrape.js');
  const rows = [];
  for (const { url, kind } of testset.scrape) {
    const bar = read(`bar_cache/scrape/${slug(url)}--${kind}.json`);
    const r = await scrape(url, { formats: ['markdown'] });
    rows.push({
      url, kind,
      ours: { latencyMs: r.latencyMs, tokens: tokens(r.markdown), chars: r.markdown?.length || 0, error: r.metadata?.error },
      bar: { latencyMs: bar.latencyMs, tokens: tokens(bar.result?.markdown), chars: bar.result?.markdown?.length || 0, cacheState: bar.result?.metadata?.cacheState },
    });
    write(`results/ours-scrape/${slug(url)}.md.json`, { url, markdown: r.markdown, latencyMs: r.latencyMs, metadata: r.metadata });
    console.log(`SCRAPE ${kind.padEnd(20)} ours ${String(r.latencyMs).padStart(6)}ms/${String(tokens(r.markdown)).padStart(6)}tok  bar ${String(bar.latencyMs).padStart(6)}ms/${String(tokens(bar.result?.markdown)).padStart(6)}tok`);
  }
  write('results/bench-scrape.json', rows);
  done.push('scrape');
}

async function benchMap() {
  const { mapSite } = await import('../src/core/map.js');
  const rows = [];
  for (const { url, limit } of testset.map) {
    const name = slug(url);
    const truth = read(`results/truth-${name}.json`);
    const r = await mapSite(url, { limit });
    const truthSet = new Set(truth.union.map((u) => u.replace(/\/$/, '')));
    const oursSet = new Set(r.urls.map((u) => u.replace(/\/$/, '')));
    let hit = 0;
    for (const u of oursSet) if (truthSet.has(u)) hit++;
    const unionCount = truth.unionCount || truth.union.length;
    rows.push({
      url, limit,
      ours: { count: oursSet.size, latencyMs: r.latencyMs, source: r.source },
      truth: { sitemap: truth.sitemapCount, walked: truth.walkedCount, union: unionCount, walkPages: truth.walkedPages },
      metrics: {
        inTruth: hit, precision: oursSet.size ? +(hit / oursSet.size).toFixed(3) : 0,
        recall: truthSet.size ? +(hit / truthSet.size).toFixed(3) : 0,
        beyondSitemap: oursSet.size - [...oursSet].filter((u) => truth.sitemap.includes(u)).length,
      },
    });
    console.log(`MAP ${url} ours=${oursSet.size} inTruth=${hit} (truth union=${truth.unionCount}, sitemap=${truth.sitemapCount}) ${r.latencyMs}ms`);
  }
  write('results/bench-map.json', rows);
  done.push('map');
}

async function benchSearch() {
  const { webSearch } = await import('../src/core/search.js');
  const rows = [];
  for (const q of testset.search) {
    const bar = read(`bar_cache/search/${slug(q)}.json`);
    const barUrls = new Set((bar.result?.data?.web || []).map((x) => new URL(x.url).hostname));
    const r = await webSearch(q, { limit: 8 });
    const hosts = r.results.map((x) => { try { return new URL(x.url).hostname } catch { return '' } });
    const overlap = hosts.filter((h) => barUrls.has(h)).length;
    rows.push({
      query: q,
      ours: { count: r.results.length, latencyMs: r.latencyMs, top3: r.results.slice(0, 3).map((x) => x.url) },
      bar: { count: (bar.result?.data?.web || []).length, latencyMs: bar.latencyMs, top3: (bar.result?.data?.web || []).slice(0, 3).map((x) => x.url) },
      domainOverlapTop8: overlap,
    });
    console.log(`SEARCH "${q}" ours=${r.results.length} results ${r.latencyMs}ms bar=${(bar.result?.data?.web || []).length} ${bar.latencyMs}ms overlap=${overlap}`);
  }
  write('results/bench-search.json', rows);
  done.push('search');
}

async function benchCrawl() {
  const { crawlSite } = await import('../src/core/crawl.js');
  const rows = [];
  for (const { url, limit } of testset.crawl) {
    const truth = read(`results/truth-${slug(url)}.json`);
    const truthSet = new Set(truth.union.map((u) => u.replace(/\/$/, '')));
    const r = await crawlSite(url, { limit });
    const valid = r.pages.filter((p) => p.statusCode === 200 && (p.markdown?.length || 0) > 200);
    const inTruth = r.pages.filter((p) => truthSet.has(p.url.replace(/\/$/, ''))).length;
    const rows2 = rows;
    rows2.push({
      url, limit,
      ours: {
        pages: r.count, latencyMs: r.latencyMs, msPerPage: Math.round(r.latencyMs / Math.max(1, r.count)),
        validPages: valid.length, inTruth,
        avgTokens: Math.round(r.pages.reduce((a, p) => a + tokens(p.markdown), 0) / Math.max(1, r.count)),
      },
      bar: { note: 'keyless cloud crawl returned 401 Unauthorized — judged against truth + parity of scrape quality' },
      sample: r.pages.slice(0, 5).map((p) => ({ url: p.url, chars: p.markdown?.length || 0 })),
    });
    write(`results/ours-crawl-${slug(url)}.json`, r);
    console.log(`CRAWL ${url} pages=${r.count} valid=${valid.length} inTruth=${inTruth} ${r.latencyMs}ms (${Math.round(r.latencyMs / Math.max(1, r.count))}ms/page)`);
  }
  write('results/bench-crawl.json', rows);
  done.push('crawl');
}

async function benchExtract() {
  const { extract } = await import('../src/core/extract.js');
  const cases = [
    {
      name: 'book-product',
      url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
      schema: {
        type: 'object', additionalProperties: false,
        properties: { title: { type: 'string' }, price: { type: 'number' }, availability: { type: 'string' }, sku: { type: 'string' }, description: { type: 'string' } },
        required: ['title', 'price', 'availability'],
      },
      expected: { title: 'A Light in the Attic', price: 51.77, availability: 'In stock (22 available)' },
    },
    {
      name: 'hn-front',
      url: 'https://news.ycombinator.com/',
      schema: {
        type: 'object', additionalProperties: false,
        properties: { stories: { type: 'array', maxItems: 5, items: { type: 'object', properties: { title: { type: 'string' }, points: { type: 'number' }, comments: { type: 'number' } }, required: ['title'] } } },
        required: ['stories'],
      },
      expected: { note: 'top-5 HN stories with points/comments; verify against live page' },
    },
  ];
  const rows = [];
  for (const c of cases) {
    const r = await extract(c.url, c.schema);
    rows.push({ name: c.name, url: c.url, mode: r.mode, latencyMs: r.latencyMs, schemaValid: !r.error, data: r.data, expected: c.expected });
    console.log(`EXTRACT ${c.name} mode=${r.mode} ${r.latencyMs}ms valid=${!r.error}`);
  }
  write('results/bench-extract.json', rows);
  done.push('extract');
}

if (which === 'all' || which === 'scrape') await benchScrape().catch((e) => console.error('scrape bench failed:', e.message));
if (which === 'all' || which === 'map') await benchMap().catch((e) => console.error('map bench failed:', e.message));
if (which === 'all' || which === 'search') await benchSearch().catch((e) => console.error('search bench failed:', e.message));
if (which === 'all' || which === 'crawl') await benchCrawl().catch((e) => console.error('crawl bench failed:', e.message));
if (which === 'all' || which === 'extract') await benchExtract().catch((e) => console.error('extract bench failed:', e.message));
console.log('BENCH DONE:', done.join(', '));
process.exit(0);
