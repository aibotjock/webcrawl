import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWebcrawl } from '../../src/index.js';
import { fakeFetch, fakeScrape, memCache } from './helpers.js';

const para = (t, n = 30) => Array.from({ length: n }, (_, i) => `${t} ${i}.`).join(' ');
const PAGES = { 'https://s.example/a': { title: 'Alpha', markdown: para('alpha kettle guide') } };

// Brave is the only source; its key comes from options, not env.
const braveFetch = (calls) => fakeFetch([
  ['https://api.search.brave.com/', () => ({ web: { results: [{ title: 'Alpha', url: 'https://s.example/a', description: 'alpha' }] } })],
  ['https://jev.example/v1/systemone', (u, init) => {
    const b = JSON.parse(init.body);
    return { answers: Object.fromEntries(Object.keys(b.questions).map((k) => [k, { type: 'score', score: 3 }])), model: 'jev-1.14.0', usage: { input_tokens: 10, output_tokens: 0 } };
  }],
], calls);

test('options replace env vars: keys, sources and Jev come from the app', async () => {
  const calls = [];
  const wc = createWebcrawl({
    useEnv: false,
    sources: { braveApiKey: 'app-brave-key', enabled: ['brave'] },
    typesafe: { apiKey: 'app-jev-key', baseUrl: 'https://jev.example', model: 'jev-1.14.0' },
    cache: memCache(),
    fetch: braveFetch(calls),
    scrape: fakeScrape(PAGES),
  });
  assert.deepEqual(wc.status(), { jev: { model: 'jev-1.14.0', images: false }, llm: null, embeddings: false, sources: ['duckduckgo', 'wikipedia', 'brave'] });
  const r = await wc.search('alpha kettle', { level: 'standard' });
  assert.equal(r.results[0].url, 'https://s.example/a');
  assert.deepEqual(r.providers.map((p) => p.name), ['brave'], 'enabled list from options');
  assert.match(r.ranking, /^jev/);
  assert.equal(calls.find((c) => c.url.includes('brave')).init.headers['X-Subscription-Token'], 'app-brave-key');
  assert.equal(calls.find((c) => c.url.includes('jev.example')).init.headers.authorization, 'Bearer app-jev-key');
});

test('with no keys at all it still searches (keyless sources, BM25)', async () => {
  const wc = createWebcrawl({ useEnv: false, typesafe: false, llm: false, cache: memCache(), scrape: fakeScrape(PAGES) });
  assert.equal(wc.status().jev, null);
  assert.equal(wc.status().llm, null);
  assert.deepEqual(wc.status().sources, ['duckduckgo', 'wikipedia']);
});

test('answer() uses the app-supplied LLM', async () => {
  const fetchImpl = fakeFetch([
    ['https://api.search.brave.com/', () => ({ web: { results: [{ title: 'Alpha', url: 'https://s.example/a' }] } })],
    ['http://my-llm/v1/chat/completions', (u, init) => ({ choices: [{ message: { content: `model=${JSON.parse(init.body).model} [1]` } }] })],
  ]);
  const wc = createWebcrawl({ useEnv: false, sources: { braveApiKey: 'k', enabled: ['brave'] }, llm: { baseUrl: 'http://my-llm/v1', model: 'qwen-local' }, cache: memCache(), fetch: fetchImpl, scrape: fakeScrape(PAGES) });
  const r = await wc.answer('alpha');
  assert.equal(r.answer, 'model=qwen-local [1]');
});

const servers = [];
after(() => servers.forEach((s) => s.close()));

test('router() mounts the Exa-compatible API inside another app, with its own key', async () => {
  const wc = createWebcrawl({ useEnv: false, sources: { braveApiKey: 'k', enabled: ['brave'] }, cache: memCache(), fetch: braveFetch([]), scrape: fakeScrape(PAGES) });
  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api/web', wc.router({ apiKey: 'inner' }));
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${s.address().port}`;
  const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  assert.equal((await post('/api/web/search', { query: 'alpha' })).status, 401);
  const j = await (await post('/api/web/search', { query: 'alpha kettle', type: 'auto' }, { 'x-api-key': 'inner' })).json();
  assert.equal(j.results[0].url, 'https://s.example/a');
  assert.equal((await fetch(base + '/health')).status, 200, 'host app routes untouched');
});

test('importing the server does not start listening', async () => {
  const before = process.listenerCount('exit');
  const m = await import('../../src/server.js');
  assert.equal(typeof m.app, 'function');
  assert.equal(process.listenerCount('exit'), before);
});
