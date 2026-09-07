// Tests for the research planner, plain-English schema generation and the
// saved-sessions store. These avoid real network I/O: planResearch/generateSchema
// gracefully fall back to deterministic heuristics when the LLM is unreachable,
// and the sessions store is plain JSON files on disk. We assert the structural
// invariants that hold for BOTH the LLM and the fallback paths, plus a full
// save/list/get/compare round-trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { planResearch, generateSchema } from '../src/core/research.js';
import { saveSession, listSessions, getSession, compareSessions } from '../src/core/sessions.js';

test('planResearch returns a usable plan (llm or fallback)', async () => {
  const plan = await planResearch({
    prompt: 'best open-source vector databases in 2025',
    output: 'answer',
    depth: 'quick',
  });
  assert.ok(plan && typeof plan === 'object');
  assert.ok(Array.isArray(plan.queries) && plan.queries.length >= 1, 'has at least one query');
  assert.ok(plan.queries.every((q) => typeof q === 'string' && q.length), 'queries are non-empty strings');
  assert.ok(Array.isArray(plan.extractFields), 'extractFields is an array');
  assert.equal(typeof plan.note, 'string');
  assert.ok(['llm', 'fallback'].includes(plan.source), 'source is llm or fallback');
});

test('planResearch respects depth query cap', async () => {
  const plan = await planResearch({ prompt: 'compare EV charging networks', output: 'report', depth: 'quick' });
  // quick depth is the smallest preset; never returns a runaway list of queries.
  assert.ok(plan.queries.length <= 8, `quick depth kept queries small (${plan.queries.length})`);
});

test('generateSchema turns plain English into an object schema (llm or fallback)', async () => {
  const { schema, source } = await generateSchema('company name, funding amount, and founding year');
  assert.ok(schema && typeof schema === 'object');
  assert.ok(schema.type || schema.properties || schema.items, 'looks like a JSON schema');
  assert.ok(['llm', 'fallback'].includes(source));
});

test('generateSchema fallback produces fields from a comma list when empty description', async () => {
  const { schema } = await generateSchema('');
  // empty description still yields a permissive object schema, never throws
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties && typeof schema.properties === 'object');
});

test('sessions: save / list / get / compare round-trip', async () => {
  const idA = `test-${Date.now()}-a`;
  const idB = `test-${Date.now()}-b`;
  const mk = (prompt, urls, answer) => ({
    request: { prompt, output: 'answer', depth: 'standard' },
    plan: { queries: [prompt], extractFields: [], note: '', source: 'fallback' },
    answer,
    sources: urls.map((u, i) => ({ url: u, title: `T${i}`, ok: true, status: 200 })),
    raw: [],
    extracted: { schema: null, schemaSource: null, rows: [] },
    activity: [],
    stats: { sources: urls.length, scraped: urls.length, failed: 0, extractedRows: 0, durationMs: 1234 },
  });

  try {
    const sA = await saveSession(mk('alpha topic', ['https://a.com', 'https://shared.com'], 'answer A'), { id: idA });
    const sB = await saveSession(mk('beta topic', ['https://b.com', 'https://shared.com'], 'answer B'), { id: idB, rerunOf: idA });
    assert.equal(sA.id, idA);
    assert.equal(sB.rerunOf, idA);
    assert.equal(sA.title, 'alpha topic');

    const list = await listSessions();
    const listedA = list.find((x) => x.id === idA);
    const listedB = list.find((x) => x.id === idB);
    assert.ok(listedA && listedB, 'both sessions listed');
    assert.equal(listedA.sources, 2);
    assert.equal(listedA.durationMs, 1234);
    assert.equal(listedB.rerunOf, idA);

    const got = await getSession(idA);
    assert.equal(got.id, idA);
    assert.equal(got.result.answer, 'answer A');

    const cmp = await compareSessions(idA, idB);
    assert.ok(cmp, 'comparison produced');
    assert.equal(cmp.sources.sharedCount, 1, 'one shared url');
    assert.deepEqual(cmp.sources.shared, ['https://shared.com']);
    assert.equal(cmp.sources.onlyACount, 1);
    assert.equal(cmp.sources.onlyBCount, 1);
    assert.equal(cmp.a.answer, 'answer A');
    assert.equal(cmp.b.answer, 'answer B');

    assert.equal(await getSession('does-not-exist-xyz'), null);
  } finally {
    await rm(new URL(`../data/sessions/${idA}.json`, import.meta.url), { force: true });
    await rm(new URL(`../data/sessions/${idB}.json`, import.meta.url), { force: true });
  }
});
