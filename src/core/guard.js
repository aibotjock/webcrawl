// Keeps webcrawl from being used to reach private networks (SSRF). Every URL that
// comes from a user, a search result or a page — and every redirect hop — must
// resolve only to public addresses. Blocks loopback, private ranges, link-local
// (cloud metadata 169.254.169.254), CGNAT, multicast and their IPv6 forms.
//
// WEBCRAWL_ALLOW_PRIVATE=on turns the guard off (local dev: crawling localhost).
// Trusted endpoints you configure yourself (LLM, embeddings, SearXNG, Jev) never
// go through this guard, so a local LM Studio still works.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const allowPrivate = () => /^(1|on|true|yes)$/i.test(String(process.env.WEBCRAWL_ALLOW_PRIVATE || ''));

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && ip.split('.')[2] === '0')
    || (a === 198 && (b === 18 || b === 19));
}

export function isPrivateIp(ip) {
  const v = isIP(ip);
  if (v === 4) return v4Private(ip);
  if (v === 6) {
    const x = ip.toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return v4Private(mapped[1]);
    const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return v4Private([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return false;
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;
const cache = new Map(); // host -> { ok, at }

export class BlockedUrlError extends Error {
  constructor(msg) { super(msg); this.name = 'BlockedUrlError'; this.code = 'BLOCKED_PRIVATE'; }
}

// Throws BlockedUrlError unless the URL is http(s) and its host resolves only to public IPs.
export async function assertPublicUrl(url, { lookup = dnsLookup } = {}) {
  if (allowPrivate()) return;
  let u;
  try { u = new URL(url); } catch { throw new BlockedUrlError(`invalid url: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError(`only http(s) URLs are allowed: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) { if (isPrivateIp(host)) throw new BlockedUrlError(`private address blocked: ${host}`); return; }
  if (BLOCKED_NAMES.test(host)) throw new BlockedUrlError(`private host blocked: ${host}`);
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 60_000) { if (!hit.ok) throw new BlockedUrlError(`private address blocked: ${host}`); return; }
  let addrs;
  try { addrs = await lookup(host, { all: true }); } catch { return; } // unresolvable: the fetch itself will fail
  const ok = !addrs.some((a) => isPrivateIp(a.address));
  cache.set(host, { ok, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  if (!ok) throw new BlockedUrlError(`host resolves to a private address: ${host}`);
}

// fetch() that checks the URL and every redirect hop. Same signature as fetch.
export async function guardedFetch(url, init = {}, { maxRedirects = 5, fetchImpl = globalThis.fetch, lookup } = {}) {
  if (allowPrivate()) return fetchImpl(url, init);
  let current = String(url);
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current, { lookup });
    const res = await fetchImpl(current, { ...init, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) {
      if (current !== String(url)) Object.defineProperty(res, 'url', { value: current, configurable: true });
      return res;
    }
    if (hop >= maxRedirects) throw new Error('too many redirects');
    current = new URL(loc, current).toString();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method && init.method !== 'GET')) init = { ...init, method: 'GET', body: undefined };
  }
}
