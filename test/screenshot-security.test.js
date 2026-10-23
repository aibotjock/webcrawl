import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenshotResult } from '../src/core/screenshot.js';

test('screenshot result contract returns exact inline bytes without a temporary path', () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const result = screenshotResult(bytes, { status: 200, url: 'https://example.com', startedAt: Date.now() });
  assert.equal(result.screenshot, `data:image/png;base64,${bytes.toString('base64')}`);
  assert.equal(result.finalUrl, 'https://example.com');
  assert.equal(result.status, 200);
  assert.equal(Object.hasOwn(result, 'screenshotPath'), false);
  assert.ok(result.latencyMs >= 0);
});

test('screenshot result enforces the PNG byte limit before base64 expansion', () => {
  assert.throws(() => screenshotResult(Buffer.alloc(5 * 1024 * 1024 + 1)), /size limit/);
  assert.throws(() => screenshotResult('not screenshot bytes'), /size limit/);
});
