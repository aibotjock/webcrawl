// The search engine: candidate sources -> page fetch (webcrawl) -> passage ranking
// (Jev when configured, else BM25 + optional embeddings) -> results with highlights.
//
// Levels
//   instant   cached pages only (private index), no network        ~<0.3 s
//   fast      all sources, ranked on titles/snippets, no page fetch ~1 s
//   standard  fast + fetch top pages, rank passages, highlights      ~3-8 s
//   deep      LLM sub-queries + link-following + standard + answer   ~15-60 s
import { gather, pickProviders, domainMatch } from './providers.js';
import { chunkMarkdown, lexicalSemanticScores, bm25, normalize, bestSentences, tokens, embedConfig } from './rank.js';
import { jevConfig, scorePassages, matchImages, scoreScreenshots } from './jev.js';
import { llmConfig, expandQuery, answerFrom, judgeSameItem, chat } from './llm.js';
import { createCache } from './cache.js';
import { publishedDateOf, pageImages, loadImage, normalizeImage } from './media.js';
import { normalizeUrl } from '../core/fetch.js';
import { guardedFetch } from '../core/guard.js';

export const LEVELS = ['instant', 'fast', 'standard', 'deep'];
let sharedCache;
const defaultCache = () => (sharedCache ||= createCache());

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function defaultScrape(url, { timeout }) {
  const { scrape } = await import('../core/scrape.js');
  return scrape(url, { formats: ['markdown', 'rawHtml'], timeout });
}

// deps are injectable for tests and for embedding the engine elsewhere.
function resolveDeps(deps = {}) {
  return {
    fetchImpl: deps.fetchImpl || globalThis.fetch, // trusted: sources, Jev, LLM, embeddings
    untrustedFetch: deps.untrustedFetch || deps.fetchImpl || guardedFetch, // user/page URLs: images
    scrapeFn: deps.scrapeFn || defaultScrape,
    screenshotFn: deps.screenshotFn,
    cache: deps.cache || defaultCache(),
    jev: deps.jev === undefined ? jevConfig() : deps.jev,
    llm: deps.llm === undefined ? llmConfig() : deps.llm,
    embed: deps.embed === undefined ? embedConfig() : deps.embed,
    registry: deps.registry || undefined,
    defaultProviders: deps.defaultProviders,
  };
}

// Fetches a page through the cache. Returns { url, title, markdown, publishedDate, images, fetchedAt, cached } or null.
async function getPage(url, d, { maxAgeHours, timeout = 15000 } = {}) {
  if (maxAgeHours == null || !Number.isFinite(Number(maxAgeHours))) maxAgeHours = undefined; else maxAgeHours = Number(maxAgeHours);
  const hit = maxAgeHours === -1 || maxAgeHours === undefined || maxAgeHours > 0 ? await d.cache.get(url, maxAgeHours === -1 ? undefined : maxAgeHours) : null;
  if (hit) return { ...hit, cached: true };
  if (maxAgeHours === -1) return null; // cache only
  let r;
  try { r = await d.scrapeFn(url, { timeout }); } catch { return null; }
  if (!r || r.metadata?.error || !r.markdown) return null;
  const finalUrl = normalizeUrl(r.metadata?.url || url) || url;
  const page = {
    url,
    finalUrl,
    title: r.metadata?.title || '',
    description: r.metadata?.description || '',
    markdown: r.markdown,
    publishedDate: publishedDateOf(r.rawHtml),
    images: pageImages(r.rawHtml, finalUrl),
  };
  return { ...(await d.cache.put(page)), cached: false };
}

function inDateRange(date, start, end) {
  if (!start && !end) return true;
  if (!date) return null; // unknown
  const t = Date.parse(date);
  if (start && t < Date.parse(start)) return false;
  if (end && t > Date.parse(end)) return false;
  return true;
}

// Scores passages; Jev leads when available, the model-free score steadies it.
async function rankPassages(query, passages, d, { rerank = 'auto', notes, meter }) {
  const texts = passages.map((p) => `${p.title || ''}\n${p.heading || ''}\n${p.text}`);
  const local = await lexicalSemanticScores(query, texts, { fetchImpl: d.fetchImpl, cfg: d.embed });
  let method = local.method, scores = local.scores;
  if (rerank !== 'local' && d.jev && passages.length) {
    try {
      const j = await scorePassages(query, passages, { cfg: d.jev, fetchImpl: d.fetchImpl });
      scores = j.scores.map((s, i) => (s == null ? local.scores[i] : 0.75 * s + 0.25 * local.scores[i]));
      method = `jev(${j.model})+${local.method}`;
      meter.jev.requests += j.requests; meter.jev.inputTokens += j.usage.input_tokens; meter.jev.costDollars += j.costDollars; meter.jev.model = j.model;
    } catch (e) {
      if (rerank === 'jev') throw e;
      notes.push(`Jev unavailable, ranked with ${local.method}: ${e.message}`);
    }
  }
  return { scores, method };
}

const asObj = (v, dflt = {}) => (v === true ? dflt : v && typeof v === 'object' ? v : null);

function shapeResult(item, query, { text, highlights }) {
  const out = {
    id: item.url, url: item.url, title: item.title || item.url, publishedDate: item.publishedDate || null,
    score: Math.round(item.score * 1000) / 1000, sources: item.sources || [],
    ...(item.image && { image: item.image }),
  };
  const h = asObj(highlights, {});
  if (h) {
    const per = Math.max(1, Math.min(5, Number(h.highlightsPerUrl) || 1));
    const n = Math.max(1, Math.min(8, Number(h.numSentences) || 3));
    const ps = (item.passages || []).slice(0, per);
    out.highlights = ps.length ? ps.map((p) => bestSentences(h.query || query, p.text, n)) : (item.description ? [item.description] : []);
    out.highlightScores = ps.length ? ps.map((p) => Math.round(p.score * 1000) / 1000) : out.highlights.map(() => out.score);
  }
  const t = asObj(text, {});
  if (t && item.markdown) {
    const max = Number(t.maxCharacters) || 20000;
    out.text = item.markdown.length > max ? item.markdown.slice(0, max) + '…' : item.markdown;
  }
  return out;
}

// Same-origin links from a page whose anchor text or URL shares words with the query.
function promisingLinks(page, query, n) {
  if (!n) return [];
  const origin = (() => { try { return new URL(page.finalUrl || page.url).origin; } catch { return ''; } })();
  const stem = (t) => t.replace(/(ing|ed|es|e|s)$/, '');
  const q = new Set(tokens(query).map(stem));
  const seen = new Set();
  const links = [];
  for (const m of String(page.markdown).matchAll(/(?<!!)\[([^\]]{2,120})\]\(([^)\s]+)/g)) {
    const u = normalizeUrl(m[2], page.finalUrl || page.url);
    if (!u || !u.startsWith(origin + '/') || seen.has(u) || u === page.url) continue;
    seen.add(u);
    const hits = tokens(`${m[1]} ${u}`).filter((t) => q.has(stem(t))).length;
    if (hits) links.push([hits, u]);
  }
  return links.sort((a, b) => b[0] - a[0]).slice(0, n).map(([, u]) => u);
}

export async function search(query, opts = {}, deps = {}) {
  const t0 = Date.now();
  const d = resolveDeps(deps);
  const notes = [];
  const meter = { jev: { requests: 0, inputTokens: 0, costDollars: 0, model: null }, pagesFetched: 0, pagesFromCache: 0 };
  const q = String(query || '').trim();
  if (!q) return { results: [], error: 'query required', latencyMs: 0 };
  let level = LEVELS.includes(opts.level) ? opts.level : 'standard';
  const requestedLevel = level;
  const numResults = Math.max(1, Math.min(50, Number(opts.numResults) || 10));
  const includeDomains = opts.includeDomains || [], excludeDomains = opts.excludeDomains || [];
  const { startPublishedDate: start, endPublishedDate: end } = opts;
  const domainOk = (u) => (!includeDomains.length || domainMatch(u, includeDomains)) && !(excludeDomains.length && domainMatch(u, excludeDomains));

  if (level === 'deep' && !d.llm) { level = 'standard'; notes.push('deep needs an LLM (WEBCRAWL_LLM_*); ran standard instead'); }

  // ---- instant: private index only
  if (level === 'instant') {
    const hits = await d.cache.search(q, { limit: numResults * 2, filter: (p) => domainOk(p.url) && inDateRange(p.publishedDate, start, end) !== false });
    const results = hits.slice(0, numResults).map((h) => shapeResult({ ...h.page, score: h.score, passages: [{ text: h.passage.text, score: h.score }], sources: ['cache'] }, q, opts));
    if (!(await d.cache.size())) notes.push('cache is empty: instant searches pages earlier searches fetched');
    return finish({ results, level, requestedLevel, providers: [{ name: 'cache', results: hits.length }], ranking: 'bm25', meter, notes, t0 });
  }

  // ---- candidates (deep fans out over LLM-written sub-queries)
  const { use, skipped } = pickProviders(opts.providers?.length ? opts.providers : d.defaultProviders, d.registry);
  if (skipped.length) notes.push(`skipped providers (unknown or not configured): ${skipped.join(', ')}`);
  if (!use.length) return finish({ results: [], level, requestedLevel, providers: [], meter, notes, t0, error: 'no search providers available' });
  const candidateCount = Math.max(numResults, Math.min(50, Number(opts.candidates) || (level === 'deep' ? 30 : level === 'standard' ? 20 : Math.max(10, numResults * 2))));

  let subqueries;
  let candidates, providerStats;
  if (level === 'deep') {
    try { subqueries = await expandQuery(q, { cfg: d.llm, fetchImpl: d.fetchImpl, n: 4 }); }
    catch (e) { notes.push(`query expansion failed: ${e.message}`); subqueries = []; }
    const all = [q, ...subqueries.filter((s) => s.toLowerCase() !== q.toLowerCase())];
    const runs = await Promise.all(all.map((s) => gather(s, { providers: use, limit: 20, includeDomains, excludeDomains, fetchImpl: d.fetchImpl, ...(d.registry && { registry: d.registry }) })));
    const merged = new Map();
    for (const r of runs) for (const c of r.candidates) {
      const cur = merged.get(c.url);
      if (cur) { cur.rrf += c.rrf; cur.sources = [...new Set([...cur.sources, ...c.sources])]; } else merged.set(c.url, { ...c });
    }
    candidates = [...merged.values()].sort((a, b) => b.rrf - a.rrf).slice(0, candidateCount);
    providerStats = runs.flatMap((r) => r.providers);
  } else {
    const g = await gather(q, { providers: use, limit: candidateCount, includeDomains, excludeDomains, fetchImpl: d.fetchImpl, ...(d.registry && { registry: d.registry }) });
    candidates = g.candidates; providerStats = g.providers;
  }
  if (!candidates.length) return finish({ results: [], level, requestedLevel, providers: providerStats, meter, notes, t0, subqueries, error: providerStats.every((p) => p.error) ? 'all search providers failed' : undefined });
  const rrfN = normalize(candidates.map((c) => c.rrf));
  candidates.forEach((c, i) => { c.prior = rrfN[i]; });

  // ---- fast: rank on snippets only
  if (level === 'fast') {
    const passages = candidates.map((c) => ({ title: c.title, heading: '', text: c.description || c.title }));
    const { scores, method } = await rankPassages(q, passages, d, { rerank: opts.rerank, notes, meter });
    let items = candidates.map((c, i) => ({ ...c, score: 0.85 * scores[i] + 0.15 * c.prior, passages: [] }))
      .filter((c) => inDateRange(c.publishedDate, start, end) !== false)
      .sort((a, b) => b.score - a.score).slice(0, numResults);
    if (opts.text) { // contents asked for: fetch just the winners
      items = await pool(items, 8, async (it) => {
        const p = await getPage(it.url, d, { maxAgeHours: opts.maxAgeHours });
        if (p) { p.cached ? meter.pagesFromCache++ : meter.pagesFetched++; }
        return p ? { ...it, markdown: p.markdown, publishedDate: it.publishedDate || p.publishedDate, image: p.images?.[0] } : it;
      });
    }
    return finish({ results: items.map((it) => shapeResult(it, q, opts)), level, requestedLevel, providers: providerStats, ranking: method, meter, notes, t0 });
  }

  // ---- standard / deep: fetch pages, rank passages
  const pages = (await pool(candidates, 8, async (c) => {
    const p = await getPage(c.url, d, { maxAgeHours: opts.maxAgeHours });
    if (p) { p.cached ? meter.pagesFromCache++ : meter.pagesFetched++; }
    return { cand: c, page: p };
  }));

  if (level === 'deep' && Number(opts.subpages ?? 2) > 0) {
    // follow the most promising in-site links of the top pages (one hop)
    const top = pages.filter((x) => x.page).slice(0, 4);
    const have = new Set(pages.map((x) => x.cand.url));
    const extra = [...new Set(top.flatMap((x) => promisingLinks(x.page, q, Number(opts.subpages ?? 2))))].filter((u) => !have.has(u) && domainOk(u)).slice(0, 8);
    const sub = await pool(extra, 8, async (u) => {
      const p = await getPage(u, d, { maxAgeHours: opts.maxAgeHours });
      if (p) { p.cached ? meter.pagesFromCache++ : meter.pagesFetched++; }
      return { cand: { url: u, title: p?.title || '', description: '', sources: ['subpage'], prior: 0 }, page: p };
    });
    pages.push(...sub.filter((x) => x.page));
  }

  const perPage = Math.max(2, Math.min(8, Number(opts.passagesPerPage) || 5));
  const passages = [];
  const pageItems = [];
  for (const { cand, page } of pages) {
    const publishedDate = cand.publishedDate || page?.publishedDate;
    const inRange = inDateRange(publishedDate, start, end);
    if (inRange === false) continue;
    const item = { ...cand, title: page?.title || cand.title, publishedDate, markdown: page?.markdown, image: page?.images?.[0], dateUnknown: inRange === null, passages: [] };
    pageItems.push(item);
    let chunks = page ? chunkMarkdown(page.markdown).map((c) => ({ ...c, title: item.title })) : [];
    if (!chunks.length) chunks = [{ title: item.title, heading: '', text: cand.description || item.title }];
    // cheap pre-filter keeps the expensive scorer to the best few passages per page
    if (chunks.length > perPage) {
      const pre = bm25(q, chunks.map((c) => `${c.heading} ${c.text}`));
      chunks = pre.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, perPage).sort((a, b) => a[1] - b[1]).map(([, i]) => chunks[i]);
    }
    for (const c of chunks) passages.push({ ...c, owner: item });
  }
  if ((start || end) && pageItems.some((p) => p.dateUnknown)) notes.push('some results have no detectable publish date and were kept');

  const { scores, method } = await rankPassages(q, passages, d, { rerank: opts.rerank, notes, meter });
  passages.forEach((p, i) => p.owner.passages.push({ text: p.text, heading: p.heading, score: scores[i] }));
  for (const it of pageItems) {
    it.passages.sort((a, b) => b.score - a.score);
    const [a = 0, b = 0] = it.passages.map((p) => p.score);
    it.score = Math.min(1, 0.8 * a + 0.1 * b + 0.1 * it.prior);
  }

  // optional visual pass: Jev reads screenshots of the leading pages
  if (opts.visual) {
    if (!d.jev?.images) notes.push('visual ranking needs Jev with WEBCRAWL_JEV_IMAGES=on');
    else {
      const lead = [...pageItems].sort((x, y) => y.score - x.score).slice(0, Math.min(6, pageItems.length));
      const shoot = d.screenshotFn || (async (u) => (await import('../core/browser.js')).screenshotPage(u, { viewport: { width: 1280, height: 1600 } }));
      const shots = await pool(lead, 3, async (it) => {
        try {
          const s = await shoot(it.url);
          const b64 = String(s?.screenshot || '').replace(/^data:image\/\w+;base64,/, '');
          return b64 ? await normalizeImage(Buffer.from(b64, 'base64'), { maxSide: 1568 }) : null;
        } catch { return null; }
      });
      const ok = lead.map((it, i) => [it, shots[i]]).filter(([, s]) => s);
      if (ok.length) {
        try {
          const v = await scoreScreenshots(q, ok.map(([, s]) => s), { cfg: d.jev, fetchImpl: d.fetchImpl });
          meter.jev.costDollars += v.costDollars;
          ok.forEach(([it], i) => { if (v.scores[i] != null) { it.visualScore = v.scores[i]; it.score = Math.max(it.score, 0.9 * v.scores[i] + 0.1 * it.prior); } });
        } catch (e) { notes.push(`visual ranking failed: ${e.message}`); }
      }
    }
  }

  const ranked = pageItems.sort((x, y) => y.score - x.score);
  const results = ranked.slice(0, numResults).map((it) => ({ ...shapeResult(it, q, opts), ...(it.visualScore != null && { visualScore: Math.round(it.visualScore * 1000) / 1000 }) }));

  // ---- answer / structured output
  let answer, output, grounding;
  if (opts.answer || opts.outputSchema) {
    const evidence = ranked.slice(0, 8).map((it) => ({ url: it.url, title: it.title, publishedDate: it.publishedDate, text: it.passages.slice(0, 2).map((p) => p.text).join('\n…\n') }));
    if (d.llm) {
      try {
        const r = await answerFrom(q, evidence, { schema: opts.outputSchema, cfg: d.llm, fetchImpl: d.fetchImpl });
        ({ answer, output, grounding } = r);
      } catch (e) { notes.push(`answer step failed: ${e.message}`); }
    } else {
      notes.push('no LLM configured: answer is the top extracted passages, not a written summary');
      answer = evidence.slice(0, 3).map((e, i) => `${bestSentences(q, e.text, 2)} [${i + 1}]`).join('\n');
    }
  }

  return finish({ results, level, requestedLevel, providers: providerStats, ranking: method, meter, notes, t0, subqueries, answer, output, grounding, citations: (answer || output) ? ranked.slice(0, 8).map((it, i) => ({ n: i + 1, url: it.url, title: it.title })) : undefined });
}

function finish({ results, level, requestedLevel, providers, ranking, meter, notes, t0, error, ...extra }) {
  const clean = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
  return {
    results,
    level,
    ...(requestedLevel !== level && { requestedLevel }),
    ...clean,
    providers,
    ranking: ranking || null,
    usage: { pagesFetched: meter.pagesFetched, pagesFromCache: meter.pagesFromCache, jev: meter.jev.requests ? meter.jev : null },
    costDollars: { jev: Math.round(meter.jev.costDollars * 1e6) / 1e6 },
    ...(notes.length && { notes }),
    ...(error && { error }),
    latencyMs: Date.now() - t0,
  };
}

// Contents for known URLs (Exa /contents): fetch through the cache, optional highlights.
export async function contents(urls, opts = {}, deps = {}) {
  const t0 = Date.now();
  const d = resolveDeps(deps);
  const meter = { jev: { requests: 0, inputTokens: 0, costDollars: 0 }, pagesFetched: 0, pagesFromCache: 0 };
  const hq = asObj(opts.highlights, {})?.query;
  const results = [], statuses = [];
  await pool(urls, 8, async (u) => {
    const url = normalizeUrl(u);
    const p = url ? await getPage(url, d, { maxAgeHours: opts.maxAgeHours }) : null;
    if (!p) { statuses.push({ id: u, status: 'error', error: { tag: 'CRAWL_FAILED' } }); return; }
    p.cached ? meter.pagesFromCache++ : meter.pagesFetched++;
    let passages = [];
    if (opts.highlights) {
      const chunks = chunkMarkdown(p.markdown);
      const sc = hq ? normalize(bm25(hq, chunks.map((c) => c.text))) : chunks.map((_, i) => 1 - i / (chunks.length + 1));
      passages = chunks.map((c, i) => ({ text: c.text, score: sc[i] })).sort((a, b) => b.score - a.score);
    }
    results.push(shapeResult({ url, title: p.title, publishedDate: p.publishedDate, markdown: p.markdown, image: p.images?.[0], score: 1, passages, sources: [p.cached ? 'cache' : 'live'] }, hq || p.title, { text: opts.text ?? true, highlights: opts.highlights }));
    statuses.push({ id: u, status: 'success' });
  });
  const order = new Map(urls.map((u, i) => [normalizeUrl(u), i]));
  results.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));
  return { results, statuses, usage: { pagesFetched: meter.pagesFetched, pagesFromCache: meter.pagesFromCache }, latencyMs: Date.now() - t0 };
}

// "More pages like this one": builds a query from the page itself.
export async function findSimilar(url, opts = {}, deps = {}) {
  const d = resolveDeps(deps);
  const p = await getPage(normalizeUrl(url) || url, d, { maxAgeHours: opts.maxAgeHours });
  if (!p) return { results: [], error: 'could not fetch the source page' };
  const chunks = chunkMarkdown(p.markdown).slice(0, 20).map((c) => c.text).join(' ');
  const freq = new Map();
  for (const t of tokens(chunks)) if (t.length > 3 && !/^\d+$/.test(t)) freq.set(t, (freq.get(t) || 0) + 1);
  const terms = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  const q = [p.title, ...terms.filter((t) => !tokens(p.title).includes(t))].filter(Boolean).join(' ').slice(0, 200);
  let host = '';
  try { host = new URL(p.finalUrl || p.url).hostname; } catch {}
  const exclude = opts.excludeSourceDomain === false ? [] : [host];
  const r = await search(q, { level: 'standard', ...opts, excludeDomains: [...(opts.excludeDomains || []), ...exclude] }, deps);
  return { ...r, query: q };
}

// Search with a photo: find candidate pages, then check each page's images against
// the photo (Jev image input, else a vision-capable LLM). Text query is optional when
// an LLM can read the photo and write one.
export async function findByImage(opts = {}, deps = {}) {
  const t0 = Date.now();
  const d = resolveDeps(deps);
  const notes = [];
  let photo;
  try { photo = await normalizeImage(await loadImage(opts.image, { fetchImpl: d.untrustedFetch })); }
  catch (e) { return { results: [], error: `image: ${e.message}`, latencyMs: Date.now() - t0 }; }

  let query = String(opts.query || '').trim();
  if (!query) {
    if (!d.llm) return { results: [], error: 'add a text "query" describing the item, or configure a vision-capable LLM so it can write one', latencyMs: Date.now() - t0 };
    try {
      query = String(await chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Write one web search query (brand, model, distinguishing details) that would find this exact item for sale or identification. Reply with the query only.' }, { type: 'image', ...photo }] }], maxTokens: 60 }, { cfg: d.llm, fetchImpl: d.fetchImpl })).replace(/["\n]/g, ' ').trim();
      notes.push(`query written from the photo: "${query}"`);
    } catch (e) { return { results: [], error: `could not describe the photo: ${e.message}`, latencyMs: Date.now() - t0 }; }
  }

  const base = await search(query, { level: 'standard', numResults: Math.min(30, (Number(opts.numResults) || 10) * 2), candidates: opts.candidates || 20, includeDomains: opts.includeDomains, excludeDomains: opts.excludeDomains, providers: opts.providers, maxAgeHours: opts.maxAgeHours, highlights: true }, deps);
  const pages = await pool(base.results, 8, async (r) => ({ r, page: await d.cache.get(r.url) }));
  const cands = [];
  await pool(pages, 6, async ({ r, page }) => {
    for (const src of (page?.images || []).slice(0, Number(opts.imagesPerPage) || 2)) {
      try { cands.push({ id: `${r.url}\n${src}`, url: r.url, src, ...(await normalizeImage(await loadImage(src, { fetchImpl: d.untrustedFetch }), { maxSide: 768 })) }); } catch {}
    }
  });

  let probs = {}, method = 'none';
  let cost = 0;
  if (cands.length && d.jev?.images) {
    try {
      const m = await matchImages({ query: photo, candidates: cands }, { cfg: d.jev, fetchImpl: d.fetchImpl, hint: query });
      probs = m.probabilities; cost = m.costDollars; method = `jev(${m.model})`;
    } catch (e) { notes.push(`Jev photo match failed: ${e.message}`); }
  }
  if (cands.length && method === 'none' && d.llm) {
    await pool(cands.slice(0, 12), 3, async (c) => {
      try { const p = await judgeSameItem(photo, c, query, { cfg: d.llm, fetchImpl: d.fetchImpl }); if (p != null) probs[c.id] = p; } catch {}
    });
    if (Object.keys(probs).length) method = 'llm-vision';
  }
  if (method === 'none') notes.push('no visual check ran (needs Jev with WEBCRAWL_JEV_IMAGES=on, or a vision-capable LLM): results are ranked on text only');

  const best = new Map();
  for (const c of cands) {
    const p = probs[c.id];
    if (p == null) continue;
    const cur = best.get(c.url);
    if (!cur || p > cur.p) best.set(c.url, { p, src: c.src });
  }
  const results = base.results.map((r) => {
    const m = best.get(r.url);
    return { ...r, ...(m && { matchedImage: m.src, matchProbability: Math.round(m.p * 1000) / 1000 }), score: m ? Math.round((0.8 * m.p + 0.2 * r.score) * 1000) / 1000 : r.score * (method === 'none' ? 1 : 0.5) };
  }).sort((a, b) => b.score - a.score).slice(0, Number(opts.numResults) || 10);

  return {
    query, results, visualMatch: method, imagesCompared: cands.length,
    costDollars: { jev: Math.round(((base.costDollars?.jev || 0) + cost) * 1e6) / 1e6 },
    ...((notes.length || base.notes) && { notes: [...notes, ...(base.notes || [])] }),
    latencyMs: Date.now() - t0,
  };
}
