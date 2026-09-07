// Secure, READ-ONLY local filesystem research.
//
// SECURITY MODEL (least privilege):
//   * Nothing is readable unless the user has explicitly added its directory to the
//     allowlist (persisted in data/localfs-allowlist.json).
//   * Every path is resolved with fs.realpath and must remain INSIDE an allowlisted
//     root after resolution — this defeats `..` traversal and symlink escapes.
//   * This module never writes, deletes, moves or executes anything. It only reads.
//   * File contents handed to the LLM elsewhere are treated as UNTRUSTED (fenced by
//     the caller); this module just returns raw text + provenance.

import { mkdir, readFile, writeFile, readdir, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '..', '..', 'data');
const STORE = path.join(DATA, 'localfs-allowlist.json');

// text-ish extensions we will read the CONTENTS of (filenames of any type are always searchable)
export const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv', '.json', '.jsonl',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php', '.swift',
  '.sh', '.bash', '.zsh', '.sql', '.html', '.htm', '.css', '.scss', '.less',
  '.xml', '.svg', '.vue', '.svelte', '.graphql', '.proto', '.tf', '.dockerfile',
]);
const DEFAULT_MAX_BYTES = 512 * 1024; // never read more than 512KB of a single file for content search
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv']);

async function ensureData() { if (!existsSync(DATA)) await mkdir(DATA, { recursive: true }); }

export async function getAllowlist() {
  try { const j = JSON.parse(await readFile(STORE, 'utf8')); return Array.isArray(j.roots) ? j.roots : []; }
  catch { return []; }
}
async function saveAllowlist(roots) {
  await ensureData();
  await writeFile(STORE, JSON.stringify({ roots }, null, 2), 'utf8');
  return roots;
}

// Expand ~ and resolve to an absolute, real path. Throws if it does not exist / not a dir.
async function resolveDir(input) {
  let p = String(input || '').trim();
  if (!p) throw new Error('path required');
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  p = path.resolve(p);
  const rp = await realpath(p); // throws if missing
  const st = await stat(rp);
  if (!st.isDirectory()) throw new Error('path is not a directory');
  return rp;
}

export async function addRoot(input) {
  const rp = await resolveDir(input);
  const roots = await getAllowlist();
  if (!roots.includes(rp)) roots.push(rp);
  await saveAllowlist(roots);
  return { root: rp, roots };
}

export async function removeRoot(input) {
  const roots = await getAllowlist();
  let target = String(input || '').trim();
  try { target = await realpath(path.resolve(target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target)); } catch {}
  const next = roots.filter((r) => r !== target && r !== String(input));
  await saveAllowlist(next);
  return { removed: roots.length - next.length, roots: next };
}

// Is `abs` inside any allowlisted root (after realpath)? Returns the root, or null.
async function insideAllowlist(abs) {
  const roots = await getAllowlist();
  let real;
  try { real = await realpath(abs); } catch { real = path.resolve(abs); }
  for (const root of roots) {
    const rel = path.relative(root, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return root;
  }
  return null;
}

// Recursively walk an allowlisted root, yielding files up to a cap.
async function* walk(dir, { maxFiles = 20000 } = {}) {
  let count = 0;
  const stack = [dir];
  while (stack.length && count < maxFiles) {
    const cur = stack.pop();
    let entries = [];
    try { entries = await readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow symlinks out of the tree
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile()) {
        count++;
        yield full;
        if (count >= maxFiles) return;
      }
    }
  }
}

// Search filenames AND (for text-ish files) contents within the allowlist.
// opts: { query, roots?, maxResults?, contentMatches?, caseSensitive? }
export async function searchLocal({ query, roots, maxResults = 100, caseSensitive = false } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query required');
  const allow = await getAllowlist();
  if (!allow.length) return { results: [], scannedFiles: 0, roots: allow, note: 'No allowlisted folders. Add one first.' };
  // if caller narrows to specific roots, they must all be allowlisted
  let searchRoots = allow;
  if (Array.isArray(roots) && roots.length) {
    searchRoots = [];
    for (const r of roots) { const root = await insideAllowlist(path.resolve(r)); if (root) searchRoots.push(root); }
    if (!searchRoots.length) throw new Error('none of the requested roots are allowlisted');
  }
  const needle = caseSensitive ? q : q.toLowerCase();
  const results = [];
  let scanned = 0;
  for (const root of searchRoots) {
    for await (const file of walk(root)) {
      if (results.length >= maxResults) break;
      scanned++;
      const base = path.basename(file);
      const nameHit = (caseSensitive ? base : base.toLowerCase()).includes(needle);
      let contentHits = [];
      let size = 0;
      const ext = path.extname(file).toLowerCase();
      const isText = TEXT_EXT.has(ext) || base.toLowerCase() === 'dockerfile' || base.toLowerCase() === 'makefile';
      if (isText) {
        try {
          const st = await stat(file);
          size = st.size;
          if (size <= DEFAULT_MAX_BYTES) {
            const text = await readFile(file, 'utf8');
            const hay = caseSensitive ? text : text.toLowerCase();
            let idx = hay.indexOf(needle), n = 0;
            const lines = text.split('\n');
            while (idx >= 0 && n < 5) {
              // find line number of this match
              const upto = text.slice(0, idx);
              const lineNo = upto.split('\n').length;
              const line = (lines[lineNo - 1] || '').trim().slice(0, 240);
              contentHits.push({ line: lineNo, text: line });
              idx = hay.indexOf(needle, idx + needle.length); n++;
            }
          }
        } catch { /* unreadable/binary — skip content */ }
      }
      if (nameHit || contentHits.length) {
        results.push({
          path: file,
          name: base,
          root,
          ext,
          size,
          nameMatch: nameHit,
          contentMatches: contentHits,
          matchCount: contentHits.length + (nameHit ? 1 : 0),
        });
      }
    }
    if (results.length >= maxResults) break;
  }
  // filename matches and higher match counts first
  results.sort((a, b) => (b.nameMatch - a.nameMatch) || (b.matchCount - a.matchCount));
  return { results, scannedFiles: scanned, roots: searchRoots };
}

// Read one file's contents — ONLY if it is inside the allowlist. Read-only.
export async function readLocalFile(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const abs = path.resolve(String(filePath || ''));
  const root = await insideAllowlist(abs);
  if (!root) throw new Error('access denied: path is not inside an allowlisted folder');
  const real = await realpath(abs);
  const st = await stat(real);
  if (!st.isFile()) throw new Error('not a file');
  const truncated = st.size > maxBytes;
  const buf = await readFile(real);
  const text = buf.slice(0, maxBytes).toString('utf8');
  return { path: real, root, size: st.size, truncated, content: text };
}
