import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, contents, findSimilar } from '../../src/search/engine.js';
import { fakeFetch, fixedProviders, fakeScrape, memCache } from './helpers.js';

const para = (topic, n = 40) => Array.from({ length: n }, (_, i) => `${topic} fact ${i}.`).join(' ');
const PAGES = {
  'https://a.com/guide': { title: 'Kettle guide', markdown: `# Guide\n\n${para('kettle descaling vinegar')}\n\n## Other\n\n${para('weather')}`, rawHtml: '<meta property="article:published_time" content="2026-05-01T00:00:00Z"><meta property="og:image" content="/k.jpg">' },
  'https://b.com/news': { title: 'Old news', markdown: para('kettle history'), rawHtml: '<meta name="date" content="2019-02-02">' },
  'https://c.com/spam': { title: 'Spam', markdown: para('buy now cheap') },
};
const registry = fixedProviders({
  p1: [{ title: 'Spam', url: 'https://c.com/spam', description: 'cheap' }, { title: 'Old news', url: 'https://b.com/news' }, { title: 'Kettle guide', url: 'https://a.com/guide', description: 'how to descale a kettle' }],
});

// Fake Jev that loves passages mentioning "descaling".
const jevFetch = (calls = []) => fakeFetch([['https://jev.test/v1/systemone', (u, init) => {
  const body = JSON.parse(init.body);
  const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, { type: 'score', score: /descaling/.test(q.instructions.passage.text) ? 3 : 0.3 }]));
  return { answers, model: 'jev-1.14.0', usage: { input_tokens: 500, output_tokens: 0 } };
}]], calls);
const jev = { apiKey: 'k', baseUrl: 'https://jev.test', model: 'jev-1.14.0', images: false, timeoutMs: 1000 };

const deps = (extra = {}) => ({ registry, scrapeFn: fakeScrape(PAGES), cache: memCache(), jev: null, llm: null, embed: null, fetchImpl: fakeFetch([]), ...extra });

test('standard level fetches pages, ranks passages with Jev, returns highlights', async () => {
  const calls = [];
  const r = await search('how to descale a kettle', { level: 'standard', providers: ['p1'], highlights: true }, deps({ jev, fetchImpl: jevFetch(calls) }));
  assert.equal(r.level, 'standard');
  assert.equal(r.results[0].url, 'https://a.com/guide');
  assert.match(r.results[0].highlights[0], /descaling/);
  assert.equal(r.results[0].publishedDate, '2026-05-01T00:00:00.000Z');
  assert.equal(r.results[0].image, 'https://a.com/k.jpg');
  assert.match(r.ranking, /^jev\(jev-1\.14\.0\)\+bm25$/);
  assert.equal(r.usage.pagesFetched, 3);
  assert.ok(r.costDollars.jev > 0);
  assert.ok(calls.length >= 1);
});

test('without Jev the same search ranks with BM25', async () => {
  const r = await search('kettle descaling vinegar', { level: 'standard', providers: ['p1'] }, deps());
  assert.equal(r.ranking, 'bm25');
  assert.equal(r.results[0].url, 'https://a.com/guide');
  assert.equal(r.usage.jev, null);
});

test('a Jev outage falls back to local ranking with a note', async () => {
  const down = fakeFetch([['https://jev.test', () => ({ status: 503, body: 'down' })]]);
  const r = await search('kettle descaling', { level: 'standard', providers: ['p1'] }, deps({ jev, fetchImpl: down }));
  assert.equal(r.ranking, 'bm25');
  assert.match(r.notes.join(' '), /Jev unavailable/);
  assert.equal(r.results[0].url, 'https://a.com/guide');
});

test('publish-date filter drops pages known to be out of range', async () => {
  const r = await search('kettle', { level: 'standard', providers: ['p1'], startPublishedDate: '2025-01-01' }, deps());
  const urls = r.results.map((x) => x.url);
  assert.ok(!urls.includes('https://b.com/news'));
  assert.ok(urls.includes('https://a.com/guide'));
  assert.ok(urls.includes('https://c.com/spam'), 'undated page kept');
  assert.match(r.notes.join(' '), /no detectable publish date/);
});

test('fast level never fetches pages unless text is asked for', async () => {
  const scrapes = [];
  const r = await search('descale kettle', { level: 'fast', providers: ['p1'], highlights: true }, deps({ scrapeFn: fakeScrape(PAGES, scrapes) }));
  assert.equal(scrapes.length, 0);
  assert.equal(r.results[0].url, 'https://a.com/guide');
  assert.deepEqual(r.results[0].highlights, ['how to descale a kettle']);
  const r2 = await search('descale kettle', { level: 'fast', providers: ['p1'], numResults: 1, text: true }, deps({ scrapeFn: fakeScrape(PAGES, scrapes) }));
  assert.equal(scrapes.length, 1);
  assert.match(r2.results[0].text, /descaling/);
});

test('instant level searches the cache that earlier searches filled', async () => {
  const d = deps();
  const empty = await search('kettle', { level: 'instant' }, d);
  assert.equal(empty.results.length, 0);
  assert.match(empty.notes.join(' '), /cache is empty/);
  await search('kettle', { level: 'standard', providers: ['p1'] }, d);
  const scrapes = [];
  const r = await search('descaling vinegar', { level: 'instant', highlights: true }, { ...d, scrapeFn: fakeScrape(PAGES, scrapes) });
  assert.equal(scrapes.length, 0);
  assert.equal(r.results[0].url, 'https://a.com/guide');
});

test('maxAgeHours: cached pages are reused, 0 forces a fresh fetch', async () => {
  const scrapes = [];
  const d = deps({ scrapeFn: fakeScrape(PAGES, scrapes) });
  await search('kettle', { level: 'standard', providers: ['p1'] }, d);
  assert.equal(scrapes.length, 3);
  const again = await search('kettle', { level: 'standard', providers: ['p1'] }, d);
  assert.equal(scrapes.length, 3);
  assert.equal(again.usage.pagesFromCache, 3);
  await search('kettle', { level: 'standard', providers: ['p1'], maxAgeHours: 0 }, d);
  assert.equal(scrapes.length, 6);
});

test('deep without an LLM runs standard and says so', async () => {
  const r = await search('kettle', { level: 'deep', providers: ['p1'] }, deps());
  assert.equal(r.level, 'standard');
  assert.equal(r.requestedLevel, 'deep');
  assert.match(r.notes.join(' '), /deep needs an LLM/);
});

test('deep with any OpenAI-compatible LLM: sub-queries, subpages, cited answer', async () => {
  const llmCalls = [];
  const pages = { ...PAGES, 'https://a.com/descaling-steps': { title: 'Descaling steps', markdown: para('descaling steps vinegar kettle', 30) } };
  pages['https://a.com/guide'] = { ...PAGES['https://a.com/guide'], markdown: PAGES['https://a.com/guide'].markdown + '\n\nSee [descaling steps](/descaling-steps).' };
  const fetchImpl = fakeFetch([['http://llm/v1/chat/completions', (u, init) => {
    const b = JSON.parse(init.body);
    llmCalls.push(b);
    const sys = b.messages[0].content;
    if (/plan web searches/.test(sys)) return { choices: [{ message: { content: '{"queries":["kettle limescale removal","descale kettle vinegar ratio"]}' } }] };
    return { choices: [{ message: { content: 'Use a 1:1 vinegar and water mix [1].' } }] };
  }]]);
  const r = await search('how do I descale a kettle', { level: 'deep', providers: ['p1'], answer: true }, deps({ scrapeFn: fakeScrape(pages), fetchImpl, llm: { provider: 'openai', baseUrl: 'http://llm/v1', model: 'local', apiKey: '', timeoutMs: 1000 } }));
  assert.equal(r.level, 'deep');
  assert.deepEqual(r.subqueries, ['kettle limescale removal', 'descale kettle vinegar ratio']);
  assert.ok(r.results.some((x) => x.url === 'https://a.com/descaling-steps'), 'followed an in-site link');
  assert.equal(r.answer, 'Use a 1:1 vinegar and water mix [1].');
  assert.equal(r.citations[0].n, 1);
  assert.equal(llmCalls[0].model, 'local');
});

test('answer without an LLM returns extracted passages, clearly labeled', async () => {
  const r = await search('kettle descaling', { level: 'standard', providers: ['p1'], answer: true }, deps());
  assert.match(r.answer, /\[1\]/);
  assert.match(r.notes.join(' '), /no LLM configured/);
});

test('contents and findSimilar work from the cache/scraper', async () => {
  const d = deps();
  const c = await contents(['https://a.com/guide', 'https://nope.com/x'], { text: { maxCharacters: 50 }, highlights: { query: 'vinegar' } }, d);
  assert.equal(c.results.length, 1);
  assert.equal(c.results[0].text.length, 51);
  assert.match(c.results[0].highlights[0], /vinegar/);
  assert.deepEqual(c.statuses.map((s) => s.status).sort(), ['error', 'success']);
  const s = await findSimilar('https://a.com/guide', { providers: ['p1'] }, d);
  assert.ok(!s.results.some((x) => x.url.startsWith('https://a.com')), 'source domain excluded');
  assert.match(s.query, /Kettle guide/);
});
