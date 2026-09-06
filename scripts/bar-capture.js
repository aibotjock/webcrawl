#!/usr/bin/env node
// Captures REAL Firecrawl cloud outputs (keyless firecrawl-mcp) ONCE, to bar_cache/.
// Every later comparison uses this frozen cache — never re-burn the rate limit.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const testset = JSON.parse(readFileSync(new URL('../testset.json', import.meta.url), 'utf8'));
const OUT = (p) => `${ROOT}bar_cache/${p}`;
for (const d of ['scrape', 'search', 'map', 'crawl']) mkdirSync(OUT(d), { recursive: true });

const slug = (s) => s.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90);

const child = spawn('npx', ['firecrawl-mcp'], { cwd: '/tmp/fcmcp-test' });
child.stderr.on('data', () => {});
let buf = '';
const pending = new Map();
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch {}
  }
});
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const call = (id, method, params, timeoutMs = 150000) => new Promise((resolve) => {
  const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true, id }); }, timeoutMs);
  pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function textOf(result) {
  try { return JSON.parse(result.content[0].text); } catch { return { raw: result.content?.[0]?.text?.slice(0, 400) }; }
}
const save = (kind, name, payload) => writeFileSync(OUT(`${kind}/${name}.json`), JSON.stringify(payload, null, 2));

let nextId = 1;
async function run(tool, args, kind, name) {
  const id = nextId++;
  const t0 = Date.now();
  const res = await call(id, 'tools/call', { name: tool, arguments: args });
  const latencyMs = Date.now() - t0;
  if (res.timeout) { console.log(`TIMEOUT ${tool} ${name}`); save(kind, name, { tool, args, latencyMs, timeout: true }); return null; }
  if (res.error) { console.log(`ERR ${tool} ${name}: ${JSON.stringify(res.error).slice(0, 200)}`); save(kind, name, { tool, args, latencyMs, error: res.error }); return null; }
  const parsed = textOf(res.result);
  save(kind, name, { tool, args, latencyMs, result: parsed });
  const mdLen = parsed?.markdown?.length ?? 0;
  console.log(`OK ${tool} ${name} ${latencyMs}ms md=${mdLen} urls=${parsed?.links?.length ?? parsed?.urls?.length ?? parsed?.results?.length ?? 0}`);
  await sleep(1800);
  return parsed;
}

const t0 = Date.now();
const init = await call(nextId++, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bar-capture', version: '0.0.1' } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
console.log('init:', init.result?.serverInfo?.name, init.result?.serverInfo?.version);

// 1) scrapes (highest priority — capture first)
for (const { url, kind: k } of testset.scrape) await run('firecrawl_scrape', { url, formats: ['markdown'] }, 'scrape', `${slug(url)}--${k}`);
// screenshot-format scrapes
for (const url of testset.screenshot) await run('firecrawl_scrape', { url, formats: ['screenshot'] }, 'scrape', `${slug(url)}--shot`);
// 2) searches
for (const q of testset.search) await run('firecrawl_search', { query: q, limit: 8 }, 'search', slug(q));
// 3) maps
for (const { url, limit } of testset.map) await run('firecrawl_map', { url, limit }, 'map', slug(url));
// 4) crawl (best effort, small)
for (const { url, limit } of testset.crawl) await run('firecrawl_crawl', { url, limit, scrapeOptions: { formats: ['markdown'] } }, 'crawl', slug(url));

console.log(`TOTAL ${((Date.now() - t0) / 1000).toFixed(0)}s`);
child.kill();
process.exit(0);
