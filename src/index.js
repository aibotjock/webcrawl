// webcrawl as a library: drop the search engine into any Node app.
//
//   import { createWebcrawl } from 'webcrawl';
//   const wc = createWebcrawl({ typesafe: { apiKey: process.env.TYPESAFE_API_KEY } });
//   const r = await wc.search('how to descale a kettle', { level: 'standard' });
//   app.use('/api/search', wc.router());   // Exa-compatible routes inside your server
//
// Every option is optional. Anything not passed falls back to the same env vars the
// standalone server reads (set useEnv: false to ignore env entirely). With no keys at
// all it still works: keyless sources, BM25 ranking, no LLM features.
import express from 'express';
import * as engine from './search/engine.js';
import { searchRouter, apiKeyGuard } from './search/api.js';
import { createProviders } from './search/providers.js';
import { jevConfig } from './search/jev.js';
import { llmConfig } from './search/llm.js';
import { embedConfig } from './search/rank.js';
import { createCache } from './search/cache.js';

const strip = (u) => String(u || '').replace(/\/+$/, '');

export function createWebcrawl(options = {}) {
  const useEnv = options.useEnv !== false;
  const envGet = (k) => (useEnv ? String(process.env[k] || '').trim() : '');

  // Jev (TypeSafe)
  const t = options.typesafe ?? options.jev ?? {};
  const jev = t === false ? null
    : t.apiKey ? { apiKey: t.apiKey, baseUrl: strip(t.baseUrl || 'https://api.typesafe.ai'), model: t.model || 'jev-1.14.0', images: Boolean(t.images), timeoutMs: t.timeoutMs || 20000 }
      : useEnv ? jevConfig() : null;

  // Any LLM
  const l = options.llm;
  const llm = l === false ? null : l && (l.baseUrl || l.apiKey || l.provider)
    ? {
      provider: (l.provider || 'openai').toLowerCase(),
      baseUrl: strip(l.baseUrl || ({ anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com/v1beta' }[(l.provider || '').toLowerCase()]) || 'http://127.0.0.1:1234/v1'),
      model: l.model || (l.provider === 'anthropic' ? 'claude-sonnet-5-5' : 'local-model'),
      apiKey: l.apiKey || '', timeoutMs: l.timeoutMs || 120000,
    }
    : useEnv ? llmConfig() : null;

  // Embeddings (optional)
  const e = options.embeddings;
  const embed = e === false ? null : e?.baseUrl ? { baseUrl: strip(e.baseUrl), model: e.model || 'text-embedding-3-small', apiKey: e.apiKey || '' } : useEnv ? embedConfig() : null;

  // Sources
  const s = options.sources || {};
  const keyMap = { SEARXNG_URL: s.searxngUrl, BRAVE_API_KEY: s.braveApiKey, EXA_API_KEY: s.exaApiKey, WEBCRAWL_WIKI_LANG: s.wikiLang };
  const registry = createProviders((k) => keyMap[k] ?? envGet(k));
  const envList = envGet('WEBCRAWL_SEARCH_PROVIDERS');
  const defaultProviders = s.enabled || (envList ? envList.split(',') : undefined);

  const cache = options.cache?.get ? options.cache : createCache({ dir: options.cache?.dir ?? (envGet('WEBCRAWL_CACHE_DIR') || '.cache/pages'), max: options.cache?.max || Number(envGet('WEBCRAWL_CACHE_MAX')) || 5000 });

  const deps = {
    jev, llm, embed, registry, defaultProviders, cache,
    ...(options.fetch && { fetchImpl: options.fetch }),
    ...(options.scrape && { scrapeFn: options.scrape }),
  };

  const wc = {
    search: (query, opts = {}) => engine.search(query, opts, deps),
    answer: (query, opts = {}) => engine.search(query, { level: 'standard', highlights: true, ...opts, answer: true }, deps),
    contents: (urls, opts = {}) => engine.contents([].concat(urls), opts, deps),
    findSimilar: (url, opts = {}) => engine.findSimilar(url, opts, deps),
    findByImage: (opts = {}) => engine.findByImage(opts, deps),
    // crawling primitives (same as the standalone server)
    scrape: async (url, opts) => (await import('./core/scrape.js')).scrape(url, opts),
    crawl: async (url, opts) => (await import('./core/crawl.js')).crawlSite(url, opts),
    map: async (url, opts) => (await import('./core/map.js')).mapSite(url, opts),
    // Express router with the Exa-compatible routes (+ /scrape /map /crawl). Pass
    // { apiKey } to require a key on these routes inside your app.
    router({ apiKey } = {}) {
      const r = express.Router();
      r.use(express.json({ limit: '30mb' }));
      if (apiKey) r.use(apiKeyGuard(apiKey));
      r.use(searchRouter(deps));
      const json = (fn) => async (req, res) => {
        try { res.json(await fn(req.body || {})); } catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
      };
      r.post('/scrape', json((b) => wc.scrape(b.url, b)));
      r.post('/map', json((b) => wc.map(b.url, b)));
      r.post('/crawl', json((b) => wc.crawl(b.url, b)));
      return r;
    },
    // What's switched on (no secrets), for health checks and settings screens.
    status: () => ({
      jev: jev ? { model: jev.model, images: jev.images } : null,
      llm: llm ? { provider: llm.provider, model: llm.model } : null,
      embeddings: Boolean(embed),
      sources: Object.entries(registry).filter(([, p]) => p.enabled()).map(([n]) => n),
    }),
    deps,
  };
  return wc;
}

export { LEVELS } from './search/engine.js';
export default createWebcrawl;
