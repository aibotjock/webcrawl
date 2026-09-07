// Tests for the workspace layer over sessions.js: it must be a back-compatible
// superset (every saved session is a workspace) and add duplicate / export /
// patch. We create workspaces with real saves and delete the files afterward.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  saveWorkspace, listWorkspaces, getWorkspace, duplicateWorkspace,
  patchWorkspace, exportWorkspace,
} from '../src/core/workspaces.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SDIR = path.join(here, '..', 'data', 'sessions');
const created = [];
async function cleanup() { for (const id of created) await rm(path.join(SDIR, `${id}.json`), { force: true }); }
after(cleanup);

function fakeResult(prompt) {
  return {
    request: { prompt, output: 'answer', depth: 'standard' },
    answer: 'a synthesized answer',
    sources: [{ url: 'https://example.com', ok: true }],
    stats: { sources: 1, scraped: 1, durationMs: 1234 },
  };
}

test('saveWorkspace + listWorkspaces + getWorkspace round-trip', async () => {
  const s = await saveWorkspace(fakeResult('workspace test alpha'), { title: 'Alpha' });
  created.push(s.id);
  const list = await listWorkspaces();
  const row = list.find((w) => w.id === s.id);
  assert.ok(row, 'workspace appears in list');
  assert.equal(row.kind, 'workspace', 'list rows are tagged as workspaces');

  const full = await getWorkspace(s.id);
  assert.ok(full.meta, 'workspace has a normalized meta block');
  assert.equal(full.meta.title, 'Alpha');
  assert.ok(Array.isArray(full.meta.tags), 'meta.tags is an array');
});

test('patchWorkspace updates tags/notes without losing results', async () => {
  const s = await saveWorkspace(fakeResult('workspace test beta'), { title: 'Beta' });
  created.push(s.id);
  const patched = await patchWorkspace(s.id, { tags: ['ai', 'db'], notes: 'a note' });
  assert.deepEqual(patched.meta.tags, ['ai', 'db']);
  assert.equal(patched.meta.notes, 'a note');
  assert.ok(patched.result && patched.result.answer === 'a synthesized answer', 'results preserved');
});

test('duplicateWorkspace branches into an independent copy', async () => {
  const s = await saveWorkspace(fakeResult('workspace test gamma'), { title: 'Gamma' });
  created.push(s.id);
  const dup = await duplicateWorkspace(s.id, { title: 'Gamma copy' });
  created.push(dup.id);
  assert.notEqual(dup.id, s.id, 'new id');
  assert.equal(dup.meta.duplicateOf, s.id, 'links back to source');
  assert.ok(dup.result && dup.result.answer === 'a synthesized answer', 'copies results');
});

test('exportWorkspace produces a portable versioned bundle', async () => {
  const s = await saveWorkspace(fakeResult('workspace test delta'), { title: 'Delta' });
  created.push(s.id);
  const bundle = await exportWorkspace(s.id);
  assert.equal(bundle.format, 'webcrawl.workspace.v1');
  assert.ok(bundle.exportedAt, 'has export timestamp');
  assert.equal(bundle.workspace.id, s.id);
  assert.ok(bundle.workspace.result, 'includes the result payload');
});
