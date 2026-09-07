// Tests for the MCP server registry, profiles and custom-import validation.
// parseImport is pure (no I/O). The registry/profile tests snapshot the on-disk
// data files first and restore them afterward so a developer's real registry is
// never clobbered by the suite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEMPLATES, BUILTIN_PROFILES, parseImport,
  listServers, saveServer, toggleServer, removeServer, enableAll, testServer,
  listProfiles, saveProfile, applyProfile, removeProfile,
} from '../src/core/mcp-servers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '..', 'data');
const SERVERS = path.join(DATA, 'mcp-servers.json');
const PROFILES = path.join(DATA, 'mcp-profiles.json');
const snap = {};

async function backup(f) { try { return await readFile(f, 'utf8'); } catch { return null; } }
async function restore(f, v) { if (v === null) await rm(f, { force: true }); else await writeFile(f, v, 'utf8'); }

before(async () => { snap.servers = await backup(SERVERS); snap.profiles = await backup(PROFILES); });
after(async () => { await restore(SERVERS, snap.servers); await restore(PROFILES, snap.profiles); });

test('TEMPLATES and BUILTIN_PROFILES are populated', () => {
  assert.ok(Array.isArray(TEMPLATES) && TEMPLATES.length >= 5, 'has starter templates');
  assert.ok(TEMPLATES.every((t) => t.id && t.command), 'templates have id + command');
  assert.ok(Array.isArray(BUILTIN_PROFILES) && BUILTIN_PROFILES.length >= 1, 'has built-in profiles');
});

test('parseImport masks secrets and flags required env', () => {
  const raw = JSON.stringify({
    mcpServers: {
      github: {
        command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwx0123456789' },
      },
    },
  });
  const res = parseImport(raw);
  assert.equal(res.ok, true, 'valid import');
  const s = res.servers[0];
  assert.equal(s.id, 'github');
  assert.notEqual(s.env.GITHUB_TOKEN, 'ghp_abcdefghijklmnopqrstuvwx0123456789', 'secret is masked');
  assert.ok(s.requiredEnv.includes('GITHUB_TOKEN'), 'flags masked secret as required env');
  assert.equal(s.valid, true);
});

test('parseImport rejects invalid JSON and empty definitions', () => {
  assert.equal(parseImport('{not json').ok, false, 'invalid JSON => ok:false');
  assert.equal(parseImport('{"nothing":true}').ok, false, 'no server defs => ok:false');
});

test('server save / toggle / test / remove round-trip', async () => {
  const id = 'test-srv-xyz';
  await saveServer({ id, name: 'Test Server', command: 'node', args: ['x.js'], env: { API_KEY: 'shortval' } });
  let list = await listServers();
  assert.ok(list.some((s) => s.id === id), 'server saved');

  const toggled = await toggleServer(id, false);
  assert.equal(toggled.enabled, false, 'toggled off');

  const tr = await testServer(id);
  assert.equal(typeof tr.ok, 'boolean', 'testServer returns ok flag');
  // API_KEY masked -> requiredEnv unfilled -> test reports a problem
  assert.ok(!tr.ok && tr.problems.length, 'flags unfilled required env');

  const rm2 = await removeServer(id);
  assert.equal(rm2.removed, 1, 'removed one');
  assert.ok(!rm2.servers.some((s) => s.id === id), 'gone from list');
});

test('profile save / apply / remove round-trip', async () => {
  const servers = await listServers();
  const firstId = servers[0]?.id;
  assert.ok(firstId, 'registry has at least the self server');
  const prof = await saveProfile({ name: 'Test Profile', servers: [firstId] });
  assert.ok(prof.id && prof.builtin === false, 'custom profile created');

  const all = await listProfiles();
  assert.ok(all.some((p) => p.id === prof.id), 'profile listed');
  assert.ok(all.some((p) => p.builtin), 'built-ins still present');

  const applied = await applyProfile(prof.id);
  assert.ok(applied.profile.id === prof.id, 'applied the profile');
  const after2 = await listServers();
  assert.equal(after2.find((s) => s.id === firstId).enabled, true, 'profile server enabled');

  const rem = await removeProfile(prof.id);
  assert.equal(rem.removed, true, 'profile removed');
});
