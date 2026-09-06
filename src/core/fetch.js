// Plain HTTP page fetch. Never throws — errors come back in-band.
import { config } from './config.js';

export async function fetchPage(url, { timeoutMs = config.timeoutMs, headers = {} } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': config.userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
    const contentType = res.headers.get('content-type') || '';
    const html = contentType.includes('html') || contentType.includes('xml') || contentType === ''
      ? await res.text()
      : '';
    return {
      status: res.status,
      contentType,
      html,
      finalUrl: res.url,
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    return { status: 0, contentType: '', html: '', finalUrl: url, latencyMs: Date.now() - t0, error: String(e?.cause?.code || e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Extract every href from an HTML document (cheap regex pass — no DOM needed for map).
export function extractHrefs(html) {
  const out = [];
  const re = /href\s*=\s*["']([^"']+)["']|href\s*=\s*([^\s>]+)/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1] || m[2]);
  return out;
}

// Normalize a discovered link against a base; returns null if unusable.
import { URL as U } from 'node:url';
export function normalizeUrl(raw, baseUrl) {
  if (!raw) return null;
  let u;
  try {
    u = new U(raw, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  // strip common tracking params
  for (const p of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref_?|mc_|igshid)/i.test(p)) u.searchParams.delete(p);
  }
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}
