// MCP server registry, profiles, custom-import validation, and starter templates.
//
// This is distinct from mcp-config.js (which manages webcrawl's OWN 6 stdio tools):
// here we track a LIST of MCP *servers* the user wants their agent/hosts to know about
// — the self "webcrawl" server plus any custom ones the user adds or imports.
//
// SECURITY:
//   * Secrets are never stored in cleartext for display. On import/save we replace any
//     value that looks like a real secret with a placeholder unless the caller explicitly
//     opts to keep it; the WebUI always shows placeholders.
//   * Read/write capability + permission scope are tracked per server so the agent and UI
//     can distinguish read-only from write-capable / destructive tools (least privilege).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SERVER_PATH, SECRET_PLACEHOLDER } from './mcp-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '..', '..', 'data');
const SERVERS = path.join(DATA, 'mcp-servers.json');
const PROFILES = path.join(DATA, 'mcp-profiles.json');

async function ensureData() { if (!existsSync(DATA)) await mkdir(DATA, { recursive: true }); }
const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; } };
const writeJson = async (f, v) => { await ensureData(); await writeFile(f, JSON.stringify(v, null, 2), 'utf8'); };

// Heuristic: does a string look like a real secret we should mask?
const SECRET_KEY_RE = /(token|key|secret|password|passwd|apikey|api_key|auth|credential|pat)/i;
function looksSecretValue(v) {
  const s = String(v || '');
  if (!s) return false;
  if (/^(sk-ant-|sk-|ghp_|gho_|github_pat_|xox[baprs]-|AIza|AKIA)/.test(s)) return true;
  if (s.length >= 20 && /[A-Za-z0-9_\-]/.test(s) && !/\s/.test(s)) return true;
  return false;
}
// Replace secret-looking env values with a placeholder. Returns { env, requiredEnv:[] }.
function maskEnv(env = {}) {
  const out = {}; const requiredEnv = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (SECRET_KEY_RE.test(k) || looksSecretValue(v)) {
      out[k] = SECRET_PLACEHOLDER;
      requiredEnv.push(k);
    } else out[k] = String(v);
  }
  return { env: out, requiredEnv };
}

// ---- starter templates ---------------------------------------------------------
// Config slots the user can enable/fill. We do NOT bundle heavy binaries; these are
// the standard `npx -y @modelcontextprotocol/server-*` style launch commands.
export const TEMPLATES = [
  { id: 'filesystem', name: 'Filesystem', description: 'Read/write files in allowed directories.', capability: 'readwrite', scope: 'local files', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'], env: {} },
  { id: 'memory', name: 'Memory', description: 'Persistent knowledge-graph memory for the agent.', capability: 'readwrite', scope: 'local memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: {} },
  { id: 'fetch', name: 'Fetch', description: 'Fetch a URL and return its contents.', capability: 'readonly', scope: 'network', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], env: {} },
  { id: 'git', name: 'Git', description: 'Read/search/operate on a local git repo.', capability: 'readwrite', scope: 'local repo', command: 'npx', args: ['-y', '@modelcontextprotocol/server-git', '--repository', '/path/to/repo'], env: {} },
  { id: 'github', name: 'GitHub', description: 'GitHub repos, issues, PRs, code search.', capability: 'readwrite', scope: 'external network', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET_PLACEHOLDER } },
  { id: 'sequential-thinking', name: 'Sequential Thinking', description: 'Structured step-by-step reasoning tool.', capability: 'readonly', scope: 'none', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], env: {} },
  { id: 'time', name: 'Time', description: 'Current time and timezone conversions.', capability: 'readonly', scope: 'none', command: 'npx', args: ['-y', '@modelcontextprotocol/server-time'], env: {} },
  { id: 'playwright', name: 'Browser Automation (Playwright)', description: 'Drive a headless browser to navigate and extract.', capability: 'readwrite', scope: 'network', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} },
  { id: 'webcrawl', name: 'Webcrawl (self)', description: 'This webcrawl instance: scrape/crawl/map/search/extract/screenshot.', capability: 'readonly', scope: 'network', command: 'node', args: [SERVER_PATH], env: { WEBCRAWL_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: SECRET_PLACEHOLDER } },
  { id: 'sqlite', name: 'SQLite', description: 'Query a local SQLite database.', capability: 'readwrite', scope: 'local db', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '/path/to/db.sqlite'], env: {} },
  { id: 'postgres', name: 'PostgreSQL', description: 'Query a PostgreSQL database (read-only recommended).', capability: 'readonly', scope: 'external db', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], env: { DATABASE_URL: SECRET_PLACEHOLDER } },
  { id: 'vectordb', name: 'Vector DB / RAG', description: 'Semantic search over an embedded vector store.', capability: 'readonly', scope: 'local db', command: 'npx', args: ['-y', '@modelcontextprotocol/server-qdrant'], env: { QDRANT_URL: 'http://127.0.0.1:6333', QDRANT_API_KEY: SECRET_PLACEHOLDER } },
  { id: 'documents', name: 'Document Ingestion', description: 'Ingest PDF/DOCX/other documents for retrieval.', capability: 'readonly', scope: 'local files', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: {} },
  { id: 'search', name: 'Search', description: 'Web search via an MCP search provider.', capability: 'readonly', scope: 'external network', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: SECRET_PLACEHOLDER } },
  { id: 'code-exec', name: 'Code Execution / Sandbox', description: 'Run code in a sandbox. Write/execute — enable with care.', capability: 'destructive', scope: 'local exec', command: 'npx', args: ['-y', '@modelcontextprotocol/server-run-python'], env: {} },
];

// ---- profiles ------------------------------------------------------------------
// Built-in profiles map to template/server ids that should be enabled together.
export const BUILTIN_PROFILES = [
  { id: 'research', name: 'Research', builtin: true, servers: ['webcrawl', 'fetch', 'search', 'memory', 'sequential-thinking'] },
  { id: 'coding', name: 'Coding', builtin: true, servers: ['filesystem', 'git', 'github', 'sequential-thinking'] },
  { id: 'medical', name: 'Medical Research', builtin: true, servers: ['webcrawl', 'search', 'fetch', 'documents', 'memory'] },
  { id: 'legal', name: 'Legal Research', builtin: true, servers: ['webcrawl', 'search', 'documents', 'memory'] },
  { id: 'web-investigation', name: 'Web Investigation', builtin: true, servers: ['webcrawl', 'playwright', 'fetch', 'search'] },
  { id: 'local-files', name: 'Local Files', builtin: true, servers: ['filesystem', 'documents', 'memory'] },
  { id: 'software-dev', name: 'Software Development', builtin: true, servers: ['filesystem', 'git', 'github', 'code-exec', 'sequential-thinking'] },
  { id: 'deep-research', name: 'Deep Research', builtin: true, servers: ['webcrawl', 'search', 'fetch', 'playwright', 'documents', 'memory', 'sequential-thinking'] },
];

// ---- server registry -----------------------------------------------------------
// Each registry entry: { id, name, description, command, args, env, capability,
//   scope, enabled, connected, source, requiredEnv, lastError, createdAt }
function seedServers() {
  const self = TEMPLATES.find((t) => t.id === 'webcrawl');
  const { env, requiredEnv } = maskEnv(self.env);
  return [{
    id: 'webcrawl', name: self.name, description: self.description,
    command: self.command, args: self.args, env,
    capability: self.capability, scope: self.scope,
    enabled: true, connected: true, source: 'builtin', requiredEnv, lastError: null,
    createdAt: new Date().toISOString(),
  }];
}

export async function listServers() {
  let servers = await readJson(SERVERS, null);
  if (!Array.isArray(servers)) { servers = seedServers(); await writeJson(SERVERS, servers); }
  return servers;
}

function normalizeServer(input, { source = 'custom' } = {}) {
  const s = input || {};
  const command = String(s.command || 'npx').slice(0, 300);
  const args = Array.isArray(s.args) ? s.args.map(String).slice(0, 50) : [];
  const { env, requiredEnv } = maskEnv(s.env || {});
  const cap = ['readonly', 'readwrite', 'destructive'].includes(s.capability) ? s.capability : 'readonly';
  return {
    id: (s.id && /^[a-zA-Z0-9_-]+$/.test(s.id)) ? s.id : `srv-${randomUUID().slice(0, 8)}`,
    name: String(s.name || s.id || 'Unnamed MCP').slice(0, 120),
    description: String(s.description || '').slice(0, 400),
    command, args, env,
    capability: cap,
    scope: String(s.scope || 'unknown').slice(0, 60),
    enabled: s.enabled !== false,
    connected: false,
    source,
    requiredEnv,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
}

export async function saveServer(input, { source = 'custom' } = {}) {
  const servers = await listServers();
  const norm = normalizeServer(input, { source });
  const i = servers.findIndex((x) => x.id === norm.id);
  if (i >= 0) servers[i] = { ...servers[i], ...norm, createdAt: servers[i].createdAt };
  else servers.push(norm);
  await writeJson(SERVERS, servers);
  return norm;
}

export async function removeServer(id) {
  const servers = await listServers();
  const next = servers.filter((x) => x.id !== id);
  await writeJson(SERVERS, next);
  return { removed: servers.length - next.length, servers: next };
}

export async function toggleServer(id, enabled) {
  const servers = await listServers();
  const s = servers.find((x) => x.id === id);
  if (!s) throw new Error('server not found');
  s.enabled = enabled !== false;
  await writeJson(SERVERS, servers);
  return s;
}

export async function enableAll(enabled) {
  const servers = await listServers();
  for (const s of servers) s.enabled = !!enabled;
  await writeJson(SERVERS, servers);
  return servers;
}

// Static "test connection": validate the launch spec looks runnable. We do NOT spawn
// arbitrary user processes automatically (that would be an execution risk); instead we
// report whether required env is filled and the command/args are well-formed.
export async function testServer(id) {
  const servers = await listServers();
  const s = servers.find((x) => x.id === id);
  if (!s) throw new Error('server not found');
  const problems = [];
  if (!s.command) problems.push('missing command');
  const unfilled = (s.requiredEnv || []).filter((k) => !s.env[k] || s.env[k] === SECRET_PLACEHOLDER);
  if (unfilled.length) problems.push(`required env not set: ${unfilled.join(', ')}`);
  const ok = problems.length === 0;
  s.connected = ok; s.lastError = ok ? null : problems.join('; ');
  await writeJson(SERVERS, servers);
  return { id, ok, problems, checkedAt: new Date().toISOString() };
}

// ---- custom import -------------------------------------------------------------
// Accepts pasted JSON in any common MCP shape and returns detected servers + validation,
// WITHOUT installing. Shapes handled: { mcpServers: {name: {...}} }, { servers: {...} },
// a single {command,args,env}, or an array of those.
export function parseImport(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { return { ok: false, error: `invalid JSON: ${e.message}`, servers: [] }; }

  const detected = [];
  const pushEntry = (name, def) => {
    if (!def || typeof def !== 'object') return;
    const spec = def.transport ? { ...def.transport } : def;
    const command = spec.command || (spec.type === 'stdio' ? spec.command : undefined);
    const entry = {
      id: (typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name)) ? name : `srv-${randomUUID().slice(0, 8)}`,
      name: def.name || name || 'Imported MCP',
      description: def.description || '',
      command: command || '',
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      env: spec.env || {},
      capability: def.capability || 'readonly',
      scope: def.scope || 'unknown',
    };
    const { env, requiredEnv } = maskEnv(entry.env);
    const problems = [];
    if (!entry.command) problems.push('no command');
    detected.push({ ...entry, env, requiredEnv, valid: problems.length === 0, problems });
  };

  if (data && typeof data === 'object') {
    if (data.mcpServers && typeof data.mcpServers === 'object') {
      for (const [k, v] of Object.entries(data.mcpServers)) pushEntry(k, v);
    } else if (data.servers && typeof data.servers === 'object' && !Array.isArray(data.servers)) {
      for (const [k, v] of Object.entries(data.servers)) pushEntry(k, v);
    } else if (Array.isArray(data)) {
      for (const v of data) pushEntry(v?.name || v?.id, v);
    } else if (data.command || data.transport) {
      pushEntry(data.name || data.id, data);
    } else {
      // maybe an object keyed by server name directly
      for (const [k, v] of Object.entries(data)) if (v && typeof v === 'object' && (v.command || v.transport)) pushEntry(k, v);
    }
  }
  if (!detected.length) return { ok: false, error: 'no MCP server definitions found', servers: [] };
  return { ok: detected.some((d) => d.valid), servers: detected };
}

// ---- profiles store ------------------------------------------------------------
export async function listProfiles() {
  const custom = await readJson(PROFILES, []);
  return [...BUILTIN_PROFILES, ...(Array.isArray(custom) ? custom : [])];
}
export async function saveProfile(input) {
  const custom = await readJson(PROFILES, []);
  const arr = Array.isArray(custom) ? custom : [];
  const prof = {
    id: (input?.id && /^[a-zA-Z0-9_-]+$/.test(input.id)) ? input.id : `prof-${randomUUID().slice(0, 8)}`,
    name: String(input?.name || 'Custom profile').slice(0, 80),
    builtin: false,
    servers: Array.isArray(input?.servers) ? input.servers.map(String) : [],
  };
  const i = arr.findIndex((p) => p.id === prof.id);
  if (i >= 0) arr[i] = prof; else arr.push(prof);
  await writeJson(PROFILES, arr);
  return prof;
}
export async function removeProfile(id) {
  const custom = await readJson(PROFILES, []);
  const arr = (Array.isArray(custom) ? custom : []).filter((p) => p.id !== id);
  await writeJson(PROFILES, arr);
  return { removed: true };
}
// Apply a profile: enable exactly its servers (that exist in the registry), disable the rest.
export async function applyProfile(id) {
  const profiles = await listProfiles();
  const prof = profiles.find((p) => p.id === id);
  if (!prof) throw new Error('profile not found');
  const wanted = new Set(prof.servers);
  const servers = await listServers();
  for (const s of servers) s.enabled = wanted.has(s.id);
  await writeJson(SERVERS, servers);
  return { profile: prof, servers, missing: [...wanted].filter((w) => !servers.some((s) => s.id === w)) };
}

// Which enabled servers should the agent consider "available"? (for tool routing)
export async function enabledServers() {
  return (await listServers()).filter((s) => s.enabled);
}
