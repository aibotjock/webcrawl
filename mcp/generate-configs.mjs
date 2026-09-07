#!/usr/bin/env node
// Generate ready-to-paste MCP client configs with THIS checkout's absolute path filled in.
// Usage: node mcp/generate-configs.mjs [--out <dir>]  (default: ./mcp/generated)
//
// The config-building logic lives in src/core/mcp-config.js so the CLI, the HTTP
// API (/v1/mcp/config) and the WebUI panel all share ONE source of truth.
// Override the LLM env by exporting WEBCRAWL_LLM_* / ANTHROPIC_API_KEY before running.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAllConfigs, defaultEnv, SERVER_PATH } from '../src/core/mcp-config.js';

const outDir = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 ? process.argv[i + 1] : path.join(path.dirname(SERVER_PATH), '..', 'mcp', 'generated');
})();

// CLI runs on the user's own machine, so it may embed a real key from the env.
const configs = buildAllConfigs({ command: 'node', serverPath: SERVER_PATH, env: defaultEnv() });

await mkdir(outDir, { recursive: true });
for (const { filename, config } of configs) {
  await writeFile(path.join(outDir, filename), JSON.stringify(config, null, 2) + '\n');
  console.log('wrote', path.join(outDir, filename));
}
console.log(`\nMCP server entry: ${SERVER_PATH}\nPaste the matching file into your host (see mcp/README.md).`);
