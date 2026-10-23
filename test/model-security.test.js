import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/core/config.js';
import { modelFetch } from '../src/core/model-fetch.js';

test('model requests reject credential-bearing URLs, private hostnames and insecure cloud destinations before fetch', async () => {
  const original = config.llmBaseUrl;
  try {
    for (const value of ['https://user:password@example.com/v1', 'http://metadata.internal/v1', 'http://localhost:1234/v1', 'http://example.com/v1', 'file:///etc/passwd']) {
      config.llmBaseUrl = value;
      await assert.rejects(modelFetch('/models'));
    }
    config.llmBaseUrl = 'http://127.0.0.1:1234/v1';
    await assert.rejects(modelFetch('/anything-else'), /Unsupported/);
  } finally { config.llmBaseUrl = original; }
});
