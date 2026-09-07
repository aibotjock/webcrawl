// Saved research sessions — self-contained JSON-file storage (no external DB).
// Each run (request + plan + results + provenance) is persisted as one JSON file
// under data/sessions/, so sessions can be listed, reopened, rerun and compared.
// The store is intentionally simple and dependency-free so the deployment just works.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', '..', 'data', 'sessions');

async function ensureDir() { if (!existsSync(DIR)) await mkdir(DIR, { recursive: true }); }
const idOk = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const fileFor = (id) => path.join(DIR, `${id}.json`);

// Persist a research result. Returns the stored session (with id + timestamps).
export async function saveSession(result, meta = {}) {
  await ensureDir();
  const id = meta.id && idOk(meta.id) ? meta.id : `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const session = {
    id,
    createdAt: new Date().toISOString(),
    title: meta.title || String(result?.request?.prompt || 'Untitled research').slice(0, 120),
    rerunOf: meta.rerunOf || null,
    request: result?.request || null,
    result,
  };
  await writeFile(fileFor(id), JSON.stringify(session, null, 2), 'utf8');
  return session;
}

// Lightweight summaries for the sessions list, newest first.
export async function listSessions() {
  await ensureDir();
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(await readFile(path.join(DIR, f), 'utf8'));
      out.push({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        rerunOf: s.rerunOf || null,
        prompt: s.request?.prompt || '',
        output: s.request?.output || '',
        depth: s.request?.depth || '',
        sources: s.result?.stats?.sources ?? 0,
        scraped: s.result?.stats?.scraped ?? 0,
        durationMs: s.result?.stats?.durationMs ?? 0,
      });
    } catch {}
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getSession(id) {
  if (!idOk(id)) return null;
  try { return JSON.parse(await readFile(fileFor(id), 'utf8')); } catch { return null; }
}

// Compare two sessions: source-URL set diff + headline stats + both answers.
export async function compareSessions(aId, bId) {
  const [a, b] = await Promise.all([getSession(aId), getSession(bId)]);
  if (!a || !b) return null;
  const urls = (s) => new Set((s.result?.sources || []).map((x) => x.url));
  const ua = urls(a), ub = urls(b);
  const onlyA = [...ua].filter((u) => !ub.has(u));
  const onlyB = [...ub].filter((u) => !ua.has(u));
  const shared = [...ua].filter((u) => ub.has(u));
  return {
    a: { id: a.id, title: a.title, createdAt: a.createdAt, stats: a.result?.stats || {}, answer: a.result?.answer || '' },
    b: { id: b.id, title: b.title, createdAt: b.createdAt, stats: b.result?.stats || {}, answer: b.result?.answer || '' },
    sources: { onlyA, onlyB, shared, sharedCount: shared.length, onlyACount: onlyA.length, onlyBCount: onlyB.length },
  };
}
