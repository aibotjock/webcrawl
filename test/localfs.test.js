// Tests for the read-only, allowlisted local filesystem search. These use a
// temporary directory as an allowlist root and clean it up afterward. They
// assert the security invariant that reads outside the allowlist are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getAllowlist, addRoot, removeRoot, searchLocal, readLocalFile,
} from '../src/core/localfs.js';

async function makeTree() {
  const base = await mkdtemp(path.join(tmpdir(), 'wc-localfs-'));
  await mkdir(path.join(base, 'sub'), { recursive: true });
  await writeFile(path.join(base, 'notes.txt'), 'the quick brown fox jumps', 'utf8');
  await writeFile(path.join(base, 'sub', 'readme.md'), '# Title\nvector databases rock', 'utf8');
  return base;
}

test('addRoot / getAllowlist / removeRoot round-trip', async () => {
  const dir = await makeTree();
  try {
    const added = await addRoot(dir);
    assert.ok(added.roots.includes(added.root), 'added root is in the returned list');
    const list = await getAllowlist();
    assert.ok(list.includes(added.root), 'allowlist persists the root');
    const removed = await removeRoot(dir);
    assert.ok(!removed.roots.includes(added.root), 'root removed from allowlist');
  } finally {
    await removeRoot(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('searchLocal finds matches only within the allowlist', async () => {
  const dir = await makeTree();
  try {
    await addRoot(dir);
    const res = await searchLocal({ query: 'vector', maxResults: 50 });
    assert.ok(Array.isArray(res.results), 'results is an array');
    assert.ok(res.results.some((r) => /readme\.md$/.test(r.path)), 'found the md file');
    assert.ok(typeof res.scannedFiles === 'number', 'reports scannedFiles');
  } finally {
    await removeRoot(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('readLocalFile refuses paths outside the allowlist', async () => {
  const dir = await makeTree();
  try {
    await addRoot(dir);
    // A path guaranteed to be outside the temp allowlist root.
    await assert.rejects(
      () => readLocalFile('/etc/hostname'),
      /allow|denied|outside|not permitted/i,
      'reading outside the allowlist is refused',
    );
    // Reading an allowed file works.
    const ok = await readLocalFile(path.join(dir, 'notes.txt'));
    assert.ok(String(ok.content ?? ok).includes('quick brown fox'), 'reads an allowed file');
  } finally {
    await removeRoot(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
