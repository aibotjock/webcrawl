#!/usr/bin/env node
// Search quality benchmark: webcrawl levels vs Exa on a labeled query set.
//
//   node scripts/bench-search.js [queries.json] [--levels fast,standard] [--exa]
//
// queries.json: [{ "query": "...", "relevant": ["url or url-prefix", ...], "highly": ["..."] }]
// A result counts as relevant (gain 1) when its URL starts with a "relevant" prefix,
// highly relevant (gain 2) for a "highly" prefix. Reports nDCG@10, precision@5,
// recall@10 and latency. --exa also runs Exa (needs EXA_API_KEY) as the bar to beat.
// Writes results/bench-search-<date>.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { search } from '../src/search/engine.js';

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.json')) || 'testset-search.json';
const li = args.indexOf('--levels');
const levels = (li >= 0 ? args[li + 1] : 'fast,standard').split(',');
const withExa = args.includes('--exa');
const set = JSON.parse(await readFile(file, 'utf8'));

const norm = (u) => String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
const gain = (url, q) => {
  const u = norm(url);
  if ((q.highly || []).some((p) => u.startsWith(norm(p)))) return 2;
  if ((q.relevant || []).some((p) => u.startsWith(norm(p)))) return 1;
  return 0;
};
function metrics(urls, q) {
  const g = urls.slice(0, 10).map((u) => gain(u, q));
  const dcg = g.reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
  const ideal = [...(q.highly || []).map(() => 2), ...(q.relevant || []).map(() => 1)].slice(0, 10);
  const idcg = ideal.reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0) || 1;
  const labels = [...(q.highly || []), ...(q.relevant || [])].map(norm);
  const found = new Set(urls.slice(0, 10).map(norm).map((u) => labels.find((p) => u.startsWith(p))).filter(Boolean));
  return {
    ndcg10: +(dcg / idcg).toFixed(3),
    p5: +(g.slice(0, 5).filter(Boolean).length / 5).toFixed(2),
    recall10: +(found.size / (labels.length || 1)).toFixed(2),
  };
}

async function exaSearch(query) {
  const t0 = Date.now();
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.EXA_API_KEY },
    body: JSON.stringify({ query, numResults: 10, type: 'auto' }),
  });
  const j = await res.json();
  return { urls: (j.results || []).map((r) => r.url), latencyMs: Date.now() - t0, cost: j.costDollars?.total };
}

const systems = levels.map((l) => [`webcrawl:${l}`, async (q) => { const t0 = Date.now(); const r = await search(q, { level: l, numResults: 10 }); return { urls: r.results.map((x) => x.url), latencyMs: Date.now() - t0, cost: r.costDollars?.jev, notes: r.notes }; }]);
if (withExa) {
  if (!process.env.EXA_API_KEY) console.error('--exa needs EXA_API_KEY; skipping Exa');
  else systems.push(['exa:auto', (q) => exaSearch(q)]);
}

const rows = [];
for (const q of set) {
  for (const [name, run] of systems) {
    try {
      const r = await run(q.query);
      rows.push({ query: q.query, system: name, ...metrics(r.urls, q), latencyMs: r.latencyMs, cost: r.cost ?? null, top3: r.urls.slice(0, 3), ...(r.notes && { notes: r.notes }) });
    } catch (e) { rows.push({ query: q.query, system: name, error: String(e.message || e) }); }
    process.stderr.write('.');
  }
}
process.stderr.write('\n');

const summary = {};
for (const [name] of systems) {
  const r = rows.filter((x) => x.system === name && !x.error);
  const avg = (k) => +(r.reduce((s, x) => s + (x[k] || 0), 0) / (r.length || 1)).toFixed(3);
  summary[name] = { queries: r.length, ndcg10: avg('ndcg10'), p5: avg('p5'), recall10: avg('recall10'), latencyMs: Math.round(avg('latencyMs')), costPerQuery: avg('cost') };
}
console.table(summary);
await mkdir('results', { recursive: true });
const out = `results/bench-search-${new Date().toISOString().slice(0, 10)}.json`;
await writeFile(out, JSON.stringify({ file, summary, rows }, null, 2));
console.log(`wrote ${out}`);
process.exit(0);
