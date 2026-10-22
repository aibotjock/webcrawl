import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import { searchRouter, apiKeyGuard, levelFor, contentsOf } from '../../src/search/api.js';
import { findByImage } from '../../src/search/engine.js';
import { fakeFetch, fixedProviders, fakeScrape, memCache } from './helpers.js';

const para = (t, n = 30) => Array.from({ length: n }, (_, i) => `${t} ${i}.`).join(' ');
const PAGES = {
  'https://shop.a/kettle': { title: 'Red Kettle 1.7L', markdown: para('red kettle 1.7 litre stainless'), rawHtml: '<meta property="og:image" content="https://img.a/red.jpg">' },
  'https://shop.b/kettle': { title: 'Blue Kettle', markdown: para('blue kettle glass'), rawHtml: '<meta property="og:image" content="https://img.b/blue.jpg">' },
};
const registry = fixedProviders({ p: [{ title: 'Blue Kettle', url: 'https://shop.b/kettle' }, { title: 'Red Kettle 1.7L', url: 'https://shop.a/kettle' }] });

const servers = [];
async function serve(deps, guardKey) {
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  if (guardKey) app.use(apiKeyGuard(guardKey));
  app.use(searchRouter(deps));
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${s.address().port}`;
  return (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
after(() => servers.forEach((s) => s.close()));

const deps = (extra = {}) => ({ registry, scrapeFn: fakeScrape(PAGES), cache: memCache(), jev: null, llm: null, embed: null, fetchImpl: fakeFetch([]), ...extra });

test('Exa search types map onto levels', () => {
  assert.equal(levelFor({ type: 'lite' }), 'instant');
  assert.equal(levelFor({ type: 'fast' }), 'fast');
  assert.equal(levelFor({ type: 'auto' }), 'standard');
  assert.equal(levelFor({ type: 'deep-reasoning' }), 'deep');
  assert.equal(levelFor({ type: 'auto', level: 'fast' }), 'fast', 'explicit level wins');
  assert.equal(contentsOf({ contents: { livecrawl: 'always' } }).maxAgeHours, 0);
  assert.equal(contentsOf({ livecrawl: 'never' }).maxAgeHours, -1);
  assert.equal(contentsOf({ highlights: true }).highlights, true, 'legacy top-level contents fields');
});

test('POST /search returns Exa-shaped results', async () => {
  const post = await serve(deps());
  const res = await post('/search', { query: 'red kettle', type: 'auto', numResults: 2, providers: ['p'], contents: { highlights: { numSentences: 1 }, text: { maxCharacters: 40 } } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.requestId);
  assert.equal(j.resolvedSearchType, 'standard');
  assert.equal(j.results[0].url, 'https://shop.a/kettle');
  assert.equal(j.results[0].id, 'https://shop.a/kettle');
  assert.equal(j.results[0].highlights.length, 1);
  assert.equal(j.results[0].highlightScores.length, 1);
  assert.equal(j.results[0].text.length, 41);
  assert.equal(j.costDollars.total, 0);
  assert.equal(j.webcrawl.ranking, 'bm25');
});

test('POST /search validates input', async () => {
  const post = await serve(deps());
  assert.equal((await post('/search', {})).status, 400);
});

test('POST /answer cites its sources', async () => {
  const fetchImpl = fakeFetch([['http://llm/v1/chat/completions', () => ({ choices: [{ message: { content: 'The red one holds 1.7 litres [1].' } }] })]]);
  const post = await serve(deps({ fetchImpl, llm: { provider: 'openai', baseUrl: 'http://llm/v1', model: 'm', apiKey: '', timeoutMs: 1000 } }));
  const j = await (await post('/answer', { query: 'red kettle capacity', providers: ['p'] })).json();
  assert.equal(j.answer, 'The red one holds 1.7 litres [1].');
  assert.equal(j.citations[0].url, 'https://shop.a/kettle');
});

test('anthropic and gemini adapters build their own request shapes', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    ['https://api.anthropic.com/v1/messages', () => ({ content: [{ type: 'text', text: 'A [1]' }] })],
    [/generativelanguage/, () => ({ candidates: [{ content: { parts: [{ text: 'G [1]' }] } }] })],
  ], calls);
  for (const [llm, want] of [[{ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', apiKey: 'ak', timeoutMs: 1000 }, 'A [1]'],
    [{ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'g', apiKey: 'gk', timeoutMs: 1000 }, 'G [1]']]) {
    const post = await serve(deps({ fetchImpl, llm }));
    const j = await (await post('/answer', { query: 'red kettle', providers: ['p'] })).json();
    assert.equal(j.answer, want);
  }
  const a = calls.find((c) => c.url.includes('anthropic'));
  assert.equal(a.init.headers['x-api-key'], 'ak');
  assert.equal(JSON.parse(a.init.body).model, 'claude-sonnet-5-5');
  const g = calls.find((c) => c.url.includes('generativelanguage'));
  assert.match(g.url, /models\/g:generateContent$/);
  assert.equal(g.init.headers['x-goog-api-key'], 'gk');
});

test('API key guard accepts x-api-key or Bearer, rejects others', async () => {
  const post = await serve(deps(), 'secret');
  assert.equal((await post('/search', { query: 'x', providers: ['p'] })).status, 401);
  assert.equal((await post('/search', { query: 'x', providers: ['p'] }, { 'x-api-key': 'wrong!' })).status, 401);
  assert.equal((await post('/search', { query: 'red kettle', providers: ['p'] }, { 'x-api-key': 'secret' })).status, 200);
  assert.equal((await post('/search', { query: 'red kettle', providers: ['p'] }, { authorization: 'Bearer secret' })).status, 200);
});

test('findByImage: Jev picks the page whose photo matches', async () => {
  const red = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#d22' } }).jpeg().toBuffer();
  const blue = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#22d' } }).jpeg().toBuffer();
  const jevCalls = [];
  const fetchImpl = fakeFetch([
    ['https://img.a/red.jpg', () => ({ body: red, contentType: 'image/jpeg' })],
    ['https://img.b/blue.jpg', () => ({ body: blue, contentType: 'image/jpeg' })],
    ['https://jev.test/v1/systemone', async (u, init) => {
      const b = JSON.parse(init.body);
      if (!b.assets) return { answers: Object.fromEntries(Object.keys(b.questions).map((k) => [k, { type: 'score', score: 1.5 }])), model: 'jev-1.14.0', usage: { input_tokens: 300, output_tokens: 0 } };
      const photoStats = await sharp(Buffer.from(b.assets[b.state.photo].data_base64, 'base64')).stats();
      const answers = {};
      for (const [k, q] of Object.entries(b.questions)) {
        const s = await sharp(Buffer.from(b.assets[q.instructions.candidate].data_base64, 'base64')).stats();
        const same = Math.abs(s.channels[0].mean - photoStats.channels[0].mean) < 30;
        answers[k] = { type: 'noul', noul: same ? 0.95 : 0.05 };
      }
      return { answers, model: 'jev-1.14.0', usage: { input_tokens: 2000, output_tokens: 0 } };
    }],
  ], jevCalls);
  const r = await findByImage({ image: `data:image/jpeg;base64,${red.toString('base64')}`, query: 'kettle', providers: ['p'] },
    deps({ fetchImpl, jev: { apiKey: 'k', baseUrl: 'https://jev.test', model: 'jev-1.14.0', images: true, timeoutMs: 1000 } }));
  assert.equal(r.visualMatch, 'jev(jev-1.14.0)');
  assert.equal(r.imagesCompared, 2);
  assert.equal(r.results[0].url, 'https://shop.a/kettle');
  assert.equal(r.results[0].matchedImage, 'https://img.a/red.jpg');
  assert.ok(r.results[0].matchProbability > 0.9);
  assert.ok(r.results[1].matchProbability < 0.1);
  const jc = jevCalls.filter((c) => c.url.includes('jev.test'));
  const imageCalls = jc.filter((c) => JSON.parse(c.init.body).assets);
  assert.ok(imageCalls.length >= 1);
  for (const c of imageCalls) assert.equal(c.init.headers['TypeSafe-Danger-Zone-Images'], 'true');
  for (const c of jc.filter((x) => !JSON.parse(x.init.body).assets)) assert.equal(c.init.headers['TypeSafe-Danger-Zone-Images'], undefined, 'text calls stay off the experimental header');
});

test('findByImage without any vision model says so and ranks on text', async () => {
  const red = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#d22' } }).jpeg().toBuffer();
  const fetchImpl = fakeFetch([[/img\./, () => ({ body: red, contentType: 'image/jpeg' })]]);
  const r = await findByImage({ image: red.toString('base64'), query: 'red kettle', providers: ['p'] }, deps({ fetchImpl }));
  assert.equal(r.visualMatch, 'none');
  assert.match(r.notes.join(' '), /no visual check ran/);
  assert.equal(r.results[0].url, 'https://shop.a/kettle');
});

test('findByImage needs a query when no LLM can read the photo', async () => {
  const red = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#d22' } }).jpeg().toBuffer();
  const r = await findByImage({ image: red.toString('base64') }, deps());
  assert.match(r.error, /add a text "query"/);
});
