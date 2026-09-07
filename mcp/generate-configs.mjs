#!/usr/bin/env node
// Generate ready-to-paste MCP client configs with THIS checkout's absolute path filled in.
// Usage: node mcp/generate-configs.mjs [--out <dir>]  (default: ./mcp/generated)
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'src', 'mcp.js');
const outDir = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : path.join(root, 'mcp', 'generated'); })();

// Default provider is Anthropic Claude. Override any of these via the environment when running
// this script, or edit the generated file, to point webcrawl_extract at a local model or another
// cloud endpoint. Set ANTHROPIC_API_KEY (or WEBCRAWL_LLM_API_KEY) to actually reach Claude.
const anthropicKey = process.env.WEBCRAWL_LLM_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const env = {
  WEBCRAWL_LLM_PROVIDER: process.env.WEBCRAWL_LLM_PROVIDER || 'anthropic',
  WEBCRAWL_LLM_BASE_URL: process.env.WEBCRAWL_LLM_BASE_URL || 'https://api.anthropic.com/v1',
  WEBCRAWL_LLM_MODEL: process.env.WEBCRAWL_LLM_MODEL || 'claude-3-5-sonnet-latest',
  ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
};
const stdio = { command: 'node', args: [server], env };

const files = {
  'claude_desktop_config.json': { mcpServers: { webcrawl: stdio } },
  'cursor.mcp.json': { mcpServers: { webcrawl: stdio } },
  'windsurf_mcp_config.json': { mcpServers: { webcrawl: stdio } },
  'vscode_mcp.json': { servers: { webcrawl: { type: 'stdio', ...stdio } } },
  'continue_config.json': { experimental: { modelContextProtocolServers: [{ transport: { type: 'stdio', ...stdio } }] } },
};

await mkdir(outDir, { recursive: true });
for (const [name, cfg] of Object.entries(files)) {
  await writeFile(path.join(outDir, name), JSON.stringify(cfg, null, 2) + '\n');
  console.log('wrote', path.join(outDir, name));
}
console.log(`\nMCP server entry: ${server}\nPaste the matching file into your host (see mcp/README.md).`);
