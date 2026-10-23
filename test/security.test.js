import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { createPublicRequester, isPublicAddress, parsePublicUrl, resolvePublicUrl } from '../src/core/safe-network.js';
import { installBrowserNetwork } from '../src/core/browser-network.js';
import { crawlSite, globMatches } from '../src/core/crawl.js';

const publicAnswer = async () => [{ address: '8.8.8.8', family: 4 }];
function fixtureTransport(replies, calls = []) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = body => queueMicrotask(() => {
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        assert.ifError(error);
        calls.push({ url: url.href, options, body, addresses });
        const reply = replies.shift();
        assert.ok(reply, 'unexpected network request');
        const res = Readable.from(reply.body ? [reply.body] : []);
        res.statusCode = reply.status || 200;
        res.headers = reply.headers || {};
        callback(res);
      });
    });
    return req;
  };
}

test('public-address policy rejects reserved IPv4, encoded loopback and non-global IPv6', async () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '168.63.129.16', '172.16.0.1', '192.168.1.2', '192.0.2.2', '198.18.0.1', '198.51.100.3', '203.0.113.4', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1', '3fff::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://[::ffff:127.0.0.1]', 'file:///etc/passwd', 'http://u:p@example.com', 'http://localhost.', 'http://foo.internal', 'http://example.com:8080', 'http://example.com\\@127.0.0.1']) assert.throws(() => parsePublicUrl(url), undefined, url);
});

test('all DNS answers are checked; mixed public/private and invalid family fail closed', async () => {
  await assert.rejects(resolvePublicUrl('https://example.com', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /private/);
  await assert.rejects(resolvePublicUrl('https://example.com', { lookup: async () => [{ address: '8.8.8.8', family: 6 }] }), /invalid/);
});

test('socket lookup uses the validated answer without a second DNS query', async () => {
  let lookups = 0;
  const calls = [];
  const request = createPublicRequester({ lookup: async () => { lookups++; return lookups === 1 ? publicAnswer() : [{ address: '127.0.0.1', family: 4 }]; }, requestImpl: fixtureTransport([{ body: Buffer.from('ok') }], calls) });
  const result = await request('https://example.com');
  assert.equal(result.body.toString(), 'ok');
  assert.equal(lookups, 1);
  assert.deepEqual(calls[0].addresses, [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(calls[0].options.agent, false);
});

test('redirects revalidate destinations and never reach a private literal', async () => {
  const calls = [];
  const request = createPublicRequester({ lookup: publicAnswer, requestImpl: fixtureTransport([{ status: 302, headers: { location: 'http://169.254.169.254/latest' } }], calls) });
  await assert.rejects(request('https://example.com'), /Private|downgrade/);
  assert.equal(calls.length, 1);
});

test('redirect DNS rebinding is rejected and cross-origin credentials are removed', async () => {
  const calls = [];
  const request = createPublicRequester({ lookup: async host => host === 'bad.example' ? [{ address: '10.0.0.1', family: 4 }] : publicAnswer(), requestImpl: fixtureTransport([{ status: 302, headers: { location: 'https://bad.example/' } }], calls) });
  await assert.rejects(request('https://example.com'), /private/);
  assert.equal(calls.length, 1);
  const secondCalls = [];
  const good = createPublicRequester({ lookup: publicAnswer, requestImpl: fixtureTransport([{ status: 302, headers: { location: 'https://other.example/' } }, { body: Buffer.from('ok') }], secondCalls) });
  await good('https://example.com', { headers: { authorization: 'test-value', cookie: 'test-cookie', 'x-api-key': 'test-value', host: 'evil.example' } });
  for (const key of ['authorization', 'cookie', 'x-api-key', 'host']) assert.equal(secondCalls[1].options.headers[key], undefined);
});

test('redirect limits and redirect:error fail closed', async () => {
  const make = () => createPublicRequester({ lookup: publicAnswer, requestImpl: fixtureTransport(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/again' } }))) });
  await assert.rejects(make()('https://example.com', { maxRedirects: 1 }), /Too many redirects/);
  await assert.rejects(make()('https://example.com', { redirect: 'error' }), /Redirect is not allowed/);
});

test('response limits cover declared size, chunked data and decompression bombs', async () => {
  for (const reply of [{ headers: { 'content-length': '200' } }, { body: Buffer.alloc(200) }, { headers: { 'content-encoding': 'gzip' }, body: gzipSync(Buffer.alloc(10000)) }]) {
    const request = createPublicRequester({ lookup: publicAnswer, requestImpl: fixtureTransport([reply]) });
    await assert.rejects(request('https://example.com', { maxBytes: 100 }), /size limit/);
  }
});

test('request cancellation prevents transport calls', async () => {
  const controller = new AbortController(); controller.abort();
  const calls = [];
  const request = createPublicRequester({ lookup: publicAnswer, requestImpl: fixtureTransport([], calls) });
  await assert.rejects(request('https://example.com', { signal: controller.signal }), /cancelled/);
  assert.equal(calls.length, 0);
});

function fakeContext() {
  return { async route(pattern, handler) { assert.equal(pattern, '**/*'); this.handler = handler; }, async routeWebSocket(pattern, handler) { assert.equal(pattern, '**/*'); this.ws = handler; } };
}
function route(url, resourceType = 'script') {
  return { request: () => ({ url: () => url, resourceType: () => resourceType, method: () => 'GET', headers: () => ({ authorization: 'operator-test', cookie: 'operator-cookie', 'x-api-key': 'test-api', accept: '*/*' }), postDataBuffer: () => null }), async fulfill(value) { this.fulfilled = value; }, async abort() { this.aborted = true; } };
}

test('browser documents and subresources are brokered; credentials are never forwarded', async () => {
  const ctx = fakeContext();
  const calls = [];
  const cleanup = await installBrowserNetwork(ctx, { request: async (url, options) => { calls.push({ url, options }); return { status: 200, headers: {}, body: Buffer.from('ok') }; } });
  for (const type of ['document', 'script', 'image', 'stylesheet', 'xhr', 'fetch', 'other']) { const r = route('https://example.com/a', type); await ctx.handler(r); assert.equal(r.fulfilled.status, 200); }
  assert.equal(calls.length, 7);
  for (const { options } of calls) { assert.equal(options.followRedirects, false); for (const name of ['authorization', 'cookie', 'x-api-key']) assert.equal(options.headers[name], undefined); }
  cleanup();
});

test('browser internal subresource, resource budget and websocket access are blocked', async () => {
  const ctx = fakeContext();
  const request = createPublicRequester({ lookup: publicAnswer, requestImpl: fixtureTransport([]) });
  const cleanup = await installBrowserNetwork(ctx, { request, maxRequests: 1 });
  const internal = route('http://127.0.0.1/admin'); await ctx.handler(internal); assert.equal(internal.aborted, true);
  const over = route('https://example.com/'); await ctx.handler(over); assert.equal(over.aborted, true);
  let closed = false; ctx.ws({ close() { closed = true; } }); assert.equal(closed, true);
  cleanup();
});

test('crawl attempted-page, output and concurrency limits apply even to failed pages', async () => {
  let n = 0, active = 0, maxActive = 0;
  const result = await crawlSite('https://example.com', { limit: 4, concurrency: 100000, _pageFn: async url => {
    n++; active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setImmediate(resolve)); active--;
    return { markdown: url, links: Array.from({ length: 2000 }, (_, i) => `https://example.com/${n}/${i}`) };
  } });
  assert.equal(n, 4); assert.ok(maxActive <= 4); assert.equal(result.count, 4);
  const controller = new AbortController(); controller.abort();
  const cancelled = await crawlSite('https://example.com', { signal: controller.signal, _pageFn: async () => { throw new Error('must not run'); } });
  assert.equal(cancelled.cancelled, true);
});

test('wildcard filters preserve literal characters without regex execution', () => {
  assert.equal(globMatches('https://example.com/foo', 'https://example.com/*'), true);
  assert.equal(globMatches('https://example.com/foo', 'https://example.com/bar*'), false);
  assert.equal(globMatches('a?b', 'a?b'), true);
});


test('Azure fabric destination is rejected as a literal and a DNS answer before transport', async () => {
  assert.throws(() => parsePublicUrl('http://168.63.129.16/'), /Private|reserved/);
  const calls = [];
  const request = createPublicRequester({
    lookup: async () => [{ address: '168.63.129.16', family: 4 }],
    requestImpl: fixtureTransport([], calls),
  });
  await assert.rejects(request('http://fabric.example/'), /private|reserved/);
  assert.equal(calls.length, 0);
});
