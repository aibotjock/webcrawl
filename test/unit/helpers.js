// Offline test helpers: a fake fetch that routes by URL, fake pages, a memory cache.
import { createCache } from '../../src/search/cache.js';

export function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (typeof match === 'string' ? String(url).startsWith(match) : match.test(String(url))) {
        const out = await handler(String(url), init);
        const body = out.body ?? out;
        const status = out.status ?? 200;
        const isBuf = Buffer.isBuffer(body);
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: new Map([['content-type', out.contentType || (isBuf ? 'image/jpeg' : 'application/json')]]),
          json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
          arrayBuffer: async () => (isBuf ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new TextEncoder().encode(JSON.stringify(body)).buffer),
        };
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
}
export const memCache = () => createCache({ dir: 'off' });

// A registry of providers returning fixed rows.
export function fixedProviders(map) {
  return Object.fromEntries(Object.entries(map).map(([name, rows]) => [name, {
    enabled: () => true,
    search: async () => { if (rows instanceof Error) throw rows; return rows; },
  }]));
}

// scrapeFn returning canned pages keyed by URL.
export function fakeScrape(pages, calls = []) {
  return async (url) => {
    calls.push(url);
    const p = pages[url];
    if (!p) return { metadata: { error: 'not found', url } };
    return { markdown: p.markdown, rawHtml: p.rawHtml || '', metadata: { title: p.title || '', url, statusCode: 200 } };
  };
}
