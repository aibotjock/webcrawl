// webcrawl HTTP API + static WebUI. Firecrawl-parity shapes per notes/core-contract.md.
// Core modules are imported lazily so the server boots even if some are missing.
import express from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './core/config.js';
import { llmPublic, setLlm, llmReachable, llmModels } from './core/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(path.join(here, '../package.json'), 'utf8'));
const core = (name) => import(`./core/${name}.js`);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
    .set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    .set('Access-Control-Allow-Headers', 'content-type,authorization');
  next();
});
app.options(/.*/, (req, res) => res.sendStatus(204));

const bad = (res, code, error) => res.status(code).json({ success: false, error });
const fail = (res, e, what) =>
  bad(res, e?.code === 'ERR_MODULE_NOT_FOUND' ? 501 : 500, `${what}: ${e?.message || e}`);
const badUrl = (u) => { try { return !/^https?:$/.test(new URL(u).protocol); } catch { return true; } };

// in-memory crawl jobs, dropped 30min after they finish
const jobs = new Map();
const JOB_TTL = 30 * 60_000;
const sweep = () => { for (const [id, j] of jobs) if (Date.now() - j.ts > JOB_TTL) jobs.delete(id); };

app.post('/v1/scrape', async (req, res) => {
  const { url, formats = ['markdown'], onlyMainContent = true, timeout, waitFor } = req.body || {};
  if (badUrl(url)) return bad(res, 400, 'valid http(s) "url" required');
  try {
    const data = await (await core('scrape')).scrape(url, { formats, onlyMainContent, timeout, waitFor });
    if (data?.metadata?.error) return bad(res, 502, data.metadata.error);
    res.json({ success: true, data, latencyMs: data.latencyMs });
  } catch (e) { fail(res, e, 'scrape'); }
});

app.post('/v1/map', async (req, res) => {
  const { url, limit } = req.body || {};
  if (badUrl(url)) return bad(res, 400, 'valid http(s) "url" required');
  try {
    const d = await (await core('map')).mapSite(url, { limit });
    res.json({ success: true, data: { urls: d.urls, count: d.count, latencyMs: d.latencyMs } });
  } catch (e) { fail(res, e, 'map'); }
});

app.post('/v1/search', async (req, res) => {
  const { query, limit = 8 } = req.body || {};
  if (typeof query !== 'string' || !query.trim()) return bad(res, 400, '"query" required');
  try {
    const d = await (await core('search')).webSearch(query, { limit });
    res.json({ success: true, data: { results: d.results, latencyMs: d.latencyMs } });
  } catch (e) { fail(res, e, 'search'); }
});

app.post('/v1/extract', async (req, res) => {
  const { url, schema, prompt } = req.body || {};
  if (badUrl(url)) return bad(res, 400, 'valid http(s) "url" required');
  if (!schema || typeof schema !== 'object') return bad(res, 400, '"schema" (object) required');
  try {
    const d = await (await core('extract')).extract(url, schema, { prompt });
    if (d.error) return bad(res, 422, d.error);
    res.json({ success: true, data: { data: d.data, mode: d.mode, latencyMs: d.latencyMs } });
  } catch (e) { fail(res, e, 'extract'); }
});

app.post('/v1/crawl', async (req, res) => {
  const { url, limit = 50, maxDepth, includeGlobs, excludeGlobs, wait } = req.body || {};
  if (badUrl(url)) return bad(res, 400, 'valid http(s) "url" required');
  sweep();
  let crawlSite;
  try { ({ crawlSite } = await core('crawl')); } catch (e) { return fail(res, e, 'crawl'); }
  const run = async (job) => {
    try {
      job.data = await crawlSite(url, { limit, maxDepth, includeGlobs, excludeGlobs, concurrency: config.concurrency });
      job.status = 'completed';
    } catch (e) { job.status = 'failed'; job.error = e?.message || String(e); }
    job.ts = Date.now();
  };
  if (wait) {
    const done = {};
    await run(done);
    return done.error ? bad(res, 502, done.error) : res.json({ success: true, data: done.data, latencyMs: done.data.latencyMs });
  }
  const job = { id: randomUUID(), status: 'running', cancelled: false, ts: Date.now(), data: null, error: null };
  jobs.set(job.id, job);
  run(job); // fire-and-forget; v1 core contract has no abort hook, so cancel is advisory only
  res.json({ success: true, id: job.id });
});

app.get('/v1/crawl/:id', (req, res) => {
  sweep();
  const j = jobs.get(req.params.id);
  if (!j) return bad(res, 404, `unknown or expired crawl job: ${req.params.id}`);
  res.json({ success: true, id: j.id, status: j.status, ...(j.data && { data: j.data }), ...(j.error && { error: j.error }) });
});

// advisory cancel: flags the job; the v1 core crawler checks nothing between pages (no-op accepted)
app.delete('/v1/crawl/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return bad(res, 404, `unknown or expired crawl job: ${req.params.id}`);
  j.cancelled = true;
  res.json({ success: true, id: j.id, status: j.status, cancelled: true, note: 'cancel is advisory in v1' });
});

app.get('/v1/test', async (req, res) => {
  const modules = {};
  await Promise.all(['scrape', 'map', 'crawl', 'search', 'extract', 'browser', 'fetch', 'markdown'].map(async (m) => {
    try { await core(m); modules[m] = true; } catch { modules[m] = false; }
  }));
  let chromium = false;
  try {
    const { chromium: c } = await import('playwright');
    const b = await c.launch();
    await b.close();
    chromium = true;
  } catch { /* headless chromium missing/broken */ }
  const llm = (await llmReachable(2000)) ? 'reachable' : 'unreachable';
  res.json({ success: Object.values(modules).every(Boolean) && chromium, modules, chromium, llm, version });
});

// --- LLM model settings (local or cloud, runtime-switchable) ---
// GET  /v1/llm         -> current provider/baseUrl/model + whether a key is set + presets (key never returned)
// POST /v1/llm         -> { provider?, baseUrl?, model?, apiKey? } patch; applies live, returns new snapshot
// GET  /v1/llm/models  -> model ids advertised by the configured endpoint (for the WebUI dropdown)
app.get('/v1/llm', async (req, res) => {
  res.json({ success: true, ...llmPublic(), reachable: await llmReachable(2000) });
});
app.post('/v1/llm', async (req, res) => {
  try {
    const snap = setLlm(req.body || {});
    res.json({ success: true, ...snap, reachable: await llmReachable(2500) });
  } catch (e) { bad(res, 400, e?.message || String(e)); }
});
app.get('/v1/llm/models', async (req, res) => {
  try { res.json({ success: true, models: await llmModels() }); }
  catch (e) { bad(res, 502, `could not list models: ${e?.message || e}`); }
});

const webui = path.join(here, '..', 'webui'); // optional; tolerated if absent
if (existsSync(webui)) app.use(express.static(webui)); // serves / and /index.html
app.use((req, res) => bad(res, 404, `no route: ${req.method} ${req.path}`));
app.use((err, req, res, _next) =>
  bad(res, err?.type === 'entity.parse.failed' ? 400 : 500, err?.message || 'internal error'));

app.listen(config.port, () =>
  console.log(`webcrawl v${version} listening on http://localhost:${config.port} (API /v1/*, WebUI /)`));
