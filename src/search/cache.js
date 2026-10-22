// Page cache and the small private index behind the "instant" level. Every page the
// search fetches lands here with a timestamp; maxAgeHours decides whether it is reused.
//
// WEBCRAWL_CACHE_DIR (default .cache/pages; "off" keeps it in memory only),
// WEBCRAWL_CACHE_MAX (default 5000 pages kept in memory).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { bm25, chunkMarkdown, normalize } from './rank.js';

const env = (k) => String(process.env[k] || '').trim();
const keyOf = (url) => createHash('sha1').update(url).digest('hex');

export function createCache({ dir = env('WEBCRAWL_CACHE_DIR') || '.cache/pages', max = Number(env('WEBCRAWL_CACHE_MAX')) || 5000 } = {}) {
  const mem = new Map(); // url -> page, in insertion (LRU-ish) order
  const disk = dir && dir !== 'off' ? path.resolve(dir) : null;
  let loaded = !disk;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const files = (await readdir(disk)).filter((f) => f.endsWith('.json'));
      for (const f of files.slice(-max)) {
        try { const p = JSON.parse(await readFile(path.join(disk, f), 'utf8')); if (p?.url) mem.set(p.url, p); } catch {}
      }
    } catch { /* no cache dir yet */ }
  }

  return {
    async get(url, maxAgeHours) {
      await load();
      const p = mem.get(url);
      if (!p) return null;
      if (maxAgeHours === 0) return null; // always fetch fresh
      if (maxAgeHours > 0 && Date.now() - Date.parse(p.fetchedAt) > maxAgeHours * 3600e3) return null;
      return p;
    },
    async put(page) {
      await load();
      const p = { ...page, fetchedAt: page.fetchedAt || new Date().toISOString() };
      mem.delete(p.url);
      mem.set(p.url, p);
      while (mem.size > max) mem.delete(mem.keys().next().value);
      if (disk) {
        try { await mkdir(disk, { recursive: true }); await writeFile(path.join(disk, keyOf(p.url) + '.json'), JSON.stringify(p)); } catch {}
      }
      return p;
    },
    async size() { await load(); return mem.size; },
    // BM25 over cached pages' passages; returns pages with their best passage.
    async search(query, { limit = 10, filter = () => true } = {}) {
      await load();
      const passages = [];
      for (const p of mem.values()) {
        if (!filter(p)) continue;
        chunkMarkdown(p.markdown).forEach((c, i) => passages.push({ page: p, i, ...c }));
      }
      if (!passages.length) return [];
      const sc = normalize(bm25(query, passages.map((x) => `${x.page.title || ''} ${x.heading} ${x.text}`)));
      const best = new Map();
      passages.forEach((x, i) => {
        if (sc[i] <= 0) return;
        const cur = best.get(x.page.url);
        if (!cur || sc[i] > cur.score) best.set(x.page.url, { page: x.page, score: sc[i], passage: x });
      });
      return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}
