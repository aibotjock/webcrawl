import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { operatorConfig, createOperatorSecurity } from '../src/operator-security.js';
const token = 'test-only-operator-credential-32-characters';
function req(path = '/v1/test', headers = {}, method = 'GET') { return { path, method, headers: { host: '127.0.0.1:8787', ...headers }, socket: { remoteAddress: '127.0.0.1' } }; }
function res() { return Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }); }
function run(s, r) { const response = res(); let passed = false; s.middleware(r, response, () => { passed = true; }); return { response, passed }; }
test('HTTP binds loopback; authentication is mandatory and remote origin must use HTTPS', () => {
  assert.throws(() => operatorConfig({}), /OPERATOR_TOKEN/);
  assert.equal(operatorConfig({ WEBCRAWL_OPERATOR_TOKEN: token }).host, '127.0.0.1');
  assert.throws(() => operatorConfig({ WEBCRAWL_OPERATOR_TOKEN: token, WEBCRAWL_HOST: '0.0.0.0' }), /PUBLIC_ORIGIN/);
  assert.throws(() => operatorConfig({ WEBCRAWL_OPERATOR_TOKEN: token, WEBCRAWL_HOST: '0.0.0.0', WEBCRAWL_PUBLIC_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.equal(operatorConfig({ WEBCRAWL_OPERATOR_TOKEN: token, WEBCRAWL_HOST: '0.0.0.0', WEBCRAWL_PUBLIC_ORIGIN: 'https://example.com' }).secureCookie, true);
});
test('bearer gates API; forwarding headers, hostile Host and cross-site origin cannot bypass it', () => {
  const s = createOperatorSecurity(operatorConfig({ WEBCRAWL_OPERATOR_TOKEN: token }));
  assert.equal(run(s, req()).response.statusCode, 401);
  assert.equal(run(s, req('/v1/llm', { 'x-forwarded-host': 'localhost' })).response.statusCode, 401);
  assert.equal(run(s, req('/v1/test', { host: 'attacker.example:8787', authorization: `Bearer ${token}` })).response.statusCode, 403);
  assert.equal(run(s, req('/v1/test', { origin: 'https://attacker.example', authorization: `Bearer ${token}` })).response.statusCode, 403);
  const allowed = run(s, req('/v1/test', { authorization: `Bearer ${token}` })); assert.equal(allowed.passed, true); allowed.response.emit('finish');
});
test('browser login uses expiring HttpOnly cookie; logout revokes it', () => {
  let time = 0;
  const s = createOperatorSecurity(operatorConfig({ WEBCRAWL_OPERATOR_TOKEN: token }), { now: () => time });
  const request = req('/v1/login', { 'content-type': 'application/json' }, 'POST'); request.body = { token };
  const response = res(); s.login(request, response);
  const cookie = response.headers['Set-Cookie']; assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=3600/); assert.ok(!cookie.includes(token));
  const logged = req('/v1/test', { cookie }); assert.equal(s.authenticated(logged), true);
  s.logout(logged, res()); assert.equal(s.authenticated(logged), false);
  const second = res(); s.login(request, second); time = 3600001;
  assert.equal(s.authenticated(req('/v1/test', { cookie: second.headers['Set-Cookie'] })), false);
});
test('sign-in attempts and concurrent operator requests have bounded admission', () => {
  const s = createOperatorSecurity(operatorConfig({ WEBCRAWL_OPERATOR_TOKEN: token }));
  for (let i = 0; i < 10; i++) assert.equal(run(s, req('/v1/login', {}, 'POST')).passed, true);
  assert.equal(run(s, req('/v1/login', {}, 'POST')).response.statusCode, 429);
  const pending = Array.from({ length: 8 }, () => run(s, req('/v1/test', { authorization: `Bearer ${token}` })));
  assert.ok(pending.every(x => x.passed)); assert.equal(run(s, req('/v1/test', { authorization: `Bearer ${token}` })).response.statusCode, 429);
  pending[0].response.emit('close'); assert.equal(run(s, req('/v1/test', { authorization: `Bearer ${token}` })).passed, true);
});
