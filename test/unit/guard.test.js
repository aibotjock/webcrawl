import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicUrl, guardedFetch } from '../../src/core/guard.js';
import { loadImage } from '../../src/search/media.js';

const fakeLookup = (table) => async (host) => {
  if (!(host in table)) throw new Error('ENOTFOUND');
  return [].concat(table[host]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('private and special addresses are recognized', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])
    assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '93.184.216.34'])
    assert.ok(!isPrivateIp(ip), ip);
});

test('assertPublicUrl blocks private targets, names and schemes', async () => {
  const lookup = fakeLookup({ 'evil.example': '10.0.0.5', 'mixed.example': ['93.184.216.34', '127.0.0.1'], 'good.example': '93.184.216.34' });
  for (const u of ['http://127.0.0.1:8080/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://printer.local/', 'http://evil.example/', 'http://mixed.example/', 'file:///etc/passwd', 'ftp://x.com/'])
    await assert.rejects(assertPublicUrl(u, { lookup }), { code: 'BLOCKED_PRIVATE' }, u);
  await assertPublicUrl('https://good.example/page', { lookup });
});

test('guardedFetch re-checks every redirect hop', async () => {
  const lookup = fakeLookup({ 'public.example': '93.184.216.34', 'next.example': '93.184.216.35' });
  const hops = [];
  const fetchImpl = async (url, init) => {
    hops.push([url, init.redirect]);
    if (url === 'https://public.example/a') return { status: 302, headers: new Map([['location', 'https://next.example/b']]) };
    if (url === 'https://next.example/b') return { status: 301, headers: new Map([['location', 'http://169.254.169.254/latest/']]) };
    return { status: 200, headers: new Map() };
  };
  await assert.rejects(guardedFetch('https://public.example/a', {}, { fetchImpl, lookup }), { code: 'BLOCKED_PRIVATE' });
  assert.deepEqual(hops.map((h) => h[0]), ['https://public.example/a', 'https://next.example/b']);
  assert.ok(hops.every((h) => h[1] === 'manual'));
  const ok = await guardedFetch('https://next.example/c', {}, { fetchImpl, lookup });
  assert.equal(ok.status, 200);
});

test('WEBCRAWL_ALLOW_PRIVATE=on turns the guard off for local use', async () => {
  process.env.WEBCRAWL_ALLOW_PRIVATE = 'on';
  try { await assertPublicUrl('http://127.0.0.1:3000/'); } finally { delete process.env.WEBCRAWL_ALLOW_PRIVATE; }
  await assert.rejects(assertPublicUrl('http://127.0.0.1:3000/'), { code: 'BLOCKED_PRIVATE' });
});

test('image downloads go through the guard by default', async () => {
  await assert.rejects(loadImage('http://169.254.169.254/latest/meta-data/photo.jpg'), { code: 'BLOCKED_PRIVATE' });
});
