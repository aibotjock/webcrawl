// scrape orchestrator: static-first, browser re-render for JS shells, never throws.
import { fetchPage, extractHrefs } from './fetch.js';
import { htmlToMarkdown, extractMain } from './markdown.js';
import { renderPage, screenshotPage } from './browser.js';
import { URL as U } from 'node:url';
import { config } from './config.js';

const JS_SHELL = /\sid=["'](root|app|__next|__nuxt|___gatsby)["']/i;

function extractLinks(html, baseUrl) {
  const seen = new Set();
  const out = [];
  for (const h of extractHrefs(html)) {
    try {
      const u = new U(h, baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      const s = u.toString();
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    } catch {}
  }
  return out;
}

export async function scrape(url, opts = {}) {
  const {
    formats = ['markdown'],
    onlyMainContent = true,
    timeout = config.timeoutMs,
    waitFor = 0,
    fullPage = false,
    viewport,
  } = opts;
  const t0 = Date.now();
  const want = (f) => formats.includes(f);
  const out = { metadata: { title: '', description: '', statusCode: 0, url } };

  let res = await fetchPage(url, { timeoutMs: timeout });
  let html = res.html || '';
  let finalUrl = res.finalUrl || url;
  let fetchMethod = 'fetch'; // 'fetch' = static HTTP, 'browser' = headless re-render (provenance)
  let conv = html ? htmlToMarkdown(html, { baseUrl: finalUrl }) : { markdown: '', title: '', description: '' };
  const mdChars = conv.markdown.replace(/\s+/g, '').length;

  // JS-shell heuristics -> re-render with the browser
  if (html.length < 1500 || mdChars < 200 || (JS_SHELL.test(html) && mdChars < 1000)) {
    const r = await renderPage(url, { timeoutMs: timeout, waitFor, viewport });
    if (r.html) {
      html = r.html;
      finalUrl = r.finalUrl || finalUrl;
      res = { ...res, status: r.status };
      fetchMethod = 'browser';
      conv = htmlToMarkdown(html, { baseUrl: finalUrl });
    } else if (!html) {
      res = { ...res, error: res.error || r.error };
    }
  }

  out.metadata = {
    title: conv.title || '',
    description: conv.description || '',
    statusCode: res.status || 0,
    url: finalUrl,
    fetchMethod,
  };
  if (!html) {
    out.metadata.error = res.error || 'empty response';
    out.latencyMs = Date.now() - t0;
    return out;
  }

  if (want('markdown')) out.markdown = conv.markdown || '';
  if (want('html')) out.html = extractMain(html, finalUrl, { mainOnly: onlyMainContent }).contentHtml;
  if (want('rawHtml')) out.rawHtml = html;
  if (want('links')) out.links = extractLinks(html, finalUrl);
  if (want('screenshot')) {
    const shot = await screenshotPage(finalUrl, { fullPage, viewport, timeoutMs: timeout, waitFor });
    if (shot.screenshot) out.screenshot = shot.screenshot;
    if (shot.error) out.metadata.error = out.metadata.error || shot.error;
  }

  out.latencyMs = Date.now() - t0;
  return out;
}
