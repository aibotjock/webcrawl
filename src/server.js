// webcrawl HTTP API + static WebUI. Firecrawl-parity shapes per notes/core-contract.md.
// Core modules are imported lazily so the server boots even if some are missing.
import express from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './core/config.js';
import { operatorConfig, createOperatorSecurity } from './operator-security.js';
import { parsePublicUrl } from './core/safe-network.js';
import { modelFetch } from './core/model-fetch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(path.join(here, '../package.json'), 'utf8'));
const core = (name) => import(`./core/${name}.js`);

export function createApp({ settings = operatorConfig(), coreLoader = core } = {}) {
const app = express();
app.disable('x-powered-by');
// Keep the router's matching rules identical to the authorization middleware.
app.enable('case sensitive routing');
app.enable('strict routing');
const security = createOperatorSecurity(settings);
app.use(security.middleware);
app.use(express.json({ limit: '128kb' }));
app.post('/v1/login', security.login);
app.post('/v1/logout', security.logout);

const bad = (res, code, error) => res.status(code).json({ success: false, error });
const fail = (res, e, what) =>
  bad(res, e?.code === 'ERR_MODULE_NOT_FOUND' ? 501 : 500, `${what}: ${e?.message || e}`);
const badUrl = (u) => { try { parsePublicUrl(u); return false; } catch { return true; } };
const bounded = (value, fallback, max) => Math.min(max, Math.max(1, Math.trunc(Number(value) || fallback)));

// in-memory crawl jobs, dropped 30min after they finish
const jobs = new Map();
let activeCrawls = 0;
const JOB_TTL = 30 * 60_000;
const sweep = () => { for (const [id, j] of jobs) if (Date.now() - j.ts > JOB_TTL) jobs.delete(id); };

app.post('/v1/scrape', async (req, res) => {
  const { url, formats = ['markdown'], onlyMainContent = true, timeout, waitFor } = req.body || {};
  if (badUrl(url)) return bad(res, 400, 'valid http(s) "url" required');
  try {
    const data = await (await coreLoader('scrape')).scrape(url, { formats, onlyMainContent, timeout, waitFor });
    if (data?.metadata?.error) return bad(res, 502, data.metadata.error);
    res.json({ success: true, data, latencyMs: data.latencyMs });
  } catch (e) { fail(res, e, 'scrape'); }
});

app.post('/v1/map', async (req, res) => {
  const { url } = req.body || {};
  const limit = bounded(req.body?.limit, 200, 500);
  if (badUrl(url)) return bad(res, 400, 'valid http(s) "url" required');
  try {
    const d = await (await coreLoader('map')).mapSite(url, { limit });
    res.json({ success: true, data: { urls: d.urls, count: d.count, latencyMs: d.latencyMs } });
  } catch (e) { fail(res, e, 'map'); }
});

app.post('/v1/search', async (req, res) => {
  const { query } = req.body || {};
  const limit = bounded(req.body?.limit, 8, 25);
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) return bad(res, 400, '"query" required');
  try {
    const d = await (await coreLoader('search')).webSearch(query, { limit });
    res.json({ success: true, data: { results: d.results, latencyMs: d.latencyMs } });
  } catch (e) { fail(res, e, 'search'); }
});

app.post('/v1/extract', async (req, res) => {
  const { url, schema, prompt } = req.body || {};
  if (badUrl(url)) return bad(res, 400, 'valid http(s) "url" required');
  if (!schema || typeof schema !== 'object') return bad(res, 400, '"schema" (object) required');
  try {
    const d = await (await coreLoader('extract')).extract(url, schema, { prompt });
    if (d.error) return bad(res, 422, d.error);
    res.json({ success: true, data: { data: d.data, mode: d.mode, latencyMs: d.latencyMs } });
  } catch (e) { fail(res, e, 'extract'); }
});

app.post('/v1/crawl', async (req, res) => {
  const { url, includeGlobs = [], excludeGlobs = [], wait } = req.body || {};
  const limit = bounded(req.body?.limit, 50, 100);
  const maxDepth = bounded(req.body?.maxDepth, 3, 5);
  if (![includeGlobs, excludeGlobs].every(a => Array.isArray(a) && a.length <= 10 && a.every(x => typeof x === 'string' && x.length <= 100))) return bad(res, 400, 'At most 10 short include/exclude patterns are allowed');
  if (badUrl(url)) return bad(res, 400, 'valid http(s) "url" required');
  sweep();
  // Reserve before importing a lazy core module; concurrent cold requests must
  // not all pass admission while that asynchronous import is pending.
  if (activeCrawls >= 2 || jobs.size >= 32) return bad(res, 429, 'Crawl capacity reached');
  activeCrawls++;
  let released = false;
  const release = () => { if (!released) { released = true; activeCrawls--; } };
  let crawlSite;
  try { ({ crawlSite } = await coreLoader('crawl')); } catch (e) { release(); return fail(res, e, 'crawl'); }
  if (jobs.size >= 32) { release(); return bad(res, 429, 'Crawl retention capacity reached'); }
  const run = async (job) => {
    try {
      job.data = await crawlSite(url, { limit, maxDepth, includeGlobs, excludeGlobs, concurrency: config.concurrency, signal: job.controller.signal });
      job.status = job.controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (e) { job.status = 'failed'; job.error = e?.message || String(e); }
    finally { job.ts = Date.now(); release(); }
  };
  if (wait) {
    const done = { controller: new AbortController() };
    const id = randomUUID();
    jobs.set(id, { ...done, status: 'running', ts: Date.now() });
    await run(done);
    jobs.delete(id);
    return done.error ? bad(res, 502, done.error) : res.json({ success: true, data: done.data, latencyMs: done.data.latencyMs });
  }
  const job = { id: randomUUID(), status: 'running', controller: new AbortController(), cancelled: false, ts: Date.now(), data: null, error: null };
  jobs.set(job.id, job);
  run(job); // The crawler propagates cancellation to active page requests.
  res.json({ success: true, id: job.id });
});

app.get('/v1/crawl/:id', (req, res) => {
  sweep();
  const j = jobs.get(req.params.id);
  if (!j) return bad(res, 404, `unknown or expired crawl job: ${req.params.id}`);
  res.json({ success: true, id: j.id, status: j.status, ...(j.data && { data: j.data }), ...(j.error && { error: j.error }) });
});

// Cancels queued and active requests as well as the saved job.
app.delete('/v1/crawl/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return bad(res, 404, `unknown or expired crawl job: ${req.params.id}`);
  j.cancelled = true;
  j.controller.abort();
  res.json({ success: true, id: j.id, status: j.status, cancelled: true });
});

app.get('/v1/test', async (req, res) => {
  const modules = {};
  await Promise.all(['scrape', 'map', 'crawl', 'search', 'extract', 'browser', 'fetch', 'markdown'].map(async (m) => {
    try { await coreLoader(m); modules[m] = true; } catch { modules[m] = false; }
  }));
  let chromium = false;
  try {
    const { chromium: c } = await import('playwright');
    chromium = existsSync(c.executablePath());
  } catch { /* headless chromium missing/broken */ }
  let llm = 'unreachable';
  try {
    const r = await modelFetch('/models', { timeoutMs: 2000 });
    if (r.ok) llm = 'reachable';
  } catch { /* LM Studio down */ }
  res.json({ success: Object.values(modules).every(Boolean) && chromium, modules, chromium, llm, version });
});

const webui = path.join(here, '..', 'webui'); // optional; tolerated if absent
if (existsSync(webui)) app.use(express.static(webui)); // serves / and /index.html
app.use((req, res) => bad(res, 404, `no route: ${req.method} ${req.path}`));
app.use((err, req, res, _next) =>
  bad(res, err?.type === 'entity.too.large' ? 413 : err?.type === 'entity.parse.failed' ? 400 : 500, 'Request could not be completed'));
return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = operatorConfig();
  const server = createApp({ settings }).listen(settings.port, settings.host, () => console.log(`webcrawl v${version} listening on ${settings.host}:${settings.port}`));
  server.requestTimeout = 35000; server.headersTimeout = 10000; server.maxConnections = 64;
}
