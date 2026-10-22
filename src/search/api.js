// Exa-compatible HTTP routes, so tools written for Exa (SDKs, MCP servers, skills)
// can point their base URL at webcrawl: POST /search, /contents, /findSimilar, /answer.
// Plus POST /findByImage (search with a photo), which Exa doesn't offer.
import express from 'express';
import { randomUUID } from 'node:crypto';
import * as engine from './engine.js';
import { llmConfig, chat } from './llm.js';

// Exa search types -> webcrawl levels. "lite" in Exa serves cached content only, like instant.
const TYPE_TO_LEVEL = {
  lite: 'instant', instant: 'fast', fast: 'fast', keyword: 'fast',
  auto: 'standard', neural: 'standard',
  'deep-lite': 'deep', deep: 'deep', 'deep-reasoning': 'deep',
};
export const levelFor = (body) => (engine.LEVELS.includes(body.level) ? body.level : TYPE_TO_LEVEL[body.type] || 'standard');

const LIVECRAWL = { always: 0, preferred: 0, never: -1, fallback: undefined, auto: undefined };

// Accepts both Exa's `contents: {...}` and the older top-level text/highlights/summary.
export function contentsOf(body) {
  const c = { ...(body.contents || {}) };
  for (const k of ['text', 'highlights', 'summary', 'maxAgeHours', 'livecrawl', 'subpages']) if (c[k] === undefined && body[k] !== undefined) c[k] = body[k];
  let maxAgeHours = c.maxAgeHours;
  if (maxAgeHours === undefined && c.livecrawl in LIVECRAWL) maxAgeHours = LIVECRAWL[c.livecrawl];
  return { text: c.text, highlights: c.highlights, summary: c.summary, maxAgeHours, subpages: c.subpages };
}

async function addSummaries(results, query, summary, deps) {
  const cfg = deps.llm === undefined ? llmConfig() : deps.llm;
  if (!summary || !cfg) return summary ? ['summary needs an LLM (WEBCRAWL_LLM_*)'] : [];
  const q = (summary && typeof summary === 'object' && summary.query) || query;
  let i = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < results.length) {
      const r = results[i++];
      const src = r.text || (r.highlights || []).join('\n');
      if (!src) continue;
      try { r.summary = String(await chat({ messages: [{ role: 'user', content: `In 2-3 sentences, summarize what this page says that is relevant to: ${q}\n\n${src.slice(0, 12000)}` }], maxTokens: 220 }, { cfg, fetchImpl: deps.fetchImpl })).trim(); } catch {}
    }
  }));
  return [];
}

const cost = (r) => ({ total: r.costDollars?.jev || 0, jev: r.costDollars?.jev || 0 });
const extras = (r) => ({ webcrawl: { level: r.level, ...(r.requestedLevel && { requestedLevel: r.requestedLevel }), providers: r.providers, ranking: r.ranking, usage: r.usage, ...(r.subqueries && { subqueries: r.subqueries }), ...(r.notes && { notes: r.notes }), latencyMs: r.latencyMs } });
const fail = (res, code, error) => res.status(code).json({ error, requestId: randomUUID() });
const filters = (b) => ({
  numResults: b.numResults, includeDomains: b.includeDomains, excludeDomains: b.excludeDomains,
  startPublishedDate: b.startPublishedDate, endPublishedDate: b.endPublishedDate,
  providers: b.providers, rerank: b.rerank, visual: b.visual, candidates: b.candidates,
});

export function searchRouter(deps = {}) {
  const r = express.Router();

  r.post('/search', async (req, res) => {
    const b = req.body || {};
    if (typeof b.query !== 'string' || !b.query.trim()) return fail(res, 400, '"query" required');
    try {
      const c = contentsOf(b);
      const out = await engine.search(b.query, { ...filters(b), level: levelFor(b), text: c.text, highlights: c.highlights, maxAgeHours: c.maxAgeHours, subpages: c.subpages, outputSchema: b.outputSchema }, deps);
      if (out.error && !out.results.length) return fail(res, 502, out.error);
      const notes = await addSummaries(out.results, b.query, c.summary, deps);
      if (notes.length) out.notes = [...(out.notes || []), ...notes];
      res.json({
        requestId: randomUUID(), resolvedSearchType: out.level, results: out.results,
        ...(out.output !== undefined && { output: out.output, grounding: out.grounding }),
        costDollars: cost(out), ...extras(out),
      });
    } catch (e) { fail(res, 500, `search: ${e.message}`); }
  });

  r.post('/contents', async (req, res) => {
    const b = req.body || {};
    const urls = [].concat(b.urls || b.ids || []).filter((u) => typeof u === 'string');
    if (!urls.length) return fail(res, 400, '"urls" (array) required');
    try {
      const c = contentsOf(b);
      const out = await engine.contents(urls.slice(0, 100), { text: c.text ?? true, highlights: c.highlights, maxAgeHours: c.maxAgeHours }, deps);
      await addSummaries(out.results, (c.summary && c.summary.query) || '', c.summary, deps);
      res.json({ requestId: randomUUID(), results: out.results, statuses: out.statuses, costDollars: { total: 0 }, webcrawl: { usage: out.usage, latencyMs: out.latencyMs } });
    } catch (e) { fail(res, 500, `contents: ${e.message}`); }
  });

  r.post('/findSimilar', async (req, res) => {
    const b = req.body || {};
    if (typeof b.url !== 'string') return fail(res, 400, '"url" required');
    try {
      const c = contentsOf(b);
      const out = await engine.findSimilar(b.url, { ...filters(b), level: levelFor(b), text: c.text, highlights: c.highlights, maxAgeHours: c.maxAgeHours, excludeSourceDomain: b.excludeSourceDomain }, deps);
      if (out.error && !out.results.length) return fail(res, 502, out.error);
      res.json({ requestId: randomUUID(), results: out.results, costDollars: cost(out), ...extras(out), query: out.query });
    } catch (e) { fail(res, 500, `findSimilar: ${e.message}`); }
  });

  r.post('/answer', async (req, res) => {
    const b = req.body || {};
    if (typeof b.query !== 'string' || !b.query.trim()) return fail(res, 400, '"query" required');
    try {
      const out = await engine.search(b.query, { ...filters(b), level: b.level || (b.type ? levelFor(b) : 'standard'), answer: true, outputSchema: b.outputSchema, highlights: true, text: b.text }, deps);
      if (out.error && !out.results.length) return fail(res, 502, out.error);
      const byUrl = new Map(out.results.map((x) => [x.url, x]));
      res.json({
        requestId: randomUUID(),
        answer: out.output !== undefined ? out.output : out.answer || '',
        ...(out.grounding && { grounding: out.grounding }),
        citations: (out.citations || []).map((c) => ({ id: c.url, url: c.url, title: c.title, publishedDate: byUrl.get(c.url)?.publishedDate || null, ...(b.text && { text: byUrl.get(c.url)?.text }) })),
        costDollars: cost(out), ...extras(out),
      });
    } catch (e) { fail(res, 500, `answer: ${e.message}`); }
  });

  r.post('/findByImage', async (req, res) => {
    const b = req.body || {};
    if (!b.image) return fail(res, 400, '"image" (data URI, base64 or URL) required');
    try {
      const out = await engine.findByImage(b, deps);
      if (out.error && !out.results.length) return fail(res, 422, out.error);
      res.json({ requestId: randomUUID(), ...out });
    } catch (e) { fail(res, 500, `findByImage: ${e.message}`); }
  });

  return r;
}

// Optional shared-secret guard for every API route (WEBCRAWL_API_KEY). Accepts
// Exa-style x-api-key or Authorization: Bearer. Off when the variable is unset.
export function apiKeyGuard(key = String(process.env.WEBCRAWL_API_KEY || '').trim()) {
  return (req, res, next) => {
    if (!key || req.method === 'OPTIONS') return next();
    const got = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (got && got.length === key.length && timingSafe(got, key)) return next();
    res.status(401).json({ success: false, error: 'missing or wrong API key (x-api-key or Authorization: Bearer)' });
  };
}
function timingSafe(a, b) {
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
