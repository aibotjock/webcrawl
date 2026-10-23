import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { operatorConfig } from '../src/operator-security.js';

const token = 'test-only-operator-credential-32-characters';
async function fixture(run, loader = async () => ({})) {
  const settings = operatorConfig({ WEBCRAWL_OPERATOR_TOKEN: token });
  const server = createApp({ settings, coreLoader: loader }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(address + path, { method: options.method || 'GET', headers: { host: '127.0.0.1:8787', ...options.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join('; ') : String(v)])) })));
    });
    req.on('error', reject); req.end(options.body);
  });
  try { await run(request); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('actual HTTP routes require auth before parsing body or loading a core module', async () => {
  let loads = 0;
  await fixture(async request => {
    assert.equal((await request('/v1/scrape', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{malformed' })).status, 401);
    assert.equal((await request('/v1/crawl/job')).status, 401);
    assert.equal((await request('/V1/scrape', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await request('/v1/SCRAPE', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await request('/v1/scrape', { method: 'POST', headers: { 'x-forwarded-host': 'localhost', 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal(loads, 0);
    assert.equal((await request('/v1/search', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://attacker.example' }, body: '{}' })).status, 403);
    assert.equal((await request('/v1/search', { method: 'POST', headers: { host: 'attacker.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  }, async () => { loads++; return {}; });
});

test('actual login cookie authorizes bounded requests and logout revokes it', async () => {
  const received = [];
  await fixture(async request => {
    const login = await request('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8787' }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.ok(!cookie.includes(token));
    const good = await request('/v1/search', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ query: 'offline test', limit: 100000 }) });
    assert.equal(good.status, 200); assert.equal(received[0].limit, 25);
    const denied = await request('/v1/scrape', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: 'http://127.0.0.1/admin' }) });
    assert.equal(denied.status, 400);
    assert.equal((await request('/v1/logout', { method: 'POST', headers: { cookie } })).status, 200);
    assert.equal((await request('/v1/search', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })).status, 401);
  }, async name => { assert.equal(name, 'search'); return { async webSearch(_query, options) { received.push(options); return { results: [], latencyMs: 0 }; } }; });
});

test('actual HTTP body limits reject oversized authenticated input', async () => {
  await fixture(async request => {
    const response = await request('/v1/search', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x'.repeat(140000) }) });
    assert.equal(response.status, 413);
  });
});

test('background crawl admission and DELETE cancellation affect active work', async () => {
  let running = 0;
  await fixture(async request => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const body = JSON.stringify({ url: 'https://example.com', limit: 100000 });
    const first = await (await request('/v1/crawl', { method: 'POST', headers, body })).json();
    const second = await (await request('/v1/crawl', { method: 'POST', headers, body })).json();
    assert.ok(first.id && second.id); assert.equal(running, 2);
    assert.equal((await request('/v1/crawl', { method: 'POST', headers, body })).status, 429);
    assert.equal((await request(`/v1/crawl/${first.id}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await request(`/v1/crawl/${second.id}`, { method: 'DELETE', headers })).status, 200);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(running, 0);
  }, async name => { assert.equal(name, 'crawl'); return { async crawlSite(_url, options) {
    assert.equal(options.limit, 100); running++;
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    running--; return { pages: [], count: 0, latencyMs: 0, cancelled: true };
  } }; });
});

test('cold concurrent crawl imports cannot overrun the reservation limit', async () => {
  let loads = 0;
  let releaseImport;
  let bothStarted;
  const barrier = new Promise(resolve => { releaseImport = resolve; });
  const started = new Promise(resolve => { bothStarted = resolve; });
  await fixture(async request => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const body = JSON.stringify({ url: 'https://example.com' });
    const first = request('/v1/crawl', { method: 'POST', headers, body });
    const second = request('/v1/crawl', { method: 'POST', headers, body });
    await started;
    try {
      assert.equal((await request('/v1/crawl', { method: 'POST', headers, body })).status, 429);
      assert.equal(loads, 2);
    } finally { releaseImport(); }
    assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [200, 200]);
    assert.equal((await request('/v1/crawl', { method: 'POST', headers, body })).status, 200, 'completed reservations are released');
  }, async name => {
    assert.equal(name, 'crawl');
    if (++loads === 2) bothStarted();
    await barrier;
    return { async crawlSite() { return { pages: [], count: 0, latencyMs: 0 }; } };
  });
});
