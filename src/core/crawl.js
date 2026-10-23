// BFS site crawl -> markdown pages via scrape(). Same-origin, glob include/
// exclude on visiting (discovery is unfiltered), worker-pool concurrency.
// Never throws.
import { config } from './config.js';
import { normalizeUrl } from './fetch.js';

// Linear wildcard matching avoids attacker-controlled regex backtracking.
export function globMatches(text, pattern) {
  let i = 0, j = 0, star = -1, mark = 0;
  while (i < text.length) {
    if (pattern[j] === text[i]) { i++; j++; }
    else if (pattern[j] === '*') { star = j++; mark = i; }
    else if (star >= 0) { j = star + 1; i = ++mark; }
    else return false;
  }
  while (pattern[j] === '*') j++;
  return j === pattern.length;
}
const assetRe = /\.(css|js|mjs|json|xml|rss|atom|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|tar|mp[34]|webm|wav)(\?|#|$)/i;

// Harvest hrefs from whatever the page function returned: markdown link syntax,
// html/rawHtml href attributes, or an explicit links array.
function hrefsOf(r) {
  const out = [];
  const md = r?.markdown || '';
  for (const m of md.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g))
    if (md[m.index - 1] !== '!') out.push(m[1]); // skip images ![alt](src)
  const html = r?.html || r?.rawHtml || '';
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) out.push(m[1]);
  if (Array.isArray(r?.links)) out.push(...r.links);
  return out;
}

export async function crawlSite(
  url,
  { limit = 50, maxDepth = 5, includeGlobs = [], excludeGlobs = [], concurrency = config.concurrency, signal, _pageFn } = {}
) {
  const t0 = Date.now();
  const pages = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 120000);
  try {
    limit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)));
    maxDepth = Math.min(5, Math.max(0, Math.trunc(Number(maxDepth) || 0)));
    concurrency = Math.min(4, Math.max(1, Math.trunc(Number(concurrency) || 1)));
    if (![includeGlobs, excludeGlobs].every(a => Array.isArray(a) && a.length <= 10 && a.every(x => typeof x === 'string' && x.length <= 100))) throw new Error('Invalid crawl filters');
    const start = normalizeUrl(url);
    if (!start) throw new Error('invalid url: ' + url);
    const origin = new URL(start).origin;
    const pageFn =
      _pageFn || (async u => (await import('./scrape.js')).scrape(u, { formats: ['markdown'], signal: controller.signal }));
    const visitable = u => (!includeGlobs.length || includeGlobs.some(g => globMatches(u, g))) && !excludeGlobs.some(g => globMatches(u, g));
    const same = u => u === origin || u === origin + '/' || u.startsWith(origin + '/');
    const seen = new Set([start]);
    const queue = [[start, 0]];
    let active = 0;
    let stop = false;
    let attempted = 0;
    let outputBytes = 0;
    await new Promise(resolve => {
      const done = () => !active && (controller.signal.aborted || stop || !queue.length || attempted >= limit || pages.length >= limit);
      const tick = () => {
        if (done()) return resolve();
        while (!controller.signal.aborted && !stop && queue.length && active < concurrency && attempted < limit && pages.length + active < limit) {
          const [u, depth] = queue.shift();
          if (!visitable(u)) continue;
          active++;
          attempted++;
          Promise.resolve(pageFn(u))
            .then(r => {
              if (r?.error || r?.metadata?.error) return;
              const markdown = String(r?.markdown ?? '').slice(0, 100000);
              outputBytes += Buffer.byteLength(markdown);
              if (outputBytes > 2 * 1024 * 1024) { stop = true; controller.abort(); return; }
              if (markdown) pages.push({ url: u, markdown, statusCode: r?.statusCode ?? r?.metadata?.statusCode ?? 0 });
              if (depth < maxDepth)
                for (const raw of hrefsOf(r)) {
                  const v = normalizeUrl(raw, u);
                  if (v && same(v) && seen.size < 1000 && !seen.has(v) && !assetRe.test(v)) {
                    seen.add(v);
                    queue.push([v, depth + 1]);
                  }
                }
            })
            .catch(() => {})
            .finally(() => {
              active--;
              if (pages.length >= limit) stop = true;
              tick();
            });
        }
        if (done()) resolve();
      };
      tick();
    });
    return { pages, count: pages.length, cancelled: controller.signal.aborted, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { pages: [], count: 0, latencyMs: Date.now() - t0, error: String(e?.message || e) };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
