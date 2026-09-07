// webcrawl HTTP API + static WebUI. Firecrawl-parity shapes per notes/core-contract.md.
// Core modules are imported lazily so the server boots even if some are missing.
import express from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './core/config.js';
import { llm, llmPublic, llmNote, setLlm, llmReachable, llmModels } from './core/llm.js';
import { runResearch, generateSchema } from './core/research.js';
import { saveSession, listSessions, getSession, compareSessions } from './core/sessions.js';

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

// --- Intent-first research (Simple Mode): plan -> search -> scrape -> extract -> answer ---
// Jobs run async so the UI can poll staged progress. Completed runs are auto-saved as sessions.
const research = new Map();
const R_TTL = 60 * 60_000;
const rsweep = () => { for (const [id, j] of research) if (j.done && Date.now() - j.ts > R_TTL) research.delete(id); };

function normResearch(body) {
  const b = body || {};
  const prompt = String(b.prompt || '').trim();
  const sources = b.sources && typeof b.sources === 'object'
    ? { mode: ['web', 'domains', 'urls'].includes(b.sources.mode) ? b.sources.mode : 'web',
        values: Array.isArray(b.sources.values) ? b.sources.values.map(String).filter(Boolean).slice(0, 25) : [] }
    : { mode: 'web', values: [] };
  return {
    prompt,
    sources,
    depth: ['quick', 'standard', 'deep'].includes(b.depth) ? b.depth : 'standard',
    output: ['answer', 'report', 'dataset', 'markdown', 'structured'].includes(b.output) ? b.output : 'answer',
    maxPages: Math.max(1, Math.min(100, Number(b.maxPages) || 10)),
    ...(b.schema && typeof b.schema === 'object' ? { schema: b.schema } : {}),
    ...(typeof b.extractPrompt === 'string' && b.extractPrompt.trim() ? { extractPrompt: b.extractPrompt.trim() } : {}),
  };
}

// Start a research run. Returns { id }; poll GET /v1/research/:id or stream /v1/research/:id/stream.
app.post('/v1/research', async (req, res) => {
  rsweep();
  const input = normResearch(req.body);
  if (!input.prompt) return bad(res, 400, '"prompt" (what to research) is required');
  const job = { id: randomUUID(), status: 'running', stage: 'planning', stages: [], result: null, error: null, sessionId: null, done: false, ts: Date.now() };
  research.set(job.id, job);
  (async () => {
    try {
      const result = await runResearch(input, (stage, entry) => { job.stage = stage; job.stages.push(entry); });
      job.result = result;
      job.status = 'completed';
      try { const s = await saveSession(result); job.sessionId = s.id; } catch (e) { job.saveError = String(e?.message || e); }
    } catch (e) {
      job.status = 'failed';
      job.error = String(e?.message || e);
    }
    job.done = true;
    job.ts = Date.now();
  })();
  res.json({ success: true, id: job.id });
});

// Poll a research job. ?since=N returns only stages after index N (cheap live updates).
app.get('/v1/research/:id', (req, res) => {
  rsweep();
  const j = research.get(req.params.id);
  if (!j) return bad(res, 404, `unknown or expired research job: ${req.params.id}`);
  const since = Math.max(0, Number(req.query.since) || 0);
  res.json({
    success: true, id: j.id, status: j.status, stage: j.stage,
    stages: j.stages.slice(since), stageCount: j.stages.length,
    ...(j.result && { result: j.result }),
    ...(j.sessionId && { sessionId: j.sessionId }),
    ...(j.error && { error: j.error }),
  });
});

// Server-Sent Events stream of stage updates for a running job (optional; polling also works).
app.get('/v1/research/:id/stream', (req, res) => {
  const j = research.get(req.params.id);
  if (!j) return bad(res, 404, `unknown or expired research job: ${req.params.id}`);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  let sent = 0;
  const push = () => {
    while (sent < j.stages.length) res.write(`data: ${JSON.stringify(j.stages[sent++])}\n\n`);
    if (j.done) {
      res.write(`event: done\ndata: ${JSON.stringify({ status: j.status, sessionId: j.sessionId, error: j.error })}\n\n`);
      clearInterval(timer);
      res.end();
    }
  };
  const timer = setInterval(push, 400);
  push();
  req.on('close', () => clearInterval(timer));
});

// Plain-English -> JSON schema preview (for the simplified Extract UI).
app.post('/v1/research/schema', async (req, res) => {
  const description = String(req.body?.description || '').trim();
  if (!description) return bad(res, 400, '"description" of the fields is required');
  try { const g = await generateSchema(description); res.json({ success: true, schema: g.schema, source: g.source }); }
  catch (e) { fail(res, e, 'schema'); }
});

// --- Saved research sessions (list / get / rerun / compare) ---
app.get('/v1/sessions', async (req, res) => {
  try { res.json({ success: true, sessions: await listSessions() }); }
  catch (e) { fail(res, e, 'sessions'); }
});
app.get('/v1/sessions/compare', async (req, res) => {
  const { a, b } = req.query || {};
  if (!a || !b) return bad(res, 400, 'query params "a" and "b" (session ids) are required');
  try {
    const cmp = await compareSessions(String(a), String(b));
    if (!cmp) return bad(res, 404, 'one or both sessions not found');
    res.json({ success: true, comparison: cmp });
  } catch (e) { fail(res, e, 'compare'); }
});
app.get('/v1/sessions/:id', async (req, res) => {
  try { const s = await getSession(req.params.id); return s ? res.json({ success: true, session: s }) : bad(res, 404, 'session not found'); }
  catch (e) { fail(res, e, 'session'); }
});
// Rerun a saved session with the SAME request; saves and returns a new job id.
app.post('/v1/sessions/:id/rerun', async (req, res) => {
  const prev = await getSession(req.params.id);
  if (!prev || !prev.request) return bad(res, 404, 'session not found');
  const input = normResearch(prev.request);
  const job = { id: randomUUID(), status: 'running', stage: 'planning', stages: [], result: null, error: null, sessionId: null, done: false, ts: Date.now() };
  research.set(job.id, job);
  (async () => {
    try {
      const result = await runResearch(input, (stage, entry) => { job.stage = stage; job.stages.push(entry); });
      job.result = result; job.status = 'completed';
      try { const s = await saveSession(result, { rerunOf: prev.id }); job.sessionId = s.id; } catch (e) { job.saveError = String(e?.message || e); }
    } catch (e) { job.status = 'failed'; job.error = String(e?.message || e); }
    job.done = true; job.ts = Date.now();
  })();
  res.json({ success: true, id: job.id, rerunOf: prev.id });
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

app.listen(config.port, () => {
  console.log(`webcrawl v${version} listening on http://localhost:${config.port} (API /v1/*, WebUI /)`);
  console.log(`webcrawl LLM: provider=${llm.provider} model=${llm.model} baseUrl=${llm.baseUrl} key=${llm.apiKey ? 'set' : 'none'}`);
  const note = llmNote();
  if (note) console.warn(`webcrawl LLM warning: ${note}`);
});
