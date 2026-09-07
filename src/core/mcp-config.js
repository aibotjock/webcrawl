// Shared MCP metadata, tool enable/disable persistence, and client-config builders.
// This is the ONE source of truth imported by:
//   - src/mcp.js            (the stdio MCP server — honors enable/disable at startup)
//   - src/server.js         (the HTTP API — /v1/mcp/* routes for the WebUI panel)
//   - mcp/generate-configs.mjs (the CLI that writes ready-to-paste host configs)
// It has no side effects on import, so it is safe to pull into the HTTP server.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const SERVER_PATH = path.join(ROOT, 'src', 'mcp.js');
const SETTINGS_FILE = path.join(ROOT, 'data', 'mcp-settings.json');

// Canonical tool list (name + short description). src/mcp.js supplies the zod
// input schemas + run functions keyed by these names; everything else (the WebUI
// panel, the settings store) works off this metadata.
export const TOOLS = [
  { name: 'webcrawl_scrape', description: 'Scrape a single URL; returns markdown/html/rawHtml/links/screenshot per requested formats.' },
  { name: 'webcrawl_crawl', description: 'Crawl a site (same-origin BFS, glob filters) and return markdown per page.' },
  { name: 'webcrawl_map', description: 'Fast site URL discovery (sitemap + link graph) without scraping page content.' },
  { name: 'webcrawl_search', description: 'Keyless web search (DuckDuckGo); returns [{ title, url, description }].' },
  { name: 'webcrawl_extract', description: 'Scrape a URL and extract structured JSON matching the given schema (local LLM, heuristic fallback).' },
  { name: 'webcrawl_screenshot', description: 'Screenshot a URL; returns PNG as a data:image/png;base64 URI.' },
];
export const TOOL_NAMES = TOOLS.map((t) => t.name);
export const DESCRIPTIONS = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));

// ---- enable/disable persistence ---------------------------------------------
// Stored as { disabled: [name, ...] } so a missing file means "all enabled".
export async function getMcpSettings() {
  try {
    const j = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    const disabled = Array.isArray(j.disabled) ? j.disabled.filter((n) => TOOL_NAMES.includes(n)) : [];
    return { disabled: [...new Set(disabled)] };
  } catch { return { disabled: [] }; }
}

export async function saveMcpSettings({ disabled = [] } = {}) {
  const clean = [...new Set((disabled || []).filter((n) => TOOL_NAMES.includes(n)))];
  if (!existsSync(path.dirname(SETTINGS_FILE))) await mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify({ disabled: clean }, null, 2), 'utf8');
  return { disabled: clean };
}

// Toggle a single tool on/off and persist. Returns the new settings.
export async function setToolEnabled(name, enabled) {
  if (!TOOL_NAMES.includes(name)) throw new Error(`unknown tool: ${name}`);
  const { disabled } = await getMcpSettings();
  const set = new Set(disabled);
  if (enabled) set.delete(name); else set.add(name);
  return saveMcpSettings({ disabled: [...set] });
}

// The tool list annotated with current enabled state (for the WebUI).
export async function toolsWithState() {
  const { disabled } = await getMcpSettings();
  return TOOLS.map((t) => ({ ...t, enabled: !disabled.includes(t.name) }));
}

// Names of the tools that are currently enabled (used by src/mcp.js at startup).
export async function enabledToolNames() {
  const { disabled } = await getMcpSettings();
  return TOOL_NAMES.filter((n) => !disabled.includes(n));
}

// ---- client-config builders --------------------------------------------------
export const HOSTS = [
  { id: 'claude', label: 'Claude Desktop', filename: 'claude_desktop_config.json', hint: 'Paste into claude_desktop_config.json (Settings → Developer → Edit Config).' },
  { id: 'cursor', label: 'Cursor', filename: 'cursor.mcp.json', hint: 'Save as .cursor/mcp.json in your project (or ~/.cursor/mcp.json globally).' },
  { id: 'windsurf', label: 'Windsurf', filename: 'windsurf_mcp_config.json', hint: 'Add under mcpServers in ~/.codeium/windsurf/mcp_config.json.' },
  { id: 'vscode', label: 'VS Code (Copilot Agent)', filename: 'vscode_mcp.json', hint: 'Save as .vscode/mcp.json in your workspace, or add under "mcp.servers" in settings.json.' },
  { id: 'continue', label: 'Continue', filename: 'continue_config.json', hint: 'Add under experimental.modelContextProtocolServers in ~/.continue/config.json.' },
];
export const HOST_IDS = HOSTS.map((h) => h.id);
export const SECRET_PLACEHOLDER = 'sk-ant-...';

// Default env for the MCP server process. Reads from the current environment.
// maskSecrets=true replaces any API key with a placeholder — ALWAYS use this for
// anything returned to the browser so a real key is never leaked to the client.
export function defaultEnv({ maskSecrets = false } = {}) {
  const provider = process.env.WEBCRAWL_LLM_PROVIDER || 'anthropic';
  const baseUrl = process.env.WEBCRAWL_LLM_BASE_URL || 'https://api.anthropic.com/v1';
  const model = process.env.WEBCRAWL_LLM_MODEL || 'claude-3-5-sonnet-latest';
  const realKey = process.env.WEBCRAWL_LLM_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const env = { WEBCRAWL_LLM_PROVIDER: provider, WEBCRAWL_LLM_BASE_URL: baseUrl, WEBCRAWL_LLM_MODEL: model };
  // local providers need no key; cloud/anthropic get a key line (masked for the browser)
  const needsKey = !['lmstudio', 'ollama', 'llamacpp'].includes(provider);
  if (needsKey) {
    const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'WEBCRAWL_LLM_API_KEY';
    env[keyName] = maskSecrets ? SECRET_PLACEHOLDER : (realKey || SECRET_PLACEHOLDER);
  }
  return env;
}

// Normalise an env object coming from an untrusted client: keep only known keys,
// coerce to strings, and mask any provided-but-empty secret with the placeholder.
export function sanitizeEnv(input = {}) {
  const allowed = ['WEBCRAWL_LLM_PROVIDER', 'WEBCRAWL_LLM_BASE_URL', 'WEBCRAWL_LLM_MODEL', 'WEBCRAWL_LLM_API_KEY', 'ANTHROPIC_API_KEY'];
  const out = {};
  for (const k of allowed) {
    if (input[k] == null || input[k] === '') continue;
    out[k] = String(input[k]).slice(0, 500);
  }
  return out;
}

// Build one host's client config. `env` should already be the desired env object.
export function buildConfig(host, { command = 'node', serverPath = SERVER_PATH, env } = {}) {
  const useEnv = env || defaultEnv();
  const stdio = { command, args: [serverPath], env: useEnv };
  const byHost = {
    claude: { mcpServers: { webcrawl: stdio } },
    cursor: { mcpServers: { webcrawl: stdio } },
    windsurf: { mcpServers: { webcrawl: stdio } },
    vscode: { servers: { webcrawl: { type: 'stdio', ...stdio } } },
    continue: { experimental: { modelContextProtocolServers: [{ transport: { type: 'stdio', ...stdio } }] } },
  };
  const meta = HOSTS.find((h) => h.id === host) || HOSTS[0];
  const config = byHost[host] || byHost.claude;
  return { host: meta.id, label: meta.label, filename: meta.filename, hint: meta.hint, config };
}

// Build configs for every host (used by the CLI generator).
export function buildAllConfigs(opts = {}) {
  return HOSTS.map((h) => buildConfig(h.id, opts));
}
