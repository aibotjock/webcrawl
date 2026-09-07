// Tests for the agent request normalizer and tool router. These are pure
// functions (no network / no disk), so they assert the structural invariants
// that govern every agent run: clamped limits, source-array normalization,
// least-privilege defaults, and transparent tool routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MODES, RESEARCH_DOMAINS, DEPTHS, normalizeAgentRequest, routeTools,
} from '../src/core/agent.js';

test('constants expose the documented enums', () => {
  assert.deepEqual(AGENT_MODES, ['manual', 'assisted', 'agent', 'advanced-agent']);
  assert.ok(RESEARCH_DOMAINS.includes('general') && RESEARCH_DOMAINS.includes('custom'));
  assert.ok(DEPTHS.includes('quick') && DEPTHS.includes('exhaustive') && DEPTHS.includes('custom'));
});

test('normalizeAgentRequest applies safe defaults', () => {
  const r = normalizeAgentRequest({ goal: 'find the best vector DBs' });
  assert.equal(r.mode, 'agent');
  assert.equal(r.depth, 'standard');
  assert.equal(r.domain, 'general');
  assert.equal(r.output, 'answer');
  assert.equal(r.allowWrite, false, 'writes are opt-in (least privilege)');
  assert.equal(r.approvalPolicy, 'destructive-only', 'safe approval default');
  assert.ok(Array.isArray(r.sources) && r.sources.length >= 1, 'defaults to a web source');
});

test('normalizeAgentRequest clamps out-of-range limits', () => {
  const r = normalizeAgentRequest({
    goal: 'x',
    limits: { maxPages: 9999, maxSearches: -5, maxCrawlDepth: 99, maxIterations: 100, runtimeMs: 1, llmCap: 9999, toolPreference: 'bogus' },
  });
  assert.ok(r.limits.maxPages <= 200 && r.limits.maxPages >= 1);
  assert.ok(r.limits.maxSearches >= 1 && r.limits.maxSearches <= 25);
  assert.ok(r.limits.maxCrawlDepth >= 0 && r.limits.maxCrawlDepth <= 5);
  assert.ok(r.limits.maxIterations >= 1 && r.limits.maxIterations <= 6);
  assert.ok(r.limits.runtimeMs >= 5000 && r.limits.runtimeMs <= 600000);
  assert.ok(r.limits.llmCap >= 1 && r.limits.llmCap <= 200);
  assert.equal(r.limits.toolPreference, 'auto', 'invalid toolPreference falls back to auto');
});

test('normalizeAgentRequest normalizes mixed source shapes into {type,values}', () => {
  const r = normalizeAgentRequest({
    goal: 'x',
    sources: ['web', { type: 'url', values: ['https://a.com', 'https://b.com'] }, { type: 'localfs' }],
  });
  assert.ok(r.sources.every((s) => typeof s.type === 'string' && Array.isArray(s.values)));
  const url = r.sources.find((s) => s.type === 'url');
  assert.deepEqual(url.values, ['https://a.com', 'https://b.com']);
});

test('normalizeAgentRequest accepts prompt as an alias for goal', () => {
  const r = normalizeAgentRequest({ prompt: 'legacy prompt field' });
  assert.equal(r.goal, 'legacy prompt field');
});

test('routeTools reflects selected sources and always ends with synthesize', () => {
  const req = normalizeAgentRequest({ goal: 'x', sources: [{ type: 'web' }, { type: 'localfs' }], output: 'dataset' });
  const tools = routeTools(req, {});
  const names = tools.map((t) => t.tool);
  assert.ok(names.includes('search'), 'web => search');
  assert.ok(names.includes('localfs'), 'localfs source => localfs tool');
  assert.ok(names.includes('extract'), 'dataset output => extract');
  assert.equal(names[names.length - 1], 'synthesize', 'routing ends with synthesize');
  assert.ok(tools.every((t) => t.reason), 'every routed tool carries a reason (transparency)');
});
