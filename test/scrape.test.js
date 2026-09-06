import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scrape } from '../src/core/scrape.js';
import { closeBrowser } from '../src/core/browser.js';

test('example.com converts to clean markdown', async () => {
  const r = await scrape('https://example.com');
  assert.ok(r.markdown.includes('# Example Domain'), 'has h1');
  assert.ok(r.markdown.includes('[Learn more](https://iana.org/domains/example)'), 'absolutized link');
  assert.equal(r.metadata.statusCode, 200);
  assert.equal(r.metadata.title, 'Example Domain');
});

test('quotes.toscrape.com/js renders via browser', async () => {
  const r = await scrape('https://quotes.toscrape.com/js/', { waitFor: 300 });
  assert.ok(r.markdown.includes('Einstein'), 'JS-rendered quotes present');
  assert.equal(r.metadata.statusCode, 200);
});

test('bad URL returns metadata.error, never throws', async () => {
  const r = await scrape('https://no-such-host.invalid/');
  assert.ok(r.metadata.error, 'error present');
  assert.equal(r.markdown, undefined);
});

after(async () => {
  await closeBrowser();
});
