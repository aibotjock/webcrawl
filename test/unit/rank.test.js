import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, bm25, bestSentences, lexicalSemanticScores, normalize } from '../../src/search/rank.js';
import { fakeFetch } from './helpers.js';

const filler = (n, w = 'lorem') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

test('chunkMarkdown splits on headings and keeps the nearest heading', () => {
  const md = `# Install\n\n${filler(40, 'setup')} npm install webcrawl.\n\n## Usage\n\n${filler(40, 'run')} call scrape with a url.`;
  const ch = chunkMarkdown(md, { maxWords: 60 });
  assert.equal(ch.length, 2);
  assert.equal(ch[0].heading, 'Install');
  assert.equal(ch[1].heading, 'Usage');
  assert.match(ch[1].text, /scrape/);
});

test('chunkMarkdown breaks an overlong paragraph by sentence', () => {
  const para = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} talks about crawling websites quickly.`).join(' ');
  const ch = chunkMarkdown(para, { maxWords: 50 });
  assert.ok(ch.length >= 4, `got ${ch.length}`);
  for (const c of ch) assert.ok(c.text.split(/\s+/).length <= 60);
});

test('chunkMarkdown drops image markup and keeps link text', () => {
  const ch = chunkMarkdown(`![logo](https://x/y.png) Read the [installation guide](https://x/install) before you begin with the tool and its many options for crawling.`);
  assert.doesNotMatch(ch[0].text, /logo|https/);
  assert.match(ch[0].text, /installation guide/);
});

test('bm25 ranks the matching document first', () => {
  const s = bm25('python asyncio event loop', ['cooking pasta at home', 'the asyncio event loop runs coroutines in python', 'python lists and dicts']);
  assert.equal(s.indexOf(Math.max(...s)), 1);
  assert.equal(s[0], 0);
});

test('normalize scales to 0..1 and keeps all-zero at zero', () => {
  assert.deepEqual(normalize([0, 2, 4]), [0, 0.5, 1]);
  assert.deepEqual(normalize([0, 0]), [0, 0]);
});

test('bestSentences picks the relevant sentences in original order', () => {
  const t = 'The weather was nice today. Jev scores passages for relevance very quickly. Lunch was pasta again. Scores from Jev range from zero to one.';
  const h = bestSentences('jev scores', t, 2);
  assert.equal(h, 'Jev scores passages for relevance very quickly. Scores from Jev range from zero to one.');
});

test('lexicalSemanticScores falls back to bm25 without embeddings', async () => {
  const r = await lexicalSemanticScores('red bicycle', ['a red bicycle for sale', 'blue car'], { cfg: null });
  assert.equal(r.method, 'bm25');
  assert.ok(r.scores[0] > r.scores[1]);
});

test('lexicalSemanticScores blends embeddings from any OpenAI-compatible server', async () => {
  const vec = { 'red bicycle': [1, 0], 'a red bicycle for sale': [0.9, 0.1], 'blue car': [0, 1] };
  const calls = [];
  const fetchImpl = fakeFetch([['http://emb/v1/embeddings', (u, init) => {
    const { input } = JSON.parse(init.body);
    return { data: input.map((t, index) => ({ index, embedding: vec[t] })) };
  }]], calls);
  const r = await lexicalSemanticScores('red bicycle', ['a red bicycle for sale', 'blue car'], { cfg: { baseUrl: 'http://emb/v1', model: 'm' }, fetchImpl });
  assert.equal(r.method, 'bm25+embeddings');
  assert.ok(r.scores[0] > 0.8 && r.scores[1] < 0.1, JSON.stringify(r.scores));
  assert.equal(JSON.parse(calls[0].init.body).model, 'm');
});
