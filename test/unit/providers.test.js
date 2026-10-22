import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gather, domainMatch, PROVIDERS, pickProviders } from '../../src/search/providers.js';
import { fakeFetch, fixedProviders } from './helpers.js';

const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
};

test('gather fuses sources with reciprocal rank fusion and dedupes URLs', async () => {
  const registry = fixedProviders({
    a: [{ title: 'A1', url: 'https://x.com/1' }, { title: 'Shared', url: 'https://www.s.com/page?utm_source=a' }],
    b: [{ title: 'Shared', url: 'https://www.s.com/page', description: 'longer description wins' }, { title: 'B2', url: 'https://y.com/2' }],
  });
  const g = await gather('q', { providers: ['a', 'b'], registry });
  assert.equal(g.candidates[0].url, 'https://www.s.com/page', 'page found by both sources ranks first');
  assert.deepEqual(g.candidates[0].sources, ['a', 'b']);
  assert.equal(g.candidates[0].description, 'longer description wins');
  assert.equal(g.candidates.length, 3);
});

test('one failing source does not sink the search', async () => {
  const registry = fixedProviders({ ok: [{ title: 'T', url: 'https://ok.com/' }], broken: new Error('boom') });
  const g = await gather('q', { providers: ['ok', 'broken'], registry });
  assert.equal(g.candidates.length, 1);
  assert.equal(g.providers.find((p) => p.name === 'broken').error, 'boom');
});

test('domain filters: subdomains and path prefixes', async () => {
  assert.ok(domainMatch('https://docs.github.com/en', ['github.com']));
  assert.ok(domainMatch('https://docs.python.org/3/library/asyncio.html', ['docs.python.org/3']));
  assert.ok(!domainMatch('https://docs.python.org/2/x', ['docs.python.org/3']));
  assert.ok(!domainMatch('https://notgithub.com/', ['github.com']));
  const registry = fixedProviders({ a: [{ url: 'https://github.com/x' }, { url: 'https://gitlab.com/y' }, { url: 'https://spam.github.com/z' }] });
  const g = await gather('q', { providers: ['a'], registry, includeDomains: ['github.com'], excludeDomains: ['spam.github.com'] });
  assert.deepEqual(g.candidates.map((c) => c.url), ['https://github.com/x']);
});

test('a single included domain is added to the query as site:', async () => {
  let seen;
  const registry = { a: { enabled: () => true, search: async (q) => { seen = q; return []; } } };
  await gather('jev pricing', { providers: ['a'], registry, includeDomains: ['typesafe.ai'] });
  assert.equal(seen, 'jev pricing site:typesafe.ai');
});

test('keyed providers turn on only with their env var', async () => {
  await withEnv({ BRAVE_API_KEY: '', SEARXNG_URL: '', EXA_API_KEY: '', WEBCRAWL_SEARCH_PROVIDERS: '' }, () => {
    assert.deepEqual(pickProviders().use, ['duckduckgo', 'wikipedia']);
  });
  await withEnv({ BRAVE_API_KEY: 'k', WEBCRAWL_SEARCH_PROVIDERS: '' }, () => {
    assert.ok(pickProviders().use.includes('brave'));
    const r = pickProviders(['brave', 'nope', 'exa']);
    assert.deepEqual(r.use, ['brave']);
    assert.deepEqual(r.skipped.sort(), ['exa', 'nope']);
  });
});

test('parsers: searxng, brave, exa, wikipedia', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    ['http://sx/search', () => ({ results: [{ title: 'S', url: 'https://s.com', content: '<b>snip</b>', publishedDate: '2026-01-02' }] })],
    ['https://api.search.brave.com/', () => ({ web: { results: [{ title: 'B', url: 'https://b.com', description: 'bd' }] } })],
    ['https://api.exa.ai/search', () => ({ results: [{ title: 'E', url: 'https://e.com', publishedDate: '2026-03-04' }] })],
    ['https://en.wikipedia.org/', () => ({ query: { search: [{ title: 'Web crawler', snippet: 'A <span>web</span> crawler' }] } })],
  ], calls);
  await withEnv({ SEARXNG_URL: 'http://sx', BRAVE_API_KEY: 'bk', EXA_API_KEY: 'ek' }, async () => {
    assert.deepEqual(await PROVIDERS.searxng.search('q', { limit: 5, fetchImpl }), [{ title: 'S', url: 'https://s.com', description: 'snip', publishedDate: '2026-01-02' }]);
    assert.equal((await PROVIDERS.brave.search('q', { limit: 5, fetchImpl }))[0].description, 'bd');
    assert.equal((await PROVIDERS.exa.search('q', { limit: 5, fetchImpl }))[0].publishedDate, '2026-03-04');
    const w = await PROVIDERS.wikipedia.search('q', { limit: 5, fetchImpl });
    assert.equal(w[0].url, 'https://en.wikipedia.org/wiki/Web_crawler');
    assert.equal(w[0].description, 'A web crawler');
  });
  assert.equal(calls.find((c) => c.url.startsWith('https://api.search.brave.com')).init.headers['X-Subscription-Token'], 'bk');
  assert.equal(calls.find((c) => c.url.startsWith('https://api.exa.ai')).init.headers['x-api-key'], 'ek');
});
