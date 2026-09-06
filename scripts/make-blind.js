#!/usr/bin/env node
// Assembles blind A/B judge sets: /tmp/judge/<piece>/<case>/{A,B,*} with random assignment.
// Mapping recorded to results/blind-map.json (NEVER shown to critics).
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { randomInt } from 'node:crypto';
const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => JSON.parse(readFileSync(ROOT + p, 'utf8'));
const testset = read('testset.json');
const slug = (s) => s.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90);
const mapping = {};
const J = '/tmp/judge';

// scrape piece
rmSync(`${J}/scrape`, { recursive: true, force: true });
for (const { url, kind } of testset.scrape) {
  const dir = `${J}/scrape/${kind}`;
  mkdirSync(dir, { recursive: true });
  const bar = read(`bar_cache/scrape/${slug(url)}--${kind}.json`).result?.markdown || '(bar produced no markdown)';
  const ours = read(`results/ours-scrape/${slug(url)}.md.json`).markdown || '(ours produced no markdown)';
  const oursFirst = randomInt(2) === 1;
  writeFileSync(`${dir}/${oursFirst ? 'A' : 'B'}.md`, ours);
  writeFileSync(`${dir}/${oursFirst ? 'B' : 'A'}.md`, bar);
  writeFileSync(`${dir}/url.txt`, url);
  mapping[`scrape/${kind}`] = { ours: oursFirst ? 'A' : 'B' };
}
writeFileSync(ROOT + 'results/blind-map.json', JSON.stringify(mapping, null, 2));
console.log('blind set ready:', Object.keys(mapping).length, 'scrape cases');
