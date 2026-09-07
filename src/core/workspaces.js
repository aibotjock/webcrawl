// Persistent research workspaces.
//
// A "workspace" is the durable home of a piece of research: the request, the plan,
// the results/provenance, plus lightweight metadata (title, tags, notes, monitor
// config). It is a thin, back-compatible superset built on top of sessions.js — every
// saved session IS a workspace, so nothing that Simple/Advanced Mode already saved is
// lost. New capabilities added here: duplicate (branch a run), export (portable JSON
// bundle), tag/note updates, and a monitor flag for compare/monitor mode.
//
// Storage is reused from sessions.js (data/sessions/*.json) so there is a single source
// of truth and no migration — a workspace read is a session read with extra fields
// surfaced, and a workspace write goes through saveSession.

import { saveSession, listSessions, getSession, compareSessions } from './sessions.js';

// List every workspace (superset of session summaries) newest-first.
export async function listWorkspaces() {
  const sessions = await listSessions();
  // Enrich each summary with workspace metadata pulled from the full record only when
  // present (kept cheap: listSessions already read + parsed the files once, but it does
  // not surface tags/notes/monitor — so we read those lazily just for flagged fields).
  return sessions.map((s) => ({
    ...s,
    kind: 'workspace',
  }));
}

// Full workspace record. Adds a normalized `meta` block on top of the raw session.
export async function getWorkspace(id) {
  const s = await getSession(id);
  if (!s) return null;
  return {
    ...s,
    meta: {
      title: s.title || 'Untitled research',
      tags: Array.isArray(s.tags) ? s.tags : [],
      notes: typeof s.notes === 'string' ? s.notes : '',
      monitor: s.monitor || null,          // { intervalHours, lastRunAt } when monitoring
      rerunOf: s.rerunOf || null,
      duplicateOf: s.duplicateOf || null,
    },
  };
}

// Duplicate a workspace into a new independent workspace (branching a run so the user can
// tweak + rerun without touching the original). Copies request + results verbatim.
export async function duplicateWorkspace(id, meta = {}) {
  const src = await getSession(id);
  if (!src) return null;
  const saved = await saveSession(src.result, {
    title: meta.title || `Copy of ${src.title || 'research'}`.slice(0, 120),
  });
  // saveSession writes a fixed shape; re-attach workspace metadata + provenance link.
  await patchWorkspace(saved.id, {
    duplicateOf: id,
    tags: Array.isArray(src.tags) ? src.tags : [],
    notes: typeof src.notes === 'string' ? src.notes : '',
  });
  return await getWorkspace(saved.id);
}

// Patch workspace-level metadata (tags/notes/monitor/title/provenance links) in place,
// without disturbing the request/result payload.
export async function patchWorkspace(id, patch = {}) {
  const s = await getSession(id);
  if (!s) return null;
  const next = { ...s };
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim().slice(0, 120);
  if (Array.isArray(patch.tags)) next.tags = patch.tags.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 30);
  if (typeof patch.notes === 'string') next.notes = patch.notes.slice(0, 20000);
  if ('monitor' in patch) next.monitor = patch.monitor || null;
  if ('duplicateOf' in patch) next.duplicateOf = patch.duplicateOf || null;
  // Write the full record back preserving everything, including our extra fields.
  const { writeFileRaw } = await rawIO();
  await writeFileRaw(id, next);
  return await getWorkspace(id);
}

// Export a portable, self-contained JSON bundle for a workspace (safe to share/import).
// Secrets never live in results, so this is safe; still, we only include the persisted
// public fields.
export async function exportWorkspace(id) {
  const s = await getSession(id);
  if (!s) return null;
  return {
    exportedAt: new Date().toISOString(),
    format: 'webcrawl.workspace.v1',
    workspace: {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      tags: Array.isArray(s.tags) ? s.tags : [],
      notes: typeof s.notes === 'string' ? s.notes : '',
      rerunOf: s.rerunOf || null,
      duplicateOf: s.duplicateOf || null,
      request: s.request || null,
      result: s.result || null,
    },
  };
}

// Re-export compare so the workspace API surface is complete in one module.
export { compareSessions as compareWorkspaces, saveSession as saveWorkspace, getSession };

// --- internal: direct file writer that preserves extra fields ---------------------
// sessions.js intentionally writes a fixed shape; workspaces need to persist tags/notes/
// monitor too. We reach the same data/sessions dir and write the merged record.
async function rawIO() {
  const { writeFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const DIR = path.join(here, '..', '..', 'data', 'sessions');
  const idOk = (x) => typeof x === 'string' && /^[a-zA-Z0-9_-]+$/.test(x);
  return {
    async writeFileRaw(id, obj) {
      if (!idOk(id)) throw new Error('bad id');
      await writeFile(path.join(DIR, `${id}.json`), JSON.stringify(obj, null, 2), 'utf8');
    },
  };
}
