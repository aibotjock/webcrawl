// BFS site crawl -> markdown pages via scrape(). Same-origin, glob include/
// exclude on visiting (discovery is unfiltered), worker-pool concurrency.
// Never throws.
import { config } from './config.js';
import { normalizeUrl } from './fetch.js';

const globRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\?]/g, c => '\\' + c).replace(/\*/g, '.*') + '$');
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
  { limit = 50, maxDepth = 5, includeGlobs = [], excludeGlobs = [], concurrency = config.concurrency, _pageFn } = {}
) {
  const t0 = Date.now();
  const pages = [];
  try {
    const start = normalizeUrl(url);
    if (!start) throw new Error('invalid url: ' + url);
    const origin = new URL(start).origin;
    const pageFn =
      _pageFn || (async u => (await import('./scrape.js')).scrape(u, { formats: ['markdown'] }));
    const inc = includeGlobs.map(globRe);
    const exc = excludeGlobs.map(globRe);
    const visitable = u => (!inc.length || inc.some(re => re.test(u))) && !exc.some(re => re.test(u));
    const same = u => u === origin || u === origin + '/' || u.startsWith(origin + '/');
    const seen = new Set([start]);
    const queue = [[start, 0]];
    let active = 0;
    let stop = false;
    await new Promise(resolve => {
      const done = () => !active && (stop || !queue.length || pages.length >= limit);
      const tick = () => {
        if (done()) return resolve();
        while (!stop && queue.length && active < concurrency && pages.length + active < limit) {
          const [u, depth] = queue.shift();
          if (!visitable(u)) continue;
          active++;
          Promise.resolve(pageFn(u))
            .then(r => {
              if (r?.error || r?.metadata?.error) return;
              const markdown = r?.markdown ?? '';
              if (markdown) pages.push({ url: u, markdown, statusCode: r?.statusCode ?? r?.metadata?.statusCode ?? 0 });
              if (depth < maxDepth)
                for (const raw of hrefsOf(r)) {
                  const v = normalizeUrl(raw, u);
                  if (v && same(v) && !seen.has(v) && !assetRe.test(v)) {
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
    return { pages, count: pages.length, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { pages: [], count: 0, latencyMs: Date.now() - t0, error: String(e?.message || e) };
  }
}
