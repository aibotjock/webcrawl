#!/usr/bin/env node
// Smoke-test the stdio MCP server: initialize + tools/list. Exits non-zero on failure.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.js');
const p = spawn('node', [server], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
p.stdout.on('data', (d) => { buf += d.toString(); });
p.stderr.on('data', (d) => process.stderr.write('[mcp] ' + d));
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

setTimeout(() => {
  let tools = null, name = null;
  for (const line of buf.trim().split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      if (j.id === 1) name = `${j.result?.serverInfo?.name} v${j.result?.serverInfo?.version}`;
      if (j.id === 2) tools = (j.result?.tools || []).map((t) => t.name);
    } catch { /* partial line */ }
  }
  p.kill();
  if (!tools || !tools.length) { console.error('FAIL: no tools listed'); process.exit(1); }
  console.log(`OK: ${name} — ${tools.length} tools: ${tools.join(', ')}`);
  process.exit(0);
}, 2000);
