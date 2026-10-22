import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePassages, matchImages, RELEVANCE_LEVELS, MAX_REQUEST_TOKENS } from '../../src/search/jev.js';
import { fakeFetch } from './helpers.js';

const cfg = { apiKey: 'tk', baseUrl: 'https://jev.test', model: 'jev-1.14.0', images: true, timeoutMs: 1000 };

// Fake Jev: score = 3 when the passage text contains "answer", else 0.
function jevServer(calls) {
  return fakeFetch([['https://jev.test/v1/systemone', (u, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [k, q] of Object.entries(body.questions)) {
      if (q.type === 'score') answers[k] = { type: 'score', score: /answer/.test(q.instructions.passage.text) ? 3 : 0, confidence: 0.9 };
      if (q.type === 'noul') answers[k] = { type: 'noul', noul: /MATCH/.test(body.assets?.[q.instructions.candidate]?.data_base64 || '') ? 0.93 : 0.08 };
    }
    return { answers, model: 'jev-1.14.0', usage: { input_tokens: 1000, output_tokens: 0 } };
  }]], calls);
}

test('scorePassages sends graded score questions and maps levels to 0..1', async () => {
  const calls = [];
  const r = await scorePassages('what is the answer', [{ text: 'here is the answer', title: 'T' }, { text: 'unrelated' }], { cfg, fetchImpl: jevServer(calls) });
  assert.deepEqual(r.scores, [1, 0]);
  const req = calls[0];
  assert.equal(req.init.headers.authorization, 'Bearer tk');
  assert.equal(req.init.headers['TypeSafe-Danger-Zone-Images'], undefined, 'no image header for text');
  const body = JSON.parse(req.init.body);
  assert.equal(body.model, 'jev-1.14.0');
  assert.deepEqual(body.state, { query: 'what is the answer' });
  assert.equal(body.questions.p0.type, 'score');
  assert.deepEqual(body.questions.p0.criteria, RELEVANCE_LEVELS);
  assert.equal(r.usage.input_tokens, 1000);
  assert.ok(Math.abs(r.costDollars - 1000 * 0.042e-6) < 1e-12);
});

test('large passage sets split into requests under the token budget', async () => {
  const calls = [];
  const big = Array.from({ length: 400 }, (_, i) => ({ text: `${'word '.repeat(170)} ${i}` }));
  const r = await scorePassages('q', big, { cfg, fetchImpl: jevServer(calls) });
  assert.ok(calls.length > 1, 'split into several requests');
  for (const c of calls) assert.ok(c.init.body.length / 4 < MAX_REQUEST_TOKENS * 1.05);
  assert.equal(r.scores.length, 400);
  assert.ok(r.scores.every((s) => s === 0));
});

test('Jev errors surface as exceptions (callers fall back)', async () => {
  const fetchImpl = fakeFetch([['https://jev.test', () => ({ status: 401, body: { error: 'bad key' } })]]);
  await assert.rejects(scorePassages('q', [{ text: 'x' }], { cfg, fetchImpl }), /HTTP 401/);
});

test('matchImages sends the Danger Zone header and only referenced assets', async () => {
  const calls = [];
  const img = (s) => ({ format: 'jpeg', data_base64: Buffer.from(s).toString('base64') });
  // base64 of strings containing MATCH won't contain "MATCH" literally, so encode marker directly:
  const cands = [
    { id: 'a', format: 'jpeg', data_base64: 'MATCHxxxx' },
    { id: 'b', format: 'jpeg', data_base64: 'nopexxxxx' },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, format: 'jpeg', data_base64: `zz${i}` })),
  ];
  const r = await matchImages({ query: img('photo'), candidates: cands }, { cfg, fetchImpl: jevServer(calls), hint: 'red kettle' });
  assert.equal(r.probabilities.a, 0.93);
  assert.equal(r.probabilities.b, 0.08);
  assert.equal(calls.length, 2, '9 candidates -> 2 requests of up to 6');
  for (const c of calls) {
    assert.equal(c.init.headers['TypeSafe-Danger-Zone-Images'], 'true');
    const body = JSON.parse(c.init.body);
    const refs = new Set([body.state.photo, ...Object.values(body.questions).map((q) => q.instructions.candidate)]);
    assert.deepEqual(new Set(Object.keys(body.assets)), refs, 'every asset referenced, none extra');
    for (const a of Object.values(body.assets)) assert.equal(a.type, 'image');
    assert.equal(body.state.what_the_user_is_looking_for, 'red kettle');
  }
});

test('image calls refuse to run unless WEBCRAWL_JEV_IMAGES is on', async () => {
  await assert.rejects(matchImages({ query: {}, candidates: [] }, { cfg: { ...cfg, images: false } }), /WEBCRAWL_JEV_IMAGES/);
});
