// Candidate sources for search. Each provider takes (query, { limit, fetchImpl })
// and resolves to [{ title, url, description, publishedDate? }]. Providers never
// throw: a failure comes back as { error } so one dead source can't sink a search.
//
// Keyless by default (DuckDuckGo + Wikipedia). Keyed sources switch on when their
// env var is set: SEARXNG_URL, BRAVE_API_KEY, EXA_API_KEY.
import { normalizeUrl } from '../core/fetch.js';

const env = (k) => String(process.env[k] || '').trim();
const json = async (res) => { try { return await res.json(); } catch { return null; } };
const clip = (s, n = 400) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

async function getJson(fetchImpl, url, init = {}, timeoutMs = 10000) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const j = await json(res);
  if (!j) throw new Error('non-JSON response');
  return j;
}

export const PROVIDERS = {
  duckduckgo: {
    keyless: true,
    enabled: () => true,
    async search(query, { limit }) {
      const { webSearch } = await import('../core/search.js');
      const r = await webSearch(query, { limit: Math.min(limit, 20) });
      if (r.error && !r.results.length) throw new Error(r.error);
      return r.results;
    },
  },

  wikipedia: {
    keyless: true,
    enabled: () => true,
    async search(query, { limit, fetchImpl }) {
      const lang = env('WEBCRAWL_WIKI_LANG') || 'en';
      const u = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${Math.min(limit, 10)}&srsearch=${encodeURIComponent(query)}`;
      const j = await getJson(fetchImpl, u, { headers: { 'user-agent': 'webcrawl-search/0.2 (self-hosted)' } });
      return (j.query?.search || []).map((h) => ({
        title: h.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
        description: clip(h.snippet),
        publishedDate: h.timestamp || undefined,
      }));
    },
  },

  // Self-hosted SearXNG with the JSON format enabled (search.formats: [html, json]).
  searxng: {
    enabled: () => Boolean(env('SEARXNG_URL')),
    async search(query, { limit, fetchImpl }) {
      const base = env('SEARXNG_URL').replace(/\/+$/, '');
      const j = await getJson(fetchImpl, `${base}/search?format=json&q=${encodeURIComponent(query)}`);
      return (j.results || []).slice(0, limit).map((r) => ({
        title: clip(r.title, 200), url: r.url, description: clip(r.content), publishedDate: r.publishedDate || undefined,
      }));
    },
  },

  brave: {
    enabled: () => Boolean(env('BRAVE_API_KEY')),
    async search(query, { limit, fetchImpl }) {
      const j = await getJson(fetchImpl,
        `https://api.search.brave.com/res/v1/web/search?count=${Math.min(limit, 20)}&q=${encodeURIComponent(query)}`,
        { headers: { accept: 'application/json', 'X-Subscription-Token': env('BRAVE_API_KEY') } });
      return (j.web?.results || []).map((r) => ({
        title: clip(r.title, 200), url: r.url, description: clip(r.description), publishedDate: r.page_age || undefined,
      }));
    },
  },

  // Exa as an optional upstream: its index finds pages the free sources miss.
  exa: {
    enabled: () => Boolean(env('EXA_API_KEY')),
    async search(query, { limit, fetchImpl }) {
      const j = await getJson(fetchImpl, 'https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env('EXA_API_KEY') },
        body: JSON.stringify({ query, numResults: Math.min(limit, 25), type: 'auto' }),
      }, 15000);
      return (j.results || []).map((r) => ({ title: clip(r.title, 200) || r.url, url: r.url, description: '', publishedDate: r.publishedDate || undefined }));
    },
  },
};

// Which providers run: the request's list, else WEBCRAWL_SEARCH_PROVIDERS, else every
// enabled one. Unknown or unconfigured names are skipped and reported.
export function pickProviders(requested, registry = PROVIDERS) {
  const want = requested?.length ? requested : (env('WEBCRAWL_SEARCH_PROVIDERS') ? env('WEBCRAWL_SEARCH_PROVIDERS').split(',') : Object.keys(registry));
  const use = [], skipped = [];
  for (const raw of want) {
    const name = String(raw).trim().toLowerCase();
    if (!name) continue;
    if (registry[name]?.enabled()) use.push(name); else skipped.push(name);
  }
  return { use: [...new Set(use)], skipped };
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
// A domain rule matches the host or any subdomain; "example.com/docs" also matches a path prefix.
export function domainMatch(url, rules) {
  const host = hostOf(url);
  let path = '';
  try { path = new URL(url).pathname; } catch {}
  return rules.some((r) => {
    const [d, ...p] = String(r).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '').split('/');
    const hostOk = host === d || host.endsWith('.' + d);
    const pre = p.length ? '/' + p.join('/') : '';
    return hostOk && (!pre || path.startsWith(pre));
  });
}

// Runs providers in parallel and fuses their lists with reciprocal rank fusion:
// a page ranked well by several sources beats one ranked first by a single source.
export async function gather(query, { providers, limit = 20, includeDomains = [], excludeDomains = [], fetchImpl = globalThis.fetch, registry = PROVIDERS, k = 60 } = {}) {
  // A single included domain can be pushed into the query itself (site: works on every engine here).
  const q = includeDomains.length === 1 && !/\bsite:/i.test(query) ? `${query} site:${includeDomains[0].replace(/^https?:\/\//, '').split('/')[0]}` : query;
  const runs = await Promise.all(providers.map(async (name) => {
    const t0 = Date.now();
    try {
      const rows = await registry[name].search(q, { limit, fetchImpl });
      return { name, rows: rows || [], ms: Date.now() - t0 };
    } catch (e) {
      return { name, rows: [], ms: Date.now() - t0, error: String(e?.message || e) };
    }
  }));
  const byUrl = new Map();
  for (const run of runs) {
    run.rows.forEach((r, i) => {
      const url = normalizeUrl(r.url);
      if (!url) return;
      if (includeDomains.length && !domainMatch(url, includeDomains)) return;
      if (excludeDomains.length && domainMatch(url, excludeDomains)) return;
      const cur = byUrl.get(url) || { url, title: '', description: '', publishedDate: undefined, sources: [], rrf: 0 };
      cur.rrf += 1 / (k + i + 1);
      cur.sources.push(run.name);
      if (!cur.title && r.title) cur.title = r.title;
      if ((r.description || '').length > cur.description.length) cur.description = r.description;
      cur.publishedDate ||= r.publishedDate;
      byUrl.set(url, cur);
    });
  }
  const candidates = [...byUrl.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
  return {
    candidates,
    providers: runs.map(({ name, rows, ms, error }) => ({ name, results: rows.length, ms, ...(error && { error }) })),
  };
}
